import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { createProjectServer, upstreamHeaders } from "../src/proxy.mjs";
import { loopbackOpen, portOpen } from "../src/supervisor.mjs";
import { Progress } from "../src/progress.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** A static project server on an ephemeral port, plus the pieces it was given. */
function serveStaticFixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lightbox-proxy-"));
  for (const [rel, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), body);

  const project = { key: `fixture-${process.pid}`, name: "Fixture", dir, kind: "static", port: 0 };
  const progress = new Progress(path.join(dir, ".lightbox", "progress.json"));
  const ctx = {
    project,
    progress,
    supervisor: { state: () => ({ state: "static" }), tail: () => "", start: async () => {} },
    hubUrl: "http://localhost:4000/",
    bridge: "http://127.0.0.1:1",
    overlayPath: path.join(HERE, "..", "src", "overlay.js"),
    inspectCommentPath: null,
  };
  const server = createProjectServer(ctx);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        port,
        progress,
        project,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

async function get(port, urlPath, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, { headers });
  return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) };
}

const PAGE =
  "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Fixture</title></head>" +
  "<body><script>window.first = 1</script><p>hello</p></body></html>";

test("HTML gets the config and the overlay at the end of <head>, before the page's own scripts", async () => {
  const { port, project, close } = await serveStaticFixture({ "index.html": PAGE });
  try {
    const r = await get(port, "/");
    assert.equal(r.status, 200);
    const html = r.body.toString();
    // After the page's own head children (the App Router hydrates <head>, and
    // a foreign node ahead of React's children reads as a mismatch), but still
    // inside <head> so the config exists before any body script runs.
    const overlayTag = '<script src="/__lb/overlay.js" defer data-lightbox></script>';
    assert.equal(html.indexOf(overlayTag) + overlayTag.length, html.indexOf("</head>"));
    assert.ok(html.indexOf("<title>Fixture</title>") < html.indexOf("<script data-lightbox-config>"));
    assert.ok(html.includes(`window.__LIGHTBOX={"key":"${project.key}"`));
    assert.ok(html.includes('<script src="/__lb/overlay.js" defer data-lightbox></script>'));
    assert.ok(
      html.indexOf("data-lightbox-config") < html.indexOf("window.first"),
      "the config is defined before any page script can run"
    );
    assert.ok(html.endsWith("</html>"), "the rest of the document is untouched");
  } finally {
    await close();
  }
});

test("x-lightbox-bare returns the document exactly as the project serves it", async () => {
  const { port, close } = await serveStaticFixture({ "index.html": PAGE });
  try {
    const bare = await get(port, "/", { "x-lightbox-bare": "1" });
    assert.equal(bare.status, 200);
    assert.equal(bare.body.toString(), PAGE, "no config, no overlay, byte for byte");
    const dressed = await get(port, "/");
    assert.ok(dressed.body.toString().includes("data-lightbox-config"), "the header is opt-in per request");
  } finally {
    await close();
  }
});

test("Range requests: 206 with the right slice, suffix ranges, and 416 when unsatisfiable", async () => {
  const { port, close } = await serveStaticFixture({ "media.bin": "0123456789" });
  try {
    const whole = await get(port, "/media.bin");
    assert.equal(whole.status, 200);
    assert.equal(whole.body.toString(), "0123456789");

    const head = await get(port, "/media.bin", { range: "bytes=0-3" });
    assert.equal(head.status, 206);
    assert.equal(head.headers.get("content-range"), "bytes 0-3/10");
    assert.equal(head.headers.get("content-length"), "4");
    assert.equal(head.body.toString(), "0123");

    const suffix = await get(port, "/media.bin", { range: "bytes=-4" });
    assert.equal(suffix.status, 206, "suffix ranges are how Chrome finds an mp4's moov atom");
    assert.equal(suffix.headers.get("content-range"), "bytes 6-9/10");
    assert.equal(suffix.body.toString(), "6789");

    const open = await get(port, "/media.bin", { range: "bytes=6-" });
    assert.equal(open.status, 206);
    assert.equal(open.body.toString(), "6789");

    const past = await get(port, "/media.bin", { range: "bytes=20-30" });
    assert.equal(past.status, 416);
    assert.equal(past.headers.get("content-range"), "bytes */10");

    const empty = await get(port, "/media.bin", { range: "bytes=-0" });
    assert.equal(empty.status, 416);
  } finally {
    await close();
  }
});

test("the tool's own endpoints: overlay, progress, missing inspect-comment", async () => {
  const { port, progress, project, close } = await serveStaticFixture({ "index.html": PAGE });
  try {
    const overlay = await get(port, "/__lb/overlay.js");
    assert.equal(overlay.status, 200);
    assert.match(overlay.headers.get("content-type"), /javascript/);
    assert.ok(overlay.body.toString().includes("__LIGHTBOX"));

    const tick = await fetch(`http://127.0.0.1:${port}/__lb/progress`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ route: "/", reviewed: true }),
    });
    assert.equal(tick.status, 204);
    assert.deepEqual(progress.get(project.key), ["/"]);

    const missing = await get(port, "/__lb/inspect-comment.js");
    assert.equal(missing.status, 404, "no inspector installed is a 404, not a crash");

    const unknown = await get(port, "/__lb/nope");
    assert.equal(unknown.status, 404);
  } finally {
    await close();
  }
});

test("static: clean URLs resolve to their .html file and directories to index.html", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lightbox-proxy-"));
  fs.mkdirSync(path.join(dir, "docs"));
  const { port, close } = await serveStaticFixture({
    "index.html": PAGE,
    "about.html": PAGE.replace("hello", "about"),
  });
  try {
    const about = await get(port, "/about");
    assert.equal(about.status, 200);
    assert.ok(about.body.toString().includes("<p>about</p>"));
    assert.ok(about.body.toString().includes("data-lightbox-config"), "resolved files are injected too");

    const missing = await get(port, "/nothing-here");
    assert.equal(missing.status, 404);
    assert.ok(missing.body.toString().includes("data-lightbox-config"), "even the 404 page carries the walker");
  } finally {
    await close();
  }
});

test("upstream headers make the browser look like localhost:<upstream> to a dev server", () => {
  const project = { port: 4003, upstream: 3103 };
  const h = upstreamHeaders(
    {
      host: "127.0.0.1:4003",
      origin: "http://127.0.0.1:4003",
      referer: "http://127.0.0.1:4003/about?x=1",
      "sec-fetch-site": "same-origin",
    },
    project
  );
  assert.equal(h.host, "localhost:3103");
  assert.equal(h.origin, "http://localhost:3103");
  assert.equal(h.referer, "http://localhost:3103/about?x=1");
  assert.equal(h["sec-fetch-site"], "same-origin");

  // A hostname other than 127.0.0.1 on the review port is rewritten too, and
  // a foreign origin is left alone.
  assert.equal(upstreamHeaders({ origin: "http://100.99.1.2:4003" }, project).origin, "http://localhost:3103");
  assert.equal(upstreamHeaders({ origin: "https://example.com" }, project).origin, "https://example.com");
  assert.equal(upstreamHeaders({ referer: "http://127.0.0.1:40031/x" }, project).referer, "http://127.0.0.1:40031/x");
});

test("a dev server that binds only the IPv6 loopback is detected and proxied", async (t) => {
  // Vite 5+ on Node 17+ listens on ::1 alone; the old 127.0.0.1-only probe
  // reported it absent for 180s and the proxy could never reach it.
  const up = http.createServer((req, res) => res.end("hello from ::1 via " + req.headers.host));
  try {
    await new Promise((resolve, reject) => {
      up.once("error", reject);
      up.listen(0, "::1", resolve);
    });
  } catch {
    t.skip("no IPv6 loopback on this machine");
    return;
  }
  const upstream = up.address().port;
  assert.equal(await portOpen(upstream), false, "the IPv4 probe alone misses it");
  assert.equal(await loopbackOpen(upstream), "::1");
  assert.equal(await loopbackOpen(1), null, "nothing listens on port 1");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lightbox-v6-"));
  const project = { key: "v6", name: "V6", dir, kind: "node", port: 0, upstream };
  const ctx = {
    project,
    progress: new Progress(path.join(dir, ".lightbox", "progress.json")),
    supervisor: { state: () => ({ state: "ready", host: "::1" }), tail: () => "", start: async () => {} },
    hubUrl: "http://localhost:4000/",
    bridge: "http://127.0.0.1:1",
    overlayPath: path.join(HERE, "..", "src", "overlay.js"),
    inspectCommentPath: null,
  };
  const server = createProjectServer(ctx);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  project.port = server.address().port;
  try {
    const r = await get(project.port, "/");
    assert.equal(r.status, 200);
    assert.ok(r.body.toString().startsWith("hello from ::1 via localhost:" + upstream), r.body.toString());
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => up.close(r));
  }
});
