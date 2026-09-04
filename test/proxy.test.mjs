import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProjectServer } from "../src/proxy.mjs";
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

test("HTML gets the config and the overlay right after <head>, before the page's own scripts", async () => {
  const { port, project, close } = await serveStaticFixture({ "index.html": PAGE });
  try {
    const r = await get(port, "/");
    assert.equal(r.status, 200);
    const html = r.body.toString();
    const afterHead = html.indexOf("<head>") + "<head>".length;
    assert.equal(html.indexOf("<script data-lightbox-config>"), afterHead);
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
