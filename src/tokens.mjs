/**
 * Compare a project's DESIGN.md token table against the stylesheets it names.
 *
 * Every DESIGN.md in these repos opens by naming one stylesheet as the single
 * source of truth and then tabulates the tokens read out of it. That pairing is
 * the thing that rots: a token gets recoloured in CSS and the table keeps
 * quoting the old hex, or a token is dropped from CSS and the table keeps
 * promising it. Either way the next person reads a value that no longer paints.
 *
 * `check()` reports three kinds of drift:
 *
 *   stale         documented with one value, defined in CSS with another
 *   missing       documented but defined nowhere in the project's CSS
 *   undocumented  defined in CSS, absent from the table
 *
 * The first two are defects. The third is informational: private helper tokens
 * legitimately go untabulated, so it is counted but never failed on.
 */

import fs from "node:fs";
import path from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "dist", "build", "out", "coverage", ".turbo", "vendor"]);

/** Every .css file in the project, minus build output and dependencies. */
export function stylesheets(dir, depth = 0, acc = []) {
  if (depth > 6) return acc;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) stylesheets(full, depth + 1, acc);
    } else if (e.name.endsWith(".css")) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Pull `--token` / value pairs out of the markdown tables.
 *
 * The table shape varies between projects (Hex vs Value in the header, a
 * parenthetical after the token name in some), so the token is taken from the
 * first cell and the value from whichever of the next two cells looks like a
 * value. A cell like "(see globals.css)" is a deliberate deferral, not a value,
 * and is skipped rather than reported as drift.
 *
 * Skipping is the dangerous outcome here, because an unparsed row and a
 * matching row are both silence. So every skipped row is recorded on the
 * returned Map as `.skipped`, and the caller reports them rather than counting
 * them as passes.
 */
/**
 * Expand "rgba(255,255,255,.035 / .06)" into one full value per half, by taking
 * the components before the "/" as the shared prefix and swapping the last one.
 */
function splitPaired(value, inner) {
  const parts = inner[2].split(",").map((s) => s.trim());
  const last = parts.pop();
  const alts = last.split("/").map((s) => s.trim());
  return alts.map((a) => `${inner[1]}(${[...parts, a].join(", ")})`);
}

export function documented(md) {
  const out = new Map();
  const skipped = [];
  for (const line of md.split(/\r?\n/)) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 2) continue;
    // A row may document two related tokens at once, with their values in the
    // same cell separated by "/": "`--sl-glass` / `--sl-glass-2`" against
    // "rgba(255,255,255,.035 / .06)". Pair them positionally so both are
    // checked, rather than testing the first name against the whole cell.
    const names = [...cells[0].matchAll(/`(--[a-z0-9-]+)`/gi)].map((m) => m[1]);
    if (names.length === 0) continue;
    let took = false;
    for (const cell of cells.slice(1, 3)) {
      // The value may carry a trailing gloss: "`#C8A96E` (gold)". Requiring the
      // backticks to be the whole cell silently skipped that row, and skipping
      // is the worst outcome here because it reads as a pass. innovation-portal
      // documented a gold --accent that way while the CSS had moved to an
      // off-white, and the check reported the project as matching.
      const v = /^`([^`]+)`/.exec(cell);
      if (!v) continue;
      const value = v[1].trim();
      if (!/^(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|oklch\(|color-mix\(|var\(|[0-9])/i.test(value)) continue;
      const inner = /^(rgba?|hsla?)\(([^)]*)\)$/i.exec(value);
      const halves = inner && inner[2].includes("/") ? splitPaired(value, inner) : null;
      if (names.length > 1 && halves && halves.length === names.length) {
        names.forEach((n, i) => out.set(n, halves[i]));
      } else {
        for (const n of names) out.set(n, value);
      }
      took = true;
      break;
    }
    if (!took) skipped.push({ names, cells: cells.slice(1, 3) });
  }
  out.skipped = skipped;
  return out;
}

/**
 * Every `--token: value` definition across the project's stylesheets, keeping
 * all of them rather than the first.
 *
 * A token is normally defined more than once: `:root` holds the light value and
 * a `prefers-color-scheme: dark` or `[data-theme='dark']` block holds the dark
 * one. Which of those a DESIGN.md tabulates is the author's choice and both are
 * correct, so taking the first definition reports a whole dark palette as
 * drifted. Claybrook documents its dark values and its `:root` is light: that
 * is a table of ten tokens which all read as stale under a first-wins rule and
 * none of which have drifted at all.
 *
 * So a token counts as matching when the documented value is painted by any of
 * its definitions.
 */
export function declarations(css) {
  const out = [];
  const stack = [];
  let buf = "";
  const flush = () => {
    const m = /^\s*(--[a-z0-9-]+)\s*:\s*([\s\S]+?)\s*$/i.exec(buf);
    buf = "";
    if (!m) return;
    const at = stack.filter((s) => s.startsWith("@"));
    const sel = [...stack].reverse().find((s) => !s.startsWith("@")) || "";
    out.push({ name: m[1], value: m[2], selector: sel, atRules: at });
  };
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      i = end === -1 ? css.length : end + 1;
      buf = "";
      continue;
    }
    if (c === "{") {
      stack.push(buf.trim().replace(/\s+/g, " "));
      buf = "";
      continue;
    }
    if (c === "}") {
      flush();
      stack.pop();
      continue;
    }
    if (c === ";") {
      flush();
      continue;
    }
    buf += c;
  }
  return out;
}

/**
 * Where a declaration sits, in one string: "@media (min-width: 900px) .card".
 * An empty context is a top-level `:root`, which needs no annotation.
 */
export function contextOf(d) {
  return [...d.atRules, d.selector === ":root" || d.selector === "html" ? "" : d.selector].filter(Boolean).join(" ");
}

export function defined(files) {
  const out = new Map();
  for (const file of files) {
    let css;
    try {
      css = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const d of declarations(css)) {
      if (!out.has(d.name)) out.set(d.name, []);
      const list = out.get(d.name);
      // The same value in two different blocks is one value as far as drift is
      // concerned, but the contexts are kept: a token redefined at three widths
      // is a responsive ladder, and a single-width measurement that reports it
      // as an override is wrong about what it saw.
      const seen = list.find((x) => x.value === d.value);
      const ctx = contextOf(d);
      if (seen) {
        if (ctx && !seen.contexts.includes(ctx)) seen.contexts.push(ctx);
      } else {
        list.push({ value: d.value, file, contexts: ctx ? [ctx] : [], conditional: d.atRules.length > 0 });
      }
    }
  }
  return out;
}

/**
 * Compare two colour values as colours, not as strings.
 *
 * The two sides are written by different hands and spell the same colour
 * differently: `rgba(255,255,255,.09)` in a table against
 * `rgba(255, 255, 255, 0.09)` in the stylesheet is one value, and reporting it
 * as drift sends someone to fix a file that is already correct. So case,
 * whitespace, a bare leading decimal point, a trailing alpha of 1, and #abc
 * shorthand are all normalised away before comparing.
 *
 * A documented cell listing two values ("rgba(...,.035 / .06)", one token used
 * at two opacities) matches if either half does.
 */
export function same(a, b) {
  const norm = (s) =>
    s
      .toLowerCase()
      .replace(/\s+/g, "")
      .replace(/(^|[(,])\./g, "$10.")
      .replace(/,1\)$/, ")")
      .replace(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/, (_, r, g, bl) => `#${r}${r}${g}${g}${bl}${bl}`);
  const left = String(a).split("/");
  // Only split on "/" when it separates whole values, never inside rgb(a / b).
  const parts = left.length > 1 && !/\(/.test(left[0]) ? left : [a];
  return parts.some((p) => norm(p) === norm(b)) || norm(a) === norm(b);
}

export function check(key, dir) {
  const mdPath = ["DESIGN.md", path.join("docs", "DESIGN.md")]
    .map((p) => path.join(dir, p))
    .find((p) => fs.existsSync(p));
  if (!mdPath) return { key, dir, doc: null, unchecked: "no DESIGN.md or docs/DESIGN.md" };

  const doc = documented(fs.readFileSync(mdPath, "utf8"));
  const skippedRows = doc.skipped || [];
  if (doc.size === 0) {
    return { key, dir, doc: path.relative(dir, mdPath), unchecked: "DESIGN.md has no parseable token table", skippedRows };
  }

  // No guard on an empty stylesheet list: with nothing defined, every
  // documented token reports as missing, which is loud. Silence is the failure
  // mode worth guarding against, and this is not one.
  const css = defined(stylesheets(dir));

  // Follow aliases before comparing. innovation-portal defines `--bg` as
  // `var(--bg-dark)`, so a table quoting a hex for it looks like drift against
  // the alias and hides whether the hex behind the alias is right. It was not:
  // the table said #0A0A0A and --bg-dark is #0D0B09. Resolved to a depth of 3,
  // which covers every chain in these repos without risking a cycle.
  for (const defs of css.values()) {
    for (const d of defs) {
      let seen = 0;
      let v = d.value;
      let hop;
      while (seen++ < 3 && (hop = /^var\(\s*(--[a-z0-9-]+)\s*\)$/i.exec(v))) {
        const target = css.get(hop[1]);
        if (!target || !target.length) break;
        v = target[0].value;
      }
      if (v !== d.value) d.resolved = v;
    }
  }
  const stale = [];
  const missing = [];
  for (const [name, want] of doc) {
    const defs = css.get(name);
    if (!defs) {
      missing.push({ name, want });
    } else if (!defs.some((d) => same(want, d.value) || (d.resolved && same(want, d.resolved)))) {
      stale.push({
        name,
        want,
        got: defs
          .map((d) => {
            const v = d.resolved ? `${d.value} = ${d.resolved}` : d.value;
            // Naming the block matters when the definitions disagree: "in
            // @media (prefers-color-scheme: dark)" is the difference between a
            // stale table and a table that documented the other half.
            return d.contexts.length ? `${v} in ${d.contexts.join(", ")}` : v;
          })
          .join(" / "),
        file: path.relative(dir, defs[0].file).replace(/\\/g, "/"),
        conditionalOnly: defs.every((d) => d.conditional),
      });
    }
  }
  const undocumented = [...css.keys()].filter((n) => !doc.has(n));

  return { key, dir, doc: path.relative(dir, mdPath), documented: doc.size, definedCount: css.size, stale, missing, undocumented, skippedRows };
}