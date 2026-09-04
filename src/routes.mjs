/**
 * Route discovery, so "go through every page" is a list and not a memory test.
 *
 * Next App Router: every app/**\/page.* is a route. Route groups "(marketing)"
 * vanish from the URL, parallel slots "@modal" are not routes on their own, and
 * api/ is not a page. Pages Router: every pages/**\/*.tsx that is not _app,
 * _document or api. Vite/CRA/Astro: src/pages/**, else just "/". Static: every
 * .html under the root.
 *
 * Dynamic segments are kept with their brackets intact rather than dropped. A
 * [person] route with no slug is still worth knowing exists, and the config's
 * `params` fills in the ones you have real values for.
 *
 * Every route also carries a `family`: its first path segment, or the
 * directory for static HTML. /admin and /admin/* are one family, /login is
 * its own. Fifty-five pages are usually a dozen templates with different data
 * in them, and the family is what lets a reviewer take one page of each before
 * the rest. App Router routes also carry `layout`, the nearest layout above
 * them, for anything that wants the finer cut. The list is grouped by family,
 * in order of each family's first appearance.
 */

import fs from "node:fs";
import path from "node:path";

const PAGE_FILES = new Set([
  "page.tsx", "page.ts", "page.jsx", "page.js", "page.mdx", "page.md",
]);
const LAYOUT_FILES = ["layout.tsx", "layout.ts", "layout.jsx", "layout.js"];
const PAGE_EXT = [".tsx", ".ts", ".jsx", ".js", ".mdx", ".astro", ".svelte", ".vue"];
const SKIP_DIRS = new Set([
  "node_modules", ".next", ".git", "api", "__tests__", "__mocks__", "components",
  "lib", "utils", "hooks", "styles", "dist", "build", "out", "coverage",
  ".turbo", ".vercel", ".svelte-kit", ".astro", "public", "assets", "static",
]);

function walk(dir, depth, onFile, maxDepth = 8) {
  if (depth > maxDepth) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      walk(full, depth + 1, onFile, maxDepth);
    } else {
      onFile(full, e.name);
    }
  }
}

/** Same walk, but nothing is skipped. Static roots are often public/ or assets/. */
function walkAll(dir, depth, onFile, maxDepth = 6) {
  if (depth > maxDepth) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      walkAll(full, depth + 1, onFile, maxDepth);
    } else {
      onFile(full, e.name);
    }
  }
}

function segmentsToRoute(rel) {
  const parts = rel.split(path.sep).filter(Boolean);
  const out = [];
  for (const p of parts) {
    if (p.startsWith("(") && p.endsWith(")")) continue; // route group
    if (p.startsWith("@")) return null;                 // parallel slot
    if (p.startsWith("_")) return null;                 // private folder
    out.push(p);
  }
  return "/" + out.join("/");
}

function fillParams(route, params) {
  if (!params) return route;
  return route.replace(/\[{1,2}(\.{3})?([^\]]+)\]{1,2}/g, (m, spread, name) => {
    const clean = name.replace(/^\.{3}/, "");
    return params[clean] != null ? String(params[clean]) : m;
  });
}

const relFile = (project, full) => path.relative(project.dir, full).split(path.sep).join("/");

/* ------------------------------------------------------------------ *
 * Families
 * ------------------------------------------------------------------ */

function hasLayout(dir) {
  return LAYOUT_FILES.some((f) => fs.existsSync(path.join(dir, f)));
}

/** Route groups stay in the family name, so "(marketing)" and "(app)" are two. */
function familyName(rel) {
  return "/" + rel.split(path.sep).filter(Boolean).join("/");
}

function nearestLayoutFamily(appRoot, pageDir) {
  let cur = pageDir;
  for (;;) {
    if (hasLayout(cur)) return familyName(path.relative(appRoot, cur));
    if (cur === appRoot) return "/";
    const parent = path.dirname(cur);
    if (parent === cur) return "/";
    cur = parent;
  }
}

/** The first path segment, or the root. */
function familyOf(route) {
  const segs = route.split("/").filter(Boolean);
  return segs.length ? "/" + segs[0] : "/";
}

/* ------------------------------------------------------------------ *
 * Discovery. Each returns Map<route, {family, file}>.
 * ------------------------------------------------------------------ */

function discoverAppRouter(project) {
  const found = new Map();
  for (const appRoot of [
    path.join(project.dir, "app"),
    path.join(project.dir, "src", "app"),
  ]) {
    if (!fs.existsSync(appRoot)) continue;
    walk(appRoot, 0, (full, name) => {
      if (!PAGE_FILES.has(name)) return;
      const dir = path.dirname(full);
      const route = segmentsToRoute(path.relative(appRoot, dir));
      if (route === null) return;
      found.set(route, {
        family: familyOf(route),
        layout: nearestLayoutFamily(appRoot, dir),
        file: relFile(project, full),
      });
    });
  }
  return found;
}

function discoverPagesRouter(project) {
  const found = new Map();
  for (const pagesRoot of [
    path.join(project.dir, "pages"),
    path.join(project.dir, "src", "pages"),
  ]) {
    if (!fs.existsSync(pagesRoot)) continue;
    walk(pagesRoot, 0, (full, name) => {
      const ext = path.extname(name);
      if (!PAGE_EXT.includes(ext)) return;
      const base = path.basename(name, ext);
      if (base.startsWith("_") || base.endsWith(".d")) return;
      let rel = path.relative(pagesRoot, full);
      rel = rel.slice(0, rel.length - ext.length);
      if (path.basename(rel) === "index") rel = path.dirname(rel);
      if (rel === "." || rel === "") rel = "";
      const route = segmentsToRoute(rel);
      if (route === null) return;
      found.set(route, { family: familyOf(route), layout: null, file: relFile(project, full) });
    });
  }
  return found;
}

function discoverStatic(project) {
  const found = new Map();
  walkAll(project.dir, 0, (full, name) => {
    if (!name.toLowerCase().endsWith(".html")) return;
    const rel = relFile(project, full);
    const dir = path.posix.dirname("/" + rel);
    // about.html is served at /about and docs/index.html at /docs, so that is
    // what the walk shows and what the browser's URL bar will say. The file
    // column keeps the real name.
    const base = path.posix.basename(rel).slice(0, -5);
    const route = base.toLowerCase() === "index" ? dir : path.posix.join(dir, base);
    found.set(route, { family: dir, layout: null, file: rel });
  });
  return found;
}

/** "/" leads, then shallow before deep, then alphabetical. */
function order(routes) {
  return routes.sort((a, b) => {
    if (a === "/") return -1;
    if (b === "/") return 1;
    const da = a.split("/").length;
    const db = b.split("/").length;
    if (da !== db) return da - db;
    return a.localeCompare(b);
  });
}

const cache = new Map();

export function routesFor(project) {
  if (cache.has(project.key)) return cache.get(project.key);

  let meta = new Map();
  try {
    if (project.kind === "static") {
      meta = discoverStatic(project);
    } else {
      meta = new Map([...discoverAppRouter(project), ...discoverPagesRouter(project)]);
    }
  } catch {
    meta = new Map();
  }

  const declared = project.routes || [];
  const merged = order([...meta.keys()]);
  const seen = new Set();
  const list = [];
  for (const r of [...declared, ...merged]) {
    const filled = fillParams(r, project.params);
    if (seen.has(filled)) continue;
    seen.add(filled);
    const m = meta.get(r) || { family: familyOf(filled), layout: null, file: null };
    list.push({
      path: filled,
      dynamic: /\[[^\]]+\]/.test(filled),
      family: m.family,
      layout: m.layout,
      file: m.file,
    });
  }
  if (!list.length) list.push({ path: "/", dynamic: false, family: "/", layout: null, file: null });

  // Group by family without disturbing the order inside one. Declared routes
  // come first in `list`, so their families lead the walk as well.
  const famOrder = [];
  for (const e of list) if (!famOrder.includes(e.family)) famOrder.push(e.family);
  list.sort((a, b) => famOrder.indexOf(a.family) - famOrder.indexOf(b.family));

  cache.set(project.key, list);
  return list;
}

/** The families in a route list, in walk order, with their sizes. */
export function familiesOf(routes) {
  const out = [];
  const byName = new Map();
  routes.forEach((r, i) => {
    let f = byName.get(r.family);
    if (!f) {
      f = { family: r.family, count: 0, first: i };
      byName.set(r.family, f);
      out.push(f);
    }
    f.count++;
  });
  return out;
}

export function clearRouteCache(key) {
  if (key) cache.delete(key);
  else cache.clear();
}
