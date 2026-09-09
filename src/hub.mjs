/**
 * The hub itself: one page listing every project, what state it is
 * in, how many of its pages you have been through, and a way into each.
 *
 * The hub owns no processes. It asks the supervisor to start and stop things
 * and reports what it is told, so a browser tab that dies mid-review does not
 * take a dev server with it.
 *
 * Visually it is a letterpress broadside: cream stock, two inks, condensed
 * wood type in the display sizes, and horizontal rules doing the work that
 * cards and badges would do elsewhere. Every value comes from src/design.css
 * through src/design.mjs. The list is dense on purpose; forty projects should
 * fit on two screens.
 */

import fs from "node:fs";
import http from "node:http";
import { summarise, STATUSES } from "./handover.mjs";
import { familiesOf, routesFor, clearRouteCache } from "./routes.mjs";
import { rootCss, token } from "./design.mjs";

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

const CSS = rootCss() + `
*{box-sizing:border-box}
html{background:var(--paper)}
body{margin:0;background:var(--paper);color:var(--ink);font:var(--t-lead)/var(--lh-body) var(--sans);
-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}

/* The one full-bleed element on the sheet: a red bar across the head of the
   page, the way a broadside carries its rule right off the trimmed edge. */
body::before{content:"";display:block;height:6px;background:var(--vermilion)}

a{color:var(--ink);text-decoration:underline;text-decoration-thickness:1px;
text-underline-offset:3px;text-decoration-color:var(--rule-ink)}
a:hover{color:var(--vermilion);text-decoration-color:var(--vermilion)}
:focus-visible{outline:2px solid var(--vermilion);outline-offset:2px}
.wrap{max-width:1180px;margin:0 auto;padding:0 var(--s-9) 0}

/* ---------------------------------------------------------------- *
 * Masthead
 *
 * Wood type on the left, the tally on the right, one heavy bar under both.
 * The tally is the largest thing on the page and the only red numeral, which
 * is deliberate: of everything the hub knows, how much of the work is done is
 * the number you came to read.
 * ---------------------------------------------------------------- */
header{display:grid;grid-template-columns:1fr auto;align-items:end;gap:var(--s-6) var(--s-9);padding:46px 0 var(--s-5)}
h1{margin:0;font:400 clamp(46px,7.5vw,78px)/.82 var(--display);font-stretch:condensed;
text-transform:uppercase;letter-spacing:var(--track-display);color:var(--ink)}
.tagline{margin:var(--s-4) 0 0;font:var(--t-body)/var(--lh-snug) var(--sans);color:var(--ink-3);max-width:44ch}
.tally{text-align:right;line-height:.78}
.tally-n{display:block;font:400 clamp(48px,8vw,84px)/.78 var(--slab);font-weight:700;
color:var(--vermilion);font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.tally-l{display:block;margin-top:var(--s-4);font:var(--t-micro)/var(--lh-solid) var(--mono);text-transform:uppercase;
letter-spacing:var(--track-micro);color:var(--ink-3)}

.rule-heavy{height:var(--rule-heavy);background:var(--ink)}

/* The colophon: everything the hub knows about itself, set the size a
   broadside sets its imprint. Diamonds separate the facts, so the line reads
   as one typeset run rather than a row of chips. */
.colophon{display:flex;align-items:center;flex-wrap:wrap;gap:0 var(--s-5);margin:0;padding:var(--s-5) 0 0;
font:var(--t-micro)/var(--lh-open) var(--mono);text-transform:uppercase;letter-spacing:var(--track-caps);color:var(--ink-3)}
.colophon b{font-weight:400;color:var(--ink);font-variant-numeric:tabular-nums}
.colophon .off{color:var(--vermilion)}
.colophon .spacer{flex:1 0 24px}
.dia{width:5px;height:5px;background:var(--vermilion);transform:rotate(45deg);flex:none}
.dia.ink{background:var(--rule-ink)}

/* The engraved band. One SVG, repeated, and the only ornament in the system:
   it closes the masthead and opens the list, and appears nowhere else. */
.band{height:var(--ornament-height);margin:var(--s-6) 0 0;
background:var(--ornament) repeat-x left center}

/* ---------------------------------------------------------------- *
 * Sections
 * ---------------------------------------------------------------- */
section{margin-top:var(--s-9)}
.head{display:flex;align-items:baseline;gap:var(--s-5);border-bottom:var(--rule-mid) solid var(--ink);padding-bottom:var(--s-3)}
section h2{margin:0;font:400 var(--t-head)/var(--lh-solid) var(--display);font-stretch:condensed;text-transform:uppercase;
letter-spacing:var(--track-caps);color:var(--ink)}
.count{font:var(--t-row)/var(--lh-solid) var(--mono);color:var(--vermilion);letter-spacing:var(--track-caps);
text-transform:uppercase;font-variant-numeric:tabular-nums}
section .blurb{margin:var(--s-4) 0 var(--s-1);color:var(--ink-3);font-size:var(--t-body);line-height:var(--lh-body);max-width:66ch}

/* ---------------------------------------------------------------- *
 * The list
 *
 * Rules, not cards. Forty projects have to fit in two screens, so every row
 * is one hairline apart from the next and nothing is boxed, padded or
 * shadowed. Density is the feature.
 * ---------------------------------------------------------------- */
.list{margin-top:var(--s-5)}

/* Tabular matter in a broadside is ruled both ways: heavy horizontals separate
   the entries, light verticals separate the fields. Without the verticals a row
   is five different kinds of fact set in one ink at one size, and you have to
   read it to find out where one ends and the next starts. The two weights are
   deliberately unequal, so the eye still reads the list as rows first. */
.cols,.row{display:grid;
grid-template-columns:16px minmax(150px,1fr) minmax(0,1.8fr) 104px 158px 224px;gap:0}
.cols>*,.row>.c-name,.row>.c-note,.row>.num,.row>.acts{padding-right:var(--s-6)}
.cols>.r,.row>.c-note,.row>.num,.row>.acts{
border-left:var(--rule-hair) solid var(--rule-ink-2);padding-left:var(--s-6)}

/* The ledger head, once per section. It is the cheapest possible way to say
   what the columns are: four words, set at the size a printed table sets its
   headings, and never repeated between rows. */
.cols{padding:0 var(--s-2) var(--s-3);font:var(--t-micro)/var(--lh-snug) var(--mono);text-transform:uppercase;
letter-spacing:var(--track-micro);color:var(--ink-3);border-bottom:var(--rule-hair) solid var(--rule-ink)}

.row{align-items:stretch;padding:var(--s-5) var(--s-2) var(--s-5);
border-bottom:var(--rule-hair) solid var(--rule-ink);position:relative}
.row:hover{background:var(--paper-tint)}
.row.missing .name,.row.missing .note{color:var(--ink-3)}

/* State is carried by the fill of one square, not by a palette. Hollow is
   stopped, half is working, solid is up, and red is the only failure. Adding
   a third ink for "healthy" would have spent the loudest thing in the system
   on the most ordinary state on the page. */
.mark{width:9px;height:9px;margin-top:var(--s-3);border:1.5px solid var(--ink-3);background:transparent}
.mark.static{visibility:hidden}
.mark.ready{background:var(--ink);border-color:var(--ink)}
.mark.starting,.mark.installing{border-color:var(--ink);
background:linear-gradient(var(--ink),var(--ink)) 0 0/100% 50% no-repeat}
.mark.failed{background:var(--vermilion);border-color:var(--vermilion)}

/* The name column is the only one that carries two registers, a title and a
   label, so it gets the extra breathing room the rules took away. */
.c-name{padding-top:var(--s-1)}
.name{margin:0;font:400 var(--t-lead)/var(--lh-tight) var(--display);font-stretch:condensed;text-transform:uppercase;
letter-spacing:.05em;color:var(--ink)}
.sys{margin-top:var(--s-2);font:var(--t-micro)/var(--lh-snug) var(--mono);text-transform:uppercase;
letter-spacing:var(--track-caps);color:var(--ink-3)}
.note{margin:var(--s-1) 0 0;color:var(--ink-2);font-size:var(--t-body);line-height:var(--lh-body)}
/* Machine output, marked as such. The note above it is something you wrote;
   this line is what the audit found, and a rule in the margin is how a proof
   distinguishes the two without spending a colour on it. */
.hand{margin:var(--s-3) 0 0;padding-left:var(--s-4);border-left:2px solid var(--rule-ink);
font:var(--t-micro)/var(--lh-open) var(--mono);color:var(--ink-3)}.hand:empty{display:none}
.err{margin:var(--s-3) 0 0;color:var(--vermilion);font-size:var(--t-body);line-height:var(--lh-body);white-space:pre-wrap}
.err:empty{display:none}
.adopted{margin:var(--s-3) 0 0;color:var(--ink-3);font-size:var(--t-body);line-height:var(--lh-body)}
.adopted:empty{display:none}
.num{margin-top:var(--s-1);font:var(--t-row)/var(--lh-open) var(--mono);color:var(--ink-3);font-variant-numeric:tabular-nums}
.num b{font-weight:600;color:var(--ink)}
.num .m{color:var(--ink-3)}

/* Actions ------------------------------------------------------- */
/* One run of small capitals, wrapping, the way the bottom line of a broadside
   sets its imprint. Stacked vertically these cost about 100px of row height
   each, and forty of those is the difference between two screens and five. */
.acts{display:flex;flex-wrap:wrap;align-items:baseline;gap:var(--s-2) var(--s-5);margin-top:var(--s-1)}
button.text{appearance:none;border:0;background:none;padding:0;cursor:pointer;
font:var(--t-micro)/var(--lh-body) var(--mono);text-transform:uppercase;letter-spacing:var(--track-caps);color:var(--ink-2)}
button.text:hover{color:var(--vermilion)}
button.text:disabled{color:var(--ink-3);cursor:default}
button.text.quiet{color:var(--ink-3)}
button.text.quiet:hover{color:var(--ink)}
.acts .open{flex:0 0 100%;font:400 var(--t-body)/var(--lh-snug) var(--display);font-stretch:condensed;
text-transform:uppercase;letter-spacing:.08em;color:var(--vermilion);text-decoration:none}
.acts .open:hover{color:var(--vermilion-2);text-decoration:underline;
text-decoration-thickness:1.5px;text-underline-offset:3px}
.acts .open:after{content:" \\2192"}
.acts button.text.ok{color:var(--ink-3);cursor:default}

/* Progress sits on the row's own hairline: the rule fills up rather than a
   bar being added next to it. */
/* The gauge sits in the column it measures. Floated at the bottom edge of the
   row it underlined the project name instead, which reads as a stray rule; and
   run the full width, a finished project drew a 2px black line the width of
   the sheet and cut the list in half in the wrong place. */
.prog{display:block;margin-top:var(--s-3);height:var(--rule-mid);background:var(--rule-ink);
overflow:hidden}
.prog i{display:block;height:100%;max-width:100%;background:var(--ink)}

.more{grid-column:2 / -1;display:none;padding:var(--s-5) 0 var(--s-2)}
.row.open-pages .more.pages,.row.open-log .more.log{display:block}
.routes{margin:0;padding:0;list-style:none;columns:2;column-gap:var(--s-8);font:var(--t-row)/var(--lh-open) var(--mono)}
.routes li{break-inside:avoid;display:flex;gap:var(--s-4);align-items:center}
.routes .d{width:6px;height:6px;border:1px solid var(--ink-3);flex:none}
.routes .d.on{background:var(--ink);border-color:var(--ink)}
.routes a{color:var(--ink-2);text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.routes a:hover{color:var(--vermilion)}
.routes .dyn{color:var(--ink-3);font-size:var(--t-micro);margin-left:auto;flex:none;
text-transform:uppercase;letter-spacing:var(--track-caps)}
.routes .fam{margin-top:var(--s-4);color:var(--ink-3);font:var(--t-micro)/var(--lh-open) var(--mono);
text-transform:uppercase;letter-spacing:var(--track-caps);break-after:avoid}
pre{margin:0;padding:var(--s-5) var(--s-5);background:var(--paper-2);border:var(--rule-hair) solid var(--rule-ink);
font:var(--t-row)/var(--lh-body) var(--mono);color:var(--ink-2);max-height:260px;overflow:auto;white-space:pre-wrap}

/* Status ---------------------------------------------------------
 * A diamond, filled the way the row marks are filled. This used to reach for
 * --line, --dim and --fg, none of which this stylesheet has ever defined, so
 * the dot painted transparent and the select had no border at all. */
.status{display:inline-flex;align-items:center;gap:var(--s-3)}
.status::before{content:"";width:6px;height:6px;background:var(--ink-3);transform:rotate(45deg);flex:none}
.status.s-unset::before{background:none;border:1px solid var(--rule-ink)}
.status.s-active::before{background:var(--ink)}
.status.s-paused::before{background:none;border:1.5px solid var(--ink)}
.status.s-archived::before{background:none;border:1px solid var(--ink-3)}
.status.s-retired::before{background:var(--vermilion)}
.status select{appearance:none;background:none;border:0;border-bottom:1px solid var(--rule-ink);
color:var(--ink-3);font:var(--t-micro)/var(--lh-body) var(--mono);text-transform:uppercase;
letter-spacing:var(--track-caps);padding:0 var(--s-1) var(--s-1);cursor:pointer}
.status select:hover,.status select:focus-visible{color:var(--ink);border-bottom-color:var(--ink)}

/* Colophon foot: the imprint line at the bottom of the sheet. */
.foot{margin:56px 0 0;border-top:var(--rule-heavy) solid var(--ink);padding:var(--s-5) 0 var(--s-9);
display:flex;align-items:center;flex-wrap:wrap;gap:0 var(--s-5);
font:var(--t-micro)/var(--lh-open) var(--mono);text-transform:uppercase;letter-spacing:var(--track-micro);color:var(--ink-3)}

.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}

@media (max-width:900px){
.wrap{padding:0 var(--s-6)}
header{grid-template-columns:1fr;align-items:start}
.tally{text-align:left}
/* Three columns carrying six fields: the vertical rules would no longer line
   up with anything, so they go, and the head goes with them. */
.cols{display:none}
.row{grid-template-columns:16px 1fr 1fr;gap:var(--s-3) var(--s-5);align-items:start}
.row>.c-note,.row>.num,.row>.acts{border-left:0;padding-left:0}
.row .note{grid-column:2 / -1}.row .num{grid-column:2}
.row .acts{grid-column:3;flex-direction:row;flex-wrap:wrap;gap:var(--s-3) var(--s-5)}
.routes{columns:1}}

/* Ink meets paper or it does not. Colour only, never movement. */
@media (prefers-reduced-motion:no-preference){
a,button.text,.acts .open,.row{transition:color var(--tap) var(--ease),
background-color var(--tap) var(--ease),text-decoration-color var(--tap) var(--ease)}}
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

/* The column heads. Same grid as a row, so the rules line up; written once
   here rather than per section, because two copies of a grid template is how
   the head and the body stop agreeing. */
const COLS = `<div class="cols"><span></span><span>Project</span><span class="r">Notes</span>
<span class="r">Pages</span><span class="r">Ports</span><span class="r">Actions</span></div>`;

function row(p, st, routes, done, hand) {
  const missing = !p.exists;
  const key = esc(p.key);
  // Clamped, because `done` counts stored paths and `routes` is what the
  // project has today. Delete a route and the two disagree, the bar runs past
  // 100%, and an absolutely positioned element 19,000px wide gives the whole
  // hub a horizontal scrollbar. Found by rendering a fixture whose progress
  // outran its route list.
  const pct = routes.length ? Math.min(100, Math.round((done / routes.length) * 100)) : 0;
  const node = p.kind === "node";
  const needsInstall = node && !p.hasModules && p.exists;
  const running = node && (st.state === "ready" || st.state === "starting");
  const runner = node ? (p.command ? "command" : p.runner || "npm") : "static";
  const fams = familiesOf(routes);

  return `<div class="row${missing ? " missing" : ""}" data-key="${key}">
  <span class="mark ${node ? esc(st.state) : "static"}" data-mark="${key}"></span>
  <div class="c-name">
    <h3 class="name">${esc(p.name)}</h3>
    <div class="sys">${esc(p.system || "no named system")} · ${esc(runner)}</div>
  </div>
  <div class="c-note">
    ${p.note ? `<p class="note">${esc(p.note)}</p>` : ""}
    ${missing ? `<p class="err">Directory not found: ${esc(p.dir)}</p>` : ""}
    ${
      p.portConflict
        ? `<p class="err">lightbox could not bind the review port :${p.port}, so it is not serving this project. The link is withheld because whatever answers there is not lightbox.</p>`
        : ""
    }
    <p class="err" data-err="${key}">${esc(st.error || "")}</p>
    <p class="adopted" data-adopted="${key}">${esc(st.adopted ? st.note || "Adopted an existing server on this port." : "")}</p>
    <p class="hand" data-hand="${key}">${esc(handLine(hand))}</p>
  </div>
  <div class="num"><b data-done="${key}">${done}</b> <span class="m">of</span> ${routes.length}${
    fams.length > 1 ? `<br>${fams.length} <span class="m">families</span>` : ""
  }<span class="prog"><i style="width:${pct}%" data-prog="${key}"></i></span></div>
  <div class="num"><span class="m">review :</span>${p.port}${
    node
      ? `<br><span class="m">dev :</span>${p.upstream}<br><span class="m" data-state="${key}">${esc(
          STATE_LABEL[st.state] || ""
        )}</span>`
      : ""
  }</div>
  <div class="acts">
    ${missing || p.portConflict ? "" : `<a class="open" href="/go/${key}">Open</a>`}
    ${
      node
        ? `<button class="text quiet" data-act="install" data-key="${key}"${
            needsInstall ? "" : " hidden"
          }>npm install</button>
    <button class="text quiet" data-act="stop" data-key="${key}"${running ? "" : " hidden"}>stop</button>
    <button class="text quiet" data-act="restart" data-key="${key}"${running ? "" : " hidden"}>restart</button>`
        : ""
    }
    <button class="text quiet" data-toggle="pages">${routes.length} pages</button>
    ${node ? `<button class="text quiet" data-toggle="log">log</button>` : ""}
    <label class="status s-${esc(hand?.status || "unset")}"><span class="vh">Status of ${esc(p.name)}</span>
      <select data-status="${key}">
        <option value=""${hand?.status ? "" : " selected"}>status</option>
        ${STATUSES.map((v) => `<option value="${v}"${hand?.status === v ? " selected" : ""}>${v}</option>`).join("")}
      </select></label>
    <button class="text${hand?.approved ? " ok" : ""}" data-act="approve" data-key="${key}"${hand ? "" : " hidden"}${
      hand?.approved ? " disabled" : ""
    }>${hand?.approved ? "Approved " + esc(String(hand.approvedAt).slice(0, 10)) : "Approve"}</button>
  </div>
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
              }${esc(r.path)}"${
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
      const live = items.filter((p) => p.exists).length;
      return `<section><div class="head"><h2>${esc(g.title)}</h2><span class="count">${
        items.length
      }${live < items.length ? ` &middot; ${items.length - live} missing` : ""}</span></div>${
        g.blurb ? `<p class="blurb">${esc(g.blurb)}</p>` : ""
      }<div class="list">${COLS}${rows}</div></section>`;
    })
    .join("");

  const totalPages = catalogue.projects.reduce((n, p) => n + routesFor(p).length, 0);
  const totalDone = catalogue.projects.reduce((n, p) => n + progress.countFor(p.key), 0);

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>lightbox</title><link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>${CSS}</style></head><body><div class="wrap">
<header>
  <div>
    <h1>lightbox</h1>
    <p class="tagline">Every front end you have built, running at once, each one carrying the same review overlay.</p>
  </div>
  <div class="tally">
    <span class="tally-n" id="done">${totalDone}</span>
    <span class="tally-l">pages reviewed</span>
  </div>
</header>
<div class="rule-heavy"></div>
<p class="colophon">
  <b>${catalogue.projects.length}</b>&nbsp;projects <i class="dia"></i>
  <b>${totalPages}</b>&nbsp;pages <i class="dia"></i>
  inspect-comment ${ctx.inspectCommentPath ? "loaded" : '<span class="off">missing</span>'} <i class="dia"></i>
  <span id="bridge">bridge ?</span>
  <span class="spacer"></span>
  <button class="text quiet" id="stopall">Stop all dev servers</button>
</p>
<div class="band"></div>
<main>${sections}</main>
<p class="foot">lightbox <i class="dia"></i> :${ctx.hubPort || 4000} <i class="dia ink"></i>
  ${catalogue.groups.length}&nbsp;groups <i class="dia ink"></i> ${catalogue.projects.length}&nbsp;projects
  <span class="spacer"></span> made on this machine</p>
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
  var BUSY={install:'installing…',approve:'approving…',stop:'stopping…',restart:'restarting…'};
  b.disabled=true;b.textContent=BUSY[b.dataset.act]||(b.dataset.act+'…');
  act(b.dataset.key,b.dataset.act);
});
document.addEventListener('change',function(e){
  var sel=e.target.closest('select[data-status]');
  if(!sel)return;
  sel.closest('.status').className='status s-'+(sel.value||'unset');
  fetch('/api/status/'+sel.dataset.status,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({status:sel.value})}).catch(function(){});
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
      var ad=q('[data-adopted="'+k+'"]');
      if(ad)ad.textContent=st.adopted?(st.note||'Adopted an existing server on this port.'):'';
      var stop=row.querySelector('button[data-act="stop"]');
      if(stop){stop.hidden=!running;if(!running){stop.disabled=false;stop.textContent='stop'}}
      var rst=row.querySelector('button[data-act="restart"]');
      if(rst){rst.hidden=!running;if(!running){rst.disabled=false;rst.textContent='restart'}}
      var inst=row.querySelector('button[data-act="install"]');
      if(inst&&st.hasModules){inst.hidden=true}
      var hp=q('[data-hand="'+k+'"]');
      if(hp&&typeof st.handoverLine==='string')hp.textContent=st.handoverLine;
      var ap=row.querySelector('button[data-act="approve"]');
      var sel=row.querySelector('select[data-status]');
      if(sel&&document.activeElement!==sel){var sv=(st.handover&&st.handover.status)||'';
        if(sel.value!==sv){sel.value=sv;sel.closest('.status').className='status s-'+(sv||'unset')}}
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
main.wait{max-width:660px;margin:0 auto;padding:84px var(--s-9)}
.wait h1{font-size:clamp(38px,6vw,58px);margin:0 0 var(--s-3)}
.wait .rule-heavy{margin:var(--s-5) 0 0}
.wait .note{font-size:var(--t-lead);max-width:52ch;margin:var(--s-6) 0 0}
.wait .prog{height:var(--ornament-height);background:var(--paper-tint);margin:var(--s-7) 0 var(--s-6)}
.wait .prog i{background:var(--vermilion)}
.wait .acts{flex-direction:row;gap:var(--s-7);margin:0 0 var(--s-7)}
</style></head><body><main class="wait">
<h1>${esc(p.name)}</h1>
<div class="rule-heavy"></div>
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

/* The broadside in 32 pixels: cream stock, a heavy black bar, a red block
   under it. Recognisable in a tab strip at 16px, which rules out type. */
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<rect width="32" height="32" fill="${token("--paper")}"/>
<rect x="5" y="7" width="22" height="4" fill="${token("--ink")}"/>
<rect x="5" y="14" width="22" height="8" fill="${token("--vermilion")}"/>
<rect x="5" y="25" width="22" height="2" fill="${token("--ink")}"/></svg>`;

/* ------------------------------------------------------------------ *
 * Server
 * ------------------------------------------------------------------ */

function bridgeStatus(bridge) {
  // No bridge configured is "the bridge is down", not a crash. Left to throw,
  // this rejected inside the request handler and the socket hung open with no
  // status line, which looks like a wedged hub rather than a missing setting.
  let target;
  try {
    target = new URL("/health", bridge);
  } catch {
    return Promise.resolve(null);
  }
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

/**
 * Which other origins may READ the hub's state, and nothing more.
 *
 * The hub binds loopback, which is a weaker boundary than it sounds: any page
 * in your browser can make requests to 127.0.0.1, so without an allowlist a
 * site you happened to open could ask this hub for the name and directory of
 * every project you have. Empty by default, so nothing can, and a config has
 * to name an origin before it gets an answer.
 *
 * Read-only by construction, and enforced twice over: only GET is offered in
 * Allow-Methods, and only /api/state is answered at all. The POST endpoints
 * that start and stop dev servers never carry these headers, so a permitted
 * origin can watch the hub and cannot touch it.
 *
 * Allow-Private-Network is what Chrome's Private Network Access requires
 * before a page served from the public internet may reach a loopback address.
 * Without it the preflight fails and the fetch never happens, which looks
 * exactly like the hub being down.
 */
function corsHeaders(ctx, req) {
  const origin = req.headers.origin;
  const allowed = ctx.hubOrigins || [];
  if (!origin || !allowed.includes(origin)) return null;
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-allow-private-network": "true",
    // Origin decides the response, so a shared cache must not serve one
    // origin's answer to another.
    vary: "Origin",
    "access-control-max-age": "600",
  };
}

export function createHubServer(ctx) {
  const { catalogue, supervisor, progress, handover } = ctx;
  const byKey = new Map(catalogue.projects.map((p) => [p.key, p]));

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;

    // Only the read-only state endpoint is ever cross-origin, and only for an
    // origin the config named. Everything else answers as it always did.
    const cors = p === "/api/state" ? corsHeaders(ctx, req) : null;

    const send = (code, type, body) => {
      if (res.headersSent) return;
      res.writeHead(code, { "content-type": type, "cache-control": "no-store", ...(cors || {}) });
      res.end(body);
    };

    if (req.method === "OPTIONS") {
      if (!cors) return send(404, "text/plain", "not found");
      res.writeHead(204, cors);
      return res.end();
    }

    // The handler is async, so anything it throws becomes an unhandled
    // rejection and the socket is left open with no status line. A hung tab is
    // the least informative way to report a bug in here; say 500 instead.
    try {
      await route(ctx, byKey, req, res, url, p, send);
    } catch (e) {
      send(500, "text/plain", `lightbox hub error: ${e && e.message}`);
    }
  });
}

async function route(ctx, byKey, req, res, url, p, send) {
  const { catalogue, supervisor, progress, handover } = ctx;
  {
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
      const m = /^\/api\/(start|stop|restart|install|stopall|approve|unapprove|status)(?:\/(.+))?$/.exec(p);
      if (m) {
        const [, action, key] = m;
        if (action === "stopall") {
          await supervisor.stopAll(catalogue.projects);
          return send(200, "application/json", '{"ok":true}');
        }
        const project = byKey.get(key);
        if (!project) return send(404, "application/json", '{"error":"no such project"}');
        if (action === "status") {
          // Set from the hub and read by every other tool, so write it through
          // now rather than on the 4s timer.
          let body = "";
          for await (const chunk of req) body += chunk;
          let wanted = "";
          try {
            wanted = String(JSON.parse(body || "{}").status || "");
          } catch {
            wanted = "";
          }
          const entry = handover.setStatus(project.key, wanted);
          handover.flush();
          return send(200, "application/json", JSON.stringify(entry));
        }
        if (action === "approve" || action === "unapprove") {
          // The only signal the push step reads. Flushed at once, not on the
          // timer, so a coding session polling the file sees it immediately.
          const entry = action === "approve" ? handover.approve(project.key) : handover.unapprove(project.key);
          handover.flush();
          return send(200, "application/json", JSON.stringify(entry));
        }
        if (action === "start") supervisor.start(project).catch(() => {});
        if (action === "stop") await supervisor.stop(project).catch(() => {});
        if (action === "restart") {
          // A page added while `serve` was running never showed up, because
          // the route list is cached for the life of the process and nothing
          // ever invalidated it. A restart is the natural moment to re-read.
          clearRouteCache(project.key);
          supervisor.restart(project).catch(() => {});
        }
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
  }
}
