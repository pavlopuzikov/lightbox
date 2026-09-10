import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import crypto from "node:crypto";
import { createProjectServer, upstreamHeaders } from "../src/proxy.mjs";
import { loopbackOpen, portOpen } from "../src/supervisor.mjs";
import { Progress } from "../src/progress.mjs";
import { Shots } from "../src/shots.mjs";

// A 1x1 JPEG, the smallest thing the capture path will actually accept.
const PIXEL =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsL" +
  "DBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAAB" +
  "AAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** A static project server on an ephemeral port, plus the pieces it was given. */
function serveStaticFixture(files, extra = {}) {
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
    ...extra,
  };
  const server = createProjectServer(ctx);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        port,
        progress,
        project,
        dir,
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

test("the upstream's first WebSocket bytes go to the browser, never back upstream", async () => {
  // Reproduces WS_ERR_EXPECTED_MASK: the dev server sends an unmasked frame
  // together with its 101, and the proxy used to unshift it onto the browser
  // socket's readable side, so socket.pipe(usocket) echoed it to the server.
  const received = [];
  const up = http.createServer((req, res) => res.end("http"));
  up.on("upgrade", (req, sock) => {
    const key = req.headers["sec-websocket-key"];
    const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    // 101 and a one-byte unmasked text frame "s" in the same write.
    sock.write(Buffer.concat([
      Buffer.from("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`),
      Buffer.from([0x81, 0x01, 0x73]),
    ]));
    sock.on("data", (d) => received.push(...d));
    sock.on("end", () => sock.destroy());
  });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const upstream = up.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lightbox-ws-"));
  const project = { key: "ws", name: "WS", dir, kind: "node", port: 0, upstream };
  const ctx = {
    project,
    progress: new Progress(path.join(dir, ".lightbox", "progress.json")),
    supervisor: { state: () => ({ state: "ready", host: "127.0.0.1" }), tail: () => "", start: async () => {} },
    hubUrl: "http://localhost:4000/",
    bridge: "http://127.0.0.1:1",
    overlayPath: path.join(HERE, "..", "src", "overlay.js"),
    inspectCommentPath: null,
  };
  const server = createProjectServer(ctx);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  project.port = server.address().port;
  try {
    const got = await new Promise((resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1",
        port: project.port,
        path: "/_next/hmr",
        headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" },
      });
      req.on("upgrade", (res, sock, h) => {
        const chunks = [h];
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          resolve({ status: res.statusCode, bytes: Buffer.concat(chunks) });
          setTimeout(() => sock.destroy(), 150);
        };
        sock.on("data", (d) => { chunks.push(d); if (Buffer.concat(chunks).length >= 3) done(); });
        if (h.length >= 3) done();
        setTimeout(done, 500);
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(got.status, 101);
    assert.deepEqual([...got.bytes.subarray(0, 3)], [0x81, 0x01, 0x73], "the frame reached the browser");
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(received, [], "nothing was echoed back to the dev server");
  } finally {
    server.closeAllConnections?.();
    up.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    await new Promise((r) => up.close(r));
  }
});

test("a forwarded review is stamped, says where to see it again, and marks the route", async () => {
  // A stub bridge, because the real one is a separate process on 7391 and this
  // test is about what leaves lightbox, not about what the MCP server does with
  // it. Whatever body arrives here is what a coding agent eventually reads.
  const seen = { bodies: [], archived: [] };
  const bridge = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      seen.bodies.push(b);
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => bridge.listen(0, "127.0.0.1", r));

  const { port, progress, project, close } = await serveStaticFixture(
    { "index.html": PAGE },
    {
      bridge: `http://127.0.0.1:${bridge.address().port}`,
      onReview: (p, payload) => seen.archived.push(payload.markdown),
    }
  );
  try {
    const res = await fetch(`http://127.0.0.1:${port}/__lb/bridge/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        page: "http://localhost:4008/career?tab=1",
        markdown: "# Review: /career\n\n- Selector: `a.cta`\n\n**Comment:** width doesnt match\n",
      }),
    });
    assert.equal(res.status, 200);

    const forwarded = JSON.parse(seen.bodies[0]);
    assert.equal(forwarded.project, project.key);
    assert.match(forwarded.markdown, /^# Review: Fixture \(fixture-/m);
    assert.match(forwarded.markdown, /^- Review port: http:\/\/localhost:0\/$/m);

    // The archive is the uncapped record, so it must carry everything the
    // bridge got. It used to run before the header was rewritten.
    assert.equal(seen.archived.length, 1);
    assert.equal(seen.archived[0], forwarded.markdown, "the archive sees the finished markdown");

    // Submitting a review for a route is the evidence the route was reviewed.
    // The query string is dropped; Progress keys on pathname, as the manual
    // Alt+M path in overlay.js already does.
    assert.deepEqual(progress.get(project.key), ["/career"]);
  } finally {
    await close();
    await new Promise((r) => bridge.close(r));
  }
});

test("a captured frame is written locally and reaches the review as a path, never as bytes", async () => {
  const sent = [];
  const bridge = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      sent.push(b);
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => bridge.listen(0, "127.0.0.1", r));

  const archived = [];
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "lightbox-shotdir-"));
  const shots = new Shots(store);
  const { port, project, close } = await serveStaticFixture(
    { "index.html": PAGE },
    {
      shots,
      bridge: `http://127.0.0.1:${bridge.address().port}`,
      onReview: (p, payload) => archived.push(payload.markdown),
    }
  );
  try {
    const shot = await fetch(`http://127.0.0.1:${port}/__lb/shot`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        selector: "a.cta",
        page: "/career",
        rect: { x: 12, y: 340, width: 128, height: 44 },
        viewport: { width: 1536, height: 838 },
        frame: "f1",
        dataUrl: PIXEL,
      }),
    });
    const saved = await shot.json();
    assert.ok(saved.file, "the proxy answers with where it put the frame");
    assert.ok(fs.existsSync(saved.file), "and the frame is on disk before the review is submitted");

    const res = await fetch(`http://127.0.0.1:${port}/__lb/bridge/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        page: "http://localhost:4008/career",
        markdown:
          "# Review: /career\n\n## 1. Nav > Cta\n- Selector: `a.cta`\n\n**Comment:** width doesnt match\n",
      }),
    });
    assert.equal(res.status, 200);

    assert.equal(archived.length, 1);
    assert.ok(
      archived[0].includes(`- Shot: ${saved.file} · element at 12,340 128x44 · viewport 1536x838`),
      "the uncapped archive carries the path:\n" + archived[0]
    );
    assert.equal(sent.length, 1);
    assert.equal(
      sent[0].includes("data:image"),
      false,
      "no image bytes go to the bridge: it caps bodies at 4 MB and deletes shot files when it evicts a review"
    );
    assert.ok(JSON.parse(sent[0]).markdown.includes(saved.file), "but the path does");

    assert.deepEqual(shots.take(project.key), [], "and the frame is not re-attached to the next review");
  } finally {
    await close();
    await new Promise((r) => bridge.close(r));
  }
});

test("a review whose page is not a URL still forwards", async () => {
  const bridge = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => res.end('{"ok":true}'));
  });
  await new Promise((r) => bridge.listen(0, "127.0.0.1", r));

  const { port, progress, project, close } = await serveStaticFixture(
    { "index.html": PAGE },
    { bridge: `http://127.0.0.1:${bridge.address().port}`, onReview: () => {} }
  );
  try {
    const res = await fetch(`http://127.0.0.1:${port}/__lb/bridge/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ page: "not a url", markdown: "# Review: /\n" }),
    });
    assert.equal(res.status, 200, "an unparseable page is not worth failing the review over");
    assert.deepEqual(progress.get(project.key), [], "and nothing is marked on a guess");
  } finally {
    await close();
    await new Promise((r) => bridge.close(r));
  }
});
