#!/usr/bin/env node
/**
 * The measurement pass.
 *
 *   node scripts/sweep.mjs --key <key> [--widths 390,768,1440] [--playwright <dir>]
 *   node scripts/sweep.mjs diff <before.json> <after.json>
 *   node scripts/sweep.mjs summary <a.json> [<b.json> ...]
 *   node scripts/sweep.mjs login --key <key> [--path /login]
 *
 * For every route of one project, at every width, through the project's review
 * port with the walker left out (the proxy honours `x-lightbox-bare`), it
 * records what a browser actually saw: status and redirects, console errors,
 * failed requests, horizontal overflow and its culprits, axe WCAG AA
 * violations, the document metadata, keyboard focus, declared motion against
 * the reduced-motion preference, and a full-page screenshot with its hash.
 *
 * lightbox itself has no dependencies, and this script keeps that promise: it
 * borrows Playwright and axe-core from a directory you name (`--playwright`, or
 * LIGHTBOX_PLAYWRIGHT), typically some other project's node_modules. Nothing
 * is installed here.
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
import { loadConfig, buildCatalogue } from "../src/catalogue.mjs";
import { routesFor } from "../src/routes.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
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

const args = parseArgs(process.argv.slice(2));
const sub = args._[0] && !args._[0].endsWith(".json") ? args._[0] : "run";

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

async function borrow(name, from) {
  const dir = from || process.env.LIGHTBOX_PLAYWRIGHT;
  if (!dir) {
    throw new Error(
      `No --playwright <dir> and no LIGHTBOX_PLAYWRIGHT. Point it at a directory whose node_modules holds ${name}.`
    );
  }
  const mod = path.join(dir, "node_modules", name);
  if (!fs.existsSync(mod)) throw new Error(`${name} is not under ${dir}/node_modules`);
  return mod;
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
  /webpack-hmr|_next\/webpack-hmr|turbopack-hmr/,
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
    await sleep(400);
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
        const r = await window.axe.run(document, {
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
          resultTypes: ["violations"],
        });
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
  if (!w || w.error) return { loaded: false };
  const meta = w.meta || {};
  const focus = w.focus || {};
  const motion = w.motion || {};
  const declared = (motion.keyframes || 0) + (motion.animated || 0) + (motion.transitions || 0) > 0;
  return {
    loaded: true,
    status: w.status,
    ok: w.status > 0 && w.status < 400,
    redirected: !!w.finalUrl,
    consoleErrors: (w.console?.errors?.length || 0) + (w.console?.pageErrors?.length || 0),
    failedRequests: (w.requests?.failed?.length || 0) + (w.requests?.bad?.length || 0),
    overflow: !!w.overflow?.over,
    contrast: w.axe?.contrast || 0,
    axeSerious: w.axe?.seriousOrCritical || 0,
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
    motionOk: !declared || (motion.reducedMotionRule && (motion.runningUnderReduce || 0) === 0),
  };
}

function totalsOf(routes, widths) {
  const t = { routes: routes.length, loads: 0, failedLoads: 0, redirects: 0, consoleErrors: 0, failedRequests: 0, overflow: 0, contrast: 0, axeSerious: 0, meta: 0, focus: 0, motion: 0 };
  for (const r of routes) {
    if (r.skipped) continue;
    let metaFail = false;
    for (const w of widths) {
      const c = checksOf(r.widths[w]);
      t.loads++;
      if (!c.loaded || !c.ok) {
        t.failedLoads++;
        continue;
      }
      if (c.redirected) t.redirects++;
      t.consoleErrors += c.consoleErrors;
      t.failedRequests += c.failedRequests;
      if (c.overflow) t.overflow++;
      t.contrast += c.contrast;
      t.axeSerious += c.axeSerious;
      if (!c.metaOk) metaFail = true;
      if (!c.focusOk) t.focus++;
      if (!c.motionOk) t.motion++;
    }
    if (metaFail) t.meta++;
  }
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
          c.contrast ? `contrast ${c.contrast}` : "",
          c.axeSerious ? `axe ${c.axeSerious}` : "",
          c.loaded && !c.metaOk ? `meta ${c.metaMissing.join(",")}` : "",
          c.loaded && !c.focusOk ? "focus" : "",
          c.loaded && !c.motionOk ? "motion" : "",
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
  console.log(`wrote ${path.relative(process.cwd(), out)}`);

  if (args.stop && project.kind === "node") {
    await fetch(`${hub}/api/stop/${key}`, { method: "POST" }).catch(() => {});
  }
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
  const shots = [];

  for (const r of after.routes) {
    const b = byPath.get(r.path);
    if (!b || r.skipped) continue;
    for (const w of after.widths) {
      const ca = checksOf(r.widths[w]);
      const cb = checksOf(b.widths?.[w]);
      if (!cb.loaded) continue;
      const cell = `${r.path}@${w}`;
      const cmp = (name, badA, badB, detail) => {
        if (badA && !badB) worse.push(`${cell} ${name}${detail ? " " + detail : ""}`);
        if (!badA && badB) better.push(`${cell} ${name}`);
      };
      cmp("load", !ca.loaded || !ca.ok, !cb.ok, ca.status ? `HTTP ${ca.status}` : r.widths[w]?.error);
      if (!ca.loaded) continue;
      cmp("console", ca.consoleErrors > cb.consoleErrors, false, `${cb.consoleErrors} -> ${ca.consoleErrors}`);
      if (ca.consoleErrors < cb.consoleErrors) better.push(`${cell} console ${cb.consoleErrors} -> ${ca.consoleErrors}`);
      cmp("requests", ca.failedRequests > cb.failedRequests, false, `${cb.failedRequests} -> ${ca.failedRequests}`);
      cmp("overflow", ca.overflow, cb.overflow);
      cmp("contrast", ca.contrast > cb.contrast, false, `${cb.contrast} -> ${ca.contrast}`);
      if (ca.contrast < cb.contrast) better.push(`${cell} contrast ${cb.contrast} -> ${ca.contrast}`);
      cmp("axe", ca.axeSerious > cb.axeSerious, false, `${cb.axeSerious} -> ${ca.axeSerious}`);
      cmp("meta", !ca.metaOk, !cb.metaOk, ca.metaMissing.join(","));
      cmp("focus", !ca.focusOk, !cb.focusOk);
      cmp("motion", !ca.motionOk, !cb.motionOk);
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
        ? `| ${j.key} | did not boot | ${(j.bootError || "").replace(/\|/g, "/").slice(0, 80)} | | | | | | | | |`
        : `| ${j.key} | ${t.routes} | ${t.loads - t.failedLoads}/${t.loads} | ${t.consoleErrors} | ${t.failedRequests} | ${t.overflow} | ${t.contrast} | ${t.axeSerious} | ${t.meta} | ${t.focus} | ${t.motion} |`
    );
  }
  console.log("| key | routes | loaded | console errors | failed requests | overflow | contrast nodes | axe serious | meta (routes) | focus | motion |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) console.log(r);
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

/* Only run as a CLI; `checksOf` is importable without side effects. */
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const main = { run, diff, summary, login }[sub];
  if (!main) {
    console.error(`unknown subcommand "${sub}"`);
    process.exit(2);
  }
  main().catch((e) => {
    console.error(e.stack || e.message);
    process.exit(1);
  });
}
