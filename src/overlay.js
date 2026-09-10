/*!
 * lightbox overlay. Injected into every page the proxy serves.
 *
 * It does three things and nothing else:
 *   1. walks the project's routes, so a review is a sequence and not a hunt
 *   2. records which pages you have finished, on the server, so the count
 *      survives the browser you happened to use
 *   3. mounts inspect-comment, pointed at a bridge on this same origin
 *
 * All of its own UI lives in a shadow root on a single host element, so the
 * page's stylesheet cannot reach in and the page's stacking context cannot bury
 * it. The host is marked data-lightbox, which is also how you tell your own
 * chrome apart from the site's when you are inspecting.
 *
 * It is drawn in lightbox's own design system and not in anything resembling a
 * default: cream stock, a red rule along its top edge, condensed capitals, a
 * hard offset impression instead of a soft shadow. That is the point. This bar
 * spends all day sitting on top of forty other people's design systems, and if
 * it is going to be in the frame while you judge them it has to be obvious at
 * a glance which pixels are yours and which are the site's.
 *
 * The values come from src/design.css. The proxy passes them down in
 * window.__LIGHTBOX.tokens, because a shadow root under `all: initial`
 * inherits nothing and there is no second copy of the palette to keep in step.
 */
(function () {
  "use strict";
  if (window.__lightbox) return;
  window.__lightbox = true;

  var CFG = window.__LIGHTBOX || {};
  var routes = CFG.routes || [];
  var here = location.pathname + location.search;
  var reviewed = new Set(CFG.reviewed || []);

  /* Older hand-rolled inspectors are still wired into a few of these projects.
     Two floating buttons in the same corner is worse than either alone, so the
     legacy one is hidden rather than left to fight for the click. */
  var kill = document.createElement("style");
  kill.setAttribute("data-lightbox-reset", "");
  kill.textContent = "[data-inspector]{display:none!important}";
  (document.head || document.documentElement).appendChild(kill);

  function idxOf(p) {
    for (var i = 0; i < routes.length; i++) if (routes[i].path === p) return i;
    // A route reached by clicking a link inside the site rather than by the
    // walker. Not in the list, so the counter shows position 0.
    return -1;
  }
  var index = idxOf(location.pathname);
  if (index === -1) index = idxOf(here);

  /* Where the walk thinks it is, carried across the navigation it just made.
     Deriving the position from location alone is wrong for any route that
     redirects: pavlopuzikov.com/about 308s to /#about, whose pathname is "/",
     which reads back as route 1. So walking forward from route 6 landed on
     route 1, and next walked 1,2,3,4,5,6,1,2,... with pages 7 to 15 permanently
     out of reach. That is the "next does nothing" case. The intended index
     wins; the landed path is shown as-is so the disagreement is visible rather
     than papered over. */
  var WALK_KEY = "lightbox:walk:" + (CFG.key || CFG.name || "project");
  var redirected = false;
  try {
    var pending = sessionStorage.getItem(WALK_KEY);
    sessionStorage.removeItem(WALK_KEY);
    var to = pending == null ? -1 : Number(pending);
    if (routes[to]) {
      redirected = routes[to].path !== location.pathname;
      index = to;
    }
  } catch (e) {
    /* private mode, or storage disabled. The walk degrades to the old
       behaviour rather than failing. */
  }

  /* How many different routes in a row have answered with this same path.
     One redirect is a redirect. Several in a row, all landing on the same
     page, is a gate: an app that wants a session, and every page of the walk
     is that app's login screen. The walk itself is working perfectly in that
     case, which is exactly why it needs saying out loud. The counter is what
     ".path.moved" cannot show, because a red arrow looks the same on the
     second page as on the sixth.

     Measured on AriOS 2026-09-09: next advanced 27 -> 28 -> 29 -> 31 and the
     bar read "/boards -> /login" each time, so the tool was right and looked
     broken. */
  var GATE_KEY = WALK_KEY + ":gate";
  var gateCount = 0;
  try {
    var prevGate = JSON.parse(sessionStorage.getItem(GATE_KEY) || "null");
    if (redirected) {
      gateCount = prevGate && prevGate.at === location.pathname ? prevGate.n + 1 : 1;
      sessionStorage.setItem(GATE_KEY, JSON.stringify({ at: location.pathname, n: gateCount }));
    } else {
      sessionStorage.removeItem(GATE_KEY);
    }
  } catch (e) {
    /* no storage, no gate detection. The bar still shows the arrow. */
  }

  /* ---------------------------------------------------------------- *
   * Chrome
   * ---------------------------------------------------------------- */

  var host = document.createElement("div");
  host.setAttribute("data-lightbox", "");
  host.style.cssText = "all:initial";
  var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;

  /* The design system, handed down by the proxy. `all: initial` on the host
     does not reset custom properties, so declaring them on :host is enough to
     light up every var() below. */
  var TOKENS = CFG.tokens || {};
  var vars = Object.keys(TOKENS)
    .map(function (k) {
      return k + ":" + TOKENS[k];
    })
    .join(";");
  if (!vars) console.warn("[lightbox] no design tokens in the injected config; the overlay will use browser defaults");

  var style = document.createElement("style");
  style.textContent = [
    ":host{all:initial;" + vars + "}",
    /* The family goes on the host, not on `*`. A universal selector matches
       every element directly, so it beat the family that `.sheet a`'s font
       shorthand set and that its inner <span class="p"> should have inherited:
       measured on the AriOS sheet, the route paths came back -apple-system
       11.5px while the row around them was mono. Inheritance from :host gets
       the same reach without out-ranking anything, and `all: initial` does not
       stop it, because a declaration on :host is not a reset. Buttons are the
       one thing that does not inherit font, and the button rule below sets its
       own, so nothing here needs a form-control exemption. */
    ":host{font-family:var(--sans)}",
    "*{box-sizing:border-box}",

    /* The bar. A red rule along the top edge and a hard offset impression
       below it: no blur, because a press does not cast a shadow, and a second
       impression slightly off register is what this actually looks like on
       paper.

       It is fully opaque, and that is a correction. It used to sit at .62 and
       come up to 1 on hover, on the theory that a translucent bar recedes
       politely. What it actually does is let the page through: park it over the
       seam between a light section and a dark one, which is where the bottom of
       a landing page usually is, and the cream goes muddy grey-green, the ink
       border goes grey and the vermilion rule goes pink. The strip stops being
       lightbox's and stops being readable in the same move. Cream stock with a
       hard offset already sits quietly against someone else's page; it does not
       need to be see-through to be polite, and being see-through was the whole
       reason it could not be seen. */
    ".bar{position:fixed;left:18px;bottom:18px;z-index:2147482000;display:flex;align-items:stretch;",
    "background:var(--paper);color:var(--ink);border:2px solid var(--ink);",
    "border-top:3px solid var(--vermilion);box-shadow:4px 4px 0 var(--ink)}",

    "button{appearance:none;border:0;border-left:1px solid var(--rule-ink);background:transparent;",
    "color:var(--ink-2);font:var(--t-micro)/var(--lh-solid) var(--mono);text-transform:uppercase;",
    "letter-spacing:var(--track-caps);padding:var(--s-4) var(--s-5);cursor:pointer}",
    "button:first-child{border-left:0}",
    "button:hover{background:var(--paper-tint);color:var(--ink)}",
    "button:disabled{color:var(--rule-ink);cursor:default;background:transparent}",
    "button:focus-visible{outline:2px solid var(--vermilion);outline-offset:-3px}",
    ".nav{font-size:var(--t-body);letter-spacing:0;padding:var(--s-4) var(--s-4)}",
    "button[hidden]{display:none}",

    /* Armed. Vermilion is spent on the gate and on failures, and this is
       neither, but it is the one control that keeps doing something after you
       stop looking at it. A filled ink block is the strongest thing this
       system has that is not red, and it reads as on rather than as wrong. */
    ".shots.on{background:var(--ink);color:var(--paper)}",
    ".shots.on:hover{background:var(--ink-2);color:var(--paper)}",

    ".label{display:flex;gap:var(--s-4);align-items:center;padding:var(--s-4) var(--s-5);cursor:pointer;",
    "max-width:48vw;border-left:1px solid var(--rule-ink)}",
    ".label:hover{background:var(--paper-tint)}",
    ".name{font:400 var(--t-body)/var(--lh-tight) var(--display);font-stretch:condensed;text-transform:uppercase;",
    "letter-spacing:.05em;color:var(--ink)}",
    ".count{font:var(--t-micro)/var(--lh-solid) var(--mono);color:var(--ink-3);letter-spacing:var(--track-caps);",
    "text-transform:uppercase;font-variant-numeric:tabular-nums;flex:none}",
    ".path{font:var(--t-row)/var(--lh-solid) var(--mono);color:var(--ink-2);overflow:hidden;",
    "text-overflow:ellipsis;white-space:nowrap}",
    /* The route did not serve itself. Red, because it is the one thing on this
       bar that means the list and the site disagree. */
    ".path.moved{color:var(--vermilion)}",

    /* Same square as the hub row marks, and it means the same thing: filled is
       done, hollow is not. One vocabulary across both surfaces. */
    ".dot{width:8px;height:8px;background:var(--ink);flex:none}",
    ".dot.todo{background:none;border:1.5px solid var(--ink-3)}",

    ".sheet{position:fixed;left:18px;bottom:62px;z-index:2147482001;width:min(500px,88vw);",
    "max-height:62vh;overflow:auto;background:var(--paper);color:var(--ink);",
    "border:2px solid var(--ink);border-top:3px solid var(--vermilion);",
    "box-shadow:4px 4px 0 var(--ink);display:none}",
    ".sheet.open{display:block}",
    ".sheet h4{margin:0;padding:var(--s-5) var(--s-6) var(--s-4);font:400 var(--t-lead)/var(--lh-tight) var(--display);",
    "font-stretch:condensed;text-transform:uppercase;letter-spacing:var(--track-caps);color:var(--ink)}",
    /* The ornament again, once, exactly where the masthead ends. */
    ".sheet .band{height:var(--ornament-height);background:var(--ornament) repeat-x left center;",
    "margin:0 var(--s-6) var(--s-2)}",
    ".sheet a{display:flex;gap:var(--s-4);align-items:center;padding:var(--s-3) var(--s-6);color:var(--ink-2);",
    "text-decoration:none;font:var(--t-row)/var(--lh-snug) var(--mono);border-bottom:1px solid var(--rule-ink-2)}",
    ".sheet a:hover{color:var(--ink);background:var(--paper-tint)}",
    /* Where you are, marked in the margin the way a proof is marked. */
    ".sheet a.here{color:var(--ink);background:var(--paper-tint);",
    "box-shadow:inset 3px 0 0 var(--vermilion)}",
    ".sheet a .p{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".sheet a .dyn{color:var(--ink-3);font-size:var(--t-micro);text-transform:uppercase;",
    "letter-spacing:var(--track-caps);flex:none;margin-left:auto}",
    /* A section head, not a caption. It carries a rule the way every other
       heading in this system does, and it holds the section's own progress on
       the right, because the open question in a review is which block is
       unfinished rather than what the block is called. */
    ".fam{display:flex;align-items:baseline;justify-content:space-between;gap:var(--s-4);",
    "margin:var(--s-5) var(--s-6) 0;padding:0 0 var(--s-1);color:var(--ink-2);",
    "border-bottom:var(--rule-mid) solid var(--ink);",
    "font:var(--t-micro)/var(--lh-body) var(--mono);",
    "text-transform:uppercase;letter-spacing:var(--track-micro)}",
    ".fam:first-of-type{margin-top:var(--s-2)}",
    ".famn{color:var(--ink-3);letter-spacing:var(--track-caps);font-variant-numeric:tabular-nums}",
    /* Children of a section sit in from its rule, so the blocks read as blocks
       and the ungrouped top-level pages stay flush. That indent is the only
       thing separating them, which is why it is a whole step and not a hair. */
    ".sheet a.in{padding-left:var(--s-7)}",
    ".foot{padding:var(--s-5) var(--s-6) var(--s-5);color:var(--ink-3);font:var(--t-micro)/var(--lh-open) var(--mono);",
    "border-top:2px solid var(--ink)}",
    "kbd{border:1px solid var(--rule-ink);background:var(--paper-2);padding:var(--s-1) var(--s-2);",
    "color:var(--ink-2);font:var(--t-micro)/var(--lh-solid) var(--mono)}",

    /* The scrollbar. A browser default scrollbar on a letterpress sheet is the
       one piece of chrome in this overlay that was still somebody else's, and
       it sits on the right edge of the panel where it is impossible not to
       see. Drawn as the system draws everything else: paper track, ink thumb,
       a hairline where the track meets the sheet, and no radius. It does not
       take vermilion on hover, because red means the tally or a failure and a
       scrollbar is neither.

       Both spellings, because they are not interchangeable. scrollbar-width /
       scrollbar-color is the standard property and all Firefox has;
       ::-webkit-scrollbar is what Chrome honours and it wins there. */
    ".sheet{scrollbar-width:thin;scrollbar-color:var(--ink) var(--paper-2)}",
    ".sheet::-webkit-scrollbar{width:10px}",
    ".sheet::-webkit-scrollbar-track{background:var(--paper-2);",
    "border-left:var(--rule-hair) solid var(--rule-ink)}",
    ".sheet::-webkit-scrollbar-thumb{background:var(--ink);border:2px solid var(--paper-2)}",
    ".sheet::-webkit-scrollbar-thumb:hover{background:var(--ink-2)}",

    /* The gate notice. Vermilion, because this is the failure case: the walk is
       stepping and the site is not letting it through. */
    ".gate{position:fixed;left:18px;bottom:calc(18px + 41px);z-index:2147482000;",
    "max-width:min(560px,88vw);background:var(--paper);color:var(--ink);",
    "border:2px solid var(--vermilion);box-shadow:4px 4px 0 var(--vermilion-2);",
    "padding:var(--s-4) var(--s-5);font:var(--t-row)/var(--lh-snug) var(--mono)}",
    ".gate[hidden]{display:none}",
  ].join("");
  root.appendChild(style);

  var bar = document.createElement("div");
  bar.className = "bar";

  var prev = document.createElement("button");
  prev.type = "button";
  prev.className = "nav";
  prev.textContent = "‹";
  prev.title = "Previous page (Alt+[)";

  var label = document.createElement("div");
  label.className = "label";
  label.title = "Every page in this project";

  var next = document.createElement("button");
  next.type = "button";
  next.className = "nav";
  next.textContent = "›";
  next.title = "Next page (Alt+])";

  var mark = document.createElement("button");
  mark.type = "button";
  mark.title = "Mark this page reviewed (Alt+M)";

  var shots = document.createElement("button");
  shots.type = "button";
  shots.className = "shots";
  shots.textContent = "shots";
  shots.title = "Screenshot every note from here on";
  if (!CFG.shots) shots.hidden = true;

  var hub = document.createElement("button");
  hub.type = "button";
  hub.textContent = "hub";
  hub.title = "Back to the hub (Alt+H)";

  /* The gate notice. It sits above the bar rather than inside it, because it
     is about the whole walk and not about this page, and it is the one place
     in the overlay besides a failure where vermilion is spent. */
  var gate = document.createElement("div");
  gate.className = "gate";
  gate.hidden = true;

  bar.appendChild(prev);
  bar.appendChild(label);
  bar.appendChild(next);
  bar.appendChild(mark);
  bar.appendChild(shots);
  bar.appendChild(hub);
  root.appendChild(gate);
  root.appendChild(bar);

  var sheet = document.createElement("div");
  sheet.className = "sheet";
  root.appendChild(sheet);

  /* An unfilled dynamic route is not a page. "/work/[slug]" is a literal
     request, and a dev server answers it by compiling for several seconds and
     then rendering a 404. Three of pavlopuzikov.com's fifteen routes are that,
     and they were the slowest clicks in the walk for the least return. Give the
     project a `params` block in lightbox.config.json and the segment fills in
     and the route rejoins the walk on its own. Until then the walk steps over
     it. The sheet still lists it, tagged dynamic, so it is visibly skipped
     rather than quietly dropped. */
  function real(i, dir) {
    while (i >= 0 && i < routes.length && routes[i].dynamic) i += dir;
    return i >= 0 && i < routes.length ? i : -1;
  }
  function step(from, dir) {
    return real(from + dir, dir);
  }

  function go(i) {
    if (i < 0 || i >= routes.length) return;
    try {
      sessionStorage.setItem(WALK_KEY, String(i));
    } catch (e) {
      /* see above: the walk still navigates, it just cannot survive a redirect */
    }
    location.href = routes[i].path;
  }

  /* One page per template is the quick pass. Families are contiguous in the
     list, so "next family" is the first route whose family differs. */
  function goFamily(dir) {
    if (index < 0) return go(0);
    var fam = routes[index].family;
    if (dir > 0) {
      for (var i = index + 1; i < routes.length; i++)
        if (routes[i].family !== fam) return go(real(i, 1));
      return;
    }
    var start = index;
    while (start > 0 && routes[start - 1].family === fam) start--;
    if (start === 0) return go(real(0, 1));
    var prevFam = routes[start - 1].family;
    var j = start - 1;
    while (j > 0 && routes[j - 1].family === prevFam) j--;
    go(real(j, 1));
  }

  function renderLabel() {
    var cur = index >= 0 ? routes[index] : null;
    label.textContent = "";
    var dot = document.createElement("span");
    dot.className = "dot" + (reviewed.has(location.pathname) ? "" : " todo");
    var nm = document.createElement("span");
    nm.className = "name";
    nm.textContent = CFG.name || "project";
    var ct = document.createElement("span");
    ct.className = "count";
    ct.textContent =
      (index >= 0 ? index + 1 : "•") + "/" + routes.length + " · " + reviewed.size + " done";
    var pt = document.createElement("span");
    pt.className = "path" + (redirected ? " moved" : "");
    /* When the route redirected, say where you actually are, not where the
       walk asked to go. Both are true and only one of them is on screen. */
    pt.textContent = redirected && cur ? cur.path + " → " + location.pathname : cur ? cur.path : location.pathname;
    if (redirected && cur) pt.title = cur.path + " redirects to " + location.pathname;
    label.appendChild(dot);
    label.appendChild(nm);
    label.appendChild(ct);
    label.appendChild(pt);

    /* Two in a row is the threshold. One redirect is a redirect and the arrow
       in the bar says so; two different routes answering with the same page
       means the site is not letting the walk through. */
    if (gateCount >= 2) {
      gate.hidden = false;
      gate.textContent =
        gateCount + " routes in a row answered with " + location.pathname +
        ". The walk is stepping, the site is not. Sign in here and the pages will follow.";
    } else {
      gate.hidden = true;
    }

    prev.disabled = step(index, -1) === -1;
    next.disabled = step(index, 1) === -1;
    mark.textContent = reviewed.has(location.pathname) ? "reviewed" : "mark done";
  }

  function renderSheet() {
    sheet.textContent = "";
    var h = document.createElement("h4");
    h.textContent =
      (CFG.name || "project") + " · " + routes.length + (routes.length === 1 ? " page" : " pages");
    sheet.appendChild(h);
    var band = document.createElement("div");
    band.className = "band";
    sheet.appendChild(band);
    /* A header only where it groups something: never for a family of one,
       never when the whole project is one family. */
    var famCount = 0;
    var lastFam = null;
    routes.forEach(function (r) {
      if (r.family !== lastFam) famCount++;
      lastFam = r.family;
    });
    /* The list is grouped, and the grouping has to do more than print a name.
       AriOS is the case that showed why: eighteen families, twelve of them a
       single route, scattered between the six real sections, so the sheet read
       as block, loose line, loose line, block, loose line. Three changes, none
       of which reorder anything, because the display order IS the walk order
       and clicking row seven has to be the same page as pressing next six
       times.

         - A family of one gets no header. It is a top-level page and prints as
           its own full path, which is already the shortest true label for it.
         - A family of more gets a header, and its children print with the
           family prefix stripped. "/ops/repos/arios" under an "ops" heading is
           "repos/arios", which is the part you are choosing between.
         - Paths are percent-decoded for display. The vault routes carry
           "%20-%20Projects%20%26%20" in them, which is thirty characters of
           nothing, and the href keeps the encoded original. */
    lastFam = null;
    routes.forEach(function (r, i) {
      var n = 0;
      for (var k = 0; k < routes.length; k++) if (routes[k].family === r.family) n++;
      var grouped = famCount > 1 && n > 1;

      if (grouped && r.family !== lastFam) {
        var done = 0;
        for (var j = 0; j < routes.length; j++)
          if (routes[j].family === r.family && reviewed.has(routes[j].path)) done++;
        var fh = document.createElement("div");
        fh.className = "fam";
        var fn = document.createElement("span");
        fn.textContent = r.family.replace(/^\//, "");
        var fc = document.createElement("span");
        fc.className = "famn";
        /* Progress per section, in the same vocabulary as the dots: the
           question a reviewer actually has open is which block is unfinished. */
        fc.textContent = done + "/" + n;
        fh.appendChild(fn);
        fh.appendChild(fc);
        sheet.appendChild(fh);
      }
      lastFam = r.family;

      var a = document.createElement("a");
      a.href = r.path;
      a.className = (i === index ? "here" : "") + (grouped ? " in" : "");
      var d = document.createElement("span");
      d.className = "dot" + (reviewed.has(r.path) ? "" : " todo");
      var p = document.createElement("span");
      p.className = "p";
      var shown = r.path;
      if (grouped && r.path !== r.family && r.path.indexOf(r.family + "/") === 0) {
        shown = r.path.slice(r.family.length + 1);
      }
      /* A malformed escape throws rather than returning the input, and one bad
         route should not empty the sheet. */
      try {
        shown = decodeURIComponent(shown);
      } catch (e) {
        /* keep it encoded */
      }
      p.textContent = shown;
      p.title = r.path;
      a.appendChild(d);
      a.appendChild(p);
      if (r.dynamic) {
        var dy = document.createElement("span");
        dy.className = "dyn";
        dy.textContent = "dynamic";
        a.appendChild(dy);
      }
      sheet.appendChild(a);
    });
    var f = document.createElement("div");
    f.className = "foot";
    f.innerHTML =
      "<kbd>Alt</kbd>+<kbd>[</kbd> / <kbd>]</kbd> walk &nbsp; <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>[</kbd> / <kbd>]</kbd> next family<br>" +
      "<kbd>Alt</kbd>+<kbd>M</kbd> mark done &nbsp; <kbd>Alt</kbd>+<kbd>H</kbd> hub &nbsp; <kbd>Alt</kbd>+<kbd>C</kbd> inspect and comment" +
      (CFG.shots
        ? "<br>shots: consent once, then every note you add is captured with the screen you added it on"
        : "");
    sheet.appendChild(f);
  }

  function toggleSheet(force) {
    var open = force != null ? force : !sheet.classList.contains("open");
    sheet.classList.toggle("open", open);
    bar.classList.toggle("open", open);
    if (open) renderSheet();
  }

  function setReviewed(on) {
    var p = location.pathname;
    if (on) reviewed.add(p);
    else reviewed.delete(p);
    renderLabel();
    if (sheet.classList.contains("open")) renderSheet();
    try {
      fetch("/__lb/progress", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ route: p, reviewed: on }),
        keepalive: true,
      });
    } catch (e) {
      /* the count is a convenience; losing one is not worth an error dialog */
    }
  }

  /* ---------------------------------------------------------------- *
   * Capture
   *
   * Twenty-four reviews were taken before this existed and not one carried an
   * image, because the inspector's own Shot button asks for a click per note
   * and the first click raises a screen-share picker. Two frictions stacked on
   * the one action that shows the reviewer nothing back.
   *
   * So: consent once, then every note captures itself. The frame is the whole
   * viewport rather than a crop of the element, because half the notes in a
   * real review are comparative and a tight crop of one nav link cannot answer
   * "width doesnt match the other links". The element's rectangle is recorded
   * as coordinates instead of drawn into the pixels.
   *
   * The stream dies on navigation, so this is armed per page rather than per
   * session. That is a property of running inside the document being reviewed,
   * not a choice.
   * ---------------------------------------------------------------- */

  var QUEUE_TAG = "element-review-inspector-queue";
  var cap = { on: false, stream: null, video: null, seen: 0, frames: {} };

  function disarm(why) {
    if (cap.stream) {
      var tracks = cap.stream.getTracks();
      for (var i = 0; i < tracks.length; i++) tracks[i].stop();
    }
    cap.stream = null;
    cap.video = null;
    cap.on = false;
    shots.classList.remove("on");
    shots.textContent = "shots";
    shots.title = why || "Screenshot every note from here on";
  }

  function queueNow() {
    var tag = document.getElementById(QUEUE_TAG);
    if (!tag) return [];
    try {
      return JSON.parse(tag.textContent) || [];
    } catch (e) {
      return [];
    }
  }

  async function arm() {
    if (cap.on) return disarm();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      shots.title = "This browser cannot capture the screen";
      shots.disabled = true;
      return;
    }
    try {
      cap.stream = await navigator.mediaDevices.getDisplayMedia({
        // preferCurrentTab puts this tab at the top of the picker. It is a
        // request, not a guarantee, and the reviewer can still pick a window;
        // the frames are then of that window, which is their choice to make.
        video: { displaySurface: "browser" },
        preferCurrentTab: true,
        selfBrowserSurface: "include",
        surfaceSwitching: "exclude",
        audio: false,
      });
    } catch (e) {
      // Dismissing the picker is a decision, not a fault. Say nothing.
      return disarm();
    }

    var v = document.createElement("video");
    v.srcObject = cap.stream;
    v.muted = true;
    v.playsInline = true;
    try {
      await v.play();
    } catch (e) {
      return disarm("The capture stream would not start");
    }
    cap.video = v;
    cap.on = true;
    // Anything already queued was noted before arming, or restored from
    // sessionStorage on this page load. Capturing those now would attach
    // today's screen to yesterday's note.
    cap.seen = queueNow().length;
    shots.classList.add("on");
    shots.textContent = "shots on";
    shots.title = "Stop screenshotting notes";

    // Ending the share from the browser's own bar has to put the button back,
    // or it says "on" over a dead track and every later note silently gets a
    // black frame.
    var t = cap.stream.getVideoTracks()[0];
    if (t) t.addEventListener("ended", function () { disarm(); });
  }

  function frameOf(el) {
    var v = cap.video;
    var c = document.createElement("canvas");
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    var ctx2d = c.getContext("2d");
    if (!ctx2d || !c.width || !c.height) return null;
    ctx2d.drawImage(v, 0, 0, c.width, c.height);
    // JPEG, not PNG. A full-width PNG of a real page runs past a megabyte, and
    // nine of them in one sitting breach both this proxy's body limit and the
    // bridge's. At 0.9 the same frame is a fifth of that and no less readable.
    var url = c.toDataURL("image/jpeg", 0.9);
    var r = el ? el.getBoundingClientRect() : null;
    return {
      dataUrl: url,
      rect: r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      // Nine notes taken without scrolling are one screen. The length of the
      // encoded frame is a cheap stand-in for its content: two captures of a
      // still page agree, and a scroll of one pixel does not.
      frame: [location.pathname, window.scrollY, window.innerWidth, url.length].join("|"),
    };
  }

  async function capture(entry) {
    var sel = entry && entry.descriptor && entry.descriptor.selector;
    var el = null;
    try {
      el = sel ? document.querySelector(sel) : null;
    } catch (e) {
      /* a selector this document cannot parse still gets a frame, just no box */
    }
    var f = frameOf(el);
    if (!f) return;

    var body = {
      selector: sel || null,
      page: location.pathname + location.search,
      rect: f.rect,
      viewport: f.viewport,
      frame: f.frame,
    };
    // A frame already on the server is referenced, not resent. This is what
    // keeps a nine-note pass over one screen down to a single file.
    if (cap.frames[f.frame]) body.ref = f.frame;
    else body.dataUrl = f.dataUrl;

    try {
      var res = await fetch("/__lb/shot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      var out = await res.json();
      if (out && out.file) cap.frames[f.frame] = out.file;
    } catch (e) {
      /* the note is still queued and the review still submits; it just goes
         without its picture, which is what every review did before this */
    }
  }

  if (CFG.shots) {
    shots.addEventListener("click", function () {
      arm();
    });
    // The inspector rewrites this tag's text on every queue change, so one
    // observer on the document catches a note added anywhere.
    var watch = new MutationObserver(function () {
      if (!cap.on) return;
      var q = queueNow();
      if (q.length <= cap.seen) {
        // Deleting a queued note must not make the next one capture twice.
        cap.seen = q.length;
        return;
      }
      var fresh = q.slice(cap.seen);
      cap.seen = q.length;
      for (var i = 0; i < fresh.length; i++) capture(fresh[i]);
    });
    watch.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  prev.addEventListener("click", function () {
    go(step(index, -1));
  });
  next.addEventListener("click", function () {
    go(step(index, 1));
  });
  label.addEventListener("click", function () {
    toggleSheet();
  });
  mark.addEventListener("click", function () {
    setReviewed(!reviewed.has(location.pathname));
  });
  hub.addEventListener("click", function () {
    location.href = CFG.hub || "http://localhost:4000/";
  });

  document.addEventListener(
    "keydown",
    function (e) {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.code === "BracketLeft" && e.shiftKey) {
        e.preventDefault();
        goFamily(-1);
      } else if (e.code === "BracketRight" && e.shiftKey) {
        e.preventDefault();
        goFamily(1);
      } else if (e.code === "BracketLeft") {
        e.preventDefault();
        go(step(index, -1));
      } else if (e.code === "BracketRight") {
        e.preventDefault();
        go(step(index, 1));
      } else if (e.code === "KeyM") {
        e.preventDefault();
        setReviewed(!reviewed.has(location.pathname));
      } else if (e.code === "KeyH") {
        e.preventDefault();
        location.href = CFG.hub || "http://localhost:4000/";
      }
    },
    true
  );

  function attach() {
    document.body.appendChild(host);
    renderLabel();
  }
  if (document.body) attach();
  else document.addEventListener("DOMContentLoaded", attach);

  /* ---------------------------------------------------------------- *
   * inspect-comment
   *
   * Imported from this origin so no CORS or CSP question arises, and pointed
   * at a bridge on this origin too: the proxy tags each review with the
   * project it came from before passing it to the MCP server, which is the
   * one thing the browser cannot know on its own when forty sites all answer
   * on "/".
   * ---------------------------------------------------------------- */
  /* inspect-comment draws its own dock bottom-right in its own design system:
     a near-black rounded pill under a soft blurred shadow. On a dark site that
     is a black pill on black, and the button that starts a selection is the one
     control on screen you cannot find. It is also the only piece of lightbox's
     review surface that does not look like lightbox, sitting two corners away
     from a bar made of cream stock and hard offsets.

     Its shadow root is open and its host carries [data-inspect-comment], so the
     dock can be redrawn from here. Doing it here rather than in inspect-comment
     is deliberate: that tool is used outside lightbox and should keep its own
     look there. This is lightbox dressing a guest, not editing it.

     The panel is left alone. It is a dark tool that appears while you use it,
     not chrome that sits in the frame while you judge someone's colours. */
  function dressDock(hostEl) {
    var sr = hostEl && hostEl.shadowRoot;
    if (!sr || sr.querySelector("style[data-lightbox-dock]")) return false;

    /* Lift the host out of its own stacking context. inspect-comment mounts on
       a 0x0 `position: fixed` div and puts z-index 2147483001 on the dock
       inside it. A fixed element with z-index:auto is itself a stacking
       context, so that number only ever competes with inspect-comment's other
       layers; the host competes with the page at auto, and loses to any
       positioned section that comes after it. On pavlopuzikov.com the dock
       measures 35px tall, fully opaque, and the page paints over all but the
       top few pixels of it: the control that starts a selection is drawn and
       then buried. lightbox's own bar dodges this by accident, because its host
       is `all: initial` and therefore static.

       The inspector now sets this on its own host, so on a current clone this
       line is a no-op writing the same value. It stays because lightbox picks
       up whatever sibling clone is on disk, and an older one still has the bug.
       The value is deliberately above lightbox's own bar: while you are
       inspecting, the thing you are inspecting with belongs on top. */
    hostEl.style.zIndex = "2147483000";
    var s = document.createElement("style");
    s.setAttribute("data-lightbox-dock", "");
    s.textContent = [
      /* The host inherits nothing of ours, so the palette comes down with it.
         inspect-comment sets --accent and --select inline on this same host;
         no name here collides with those. */
      ":host{" + vars + "}",
      /* One strip, the way the bar is one strip, instead of three pills. */
      ".dock{gap:0;align-items:stretch;background:var(--paper);color:var(--ink);",
      "border:2px solid var(--ink);border-top:3px solid var(--vermilion);",
      "box-shadow:4px 4px 0 var(--ink)}",
      ".dock button{border-radius:0;box-shadow:none;border:0;",
      "border-left:1px solid var(--rule-ink);background:var(--paper);color:var(--ink-2);",
      "font:var(--t-micro)/var(--lh-solid) var(--mono);text-transform:uppercase;letter-spacing:var(--track-caps);",
      "padding:var(--s-4) var(--s-5)}",
      ".dock button:first-child{border-left:0}",
      ".dock button:hover{background:var(--paper-tint);color:var(--ink)}",
      ".dock button:focus-visible{outline:2px solid var(--vermilion);outline-offset:-3px}",
      /* Armed and counting are the two states worth shouting, and red is what
         the bar already uses for them. */
      ".dock .toggle[data-active]{background:var(--vermilion);color:var(--paper)}",
      ".dock .count{background:var(--vermilion);color:var(--paper)}",
      ".dock .focus-btn[data-active]{background:var(--ink);color:var(--paper)}",
    ].join("");
    sr.appendChild(s);
    return true;
  }

  /* The inspector's host attribute, newest name first. It is
     [data-element-review-inspector] since 3.0.0 and was [data-inspect-comment]
     before it, and lightbox has to dress whichever one is actually installed.

     Querying only the old name does more than leave the dock undressed. It
     also skips the z-index lift, which on a pre-fix clone is the only thing
     keeping the dock above the page, so a stale selector leaves it drawn in
     its own near-black pill, on a dark site, buried. Undressed and invisible
     are the same outcome. */
  function inspectorHost() {
    return (
      document.querySelector("[data-element-review-inspector]") ||
      document.querySelector("[data-inspect-comment]")
    );
  }

  if (CFG.inspect) {
    import("/__lb/inspect-comment.js")
      .then(function (m) {
        m.mount({ bridge: location.origin + "/__lb/bridge" });
        if (!dressDock(inspectorHost()))
          console.warn("[lightbox] the element inspector mounted but its dock could not be restyled: no known host attribute on the page");
      })
      .catch(function (err) {
        console.warn("[lightbox] the element inspector did not load:", err && err.message);
      });
  }
})();
