/**
 * overlay.js is the whole user-facing surface and had no executing test.
 *
 * What is worth pinning here is not the drawing, it is the walk arithmetic: the
 * dynamic-route skip, the sessionStorage recovery that exists because deriving
 * the position from location alone breaks on any redirecting route, the gate
 * threshold, and the keyboard map. Every one of those is a rule someone worked
 * out from a real site behaving badly, and none of them is obvious enough to
 * survive an edit unwatched.
 *
 * No jsdom, because zero runtime dependencies is a hard constraint and
 * scripts/check.mjs enforces it. node:vm is a builtin, and the overlay only
 * touches about a dozen DOM calls, so the stub below is smaller than the
 * argument for a library would be.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, "..", "src", "overlay.js"), "utf8");

/** Enough of an element for the overlay to build its chrome out of. */
function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    attrs: {},
    style: {},
    listeners: {},
    className: "",
    textContent: "",
    innerHTML: "",
    title: "",
    hidden: false,
    type: "",
    href: "",
    shadow: null,
    classList: {
      _has: new Set(),
      add(c) {
        this._has.add(c);
      },
      remove(c) {
        this._has.delete(c);
      },
      contains(c) {
        return this._has.has(c);
      },
      toggle(c, on) {
        const want = on == null ? !this._has.has(c) : !!on;
        if (want) this._has.add(c);
        else this._has.delete(c);
        return want;
      },
    },
    setAttribute(k, v) {
      this.attrs[k] = String(v);
    },
    getAttribute(k) {
      return k in this.attrs ? this.attrs[k] : null;
    },
    appendChild(c) {
      this.children.push(c);
      return c;
    },
    append(...cs) {
      this.children.push(...cs);
    },
    attachShadow() {
      this.shadow = makeEl("shadow-root");
      return this.shadow;
    },
    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    },
    /** Fire a listener the overlay registered, as a click or a key would. */
    fire(type, ev = {}) {
      for (const fn of this.listeners[type] || []) fn({ preventDefault() {}, ...ev });
    },
  };
  el.style.cssText = "";
  return el;
}

/** Every element the overlay made, flattened, so a test can find one by class. */
function walk(el, out = []) {
  out.push(el);
  if (el.shadow) walk(el.shadow, out);
  for (const c of el.children) walk(c, out);
  return out;
}

/**
 * Run overlay.js against a stub page.
 * @param {object} o
 * @param {object} o.cfg   window.__LIGHTBOX
 * @param {string} o.path  the pathname the browser actually landed on
 * @param {object} o.store seed for sessionStorage
 */
function run({ cfg = {}, path: pathname = "/", search = "", store = {} } = {}) {
  const body = makeEl("body");
  const head = makeEl("head");
  const made = [];
  const fetches = [];
  const warnings = [];

  // The inspector's exposed queue tag, which the capture path watches. Tests
  // that do not arm capture never touch it.
  const queueTag = { textContent: "[]" };
  const observers = [];

  const document = {
    head,
    body,
    documentElement: makeEl("html"),
    listeners: {},
    createElement(tag) {
      const el = makeEl(tag);
      if (tag === "canvas") {
        el.width = 0;
        el.height = 0;
        el.getContext = () => ({ drawImage() {} });
        el.toDataURL = () => "data:image/jpeg;base64,AAAA";
      }
      if (tag === "video") {
        el.play = async () => {};
        // A real stream reports the captured surface in device pixels. Zero
        // here means frameOf() correctly refuses to encode an empty canvas.
        el.videoWidth = 1920;
        el.videoHeight = 1048;
      }
      made.push(el);
      return el;
    },
    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    },
    getElementById: (id) => (id === "element-review-inspector-queue" ? queueTag : null),
    // Nothing in these tests installs an inspector, and the overlay is expected
    // to cope with that: it is the "no known host attribute" branch.
    querySelector: () => ({
      getBoundingClientRect: () => ({ x: 1, y: 2, width: 3, height: 4 }),
    }),
  };

  const location = {
    pathname,
    search,
    origin: "http://localhost:4008",
    href: `http://localhost:4008${pathname}${search}`,
  };

  const storage = new Map(Object.entries(store));
  const sessionStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  };

  const win = {
    // `inspect` off: the dynamic import of the inspector is a network fetch and
    // a separate package, and neither belongs in a unit test of the walk.
    __LIGHTBOX: { inspect: false, ...cfg },
    scrollY: 0,
    innerWidth: 1536,
    innerHeight: 838,
  };

  const track = { listeners: {}, stop() {}, addEventListener(t, fn) { this.listeners[t] = fn; } };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const picker = { calls: 0, deny: false };

  const sandbox = {
    window: win,
    document,
    location,
    sessionStorage,
    console: { warn: (...a) => warnings.push(a.join(" ")) },
    fetch: (url, init) => {
      fetches.push({ url, init });
      return Promise.resolve({
        ok: true,
        json: async () => ({ file: "C:/shots/frame-" + fetches.length + ".jpg" }),
      });
    },
    navigator: {
      mediaDevices: {
        getDisplayMedia: async () => {
          picker.calls++;
          if (picker.deny) throw new Error("NotAllowedError");
          return stream;
        },
      },
    },
    MutationObserver: class {
      constructor(fn) {
        this.fn = fn;
        observers.push(this);
      }
      observe() {}
      disconnect() {}
    },
    JSON,
    Set,
    Object,
    Number,
    String,
    Array,
    Math,
    Date,
  };
  sandbox.window.location = location;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: "overlay.js" });

  // The bar is only appended once there is a body, which there is.
  const host = body.children[0];
  const all = walk(host);
  const byClass = (c) => all.filter((e) => e.className.split(" ").includes(c));

  /** Put a queue on the page and tell the observer it changed, as the inspector does. */
  const setQueue = (selectors) => {
    queueTag.textContent = JSON.stringify(selectors.map((s) => ({ descriptor: { selector: s } })));
    observers.forEach((o) => o.fn());
  };

  return {
    host,
    all,
    byClass,
    made,
    fetches,
    warnings,
    location,
    storage,
    document,
    setQueue,
    picker,
    track,
    win,
  };
}

const ROUTES = [
  { path: "/", family: "home" },
  { path: "/career", family: "page" },
  { path: "/work/[slug]", family: "work", dynamic: true },
  { path: "/brand", family: "page" },
];

test("the bar mounts into a shadow root on a marked host", () => {
  const o = run({ cfg: { key: "arios", routes: ROUTES } });
  assert.equal(o.host.getAttribute("data-lightbox"), "");
  assert.ok(o.host.shadow, "the chrome is isolated from the page's stylesheet");
  assert.equal(o.byClass("bar").length, 1);
});

test("next steps over a dynamic route instead of navigating to a literal [slug]", () => {
  const o = run({ cfg: { key: "arios", routes: ROUTES }, path: "/career" });
  const next = o.byClass("nav").find((e) => e.textContent === "›");

  next.fire("click");
  assert.equal(
    o.location.href,
    "/brand",
    "index 1 -> 3: a dev server answers /work/[slug] by compiling for seconds and then 404ing"
  );
  assert.equal(o.storage.get("lightbox:walk:arios"), "3", "and the walk carries its intent across");
});

test("prev from the first route does nothing rather than wrapping", () => {
  const o = run({ cfg: { key: "arios", routes: ROUTES }, path: "/" });
  const prev = o.byClass("nav").find((e) => e.textContent === "‹");
  prev.fire("click");
  assert.equal(o.location.href, "http://localhost:4008/", "unchanged");
});

test("a redirect does not reset the walk to whatever route the landing path is", () => {
  // The bug this exists for: /career 307s to /login, whose pathname is not in
  // the route list, and deriving position from location alone put the walk
  // back at the top of the list, so next cycled the first few routes forever.
  const o = run({
    cfg: { key: "arios", routes: ROUTES },
    path: "/login",
    store: { "lightbox:walk:arios": "1" },
  });

  const pt = o.byClass("path")[0];
  assert.ok(pt.textContent.includes("→"), "the disagreement is shown, not papered over");
  assert.ok(pt.textContent.includes("/login"), "the landed path is shown as-is");

  // And the walk continues from where it meant to be, not from the landing.
  const next = o.byClass("nav").find((e) => e.textContent === "›");
  next.fire("click");
  assert.equal(o.location.href, "/brand", "index 1 -> 3, still skipping the dynamic route");
});

test("one redirect is a redirect, several onto the same page is a gate and says so", () => {
  const first = run({
    cfg: { key: "arios", routes: ROUTES },
    path: "/login",
    store: { "lightbox:walk:arios": "1" },
  });
  assert.equal(first.byClass("gate")[0].hidden, true, "one is not yet a story");

  const gateState = first.storage.get("lightbox:walk:arios:gate");
  assert.deepEqual(JSON.parse(gateState), { at: "/login", n: 1 });

  const second = run({
    cfg: { key: "arios", routes: ROUTES },
    path: "/login",
    store: { "lightbox:walk:arios": "3", "lightbox:walk:arios:gate": gateState },
  });
  const gate = second.byClass("gate")[0];
  assert.equal(gate.hidden, false);
  assert.ok(gate.textContent.includes("2 routes"), "it names the count: " + gate.textContent);
  assert.ok(gate.textContent.includes("/login"));
});

test("reaching a route the walk did not send you to clears the gate", () => {
  const o = run({
    cfg: { key: "arios", routes: ROUTES },
    path: "/brand",
    store: { "lightbox:walk:arios": "3", "lightbox:walk:arios:gate": '{"at":"/login","n":2}' },
  });
  assert.equal(o.byClass("gate")[0].hidden, true);
  assert.equal(o.storage.has("lightbox:walk:arios:gate"), false, "the streak is over");
});

/**
 * Setting location.href in a real browser navigates, which re-runs the overlay
 * on the next page. The stub does not, so each chord is pressed on its own
 * instance rather than chained; chaining would test a page state that never
 * exists.
 */
function press(o, code, extra = {}) {
  o.document.listeners.keydown.forEach((fn) =>
    fn({ altKey: true, code, preventDefault() {}, ...extra })
  );
}

test("the Alt keymap walks, jumps family, marks and leaves", () => {
  const at = (p) =>
    run({ cfg: { key: "arios", routes: ROUTES, hub: "http://localhost:4000/" }, path: p });

  const home = at("/");
  press(home, "BracketRight");
  assert.equal(home.location.href, "/career", "Alt+] is next");

  const career = at("/career");
  press(career, "BracketLeft");
  assert.equal(career.location.href, "/", "Alt+[ is prev");

  // Families are contiguous, so next family from "home" is the first "page".
  const fam = at("/");
  press(fam, "BracketRight", { shiftKey: true });
  assert.equal(fam.location.href, "/career", "Alt+Shift+] is the next family");

  // Worth pinning because it surprises: from /career the next differing family
  // is "work", but every route in it is dynamic, so the skip carries on and
  // lands on /brand, which is back in the family we started in. The jump is
  // "first route of a different family, then skip what cannot be visited", not
  // "first visitable route of a different family".
  const last = at("/career");
  press(last, "BracketRight", { shiftKey: true });
  assert.equal(last.location.href, "/brand");

  const mark = at("/");
  press(mark, "KeyM");
  assert.equal(mark.fetches.length, 1, "Alt+M posts exactly one tick");
  assert.equal(mark.fetches[0].url, "/__lb/progress");
  assert.deepEqual(JSON.parse(mark.fetches[0].init.body), { route: "/", reviewed: true });

  const leave = at("/");
  press(leave, "KeyH");
  assert.equal(leave.location.href, "http://localhost:4000/", "Alt+H is the hub");
});

test("a modified Alt chord is the browser's, not ours", () => {
  const o = run({ cfg: { key: "arios", routes: ROUTES }, path: "/" });
  o.document.listeners.keydown.forEach((fn) =>
    fn({ altKey: true, ctrlKey: true, code: "BracketRight", preventDefault() {} })
  );
  assert.equal(o.location.href, "http://localhost:4008/", "Ctrl+Alt+] is left alone");
});

test("marking twice unmarks, and the second tick says so", () => {
  const o = run({ cfg: { key: "arios", routes: ROUTES, reviewed: [] }, path: "/" });
  const mark = o.all.find((e) => e.title && e.title.includes("Alt+M"));

  mark.fire("click");
  assert.deepEqual(JSON.parse(o.fetches[0].init.body), { route: "/", reviewed: true });
  assert.equal(mark.textContent, "reviewed");

  mark.fire("click");
  assert.deepEqual(JSON.parse(o.fetches[1].init.body), { route: "/", reviewed: false });
  assert.equal(mark.textContent, "mark done");
});

/* ------------------------------------------------------------------ *
 * Capture
 * ------------------------------------------------------------------ */

const CAP = { key: "arios", routes: ROUTES, shots: true };
const armed = (o) => o.byClass("shots")[0];
const tick = () => new Promise((r) => setImmediate(r));

test("the shots button is hidden unless the server offers somewhere to put frames", () => {
  assert.equal(run({ cfg: { key: "arios", routes: ROUTES } }).byClass("shots")[0].hidden, true);
  assert.equal(run({ cfg: CAP }).byClass("shots")[0].hidden, false);
});

test("arming asks once, then every new note captures itself", async () => {
  const o = run({ cfg: CAP });
  armed(o).fire("click");
  await tick();

  assert.equal(o.picker.calls, 1, "one consent");
  assert.equal(armed(o).classList.contains("on"), true);
  assert.equal(armed(o).textContent, "shots on");

  o.setQueue(["h1"]);
  await tick();
  const posts = o.fetches.filter((f) => f.url === "/__lb/shot");
  assert.equal(posts.length, 1, "and no second prompt");

  const body = JSON.parse(posts[0].init.body);
  assert.equal(body.selector, "h1");
  assert.deepEqual(body.rect, { x: 1, y: 2, width: 3, height: 4 }, "the element is coordinates");
  assert.deepEqual(body.viewport, { width: 1536, height: 838 }, "the image is the whole viewport");
  assert.ok(body.dataUrl.startsWith("data:image/jpeg"), "JPEG: nine PNGs would breach the body caps");
});

test("notes already queued when you arm are not captured with today's screen", async () => {
  const o = run({ cfg: CAP });
  // The inspector restores its queue from sessionStorage on load, so a page
  // reload mid-review starts with notes already on the page.
  o.setQueue(["h1", "nav > span"]);
  armed(o).fire("click");
  await tick();
  assert.equal(o.fetches.filter((f) => f.url === "/__lb/shot").length, 0);

  o.setQueue(["h1", "nav > span", "footer"]);
  await tick();
  const posts = o.fetches.filter((f) => f.url === "/__lb/shot");
  assert.equal(posts.length, 1, "only the new one");
  assert.equal(JSON.parse(posts[0].init.body).selector, "footer");
});

test("a second note on an unscrolled page references the first frame instead of resending it", async () => {
  const o = run({ cfg: CAP });
  armed(o).fire("click");
  await tick();

  o.setQueue(["h1"]);
  await tick();
  o.setQueue(["h1", "nav > span"]);
  await tick();

  const posts = o.fetches.filter((f) => f.url === "/__lb/shot").map((f) => JSON.parse(f.init.body));
  assert.equal(posts.length, 2);
  assert.ok(posts[0].dataUrl, "the first carries the frame");
  assert.equal(posts[1].dataUrl, undefined, "the second does not");
  assert.equal(posts[1].ref, posts[0].frame, "it points at the frame already on the server");

  // Scrolling makes it a different screen, so the bytes go again.
  o.win.scrollY = 900;
  o.setQueue(["h1", "nav > span", "footer"]);
  await tick();
  const third = JSON.parse(o.fetches.filter((f) => f.url === "/__lb/shot")[2].init.body);
  assert.ok(third.dataUrl, "a different screen is a different frame");
});

test("deleting a queued note does not make the next one capture twice", async () => {
  const o = run({ cfg: CAP });
  armed(o).fire("click");
  await tick();

  o.setQueue(["h1", "nav > span"]);
  await tick();
  o.setQueue(["h1"]);
  await tick();
  o.setQueue(["h1", "footer"]);
  await tick();

  const posts = o.fetches.filter((f) => f.url === "/__lb/shot").map((f) => JSON.parse(f.init.body));
  assert.deepEqual(posts.map((p) => p.selector), ["h1", "nav > span", "footer"]);
});

test("dismissing the picker leaves the button off, and nothing is captured", async () => {
  const o = run({ cfg: CAP });
  o.picker.deny = true;
  armed(o).fire("click");
  await tick();

  assert.equal(armed(o).classList.contains("on"), false, "declining is a decision, not a fault");
  assert.equal(armed(o).textContent, "shots");
  o.setQueue(["h1"]);
  await tick();
  assert.equal(o.fetches.filter((f) => f.url === "/__lb/shot").length, 0);
});

test("ending the share from the browser's own bar puts the button back", async () => {
  const o = run({ cfg: CAP });
  armed(o).fire("click");
  await tick();
  assert.equal(armed(o).classList.contains("on"), true);

  // Without this the button reads "on" over a dead track and every later note
  // silently gets a black frame.
  o.track.listeners.ended();
  assert.equal(armed(o).classList.contains("on"), false);

  o.setQueue(["h1"]);
  await tick();
  assert.equal(o.fetches.filter((f) => f.url === "/__lb/shot").length, 0);
});

test("clicking again disarms, and stops the track rather than leaving it live", async () => {
  const o = run({ cfg: CAP });
  let stopped = 0;
  o.track.stop = () => stopped++;

  armed(o).fire("click");
  await tick();
  armed(o).fire("click");
  await tick();

  assert.equal(stopped, 1, "the browser's sharing indicator must go away");
  assert.equal(armed(o).classList.contains("on"), false);
});

test("no design tokens is a warning, not a silently unstyled bar", () => {
  const o = run({ cfg: { key: "arios", routes: ROUTES } });
  assert.ok(
    o.warnings.some((w) => w.includes("no design tokens")),
    "the proxy failing to pass tokens must be visible"
  );
});
