/**
 * One HTTP server per project, on that project's review port.
 *
 * For a node project it reverse-proxies the dev server; for a static project it
 * serves the directory. Either way every HTML response gets the same overlay
 * injected, which is the point: forty front ends built over three years, all
 * reviewed through one set of keys.
 *
 * Three things worth knowing about the implementation:
 *
 *  - accept-encoding is stripped from the upstream request. Injecting into a
 *    gzip stream means decompressing it first, and there is nothing to gain
 *    from compression over loopback.
 *  - only text/html is buffered. Everything else streams, so a 200 MB splat
 *    file does not land in memory on its way past.
 *  - the WebSocket upgrade is forwarded by hand. Without it every Next and Vite
 *    project loses hot reload and, worse, sits there looking merely slow.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { routesFor } from "./routes.mjs";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ply": "application/octet-stream",
  ".splat": "application/octet-stream",
  ".ksplat": "application/octet-stream",
  ".spz": "application/octet-stream",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".pdf": "application/pdf",
};

const mime = (p) => MIME[path.extname(p).toLowerCase()] || "application/octet-stream";
const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* ------------------------------------------------------------------ *
 * Injection
 * ------------------------------------------------------------------ */

/**
 * The overlay goes into <head>, not before </body>.
 *
 * React hydrates the whole document in the App Router, and an extra node at the
 * end of <body> is the one place that reliably produces a hydration mismatch.
 * React treats <head> as a place third parties write to, so a tag there is
 * absorbed without complaint. A module script is deferred anyway, so it still
 * runs after the DOM is parsed.
 */
function injectionFor(ctx) {
  const cfg = {
    key: ctx.project.key,
    name: ctx.project.name,
    hub: ctx.hubUrl,
    inspect: !!ctx.inspectCommentPath,
    routes: routesFor(ctx.project),
    reviewed: ctx.progress.get(ctx.project.key),
  };
  return (
    `<script data-lightbox-config>window.__LIGHTBOX=${JSON.stringify(cfg).replace(
      /</g,
      "\\u003c"
    )}</script>` + `<script src="/__lb/overlay.js" defer data-lightbox></script>`
  );
}

function injectHtml(html, ctx) {
  if (html.includes("data-lightbox-config")) return html;
  const tag = injectionFor(ctx);
  const head = html.search(/<head[^>]*>/i);
  if (head !== -1) {
    const end = html.indexOf(">", head) + 1;
    return html.slice(0, end) + tag + html.slice(end);
  }
  const html5 = html.search(/<html[^>]*>/i);
  if (html5 !== -1) {
    const end = html.indexOf(">", html5) + 1;
    return html.slice(0, end) + "<head>" + tag + "</head>" + html.slice(end);
  }
  return tag + html;
}

/* ------------------------------------------------------------------ *
 * Static serving
 * ------------------------------------------------------------------ */

function autoIndex(dirPath, urlPath, project) {
  let entries = [];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    /* handled by the empty listing below */
  }
  const rows = entries
    .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .map((e) => {
      const href = path.posix.join(urlPath, e.name) + (e.isDirectory() ? "/" : "");
      const kind = e.isDirectory() ? "dir" : path.extname(e.name).slice(1) || "file";
      return `<li><a href="${esc(href)}"><span class="k">${esc(kind)}</span>${esc(e.name)}</a></li>`;
    })
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(project.name)} ${esc(urlPath)}</title><style>
body{margin:0;background:#111114;color:#e9e8e4;font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
main{max-width:820px;margin:0 auto;padding:48px 24px}
h1{font-size:15px;font-weight:600;margin:0 0 4px}p{color:#8d8d97;margin:0 0 28px;font-size:12px}
ul{list-style:none;margin:0;padding:0;border-top:1px solid #26262b}
li{border-bottom:1px solid #26262b}
a{display:flex;gap:12px;padding:9px 4px;color:#cfe4f6;text-decoration:none}
a:hover{background:#1b1b21}.k{color:#7e7e88;width:56px;flex:none}
</style></head><body><main><h1>${esc(project.name)}</h1><p>${esc(urlPath)}</p><ul>${rows}</ul></main></body></html>`;
}

function serveStatic(req, res, ctx) {
  const project = ctx.project;
  const url = new URL(req.url, "http://localhost");
  let rel = decodeURIComponent(url.pathname);
  const full = path.join(project.dir, rel);

  // Never serve outside the configured root, whatever the URL claims.
  const rootReal = path.resolve(project.dir);
  if (!path.resolve(full).startsWith(rootReal)) {
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("outside the project root");
    return;
  }

  let stat;
  try {
    stat = fs.statSync(full);
  } catch {
    // /about is about.html on disk. The route list says /about, and so does
    // every static host these folders were built for.
    const clean = full + ".html";
    if (!path.extname(full) && fs.existsSync(clean)) return sendFile(req, res, clean, ctx);
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    res.end(injectHtml(notFoundPage(project, rel), ctx));
    return;
  }

  if (stat.isDirectory()) {
    const index = path.join(full, "index.html");
    if (fs.existsSync(index)) return sendFile(req, res, index, ctx);
    if (!rel.endsWith("/")) {
      res.writeHead(302, { location: rel + "/" });
      res.end();
      return;
    }
    const body = injectHtml(autoIndex(full, rel, project), ctx);
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
    return;
  }

  sendFile(req, res, full, ctx);
}

/**
 * Range matters more than it looks. Without 206 support any page with audio or
 * video loses seeking past the buffered end, and it fails silently: currentTime
 * snaps back and nothing throws. Suffix ranges are included because that is how
 * Chrome finds an mp4's moov atom.
 */
function sendFile(req, res, file, ctx) {
  const type = mime(file);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    res.writeHead(404);
    res.end();
    return;
  }

  if (type.startsWith("text/html")) {
    let html;
    try {
      html = fs.readFileSync(file, "utf8");
    } catch {
      res.writeHead(500);
      res.end();
      return;
    }
    const body = injectHtml(html, ctx);
    res.writeHead(200, {
      "content-type": type,
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
    });
    res.end(body);
    return;
  }

  const range = req.headers.range;
  const size = stat.size;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m) {
      let start;
      let end;
      if (m[1] === "") {
        const suffix = parseInt(m[2], 10);
        if (!Number.isFinite(suffix) || suffix <= 0) {
          res.writeHead(416, { "content-range": `bytes */${size}` });
          res.end();
          return;
        }
        start = Math.max(0, size - suffix);
        end = size - 1;
      } else {
        start = parseInt(m[1], 10);
        end = m[2] === "" ? size - 1 : parseInt(m[2], 10);
      }
      if (!(start >= 0 && end < size && start <= end)) {
        res.writeHead(416, { "content-range": `bytes */${size}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        "content-type": type,
        "content-range": `bytes ${start}-${end}/${size}`,
        "accept-ranges": "bytes",
        "content-length": end - start + 1,
      });
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
  }

  res.writeHead(200, {
    "content-type": type,
    "content-length": size,
    "accept-ranges": "bytes",
    "cache-control": "no-store",
  });
  fs.createReadStream(file).pipe(res);
}

/* ------------------------------------------------------------------ *
 * Upstream proxying
 * ------------------------------------------------------------------ */

function proxyUpstream(req, res, ctx) {
  const project = ctx.project;
  const headers = { ...req.headers, host: `127.0.0.1:${project.upstream}` };
  delete headers["accept-encoding"];

  const up = http.request(
    { host: "127.0.0.1", port: project.upstream, method: req.method, path: req.url, headers },
    (ur) => {
      const out = { ...ur.headers };

      // A dev server that redirects to its own absolute origin would walk you
      // off the review port and out from under the overlay.
      if (out.location) {
        out.location = String(out.location).replace(
          new RegExp(`http://(localhost|127\\.0\\.0\\.1):${project.upstream}`, "g"),
          ""
        );
      }

      const ct = String(ur.headers["content-type"] || "");
      if (!ct.includes("text/html")) {
        res.writeHead(ur.statusCode || 200, out);
        ur.pipe(res);
        return;
      }

      const chunks = [];
      ur.on("data", (c) => chunks.push(c));
      ur.on("end", () => {
        const body = Buffer.from(injectHtml(Buffer.concat(chunks).toString("utf8"), ctx), "utf8");
        delete out["content-length"];
        delete out["content-encoding"];
        delete out["transfer-encoding"];
        out["content-length"] = body.length;
        res.writeHead(ur.statusCode || 200, out);
        res.end(body);
      });
    }
  );

  up.on("error", () => {
    if (res.headersSent) return res.end();
    const body = notRunningPage(ctx);
    res.writeHead(503, {
      "content-type": "text/html; charset=utf-8",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
  });

  req.pipe(up);
}

function proxyUpgrade(req, socket, head, ctx) {
  const project = ctx.project;
  const up = http.request({
    host: "127.0.0.1",
    port: project.upstream,
    path: req.url,
    method: "GET",
    headers: { ...req.headers, host: `127.0.0.1:${project.upstream}` },
  });

  up.on("upgrade", (ures, usocket, uhead) => {
    const lines = [`HTTP/1.1 ${ures.statusCode} ${ures.statusMessage}`];
    for (const [k, v] of Object.entries(ures.headers)) {
      if (Array.isArray(v)) for (const one of v) lines.push(`${k}: ${one}`);
      else lines.push(`${k}: ${v}`);
    }
    socket.write(lines.join("\r\n") + "\r\n\r\n");
    if (uhead && uhead.length) socket.unshift(uhead);
    usocket.on("error", () => socket.destroy());
    socket.on("error", () => usocket.destroy());
    usocket.pipe(socket);
    socket.pipe(usocket);
  });
  up.on("error", () => socket.destroy());
  if (head && head.length) up.write(head);
  up.end();
}

/* ------------------------------------------------------------------ *
 * Pages the proxy serves itself
 * ------------------------------------------------------------------ */

const SHELL = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
body{margin:0;background:#111114;color:#e9e8e4;font:14px/1.65 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
display:grid;place-items:center;min-height:100vh}
main{max-width:560px;padding:32px}
h1{font-size:16px;margin:0 0 10px;font-weight:600}
p{color:#9a9aa3;margin:0 0 18px;font-size:12.5px}
pre{background:#1a1a1f;border:1px solid #2c2c33;border-radius:8px;padding:12px;overflow:auto;
font-size:11px;color:#b9b8b3;max-height:44vh;white-space:pre-wrap}
button,a.btn{display:inline-block;appearance:none;border:1px solid #33333c;background:#1d1d23;color:#e9e8e4;
border-radius:7px;padding:9px 14px;font:inherit;font-size:12px;cursor:pointer;text-decoration:none;margin-right:8px}
button:hover,a.btn:hover{background:#26262e}
.err{color:#e0a4a4}
</style></head><body><main>${body}</main></body></html>`;

function notRunningPage(ctx) {
  const p = ctx.project;
  const st = ctx.supervisor.state(p);
  return SHELL(
    `${p.name} is not running`,
    `<h1>${esc(p.name)}</h1>
<p>Nothing is answering on the dev server behind this port yet.</p>
${st.error ? `<p class="err">${esc(st.error)}</p>` : ""}
<p><button id="start">Start it</button><a class="btn" href="${esc(ctx.hubUrl)}">Back to lightbox</a></p>
<pre id="log">${esc(ctx.supervisor.tail(p.key, 60) || "(no output yet)")}</pre>
<script>
var b=document.getElementById('start');
b.addEventListener('click',function(){
  b.disabled=true;b.textContent='Starting…';
  fetch('/__lb/start',{method:'POST'}).then(function(){poll()});
});
function poll(){
  fetch('/__lb/state').then(function(r){return r.json()}).then(function(s){
    document.getElementById('log').textContent=s.log||'';
    if(s.state==='ready'){location.reload();return}
    if(s.state==='failed'){b.disabled=false;b.textContent='Try again';return}
    setTimeout(poll,1200);
  }).catch(function(){setTimeout(poll,2000)});
}
if(${st.state === "starting"}) poll();
</script>`
  );
}

function notFoundPage(project, rel) {
  return SHELL(
    "404",
    `<h1>404</h1><p>${esc(project.name)} has nothing at <code>${esc(rel)}</code>.</p>`
  );
}

/* ------------------------------------------------------------------ *
 * The server
 * ------------------------------------------------------------------ */

function readBody(req, limit = 6 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > limit) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

/**
 * Forward a finished review to the inspect-comment MCP server, tagged with the
 * project it came from. Forty sites all answer on "/", so a review that says
 * only "Review: /" is ambiguous the moment there is more than one of them.
 */
async function forwardReview(body, ctx) {
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return { status: 400, body: JSON.stringify({ error: "invalid JSON" }) };
  }
  const label = `${ctx.project.name} (${ctx.project.key})`;
  payload.project = ctx.project.key;
  payload.projectName = ctx.project.name;
  payload.projectDir = ctx.project.dir;
  if (typeof payload.markdown === "string") {
    payload.markdown = payload.markdown.replace(
      /^# Review: (.*)$/m,
      (m, page) => `# Review: ${label} ${page}\n- Project directory: \`${ctx.project.dir}\``
    );
  }
  ctx.onReview?.(ctx.project, payload);

  const target = new URL("/review", ctx.bridge);
  const data = Buffer.from(JSON.stringify(payload), "utf8");
  return new Promise((resolve) => {
    const r = http.request(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": data.length },
      },
      (up) => {
        let out = "";
        up.on("data", (c) => (out += c));
        up.on("end", () => resolve({ status: up.statusCode || 200, body: out }));
      }
    );
    r.on("error", (e) =>
      resolve({ status: 502, body: JSON.stringify({ error: "bridge unreachable: " + e.message }) })
    );
    r.end(data);
  });
}

function bridgeHealth(ctx) {
  const target = new URL("/health", ctx.bridge);
  return new Promise((resolve) => {
    const r = http.request(
      { host: target.hostname, port: target.port, path: target.pathname, method: "GET", timeout: 900 },
      (up) => {
        let out = "";
        up.on("data", (c) => (out += c));
        up.on("end", () => resolve({ status: up.statusCode || 200, body: out }));
      }
    );
    r.on("timeout", () => {
      r.destroy();
      resolve({ status: 503, body: '{"error":"bridge timeout"}' });
    });
    r.on("error", () => resolve({ status: 503, body: '{"error":"no bridge"}' }));
    r.end();
  });
}

export function createProjectServer(ctx) {
  const project = ctx.project;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;

    if (p.startsWith("/__lb/")) {
      // ---- the tool's own endpoints, never forwarded upstream ----
      if (p === "/__lb/overlay.js") {
        const src = fs.readFileSync(ctx.overlayPath);
        res.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          "content-length": src.length,
          "cache-control": "no-store",
        });
        return res.end(src);
      }
      if (p === "/__lb/inspect-comment.js") {
        if (!ctx.inspectCommentPath) {
          res.writeHead(404, { "content-type": "text/plain" });
          return res.end("inspect-comment is not installed");
        }
        const src = fs.readFileSync(ctx.inspectCommentPath);
        res.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          "content-length": src.length,
          "cache-control": "no-store",
        });
        return res.end(src);
      }
      if (p === "/__lb/bridge/health") {
        const r = await bridgeHealth(ctx);
        res.writeHead(r.status, { "content-type": "application/json" });
        return res.end(r.body);
      }
      if (p === "/__lb/bridge/review" && req.method === "POST") {
        try {
          const r = await forwardReview(await readBody(req), ctx);
          res.writeHead(r.status, { "content-type": "application/json" });
          return res.end(r.body);
        } catch (e) {
          res.writeHead(400, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: e.message }));
        }
      }
      if (p === "/__lb/progress" && req.method === "POST") {
        try {
          const { route, reviewed } = JSON.parse(await readBody(req, 8192));
          ctx.progress.set(project.key, route, reviewed);
        } catch {
          /* a malformed tick is not worth a 500 */
        }
        res.writeHead(204);
        return res.end();
      }
      if (p === "/__lb/start" && req.method === "POST") {
        ctx.supervisor.start(project).catch(() => {});
        res.writeHead(202, { "content-type": "application/json" });
        return res.end('{"ok":true}');
      }
      if (p === "/__lb/state") {
        const st = ctx.supervisor.state(project);
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ...st, log: ctx.supervisor.tail(project.key, 60) }));
      }
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("no such lightbox endpoint");
    }

    if (project.kind === "static") return serveStatic(req, res, ctx);
    return proxyUpstream(req, res, ctx);
  });

  if (project.kind !== "static") {
    server.on("upgrade", (req, socket, head) => proxyUpgrade(req, socket, head, ctx));
  }
  server.on("clientError", (err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  return server;
}
