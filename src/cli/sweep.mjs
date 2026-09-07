#!/usr/bin/env node
/**
 * The measurement pass.
 *
 *   lightbox sweep --key <key> [--widths 390,768,1440] [--playwright <dir>]
 *   lightbox diff <before.json> <after.json>
 *   lightbox summary <a.json> [<b.json> ...]
 *   lightbox login --key <key> [--path /login]
 *
 * For every route of one project, at every width, through the project's review
 * port with the walker left out (the proxy honours `x-lightbox-bare`), it
 * records what a browser actually saw: status and redirects, console errors,
 * failed requests, horizontal overflow and its culprits, axe WCAG AA
 * violations, the document metadata, keyboard focus, declared motion against
 * the reduced-motion preference, and a full-page screenshot with its hash.
 *
 * lightbox itself has no runtime dependencies, and this keeps that promise:
 * Playwright and axe-core are resolved at call time, from your working
 * directory if you installed them there, or from a directory you name
 * (`--playwright`, or LIGHTBOX_PLAYWRIGHT). Nothing is installed here.
 *
 * Output is one JSON per project under .lightbox/audit/<key>.json and the
 * screenshots under .lightbox/shots/<key>/<label>/. `diff` compares two such
 * files check by check and exits 1 on any new failure, so a fix pass can be
 * gated on "nothing got worse".
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { loadConfig, buildCatalogue } from "../catalogue.mjs";
import { routesFor } from "../routes.mjs";

/**
 * Config and state resolve from the working directory, never from the package.
 *
 * `serve` always did this and the audit scripts never did, so an installed copy
 * would have read lightbox.config.json out of node_modules and tried to write
 * .lightbox/ in there. There is one working directory now, and it is yours.
 */
const ROOT = process.cwd();
const FIXED_TIME = new Date("2026-09-04T12:00:00Z");

/* ------------------------------------------------------------------ *
 * Arguments
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) args[key] = true;
      else {
        args[key] = next;
        i++;
      }
    } else args._.push(a);
  }
  return args;
}

let args = parseArgs(process.argv.slice(2));
let sub = args._[0] && !args._[0].endsWith(".json") ? args._[0] : "run";

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function slug(route) {
  const s = route.replace(/^\/+|\/+$/g, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "");
  return s || "index";
}

function trunc(s, n = 300) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n) + "..." : s;
}

/** Tag an error as a fixable setup problem rather than a bug in lightbox. */
export function expected(err) {
  err.expected = true;
  return err;
}

/**
 * Find playwright or axe-core, in the order that makes the common case work.
 *
 *   1. --playwright <dir> or LIGHTBOX_PLAYWRIGHT, kept because borrowing some
 *      other project's node_modules is a legitimate way to avoid a second copy
 *      of a browser, and the audit branches were all swept that way.
 *   2. Normal resolution from the working directory. This is the case that did
 *      not exist: a user who ran `npm i -D playwright axe-core` still had to
 *      pass a flag pointing at their own project.
 *
 * Neither is a static bare import, so scripts/check.mjs and the
 * no-runtime-dependencies promise both still hold.
 */
async function borrow(name, from) {
  const dir = from || process.env.LIGHTBOX_PLAYWRIGHT;
  if (dir) {
    const mod = path.join(dir, "node_modules", name);
    if (!fs.existsSync(mod)) throw expected(new Error(`${name} is not under ${dir}/node_modules`));
    return mod;
  }

  const req = createRequire(path.join(ROOT, "noop.js"));
  try {
    return path.dirname(req.resolve(`${name}/package.json`));
  } catch {
    // `expected` marks this as something the person running lightbox can fix,
    // so the CLI prints the instruction rather than a stack trace through it.
    throw expected(new Error(
      `sweep needs ${name} and could not find it.\n` +
        `  Install both where you run lightbox:\n` +
        `    npm i -D playwright axe-core && npx playwright install chromium\n` +
        `  Or borrow another project's copy:\n` +
        `    --playwright <dir whose node_modules holds them>, or LIGHTBOX_PLAYWRIGHT`
      )
    );
  }
}

async function loadPlaywright(from) {
  const mod = await borrow("playwright", from);
  const entry = fs.existsSync(path.join(mod, "index.mjs"))
    ? path.join(mod, "index.mjs")
    : path.join(mod, "index.js");
  return import(pathToFileURL(entry).href);
}

async function loadAxe(from) {
  const mod = await borrow("axe-core", from);
  return fs.readFileSync(path.join(mod, "axe.min.js"), "utf8");
}

async function findProject(key) {
  const { config } = await loadConfig(ROOT);
  const { projects } = buildCatalogue(config);
  const project = projects.find((p) => p.key === key);
  if (!project) throw new Error(`no project "${key}" in lightbox.config`);
  return project;
}

/* Boot through the hub so the sweep sees what the walker sees. */
async function ensureUp(project, hub) {
  if (project.kind !== "node") return { state: "static" };
  const state = async () => (await fetch(`${hub}/api/state/${project.key}`)).json();
  let st = await state();
  if (st.state !== "ready") {
    await fetch(`${hub}/api/start/${project.key}`, { method: "POST" });
    const t0 = Date.now();
    while (Date.now() - t0 < 180000) {
      await sleep(2000);
      st = await state();
      if (st.state === "ready" || st.state === "failed") break;
    }
  }
  return st;
}

/* Noise that is not the project's: the walker, the bridge, HMR chatter. */
const NOISE = [
  /\/__lb\//,
  /127\.0\.0\.1:7391/,
  /\[HMR\]/,
  /\[Fast Refresh\]/,
  /Download the React DevTools/,
  /webpack-hmr|_next\/webpack-hmr|turbopack-hmr|_next\/hmr\b/,
  /favicon\.ico/,
];
const isNoise = (s) => NOISE.some((re) => re.test(s));

/* ------------------------------------------------------------------ *
 * In-page measurement (serialised into the browser)
 * ------------------------------------------------------------------ */

function measureInPage() {
  const doc = document;
  const html = doc.documentElement;
  const innerWidth = window.innerWidth;

  /* overflow: who sticks out */
  const culprits = [];
  if (html.scrollWidth > innerWidth + 1) {
    const all = doc.body ? doc.body.querySelectorAll("*") : [];
    for (const el of all) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.right > innerWidth + 1) {
        const cls = typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
        culprits.push({ sel: el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + cls, right: Math.round(r.right), width: Math.round(r.width) });
      }
      if (culprits.length >= 200) break;
    }
    culprits.sort((a, b) => b.right - a.right);
  }

  /* meta */
  const metaDesc = doc.querySelector('meta[name="description"]');
  const viewport = doc.querySelector('meta[name="viewport"]');
  const meta = {
    lang: html.getAttribute("lang") || "",
    title: (doc.title || "").trim(),
    description: metaDesc ? (metaDesc.getAttribute("content") || "").trim().length : 0,
    viewport: viewport ? viewport.getAttribute("content") || "" : "",
    h1: doc.querySelectorAll("h1").length,
  };

  /* focusables */
  const FOCUSABLE = 'a[href],button,input,select,textarea,summary,[tabindex],[contenteditable="true"]';
  const stops = [];
  let positiveTabindex = 0;
  for (const el of doc.querySelectorAll(FOCUSABLE)) {
    if (el.disabled) continue;
    const ti = el.getAttribute("tabindex");
    if (ti !== null && Number(ti) < 0) continue;
    if (ti !== null && Number(ti) > 0) positiveTabindex++;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    stops.push(el);
  }

  /* motion: what the stylesheets declare */
  let keyframes = 0;
  let animated = 0;
  let transitions = 0;
  let reducedMotionRule = false;
  let unreadableSheets = 0;
  const walk = (rules) => {
    for (const rule of rules) {
      if (rule.type === CSSRule.KEYFRAMES_RULE) keyframes++;
      else if (rule.type === CSSRule.MEDIA_RULE) {
        if (/prefers-reduced-motion/.test(rule.conditionText || rule.media.mediaText)) reducedMotionRule = true;
        walk(rule.cssRules);
      } else if (rule.type === CSSRule.STYLE_RULE) {
        const st = rule.style;
        const an = st.getPropertyValue("animation-name");
        if (an && an !== "none") animated++;
        const td = st.getPropertyValue("transition-duration");
        if (td && /[1-9]/.test(td)) transitions++;
      } else if (rule.cssRules) walk(rule.cssRules);
    }
  };
  for (const sheet of doc.styleSheets) {
    try {
      walk(sheet.cssRules);
    } catch {
      unreadableSheets++;
    }
  }
  const running = typeof doc.getAnimations === "function" ? doc.getAnimations().filter((a) => a.playState === "running").length : -1;
  const framer = !!doc.querySelector("[data-framer-appear-id],[data-projection-id]");

  return {
    overflow: { scrollWidth: html.scrollWidth, innerWidth, over: html.scrollWidth > innerWidth + 1, culprits: culprits.slice(0, 5) },
    meta,
    focus: { stops: stops.length, positiveTabindex },
    motion: { keyframes, animated, transitions, reducedMotionRule, unreadableSheets, runningUnderReduce: running, framer },
    height: html.scrollHeight,
  };
}

function firstStopInPage() {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return { landed: false };
  const cs = getComputedStyle(el);
  const outline = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0;
  const shadow = cs.boxShadow && cs.boxShadow !== "none";
  const cls = typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
  return {
    landed: true,
    sel: el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + cls,
    text: (el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 40),
    focusVisible: el.matches(":focus-visible"),
    visible: outline || shadow,
    outline: cs.outline,
  };
}

/* ------------------------------------------------------------------ *
 * One route at one width
 * ------------------------------------------------------------------ */

/**
 * Wait for entrance animations to finish before measuring anything.
 *
 * This used to be a flat 400ms, which is shorter than a normal staggered
 * entrance, so axe read colours mid-fade and reported contrast failures that
 * were not there once the page settled: one element on one route came back at
 * 3.33, 3.67 and 4.15 on three widths, and did not fail at all when the page
 * was left alone. Infinite animations (a looping shimmer) never finish, so they
 * are ignored rather than waited on, and the whole wait is capped.
 */
async function settleAnimations(page, cap = 2500) {
  const started = Date.now();
  try {
    await page.waitForFunction(
      () => {
        if (typeof document.getAnimations !== "function") return true;
        return !document.getAnimations().some((a) => {
          if (a.playState !== "running") return false;
          const it = a.effect && a.effect.getTiming ? a.effect.getTiming().iterations : 1;
          return it !== Infinity;
        });
      },
      undefined,
      { timeout: cap, polling: 100 }
    );
  } catch {
    /* something loops or never settles: measure it as it is rather than hang */
  }
  // A frame or two for the last committed style to land.
  await sleep(Math.max(150, 400 - (Date.now() - started)));
}

async function sweepRoute(context, base, route, width, opts) {
  const page = await context.newPage();
  const consoleErrors = [];
  const consoleWarnings = [];
  const pageErrors = [];
  const failedRequests = [];
  const badResponses = [];

  page.on("console", (msg) => {
    const text = msg.text();
    if (isNoise(text)) return;
    const loc = msg.location();
    const entry = { text: trunc(text), at: loc && loc.url ? `${loc.url.replace(base, "")}:${loc.lineNumber}` : "" };
    if (msg.type() === "error") consoleErrors.push(entry);
    else if (msg.type() === "warning") consoleWarnings.push(entry);
  });
  page.on("pageerror", (err) => pageErrors.push(trunc(err.message)));
  page.on("requestfailed", (req) => {
    const url = req.url();
    if (isNoise(url)) return;
    failedRequests.push({ url: trunc(url.replace(base, ""), 200), error: req.failure() ? req.failure().errorText : "" });
  });
  page.on("response", (res) => {
    const url = res.url();
    if (isNoise(url)) return;
    if (res.status() >= 400) badResponses.push({ url: trunc(url.replace(base, ""), 200), status: res.status() });
  });

  const out = { status: 0, ms: 0 };
  const t0 = Date.now();
  try {
    await page.clock.setFixedTime(FIXED_TIME);
    const res = await page.goto(base + route.path, { waitUntil: "load", timeout: opts.timeout });
    out.status = res ? res.status() : 0;
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    await settleAnimations(page);
    const finalUrl = page.url();
    if (finalUrl !== base + route.path) out.finalUrl = finalUrl.replace(base, "");

    const m = await page.evaluate(measureInPage);
    Object.assign(out, m);

    /* keyboard: the first Tab from the top of the document */
    await page.evaluate(() => {
      if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
      window.scrollTo(0, 0);
    });
    await page.keyboard.press("Tab");
    out.focus.first = await page.evaluate(firstStopInPage);

    /* axe */
    try {
      await page.addScriptTag({ content: opts.axe });
      const axe = await page.evaluate(async () => {
        // Audit the page, not our own furniture. The overlay host and its reset
        // sheet are injected by src/overlay.js and are not the project's markup;
        // left in, they added three color-contrast nodes to every route of every
        // project and made the totals read as the project's own failures.
        const r = await window.axe.run(
          { exclude: [["[data-lightbox]"], ["[data-lightbox-reset]"]] },
          {
            runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
            resultTypes: ["violations"],
          }
        );
        return r.violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          tags: v.tags.filter((t) => /^wcag|best-practice/.test(t)),
          nodes: v.nodes.length,
          target: v.nodes[0] ? String(v.nodes[0].target[0]).slice(0, 120) : "",
          summary: v.nodes[0] && v.nodes[0].failureSummary ? v.nodes[0].failureSummary.split("\n").slice(0, 2).join(" ").slice(0, 200) : "",
        }));
      });
      const contrast = axe.filter((v) => v.id === "color-contrast").reduce((n, v) => n + v.nodes, 0);
      const serious = axe.filter((v) => v.id !== "color-contrast" && (v.impact === "serious" || v.impact === "critical"));
      out.axe = { violations: axe, contrast, seriousOrCritical: serious.length };
    } catch (e) {
      out.axe = { violations: [], contrast: 0, seriousOrCritical: 0, error: trunc(e.message, 160) };
    }

    /* the picture */
    if (opts.shotsDir) {
      const file = path.join(opts.shotsDir, `${slug(route.path)}@${width}.png`);
      fs.mkdirSync(opts.shotsDir, { recursive: true });
      const buf = await page.screenshot({ fullPage: true, animations: "disabled", caret: "hide", timeout: 60000 });
      fs.writeFileSync(file, buf);
      out.shot = path.relative(ROOT, file).split(path.sep).join("/");
      out.sha256 = sha256(buf);
    }
  } catch (e) {
    out.error = trunc(e.message, 240);
  } finally {
    out.ms = Date.now() - t0;
    out.console = { errors: dedupe(consoleErrors), warnings: dedupe(consoleWarnings).slice(0, 20), pageErrors: [...new Set(pageErrors)] };
    out.requests = { failed: dedupe(failedRequests), bad: dedupe(badResponses) };
    await page.close().catch(() => {});
  }
  return out;
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const x of list) {
    const k = JSON.stringify(x);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out.slice(0, 40);
}

/* ------------------------------------------------------------------ *
 * Pass/fail per check, shared by run (totals) and diff
 * ------------------------------------------------------------------ */

export function checksOf(w) {
  if (!w || w.error) return { loaded: false, axeMeasured: false, motionMeasured: false };
  const meta = w.meta || {};
  const focus = w.focus || {};
  const motion = w.motion || {};
  const declared = (motion.keyframes || 0) + (motion.animated || 0) + (motion.transitions || 0) > 0;
  // axe either ran or it threw, and a throw is recorded with zeroed counts.
  // Reading those zeros back as a result is how a crashed scan came to look
  // exactly like a clean page.
  const axeMeasured = !!w.axe && !w.axe.error;
  // A stylesheet the page cannot read (cross-origin, no CORS header) is a
  // stylesheet whose keyframes and transitions were never counted, so
  // "declares no motion" is not something this cell is entitled to say.
  const motionMeasured = (motion.unreadableSheets || 0) === 0;
  return {
    loaded: true,
    status: w.status,
    ok: w.status > 0 && w.status < 400,
    redirected: !!w.finalUrl,
    // Filtered again here so a sweep recorded before a noise pattern was
    // added reads the same as one recorded after it.
    consoleErrors: (w.console?.errors || []).filter((e) => !isNoise(e.text || "")).length + (w.console?.pageErrors || []).filter((e) => !isNoise(String(e))).length,
    // A request the browser itself cancelled (navigation, page close, a
    // superseded prefetch) is not a failure of the page.
    failedRequests: (w.requests?.failed || []).filter((q) => !/ERR_ABORTED/.test(q.error || "")).length + (w.requests?.bad?.length || 0),
    overflow: !!w.overflow?.over,
    axeMeasured,
    axeError: w.axe?.error || null,
    contrast: axeMeasured ? w.axe.contrast || 0 : null,
    axeSerious: axeMeasured ? w.axe.seriousOrCritical || 0 : null,
    metaOk: !!(meta.lang && meta.title && meta.description > 0 && meta.viewport && meta.h1 === 1),
    metaMissing: [
      !meta.lang && "lang",
      !meta.title && "title",
      !(meta.description > 0) && "description",
      !meta.viewport && "viewport",
      meta.h1 !== 1 && `h1=${meta.h1}`,
    ].filter(Boolean),
    focusOk: !(focus.positiveTabindex > 0) && (!focus.first?.landed || focus.first.visible || focus.first.focusVisible),
    motionDeclared: declared,
    motionMeasured,
    unreadableSheets: motion.unreadableSheets || 0,
    motionOk: !motionMeasured ? null : !declared || (motion.reducedMotionRule && (motion.runningUnderReduce || 0) === 0),
  };
}

const CHECKS = ["console", "requests", "overflow", "contrast", "axe", "meta", "focus", "motion"];

/**
 * A one-line verdict on whether the numbers beside it are measurements.
 *
 * The failure this exists for: a run where every route 500s produces
 * `contrast 0`, which is the same string a clean page produces. Nothing in the
 * output distinguished them, so a dead project read as a passing one.
 */
export function coverageLine(t) {
  const cov = t && t.coverage;
  if (!cov) return "coverage: unknown, this audit was written before coverage was recorded";
  if (cov.complete) return `coverage: complete, ${cov.cells} cells`;
  const parts = CHECKS.filter((k) => cov.byCheck[k] && cov.byCheck[k].unmeasured)
    .map((k) => `${k} ${cov.byCheck[k].unmeasured}/${cov.byCheck[k].measured + cov.byCheck[k].unmeasured}`);
  const why = [
    cov.failedLoads ? `${cov.failedLoads} loads failed` : "",
    cov.axeErrors ? `axe threw on ${cov.axeErrors} cells` : "",
    cov.unreadableSheetCells ? `${cov.unreadableSheetCells} cells had unreadable stylesheets` : "",
  ].filter(Boolean).join(", ");
  return `coverage: INCOMPLETE. Unmeasured cells: ${parts.join(", ")}${why ? ` (${why})` : ""}. A zero on those checks is not a measurement.`;
}

/** `12/36 unmeasured`, or `complete`. For table cells. */
export function coverageShort(t) {
  const cov = t && t.coverage;
  if (!cov) return "unknown";
  if (cov.complete) return "complete";
  const worst = CHECKS.map((k) => cov.byCheck[k]).filter(Boolean).reduce((a, b) => (b.unmeasured > a.unmeasured ? b : a));
  return `${worst.unmeasured}/${worst.measured + worst.unmeasured} unmeasured`;
}

export function totalsOf(routes, widths) {
  const t = { routes: routes.length, loads: 0, failedLoads: 0, redirects: 0, consoleErrors: 0, failedRequests: 0, overflow: 0, contrast: 0, axeSerious: 0, meta: 0, focus: 0, motion: 0 };
  const byCheck = {};
  for (const k of CHECKS) byCheck[k] = { measured: 0, unmeasured: 0 };
  let axeErrors = 0;
  let unreadableSheetCells = 0;

  for (const r of routes) {
    if (r.skipped) continue;
    let metaFail = false;
    for (const w of widths) {
      const c = checksOf(r.widths[w]);
      t.loads++;
      if (!c.loaded || !c.ok) {
        // Nothing was measured on this cell. Every check has to say so,
        // rather than each of them contributing a zero to the totals.
        t.failedLoads++;
        for (const k of CHECKS) byCheck[k].unmeasured++;
        continue;
      }
      if (c.redirected) t.redirects++;
      t.consoleErrors += c.consoleErrors;
      byCheck.console.measured++;
      t.failedRequests += c.failedRequests;
      byCheck.requests.measured++;
      if (c.overflow) t.overflow++;
      byCheck.overflow.measured++;
      if (c.axeMeasured) {
        t.contrast += c.contrast;
        t.axeSerious += c.axeSerious;
        byCheck.contrast.measured++;
        byCheck.axe.measured++;
      } else {
        byCheck.contrast.unmeasured++;
        byCheck.axe.unmeasured++;
        axeErrors++;
      }
      if (!c.metaOk) metaFail = true;
      byCheck.meta.measured++;
      if (!c.focusOk) t.focus++;
      byCheck.focus.measured++;
      if (c.motionMeasured) {
        if (!c.motionOk) t.motion++;
        byCheck.motion.measured++;
      } else {
        byCheck.motion.unmeasured++;
        unreadableSheetCells++;
      }
    }
    if (metaFail) t.meta++;
  }

  t.coverage = {
    cells: t.loads,
    loaded: t.loads - t.failedLoads,
    failedLoads: t.failedLoads,
    axeErrors,
    unreadableSheetCells,
    byCheck,
    complete: t.loads > 0 && CHECKS.every((k) => byCheck[k].unmeasured === 0),
  };
  return t;
}

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */

async function run() {
  const key = args.key;
  if (!key) throw new Error("--key <project> is required");
  const project = await findProject(key);
  const hub = args.hub || "http://localhost:4000";
  const widths = String(args.widths || "390,768,1440").split(",").map(Number).filter(Boolean);
  const label = args.label || "before";
  const out = args.out || path.join(ROOT, ".lightbox", "audit", `${key}${label === "before" ? "" : "." + label}.json`);
  const shotsDir = args["no-shots"] ? null : args.shots || path.join(ROOT, ".lightbox", "shots", key, label);
  const timeout = Number(args.timeout || 45000);
  const base = `http://127.0.0.1:${project.port}`;

  const st = await ensureUp(project, hub);
  if (project.kind === "node" && st.state !== "ready") {
    const result = { key, name: project.name, port: project.port, base, booted: false, bootState: st.state, bootError: st.error || trunc(String(st.log || "").split("\n").slice(-5).join(" | "), 400), widths, routes: [], totals: totalsOf([], widths), ranAt: new Date().toISOString() };
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(result, null, 2));
    console.log(`${key}: did not boot (${st.state}). ${result.bootError}`);
    console.log(coverageLine(result.totals));
    if (!args["allow-partial"]) process.exitCode = 2;
    return;
  }

  let routes = routesFor(project);
  if (args.routes) {
    const want = String(args.routes).split(",");
    routes = want.map((p) => routes.find((r) => r.path === p) || { path: p, dynamic: false, family: "/" + p.split("/")[1], layout: null, file: null });
  }
  if (args["max-routes"]) routes = routes.slice(0, Number(args["max-routes"]));

  const pw = await loadPlaywright(args.playwright);
  const axe = await loadAxe(args.playwright);
  const browser = await pw.chromium.launch({ headless: true });
  const ranAt = new Date().toISOString();
  const t0 = Date.now();
  const results = [];

  try {
    for (const width of widths) {
      const context = await browser.newContext({
        viewport: { width, height: width < 700 ? 844 : 900 },
        deviceScaleFactor: 1,
        reducedMotion: "reduce",
        colorScheme: args.dark ? "dark" : "light",
        ignoreHTTPSErrors: true,
        storageState: args["storage-state"] || undefined,
        locale: "en-GB",
        timezoneId: "Europe/Paris",
      });
      // The bare header goes only to the review port. As a context-wide extra
      // header it would ride along to fonts.gstatic.com and fail every CORS
      // preflight, and the sweep would then report errors the page never had.
      await context.route((url) => url.origin === base, (route) =>
        route.continue({ headers: { ...route.request().headers(), "x-lightbox-bare": "1" } })
      );
      for (const route of routes) {
        let entry = results.find((r) => r.path === route.path);
        if (!entry) {
          entry = { path: route.path, family: route.family, file: route.file, widths: {} };
          if (route.dynamic) entry.skipped = "dynamic segment without a params fill";
          results.push(entry);
        }
        if (entry.skipped) continue;
        const r = await sweepRoute(context, base, route, width, { axe, shotsDir, timeout });
        entry.widths[width] = r;
        const c = checksOf(r);
        const flags = [
          !c.loaded ? "LOAD" : !c.ok ? `HTTP ${c.status}` : "",
          c.redirected ? `-> ${r.finalUrl}` : "",
          c.consoleErrors ? `err ${c.consoleErrors}` : "",
          c.failedRequests ? `req ${c.failedRequests}` : "",
          c.overflow ? `overflow +${r.overflow.scrollWidth - r.overflow.innerWidth}` : "",
          c.loaded && c.ok && !c.axeMeasured ? `contrast/axe UNMEASURED (${trunc(c.axeError || "axe did not run", 60)})` : "",
          c.contrast ? `contrast ${c.contrast}` : "",
          c.axeSerious ? `axe ${c.axeSerious}` : "",
          c.loaded && !c.metaOk ? `meta ${c.metaMissing.join(",")}` : "",
          c.loaded && !c.focusOk ? "focus" : "",
          c.loaded && c.ok && !c.motionMeasured ? `motion UNMEASURED (${c.unreadableSheets} unreadable sheets)` : "",
          c.motionOk === false ? "motion" : "",
        ].filter(Boolean);
        console.log(`${key} ${String(width).padStart(4)} ${route.path.padEnd(44)} ${String(r.ms).padStart(6)}ms  ${flags.join("  ") || "ok"}${r.error ? "  " + r.error : ""}`);
      }
      await context.close();
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const result = {
    key,
    name: project.name,
    kind: project.kind,
    port: project.port,
    upstream: project.upstream,
    dir: project.dir,
    base,
    booted: true,
    label,
    widths,
    ranAt,
    tookMs: Date.now() - t0,
    routes: results,
    totals: totalsOf(results, widths),
    noisy: [],
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  const t = result.totals;
  console.log(`\n${key}: ${t.routes} routes, ${t.loads} loads (${t.failedLoads} failed), errors ${t.consoleErrors}, requests ${t.failedRequests}, overflow ${t.overflow}, contrast ${t.contrast}, axe ${t.axeSerious}, meta ${t.meta}, focus ${t.focus}, motion ${t.motion}. ${Math.round(result.tookMs / 1000)}s.`);
  console.log(coverageLine(t));
  console.log(`wrote ${path.relative(process.cwd(), out)}`);

  if (args.stop && project.kind === "node") {
    await fetch(`${hub}/api/stop/${key}`, { method: "POST" }).catch(() => {});
  }

  // 2, not 1: `diff` owns exit 1 and means "this got worse". This means
  // "do not read these numbers as a result yet".
  if (!t.coverage.complete && !args["allow-partial"]) process.exitCode = 2;
}

/* ------------------------------------------------------------------ *
 * diff
 * ------------------------------------------------------------------ */

function diff() {
  const [, beforeFile, afterFile] = args._;
  if (!beforeFile || !afterFile) throw new Error("diff <before.json> <after.json>");
  const before = JSON.parse(fs.readFileSync(beforeFile, "utf8"));
  const after = JSON.parse(fs.readFileSync(afterFile, "utf8"));
  const noisy = new Set([...(before.noisy || []), ...(after.noisy || [])]);
  const byPath = new Map(before.routes.map((r) => [r.path, r]));
  const worse = [];
  const better = [];
  const unmeasured = [];
  const shots = [];

  for (const r of after.routes) {
    const b = byPath.get(r.path);
    if (!b || r.skipped) continue;
    for (const w of after.widths) {
      const ca = checksOf(r.widths[w]);
      const cb = checksOf(b.widths?.[w]);
      const cell = `${r.path}@${w}`;
      if (!cb.loaded) {
        // No baseline for this cell, so nothing here can be called a
        // regression or a fix. Dropping it silently is what made a run
        // against a dead server look like a clean diff.
        unmeasured.push(`${cell} every check (no baseline: the before run did not load this cell)`);
        continue;
      }
      const cmp = (name, badA, badB, detail) => {
        if (badA && !badB) worse.push(`${cell} ${name}${detail ? " " + detail : ""}`);
        if (!badA && badB) better.push(`${cell} ${name}`);
      };
      cmp("load", !ca.loaded || !ca.ok, !cb.ok, ca.status ? `HTTP ${ca.status}` : r.widths[w]?.error);
      if (!ca.loaded) continue;
      cmp("console", ca.consoleErrors > cb.consoleErrors, false, `${cb.consoleErrors} -> ${ca.consoleErrors}`);
      if (ca.consoleErrors < cb.consoleErrors) better.push(`${cell} console ${cb.consoleErrors} -> ${ca.consoleErrors}`);
      cmp("requests", ca.failedRequests > cb.failedRequests, false, `${cb.failedRequests} -> ${ca.failedRequests}`);
      if (ca.failedRequests < cb.failedRequests) better.push(`${cell} requests ${cb.failedRequests} -> ${ca.failedRequests}`);
      cmp("overflow", ca.overflow, cb.overflow);
      // Comparing a measured count against an unmeasured one manufactures a
      // verdict out of a scan that never ran. Say so instead.
      if (ca.axeMeasured && cb.axeMeasured) {
        cmp("contrast", ca.contrast > cb.contrast, false, `${cb.contrast} -> ${ca.contrast}`);
        if (ca.contrast < cb.contrast) better.push(`${cell} contrast ${cb.contrast} -> ${ca.contrast}`);
        cmp("axe", ca.axeSerious > cb.axeSerious, false, `${cb.axeSerious} -> ${ca.axeSerious}`);
        if (ca.axeSerious < cb.axeSerious) better.push(`${cell} axe ${cb.axeSerious} -> ${ca.axeSerious}`);
      } else {
        unmeasured.push(`${cell} contrast/axe (${!cb.axeMeasured ? "before" : "after"}: ${trunc((!cb.axeMeasured ? cb.axeError : ca.axeError) || "axe did not run", 60)})`);
      }
      cmp("meta", !ca.metaOk, !cb.metaOk, ca.metaMissing.join(","));
      cmp("focus", !ca.focusOk, !cb.focusOk);
      if (ca.motionMeasured && cb.motionMeasured) cmp("motion", !ca.motionOk, !cb.motionOk);
      else unmeasured.push(`${cell} motion (unreadable stylesheets)`);
      const sa = r.widths[w]?.sha256;
      const sb = b.widths[w]?.sha256;
      if (sa && sb && sa !== sb) shots.push({ cell, noisy: noisy.has(r.path), before: b.widths[w].shot, after: r.widths[w].shot });
    }
  }

  console.log(`diff ${before.key}: ${path.basename(beforeFile)} -> ${path.basename(afterFile)}`);
  console.log(`\nworse (${worse.length})`);
  for (const l of worse) console.log("  " + l);
  console.log(`\nbetter (${better.length})`);
  for (const l of better) console.log("  " + l);
  console.log(`\nnot comparable (${unmeasured.length})`);
  for (const l of unmeasured) console.log("  " + l);
  console.log(`\nbefore ${coverageLine(before.totals)}`);
  console.log(`after  ${coverageLine(after.totals)}`);
  const real = shots.filter((s) => !s.noisy);
  console.log(`\nscreenshots changed (${shots.length}, ${real.length} on routes not declared noisy)`);
  for (const s of shots) console.log(`  ${s.cell}${s.noisy ? " (noisy)" : ""}  ${s.before}  ${s.after}`);
  process.exitCode = worse.length ? 1 : 0;
}

/* ------------------------------------------------------------------ *
 * summary (markdown)
 * ------------------------------------------------------------------ */

function summary() {
  const files = args._.filter((f) => f.endsWith(".json"));
  if (!files.length) throw new Error("summary <a.json> [...]");
  const rows = [];
  for (const f of files) {
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    const t = j.totals || {};
    rows.push(
      j.booted === false
        ? `| ${j.key} | did not boot | ${(j.bootError || "").replace(/\|/g, "/").slice(0, 80)} | | | | | | | | | nothing measured |`
        : `| ${j.key} | ${t.routes} | ${t.loads - t.failedLoads}/${t.loads} | ${t.consoleErrors} | ${t.failedRequests} | ${t.overflow} | ${t.contrast} | ${t.axeSerious} | ${t.meta} | ${t.focus} | ${t.motion} | ${coverageShort(t)} |`
    );
  }
  console.log("| key | routes | loaded | console errors | failed requests | overflow | contrast nodes | axe serious | meta (routes) | focus | motion | coverage |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) console.log(r);
  console.log("\nA number in a row whose coverage is not `complete` is a partial count. The checks it could not run contributed nothing, not zero.");
}

/* ------------------------------------------------------------------ *
 * login: a headed browser, you sign in, the storage state is kept
 * ------------------------------------------------------------------ */

async function login() {
  const key = args.key;
  if (!key) throw new Error("--key <project> is required");
  const project = await findProject(key);
  const hub = args.hub || "http://localhost:4000";
  await ensureUp(project, hub);
  const pw = await loadPlaywright(args.playwright);
  const browser = await pw.chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${project.port}${args.path || "/login"}`);
  const outFile = args.out || path.join(ROOT, ".lightbox", "auth", `${key}.json`);
  console.log(`Sign in in the browser window, then press Enter here to save ${path.relative(process.cwd(), outFile)}.`);
  await new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin });
    rl.once("line", () => {
      rl.close();
      resolve();
    });
  });
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  await context.storageState({ path: outFile });
  await browser.close();
  console.log(`saved. Run the sweep with --storage-state ${path.relative(process.cwd(), outFile)}`);
}

/* ------------------------------------------------------------------ */

const SUBCOMMANDS = { run, diff, summary, login };

/**
 * Entry point for `bin/lightbox.mjs`. `name` is the subcommand the CLI already
 * matched, so `lightbox sweep --key x` and `lightbox diff a.json b.json` both
 * land here without the caller re-deriving it from argv.
 */
export async function main(name, argv) {
  args = parseArgs(argv);
  sub = name;
  const fn = SUBCOMMANDS[name];
  if (!fn) throw new Error(`unknown sweep subcommand "${name}"`);
  return fn();
}

/* Still runnable directly. `checksOf` stays importable without side effects. */
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const fn = SUBCOMMANDS[sub];
  if (!fn) {
    console.error(`unknown subcommand "${sub}"`);
    process.exit(2);
  }
  Promise.resolve().then(fn).catch((e) => {
    console.error(e.stack || e.message);
    process.exit(1);
  });
}
