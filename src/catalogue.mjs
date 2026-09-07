/**
 * The catalogue: what to serve, and on which ports.
 *
 * Two ways in. `projects` lists things explicitly. `scan` points at a directory
 * and lets lightbox work out what is in it, which is what makes the tool
 * useful on a machine that is not the author's: nobody is going to hand-write
 * forty entries.
 *
 * Ports are assigned here, once, and never negotiated later. A project keeps
 * the same review port across restarts as long as the catalogue order holds,
 * because a URL you have bookmarked mid-review should still be that project
 * tomorrow.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULTS = {
  hubPort: 4000,
  reviewPortBase: 4001,
  upstreamPortBase: 3100,
  bridge: "http://127.0.0.1:7391",
  inspectComment: "auto",
  // The branch `lightbox handover` reads fix commits from, in every project.
  // It used to be a date-stamped constant compiled into the script.
  auditBranch: "audit/front-end",
  // Origins allowed to read /api/state cross-origin. Empty means none, which
  // is the right default for a server on loopback that any page in your
  // browser can address. See corsHeaders in src/hub.mjs.
  hubOrigins: [],
  scan: [],
  projects: [],
  groups: [],
};

/* ------------------------------------------------------------------ *
 * Framework detection
 *
 * Read from package.json rather than from the file tree, because "has an
 * app/ directory" is true of plenty of things that are not Next apps, and a
 * wrong runner produces a spawn that fails a minute later with no clue why.
 * ------------------------------------------------------------------ */

const RUNNERS = [
  { dep: "next", runner: "next" },
  { dep: "@remix-run/dev", runner: "remix" },
  { dep: "astro", runner: "astro" },
  { dep: "@sveltejs/kit", runner: "vite" },
  { dep: "nuxt", runner: "nuxt" },
  { dep: "react-scripts", runner: "cra" },
  { dep: "vite", runner: "vite" },
];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function detectRunner(dir) {
  const pkg = readJson(path.join(dir, "package.json"));
  if (!pkg) return null;
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const { dep, runner } of RUNNERS) if (deps[dep]) return runner;
  // A package.json with a dev script but no framework we know. Fall back to
  // `npm run dev` and let the project's own script decide, honouring PORT.
  if (pkg.scripts && pkg.scripts.dev) return "npm";
  return null;
}

/** Shallow hunt for html, so a directory of mockups registers as a static site. */
function hasHtml(dir, depth = 2) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (e.isFile() && e.name.toLowerCase().endsWith(".html")) return true;
  }
  if (depth <= 0) return false;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    if (hasHtml(path.join(dir, e.name), depth - 1)) return true;
  }
  return false;
}

function slug(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Turn one directory into a project entry, or null if it is not a front end. */
export function classify(dir, extra = {}) {
  if (!fs.existsSync(dir)) return null;
  const runner = detectRunner(dir);
  const name = extra.name || path.basename(dir);
  if (runner) {
    return {
      key: extra.key || slug(name),
      name,
      kind: "node",
      runner,
      dir: dir.split(path.sep).join("/"),
      hasModules: fs.existsSync(path.join(dir, "node_modules")),
      ...extra,
    };
  }
  if (hasHtml(dir)) {
    return {
      key: extra.key || slug(name),
      name,
      kind: "static",
      dir: dir.split(path.sep).join("/"),
      hasModules: true,
      ...extra,
    };
  }
  return null;
}

/** Walk one `scan` rule and classify every directory it names. */
function runScan(rule) {
  const root = rule.dir;
  const found = [];
  if (!fs.existsSync(root)) return found;

  if (rule.depth === 0) {
    const p = classify(root, { group: rule.group });
    return p ? [p] : [];
  }

  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }
  const exclude = new Set(rule.exclude || []);
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    if (exclude.has(e.name)) continue;
    const dir = path.join(root, e.name);
    const p = classify(dir, { group: rule.group });
    if (p) found.push(p);
    else if ((rule.depth || 1) > 1) {
      // One more level, for monorepos: apps/*, packages/*.
      for (const sub of ["apps", "packages", "sites", "web"]) {
        const subdir = path.join(dir, sub);
        if (!fs.existsSync(subdir)) continue;
        for (const child of fs.readdirSync(subdir, { withFileTypes: true })) {
          if (!child.isDirectory()) continue;
          const cp = classify(path.join(subdir, child.name), {
            group: rule.group,
            name: `${e.name}/${child.name}`,
          });
          if (cp) found.push(cp);
        }
      }
    }
  }
  return found;
}

/* ------------------------------------------------------------------ *
 * Loading
 * ------------------------------------------------------------------ */

export async function loadConfig(cwd = process.cwd()) {
  const candidates = [
    path.join(cwd, "lightbox.config.mjs"),
    path.join(cwd, "lightbox.config.json"),
  ];
  let raw = null;
  let from = null;
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    from = file;
    if (file.endsWith(".mjs")) {
      const mod = await import(pathToFileURL(file).href);
      raw = mod.default || mod.config || mod;
    } else {
      raw = readJson(file);
    }
    break;
  }
  if (!raw) {
    const err = new Error(
      `No lightbox.config.json or .mjs in ${cwd}. Run \`lightbox init\` to write one.`
    );
    err.code = "ENOCONFIG";
    throw err;
  }
  return { config: { ...DEFAULTS, ...raw }, from };
}

/**
 * Merge explicit projects with scanned ones and assign ports.
 * Explicit entries win on key collision: a hand-written note and a chosen
 * group beat anything inferred from a directory name.
 */
export function buildCatalogue(config) {
  const byKey = new Map();

  for (const rule of config.scan || []) {
    for (const p of runScan(rule)) if (!byKey.has(p.key)) byKey.set(p.key, p);
  }
  for (const raw of config.projects || []) {
    const dir = raw.dir;
    const base = dir ? classify(dir, {}) || {} : {};
    const merged = {
      kind: base.kind || "static",
      runner: base.runner,
      hasModules: base.hasModules !== false,
      ...base,
      ...raw,
      key: raw.key || base.key || slug(raw.name || "project"),
    };
    merged.exists = !!dir && fs.existsSync(dir);
    // A `command` means "start this", which is a node project by definition,
    // even when nothing in package.json says which framework it is.
    if (merged.command && !raw.kind) merged.kind = "node";
    byKey.set(merged.key, merged);
  }

  const list = [...byKey.values()];
  let review = config.reviewPortBase ?? DEFAULTS.reviewPortBase;
  let upstream = config.upstreamPortBase ?? DEFAULTS.upstreamPortBase;

  for (const p of list) {
    p.exists = p.exists ?? fs.existsSync(p.dir);
    p.hasModules =
      p.kind === "static" ? true : fs.existsSync(path.join(p.dir, "node_modules"));
    if (p.port == null) p.port = review++;
    else review = Math.max(review, p.port + 1);
    if (p.kind === "node") {
      if (p.upstream == null) p.upstream = upstream++;
      else upstream = Math.max(upstream, p.upstream + 1);
    }
    p.group = p.group || "ungrouped";
  }

  const groups = [...(config.groups || [])];
  const known = new Set(groups.map((g) => g.id));
  for (const p of list) {
    if (!known.has(p.group)) {
      known.add(p.group);
      groups.push({ id: p.group, title: p.group, blurb: "" });
    }
  }

  return { projects: list, groups };
}

/**
 * Where to read inspect-comment from. "auto" checks, in order: a local
 * node_modules install, a sibling clone, then the tool's own parent directory.
 * Returns null when it cannot be found, which is a warning and not a failure:
 * lightbox still serves every page, just without the overlay.
 */
export function resolveInspectComment(config, cwd = process.cwd()) {
  const explicit = config.inspectComment;
  if (explicit && explicit !== "auto") {
    return fs.existsSync(explicit) ? explicit : null;
  }
  const rel = ["src", "inspect-comment.js"];
  const candidates = [
    path.join(cwd, "node_modules", "inspect-comment", ...rel),
    path.join(cwd, "..", "inspect-comment", ...rel),
    path.join(cwd, "..", "..", "inspect-comment", ...rel),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}
