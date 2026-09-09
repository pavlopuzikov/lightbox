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
import { TOKENS, rootCss } from "./design.mjs";

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
 * The overlay goes at the end of <head>, not before </body>.
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
    // The overlay draws itself in a shadow root under `all: initial`, which
    // inherits nothing from this page or from lightbox. Sending the design
    // tokens down with the config is what lets one stylesheet on disk decide
    // how both surfaces look, instead of the palette being typed out a second
    // time in overlay.js and drifting the first time a colour changes.
    tokens: TOKENS,
  };
  return (
    `<script data-lightbox-config>window.__LIGHTBOX=${JSON.stringify(cfg).replace(
      /</g,
      "\\u003c"
    )}</script>` + `<script src="/__lb/overlay.js" defer data-lightbox></script>`
  );
}

function injectHtml(html, ctx, req) {
  // A sweep (scripts/sweep.mjs) measures the page, not the walker, and asks
  // for the document exactly as the project serves it.
  if (req && req.headers["x-lightbox-bare"]) return html;
  if (html.includes("data-lightbox-config")) return html;
  const tag = injectionFor(ctx);
  // At the end of <head>, not the start: the App Router hydrates <head> too,
  // and a foreign node placed ahead of React's own children shifts every one
  // of them, which surfaces as an attribute mismatch on the first (seen on
  // pavlopuzikov.com, 2026-09-05). Trailing nodes are absorbed.
  const headClose = html.search(/<[/]head>/i);
  if (headClose !== -1) return html.slice(0, headClose) + tag + html.slice(headClose);
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
      return `<li><a href="${esc(href)}"><span class="k">${esc(kind)}</span><span class="n">${esc(
        e.name
      )}</span></a></li>`;
    })
    .join("");
  return SHELL(
    `${project.name} ${urlPath}`,
    `${masthead(`index of ${urlPath}`, project.name)}
<div class="cols"><span>Kind</span><span>Name</span></div>
<ul class="idx">${rows}</ul>`
  );
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
    res.end(injectHtml(notFoundPage(project, rel, ctx), ctx, req));
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
    const body = injectHtml(autoIndex(full, rel, project), ctx, req);
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
    const body = injectHtml(html, ctx, req);
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

/**
 * The headers a request is forwarded upstream with. Next 16's dev server
 * refuses its own /_next/* resources and the HMR socket when the Origin or
 * Referer names a host it does not allow, and "127.0.0.1" is not "localhost"
 * to it: the page renders but never hydrates, and hot reload never connects.
 * The upstream is always a local dev server, so every request is rewritten
 * to look as if the browser were at localhost:<upstream>, whatever hostname
 * the review port was opened on. Host follows, so a server action's
 * origin-against-host check still agrees.
 */
export function upstreamHeaders(reqHeaders, project) {
  const headers = { ...reqHeaders, host: `localhost:${project.upstream}` };
  const self = new RegExp(`^https?://[^/]+:${project.port}(?=/|$)`, "i");
  for (const name of ["origin", "referer"]) {
    const v = headers[name];
    if (typeof v === "string") headers[name] = v.replace(self, `http://localhost:${project.upstream}`);
  }
  return headers;
}

/**
 * The loopback the dev server actually answers on. The supervisor records it
 * when the server comes up or is adopted; Vite binds only ::1 on Node 17+.
 */
function upstreamHost(ctx) {
  return ctx.supervisor?.state?.(ctx.project)?.host || "127.0.0.1";
}

function proxyUpstream(req, res, ctx) {
  const project = ctx.project;
  const headers = upstreamHeaders(req.headers, project);
  delete headers["accept-encoding"];

  const up = http.request(
    { host: upstreamHost(ctx), port: project.upstream, method: req.method, path: req.url, headers },
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
        const body = Buffer.from(injectHtml(Buffer.concat(chunks).toString("utf8"), ctx, req), "utf8");
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
    host: upstreamHost(ctx),
    port: project.upstream,
    path: req.url,
    method: "GET",
    headers: upstreamHeaders(req.headers, project),
  });

  up.on("upgrade", (ures, usocket, uhead) => {
    const lines = [`HTTP/1.1 ${ures.statusCode} ${ures.statusMessage}`];
    for (const [k, v] of Object.entries(ures.headers)) {
      if (Array.isArray(v)) for (const one of v) lines.push(`${k}: ${one}`);
      else lines.push(`${k}: ${v}`);
    }
    socket.write(lines.join("\r\n") + "\r\n\r\n");
    // Bytes that arrived with either 101 belong to the OTHER side. Pushing
    // uhead onto the browser socket's readable side (socket.unshift) piped the
    // dev server's own first, unmasked frame straight back at it, and ws
    // throws WS_ERR_EXPECTED_MASK on an unmasked frame from a client. Next
    // and Vite both treat that as an uncaught exception and die.
    if (uhead && uhead.length) socket.write(uhead);
    if (head && head.length) usocket.write(head);
    usocket.on("error", () => socket.destroy());
    socket.on("error", () => usocket.destroy());
    // Upgraded sockets allow half-open, so a pipe ending one side leaves the
    // other waiting forever and keeps the dev server's ws count climbing.
    usocket.on("close", () => socket.destroy());
    socket.on("close", () => usocket.destroy());
    usocket.pipe(socket);
    socket.pipe(usocket);
  });
  up.on("error", () => socket.destroy());
  up.end();
}

/* ------------------------------------------------------------------ *
 * Pages the proxy serves itself
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * The proxy's own pages
 *
 * Same broadside as the hub, cut down. These are the pages you land on when
 * something is wrong, so they carry the same stock and the same rules: a
 * reader who hits a 404 should still know whose chrome they are looking at.
 * DESIGN.md is the system; nothing below may name a colour.
 * ------------------------------------------------------------------ */

const PAGE_CSS =
  rootCss() +
  `
body{margin:0;background:var(--paper);color:var(--ink);
font:var(--t-lead)/var(--lh-body) var(--sans);-webkit-font-smoothing:antialiased}
main{max-width:680px;margin:0 auto;padding:76px var(--s-8) 72px}
.eyebrow{margin:0 0 var(--s-5);font:var(--t-micro)/var(--lh-solid) var(--mono);text-transform:uppercase;
letter-spacing:var(--track-micro);color:var(--ink-3)}
h1{margin:0;font:400 clamp(34px,6vw,54px)/0.94 var(--display);font-stretch:condensed;
text-transform:uppercase;letter-spacing:var(--track-display)}
.rule-heavy{height:var(--rule-heavy);background:var(--ink);margin:var(--s-5) 0 0}
.band{height:var(--ornament-height);margin:var(--s-4) 0 0;opacity:.55;
background-image:var(--ornament);background-repeat:repeat-x;background-position:left center}
p{margin:var(--s-7) 0 0;max-width:58ch;font-size:var(--t-lead);color:var(--ink-2)}
code{padding:var(--s-1) var(--s-2);background:var(--paper-tint);font:var(--t-body) var(--mono)}
.err{color:var(--vermilion)}
.err:empty{display:none}

/* A pressed key on paper is an impression, so the buttons carry a hard offset
   with no blur and lose it on the way down rather than dimming. */
.acts{display:flex;flex-wrap:wrap;gap:var(--s-5);margin:var(--s-7) 0 0}
button,a.btn{appearance:none;display:inline-block;cursor:pointer;text-decoration:none;
padding:var(--s-4) var(--s-5);background:var(--paper-2);color:var(--ink);border:2px solid var(--ink);
box-shadow:3px 3px 0 var(--ink);font:var(--t-row)/var(--lh-solid) var(--mono);text-transform:uppercase;
letter-spacing:var(--track-caps);
transition:transform var(--tap) var(--ease),box-shadow var(--tap) var(--ease)}
button:hover,a.btn:hover{background:var(--paper-tint)}
button:active,a.btn:active{transform:translate(3px,3px);box-shadow:0 0 0 var(--ink)}
button[disabled]{cursor:default;color:var(--ink-3);transform:translate(3px,3px);box-shadow:none}

/* Machine output, in the margin, the way the hub sets it. */
pre{margin:var(--s-8) 0 0;padding:var(--s-5) 0 var(--s-5) var(--s-5);border-left:var(--rule-mid) solid var(--rule-ink);
overflow:auto;max-height:44vh;white-space:pre-wrap;font:var(--t-row)/var(--lh-open) var(--mono);color:var(--ink-3)}

/* The directory listing is tabular matter, so it is ruled both ways. */
.cols{display:grid;grid-template-columns:74px 1fr;margin:var(--s-8) 0 0;padding:0 var(--s-2) var(--s-3);
font:var(--t-micro)/var(--lh-snug) var(--mono);text-transform:uppercase;letter-spacing:var(--track-micro);
color:var(--ink-3);border-bottom:var(--rule-hair) solid var(--rule-ink)}
.idx{list-style:none;margin:0;padding:0}
.idx li{border-bottom:var(--rule-hair) solid var(--rule-ink)}
.idx a{display:grid;grid-template-columns:74px 1fr;align-items:baseline;
padding:var(--s-4) var(--s-2);color:var(--ink);text-decoration:none}
.idx a:hover{background:var(--paper-tint)}
.idx .k{padding-right:var(--s-5);font:var(--t-micro)/var(--lh-open) var(--mono);text-transform:uppercase;
letter-spacing:var(--track-micro);color:var(--ink-3)}
.idx .n{padding-left:var(--s-5);border-left:var(--rule-hair) solid var(--rule-ink-2);font-size:var(--t-body)}
.idx .n b{font-weight:400}

a:focus-visible,button:focus-visible{outline:var(--rule-mid) solid var(--vermilion);
outline-offset:3px}
@media (prefers-reduced-motion:reduce){*{transition:none}}
`;

/* Every page opens the same way: who is speaking, then the title, then the
   rule that closes the block. Written once so the three cannot drift. */
const masthead = (eyebrow, title) =>
  `<p class="eyebrow">${esc(eyebrow)}</p><h1>${esc(title)}</h1>
<div class="rule-heavy"></div><div class="band"></div>`;

const SHELL = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>${PAGE_CSS}</style></head><body><main>${body}</main></body></html>`;

function notRunningPage(ctx) {
  const p = ctx.project;
  const st = ctx.supervisor.state(p);
  return SHELL(
    `${p.name} is not running`,
    `${masthead(`lightbox \u00b7 review :${p.port} \u00b7 dev :${p.upstream}`, p.name)}
<p>Nothing is answering on the dev server behind this port yet.</p>
<p class="err">${st.error ? esc(st.error) : ""}</p>
<div class="acts"><button id="start">Start it</button>
<a class="btn" href="${esc(ctx.hubUrl)}">Back to lightbox</a></div>
<pre id="log">${esc(ctx.supervisor.tail(p.key, 60) || "(no output yet)")}</pre>
<script>
var b=document.getElementById('start');
b.addEventListener('click',function(){
  b.disabled=true;b.textContent='Starting';
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

function notFoundPage(project, rel, ctx) {
  return SHELL(
    `404 ${rel}`,
    `${masthead(project.name, "404")}
<p>Nothing is served at <code>${esc(rel)}</code>.</p>
<div class="acts"><a class="btn" href="/">${esc(project.name)} index</a>
<a class="btn" href="${esc(ctx.hubUrl)}">Back to lightbox</a></div>`
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
