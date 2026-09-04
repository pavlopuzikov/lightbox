/**
 * The hub itself: one page listing every project, what state it is
 * in, how many of its pages you have been through, and a way into each.
 *
 * The hub owns no processes. It asks the supervisor to start and stop things
 * and reports what it is told, so a browser tab that dies mid-review does not
 * take a dev server with it.
 *
 * Visually it is a light table: a bright ground, hairlines, one serif for
 * names, one monospace for paths and ports, and text where a dashboard would
 * put buttons and badges. The list is dense on purpose; forty projects should
 * fit on two screens.
 */

import fs from "node:fs";
import http from "node:http";
import { summarise } from "./handover.mjs";
import { familiesOf, routesFor } from "./routes.mjs";

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

const CSS = `
:root{--ground:#f7f6f2;--panel:#fcfcfa;--ink:#17171a;--ink-2:#4b4a47;--muted:#7d7b75;
--hair:#dedad1;--hair-2:#ebe8e1;--teal:#1f6e7a;--fail:#a23f3f;
--serif:"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",Georgia,serif;
--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Helvetica,Arial,sans-serif;
--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace}
*{box-sizing:border-box}
html{background:var(--ground)}
body{margin:0;color:var(--ink);font:14px/1.5 var(--sans);-webkit-font-smoothing:antialiased}
a{color:var(--teal);text-decoration:none}
a:hover{text-decoration:underline;text-underline-offset:2px}
:focus-visible{outline:2px solid var(--teal);outline-offset:2px}
.wrap{max-width:1160px;margin:0 auto;padding:0 40px 96px}
header{display:flex;align-items:baseline;gap:28px;flex-wrap:wrap;padding:44px 0 22px;
border-bottom:1px solid var(--ink)}
h1{font:400 38px/1 var(--serif);letter-spacing:-.01em;margin:0}
.stat{color:var(--ink-2);font-size:13.5px}
.stat b{font-weight:500;color:var(--ink);font-variant-numeric:tabular-nums}
.stat .off{color:var(--fail)}
.spacer{flex:1}
button.text{appearance:none;border:0;background:none;padding:0;font:inherit;color:var(--teal);cursor:pointer}
button.text:hover{text-decoration:underline;text-underline-offset:2px}
button.text:disabled{color:var(--muted);cursor:default;text-decoration:none}
button.text.quiet{color:var(--muted)}
button.text.quiet:hover{color:var(--ink)}
section{margin-top:54px}
section h2{font:400 24px/1.2 var(--serif);margin:0 0 4px}
section .blurb{margin:0 0 14px;color:var(--muted);font-size:13px;max-width:64ch}
.list{border-top:1px solid var(--hair)}
.row{display:grid;grid-template-columns:14px minmax(180px,1.3fr) minmax(0,2fr) 128px 140px 150px;
gap:0 18px;align-items:start;padding:14px 0 13px;border-bottom:1px solid var(--hair);position:relative}
.row.missing .name,.row.missing .note{color:var(--muted)}
.mark{width:8px;height:8px;margin-top:8px;border:1px solid var(--muted);background:transparent}
.mark.static{visibility:hidden}
.mark.ready{background:var(--teal);border-color:var(--teal)}
.mark.starting,.mark.installing{border-color:var(--teal);
background:linear-gradient(var(--teal),var(--teal)) 0 0/50% 100% no-repeat}
.mark.failed{border-color:var(--fail);background:var(--fail)}
.name{font:400 17px/1.25 var(--serif);color:var(--ink);margin:0}
.sys{color:var(--muted);font-size:12px;margin-top:3px}
.note{margin:2px 0 0;color:var(--ink-2);font-size:13px;line-height:1.45}
.hand{margin:4px 0 0;font:11.5px/1.7 var(--mono);color:var(--muted)}.hand:empty{display:none}
.acts button.text.ok{color:var(--muted);cursor:default}
.err{margin:6px 0 0;color:var(--fail);font-size:12.5px;white-space:pre-wrap}
.err:empty{display:none}
.num{font:12.5px/1.6 var(--mono);color:var(--ink-2);font-variant-numeric:tabular-nums;margin-top:3px}
.num b{font-weight:600;color:var(--ink)}
.num .m{color:var(--muted)}
.acts{display:flex;flex-direction:column;align-items:flex-start;gap:4px;margin-top:2px;font-size:13px}
.acts .open{font-weight:500}
.acts .open:after{content:" →"}
.prog{position:absolute;left:32px;right:0;bottom:-1px;height:2px}
.prog i{display:block;height:100%;background:var(--teal)}
.more{grid-column:2 / -1;display:none;padding:10px 0 4px}
.row.open-pages .more.pages,.row.open-log .more.log{display:block}
.routes{margin:0;padding:0;list-style:none;columns:2;column-gap:32px;font:12.5px/1.9 var(--mono)}
.routes li{break-inside:avoid;display:flex;gap:10px;align-items:center}
.routes .d{width:6px;height:6px;border:1px solid var(--muted);flex:none}
.routes .d.on{background:var(--teal);border-color:var(--teal)}
.routes a{color:var(--ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.routes a:hover{color:var(--teal)}
.routes .dyn{color:var(--muted);font-size:11px;margin-left:auto;flex:none}
.routes .fam{color:var(--muted);font:11px/1.8 var(--mono);margin-top:8px;break-after:avoid}
pre{margin:0;padding:10px 12px;background:var(--panel);border:1px solid var(--hair);
font:11.5px/1.5 var(--mono);color:var(--ink-2);max-height:260px;overflow:auto;white-space:pre-wrap}
@media (max-width:900px){
.wrap{padding:0 20px 64px}
.row{grid-template-columns:14px 1fr 1fr;gap:6px 14px}
.row .note{grid-column:2 / -1}.row .num{grid-column:2}
.row .acts{grid-column:3;flex-direction:row;flex-wrap:wrap;gap:4px 14px}
.routes{columns:1}}
@media (prefers-reduced-motion:no-preference){a,button.text{transition:color .12s ease}}
`;

const STATE_LABEL = {
  ready: "running",
  starting: "starting",
  installing: "installing",
  failed: "failed",
  stopping: "stopping",
  stopped: "",
};

/** One muted line under the notes: the audit branch, its sweep, what waits on a decision. */
function handLine(h) {
  if (!h) return "";
  return [h.note, ...summarise(h)].filter(Boolean).join(" · ");
}

function row(p, st, routes, done, hand) {
  const missing = !p.exists;
  const key = esc(p.key);
  const pct = routes.length ? Math.round((done / routes.length) * 100) : 0;
  const node = p.kind === "node";
  const needsInstall = node && !p.hasModules && p.exists;
  const running = node && (st.state === "ready" || st.state === "starting");
  const runner = node ? (p.command ? "command" : p.runner || "npm") : "static";
  const fams = familiesOf(routes);

  return `<div class="row${missing ? " missing" : ""}" data-key="${key}">
  <span class="mark ${node ? esc(st.state) : "static"}" data-mark="${key}"></span>
  <div>
    <h3 class="name">${esc(p.name)}</h3>
    <div class="sys">${esc(p.system || "no named system")} · ${esc(runner)}</div>
  </div>
  <div>
    ${p.note ? `<p class="note">${esc(p.note)}</p>` : ""}
    ${missing ? `<p class="err">Directory not found: ${esc(p.dir)}</p>` : ""}
    <p class="err" data-err="${key}">${esc(st.error || "")}</p>
    <p class="hand" data-hand="${key}">${esc(handLine(hand))}</p>
  </div>
  <div class="num"><b data-done="${key}">${done}</b> <span class="m">of</span> ${routes.length} <span class="m">pages</span>${
    fams.length > 1 ? `<br>${fams.length} <span class="m">families</span>` : ""
  }</div>
  <div class="num"><span class="m">:</span>${p.port}${
    node
      ? `<br><span class="m">dev :</span>${p.upstream} <span class="m" data-state="${key}">${esc(
          STATE_LABEL[st.state] || ""
        )}</span>`
      : ""
  }</div>
  <div class="acts">
    ${missing ? "" : `<a class="open" href="/go/${key}">Open</a>`}
    ${
      node
        ? `<button class="text quiet" data-act="install" data-key="${key}"${
            needsInstall ? "" : " hidden"
          }>npm install</button>
    <button class="text quiet" data-act="stop" data-key="${key}"${running ? "" : " hidden"}>stop</button>`
        : ""
    }
    <button class="text quiet" data-toggle="pages">${routes.length} pages</button>
    ${node ? `<button class="text quiet" data-toggle="log">log</button>` : ""}
    <button class="text${hand?.approved ? " ok" : ""}" data-act="approve" data-key="${key}"${hand ? "" : " hidden"}${
      hand?.approved ? " disabled" : ""
    }>${hand?.approved ? "Approved " + esc(String(hand.approvedAt).slice(0, 10)) : "Approve"}</button>
  </div>
  <span class="prog"><i style="width:${pct}%" data-prog="${key}"></i></span>
  <div class="more pages"><ul class="routes">${fams
    .map(
      (f) =>
        (fams.length > 1 && f.count > 1 ? `<li class="fam">${esc(f.family)} · ${f.count}</li>` : "") +
        routes
          .slice(f.first, f.first + f.count)
          .map(
            (r) =>
              `<li><span class="d${r.reviewed ? " on" : ""}"></span><a href="http://localhost:${
                p.port
              }${esc(r.path)}" target="_blank" rel="noreferrer"${
                r.file ? ` title="${esc(r.file)}"` : ""
              }>${esc(r.path)}</a>${r.dynamic ? '<span class="dyn">dynamic</span>' : ""}</li>`
          )
          .join("")
    )
    .join("")}</ul></div>
  ${node ? `<div class="more log"><pre data-log="${key}">(nothing yet)</pre></div>` : ""}
</div>`;
}

function page(ctx) {
  const { catalogue, supervisor, progress, handover } = ctx;
  const sections = catalogue.groups
    .map((g) => {
      const items = catalogue.projects.filter((p) => p.group === g.id);
      if (!items.length) return "";
      const rows = items
        .map((p) => {
          const routes = routesFor(p).map((r) => ({
            ...r,
            reviewed: progress.get(p.key).includes(r.path),
          }));
          return row(p, supervisor.state(p), routes, progress.countFor(p.key), handover.get(p.key));
        })
        .join("");
      return `<section><h2>${esc(g.title)}</h2>${
        g.blurb ? `<p class="blurb">${esc(g.blurb)}</p>` : ""
      }<div class="list">${rows}</div></section>`;
    })
    .join("");

  const totalPages = catalogue.projects.reduce((n, p) => n + routesFor(p).length, 0);
  const totalDone = catalogue.projects.reduce((n, p) => n + progress.countFor(p.key), 0);

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>lightbox</title><link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>${CSS}</style></head><body><div class="wrap">
<header>
  <h1>lightbox</h1>
  <span class="stat"><b>${catalogue.projects.length}</b> projects · <b>${totalPages}</b> pages · <b id="done">${totalDone}</b> reviewed</span>
  <span class="stat">inspect-comment ${
    ctx.inspectCommentPath ? "loaded" : '<span class="off">missing</span>'
  } · <span id="bridge">bridge ?</span></span>
  <span class="spacer"></span>
  <button class="text quiet" id="stopall">Stop all dev servers</button>
</header>
<main>${sections}</main>
</div>
<script>
var LABEL=${JSON.stringify(STATE_LABEL)};
async function act(key, what){
  await fetch('/api/'+what+'/'+key,{method:'POST'});
  refresh();
}
document.addEventListener('click',function(e){
  var t=e.target.closest('button[data-toggle]');
  if(t){t.closest('.row').classList.toggle('open-'+t.dataset.toggle);return}
  var b=e.target.closest('button[data-act]');
  if(!b)return;
  b.disabled=true;b.textContent=b.dataset.act==='install'?'installing…':b.dataset.act==='approve'?'approving…':b.dataset.act+'ping…';
  act(b.dataset.key,b.dataset.act);
});
document.getElementById('stopall').addEventListener('click',function(){
  fetch('/api/stopall',{method:'POST'}).then(refresh);
});
function q(sel){return document.querySelector(sel)}
async function refresh(){
  try{
    var s=await (await fetch('/api/state')).json();
    q('#done').textContent=s.totalDone;
    var br=q('#bridge');
    br.textContent=s.bridge?('bridge up · '+s.reviews+' review'+(s.reviews===1?'':'s')):'bridge down';
    br.className=s.bridge?'':'off';
    for(var k in s.projects){
      var st=s.projects[k];
      var row=q('.row[data-key="'+k+'"]');
      if(!row)continue;
      var mark=q('[data-mark="'+k+'"]');
      if(mark&&!mark.classList.contains('static'))mark.className='mark '+st.state;
      var lab=q('[data-state="'+k+'"]');
      if(lab)lab.textContent=LABEL[st.state]||'';
      var err=q('[data-err="'+k+'"]');
      if(err)err.textContent=st.error||'';
      var done=q('[data-done="'+k+'"]');
      if(done)done.textContent=st.done;
      var log=q('pre[data-log="'+k+'"]');
      if(log&&st.log)log.textContent=st.log;
      var running=st.state==='ready'||st.state==='starting';
      var stop=row.querySelector('button[data-act="stop"]');
      if(stop){stop.hidden=!running;if(!running){stop.disabled=false;stop.textContent='stop'}}
      var inst=row.querySelector('button[data-act="install"]');
      if(inst&&st.hasModules){inst.hidden=true}
      var hp=q('[data-hand="'+k+'"]');
      if(hp&&typeof st.handoverLine==='string')hp.textContent=st.handoverLine;
      var ap=row.querySelector('button[data-act="approve"]');
      if(ap){var h=st.handover;ap.hidden=!h;if(h){ap.disabled=!!h.approved;ap.classList.toggle('ok',!!h.approved);ap.textContent=h.approved?'Approved '+String(h.approvedAt).slice(0,10):'Approve'}}
    }
  }catch(e){}
}
setInterval(refresh,2500);refresh();
</script></body></html>`;
}

/** The page you land on while a dev server boots. */
function waitPage(p, hubUrl) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Starting ${esc(p.name)}</title><link rel="icon" href="${esc(hubUrl)}favicon.svg" type="image/svg+xml">
<style>${CSS}
main.wait{max-width:640px;margin:0 auto;padding:96px 40px}
.wait h1{font-size:34px;margin-bottom:12px}
.wait .prog{position:static;display:block;background:var(--hair);margin:22px 0 14px}
.wait .acts{flex-direction:row;gap:22px;margin:0 0 22px}
</style></head><body><main class="wait">
<h1>${esc(p.name)}</h1>
<p class="note">Starting its dev server on :${p.upstream}. First boot compiles the whole app, so a minute is normal.</p>
<span class="prog"><i style="width:8%" id="b"></i></span>
<p class="err" id="err"></p>
<div class="acts">
  <a href="${esc(hubUrl)}">Back to lightbox</a>
  <a href="http://localhost:${p.port}/" id="anyway">Open anyway</a>
</div>
<pre id="log">(waiting for output)</pre>
</main><script>
var w=8;
function poll(){
  fetch('/api/state/${esc(p.key)}').then(function(r){return r.json()}).then(function(s){
    document.getElementById('log').textContent=s.log||'(waiting for output)';
    w=Math.min(94,w+4);document.getElementById('b').style.width=w+'%';
    if(s.state==='ready'){location.href='http://localhost:${p.port}/';return}
    if(s.state==='failed'){document.getElementById('err').textContent=s.error||'Failed to start.';return}
    setTimeout(poll,1200);
  }).catch(function(){setTimeout(poll,2000)});
}
poll();
</script></body></html>`;
}

/* A paper square with a teal one on the light table. */
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<rect width="32" height="32" fill="#f7f6f2"/><rect x="6" y="6" width="20" height="20" fill="none" stroke="#17171a" stroke-width="1.5"/>
<rect x="12" y="12" width="8" height="8" fill="#1f6e7a"/></svg>`;

/* ------------------------------------------------------------------ *
 * Server
 * ------------------------------------------------------------------ */

function bridgeStatus(bridge) {
  const target = new URL("/health", bridge);
  return new Promise((resolve) => {
    const r = http.request(
      { host: target.hostname, port: target.port, path: target.pathname, timeout: 700 },
      (up) => {
        let out = "";
        up.on("data", (c) => (out += c));
        up.on("end", () => {
          try {
            resolve(JSON.parse(out));
          } catch {
            resolve(null);
          }
        });
      }
    );
    r.on("timeout", () => {
      r.destroy();
      resolve(null);
    });
    r.on("error", () => resolve(null));
    r.end();
  });
}

export function createHubServer(ctx) {
  const { catalogue, supervisor, progress, handover } = ctx;
  const byKey = new Map(catalogue.projects.map((p) => [p.key, p]));

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;

    const send = (code, type, body) => {
      res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };

    if (p === "/" || p === "/index.html") {
      return send(200, "text/html; charset=utf-8", page(ctx));
    }

    if (p === "/favicon.svg" || p === "/favicon.ico") {
      return send(200, "image/svg+xml", FAVICON);
    }

    if (p.startsWith("/go/")) {
      const project = byKey.get(p.slice(4));
      if (!project) return send(404, "text/plain", "no such project");
      if (project.kind === "static") {
        res.writeHead(302, { location: `http://localhost:${project.port}/` });
        return res.end();
      }
      const st = supervisor.state(project);
      if (st.state === "ready") {
        res.writeHead(302, { location: `http://localhost:${project.port}/` });
        return res.end();
      }
      supervisor.start(project).catch(() => {});
      return send(200, "text/html; charset=utf-8", waitPage(project, ctx.hubUrl));
    }

    if (p === "/api/state") {
      const projects = {};
      for (const project of catalogue.projects) {
        projects[project.key] = {
          ...supervisor.state(project),
          log: project.kind === "node" ? supervisor.tail(project.key, 40) : "",
          done: progress.countFor(project.key),
          hasModules: project.kind !== "node" || !!project.hasModules,
          handover: handover.get(project.key),
          handoverLine: handLine(handover.get(project.key)),
        };
      }
      const health = await bridgeStatus(ctx.bridge);
      return send(
        200,
        "application/json",
        JSON.stringify({
          projects,
          bridge: !!health,
          reviews: health ? health.reviews : 0,
          totalDone: catalogue.projects.reduce((n, x) => n + progress.countFor(x.key), 0),
        })
      );
    }

    if (p === "/api/handover") {
      return send(200, "application/json", JSON.stringify(handover.all()));
    }

    if (p.startsWith("/api/state/")) {
      const project = byKey.get(p.slice("/api/state/".length));
      if (!project) return send(404, "application/json", '{"error":"no such project"}');
      return send(
        200,
        "application/json",
        JSON.stringify({ ...supervisor.state(project), log: supervisor.tail(project.key, 60) })
      );
    }

    if (req.method === "POST") {
      const m = /^\/api\/(start|stop|install|stopall|approve|unapprove)(?:\/(.+))?$/.exec(p);
      if (m) {
        const [, action, key] = m;
        if (action === "stopall") {
          await supervisor.stopAll(catalogue.projects);
          return send(200, "application/json", '{"ok":true}');
        }
        const project = byKey.get(key);
        if (!project) return send(404, "application/json", '{"error":"no such project"}');
        if (action === "approve" || action === "unapprove") {
          // The only signal the push step reads. Flushed at once, not on the
          // timer, so a coding session polling the file sees it immediately.
          const entry = action === "approve" ? handover.approve(project.key) : handover.unapprove(project.key);
          handover.flush();
          return send(200, "application/json", JSON.stringify(entry));
        }
        if (action === "start") supervisor.start(project).catch(() => {});
        if (action === "stop") await supervisor.stop(project).catch(() => {});
        if (action === "install")
          supervisor
            .install(project)
            .then((ok) => {
              if (ok) project.hasModules = fs.existsSync(project.dir + "/node_modules");
            })
            .catch(() => {});
        return send(202, "application/json", '{"ok":true}');
      }
    }

    send(404, "text/plain", "not found");
  });
}
