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
    "*{box-sizing:border-box;font-family:var(--sans)}",

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
    "color:var(--ink-2);font:10px/1 var(--mono);text-transform:uppercase;",
    "letter-spacing:var(--track-caps);padding:10px 11px;cursor:pointer}",
    "button:first-child{border-left:0}",
    "button:hover{background:var(--paper-tint);color:var(--ink)}",
    "button:disabled{color:var(--rule-ink);cursor:default;background:transparent}",
    "button:focus-visible{outline:2px solid var(--vermilion);outline-offset:-3px}",
    ".nav{font-size:13px;letter-spacing:0;padding:10px 9px}",

    ".label{display:flex;gap:10px;align-items:center;padding:8px 12px;cursor:pointer;",
    "max-width:48vw;border-left:1px solid var(--rule-ink)}",
    ".label:hover{background:var(--paper-tint)}",
    ".name{font:400 13px/1.2 var(--display);font-stretch:condensed;text-transform:uppercase;",
    "letter-spacing:.05em;color:var(--ink)}",
    ".count{font:10px/1 var(--mono);color:var(--ink-3);letter-spacing:var(--track-caps);",
    "text-transform:uppercase;font-variant-numeric:tabular-nums;flex:none}",
    ".path{font:11px/1 var(--mono);color:var(--ink-2);overflow:hidden;",
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
    ".sheet h4{margin:0;padding:13px 15px 10px;font:400 15px/1.1 var(--display);",
    "font-stretch:condensed;text-transform:uppercase;letter-spacing:var(--track-caps);color:var(--ink)}",
    /* The ornament again, once, exactly where the masthead ends. */
    ".sheet .band{height:var(--ornament-height);background:var(--ornament) repeat-x left center;",
    "margin:0 15px 4px}",
    ".sheet a{display:flex;gap:10px;align-items:center;padding:7px 15px;color:var(--ink-2);",
    "text-decoration:none;font:11.5px/1.4 var(--mono);border-bottom:1px solid var(--rule-ink-2)}",
    ".sheet a:hover{color:var(--ink);background:var(--paper-tint)}",
    /* Where you are, marked in the margin the way a proof is marked. */
    ".sheet a.here{color:var(--ink);background:var(--paper-tint);",
    "box-shadow:inset 3px 0 0 var(--vermilion)}",
    ".sheet a .p{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".sheet a .dyn{color:var(--ink-3);font-size:9.5px;text-transform:uppercase;",
    "letter-spacing:var(--track-caps);flex:none;margin-left:auto}",
    ".fam{padding:11px 15px 3px;color:var(--ink-3);font:9.5px/1.6 var(--mono);",
    "text-transform:uppercase;letter-spacing:var(--track-micro)}",
    ".foot{padding:11px 15px 13px;color:var(--ink-3);font:10px/1.9 var(--mono);",
    "border-top:2px solid var(--ink)}",
    "kbd{border:1px solid var(--rule-ink);background:var(--paper-2);padding:1px 4px;",
    "color:var(--ink-2);font:9.5px/1 var(--mono)}",
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

  var hub = document.createElement("button");
  hub.type = "button";
  hub.textContent = "hub";
  hub.title = "Back to the hub (Alt+H)";

  bar.appendChild(prev);
  bar.appendChild(label);
  bar.appendChild(next);
  bar.appendChild(mark);
  bar.appendChild(hub);
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
    lastFam = null;
    routes.forEach(function (r, i) {
      if (r.family && r.family !== lastFam) {
        lastFam = r.family;
        var n = 0;
        for (var k = 0; k < routes.length; k++) if (routes[k].family === r.family) n++;
        if (famCount > 1 && n > 1) {
          var fh = document.createElement("div");
          fh.className = "fam";
          fh.textContent = r.family + " · " + n;
          sheet.appendChild(fh);
        }
      }
      var a = document.createElement("a");
      a.href = r.path;
      if (i === index) a.className = "here";
      var d = document.createElement("span");
      d.className = "dot" + (reviewed.has(r.path) ? "" : " todo");
      var p = document.createElement("span");
      p.className = "p";
      p.textContent = r.path;
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
      "<kbd>Alt</kbd>+<kbd>M</kbd> mark done &nbsp; <kbd>Alt</kbd>+<kbd>H</kbd> hub &nbsp; <kbd>Alt</kbd>+<kbd>C</kbd> inspect and comment";
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

       Fixing it here means giving the host the z-index its contents already
       assume. Above lightbox's own bar, because while you are inspecting, the
       thing you are inspecting with belongs on top. */
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
      "font:10px/1 var(--mono);text-transform:uppercase;letter-spacing:var(--track-caps);",
      "padding:10px 11px}",
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

  if (CFG.inspect) {
    import("/__lb/inspect-comment.js")
      .then(function (m) {
        m.mount({ bridge: location.origin + "/__lb/bridge" });
        if (!dressDock(document.querySelector("[data-inspect-comment]")))
          console.warn("[lightbox] inspect-comment mounted but its dock could not be restyled");
      })
      .catch(function (err) {
        console.warn("[lightbox] inspect-comment did not load:", err && err.message);
      });
  }
})();
