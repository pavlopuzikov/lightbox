import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check, defined, documented, same, stylesheets } from "../src/tokens.mjs";

/** Build a throwaway project: a DESIGN.md and one or more stylesheets. */
function project(md, sheets) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lightbox-tokens-"));
  fs.writeFileSync(path.join(dir, "DESIGN.md"), md);
  for (const [rel, css] of Object.entries(sheets)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, css);
  }
  return dir;
}

const TABLE = (rows) => `# Test\n\n| Token | Hex | Usage |\n|---|---|---|\n${rows}\n`;

test("a token whose documented value is painted is not drift", () => {
  const dir = project(TABLE("| `--bg` | `#0A0A0A` | page |"), { "app/globals.css": ":root { --bg: #0A0A0A; }" });
  const r = check("t", dir);
  assert.deepEqual(r.stale, []);
  assert.deepEqual(r.missing, []);
});

test("a recoloured token is reported as stale, with both values", () => {
  const dir = project(TABLE("| `--bg` | `#0A0A0A` | page |"), { "app/globals.css": ":root { --bg: #f7f3ea; }" });
  const r = check("t", dir);
  assert.equal(r.stale.length, 1);
  assert.equal(r.stale[0].name, "--bg");
  assert.equal(r.stale[0].want, "#0A0A0A");
  assert.match(r.stale[0].got, /#f7f3ea/);
});

test("a documented token defined in no stylesheet is missing, not stale", () => {
  const dir = project(TABLE("| `--gold` | `#C8A96E` | accent |"), { "app/globals.css": ":root { --bg: #000; }" });
  const r = check("t", dir);
  assert.deepEqual(r.stale, []);
  assert.equal(r.missing.length, 1);
  assert.equal(r.missing[0].name, "--gold");
});

test("documenting the dark value of a light/dark pair is not drift", () => {
  // Claybrook tabulates its dark palette while :root is light. Taking the first
  // definition reported all ten of its tokens as stale when none had moved.
  const dir = project(TABLE("| `--bg` | `#16130f` | page |"), {
    "app/globals.css": ":root { --bg: #f6f1e7; }\n@media (prefers-color-scheme: dark) { :root { --bg: #16130f; } }",
  });
  assert.deepEqual(check("t", dir).stale, []);
});

test("a token aliased through var() is compared against what the alias resolves to", () => {
  // innovation-portal defines --bg as var(--bg-dark). Without resolving the
  // hop, the real drift behind the alias stays invisible.
  const ok = project(TABLE("| `--bg` | `#0D0B09` | page |"), {
    "app/globals.css": ":root { --bg-dark: #0D0B09; --bg: var(--bg-dark); }",
  });
  assert.deepEqual(check("t", ok).stale, []);

  const drifted = project(TABLE("| `--bg` | `#0A0A0A` | page |"), {
    "app/globals.css": ":root { --bg-dark: #0D0B09; --bg: var(--bg-dark); }",
  });
  const r = check("t", drifted);
  assert.equal(r.stale.length, 1);
  assert.match(r.stale[0].got, /#0D0B09/);
});

test("a row documenting two tokens at two opacities checks both", () => {
  // splatlas writes "`--sl-glass` / `--sl-glass-2`" against
  // "rgba(255,255,255,.035 / .06)" in one row.
  const md = TABLE("| `--sl-glass` / `--sl-glass-2` | `rgba(255,255,255,.035 / .06)` | glass |");
  assert.equal(documented(md).size, 2);
  const dir = project(md, {
    "app/tokens.css": ":root { --sl-glass: rgba(255, 255, 255, 0.035); --sl-glass-2: rgba(255, 255, 255, 0.06); }",
  });
  assert.deepEqual(check("t", dir).stale, []);
});

test("the same colour spelled two ways compares equal", () => {
  assert.ok(same("rgba(255,255,255,.09)", "rgba(255, 255, 255, 0.09)"));
  assert.ok(same("#ABC", "#aabbcc"));
  assert.ok(!same("#0A0A0A", "#0D0B09"));
});

test("a DESIGN.md with no token table reports as unchecked, not as a pass", () => {
  const dir = project("# Test\n\nProse only, no table.\n", { "app/globals.css": ":root { --bg: #000; }" });
  assert.equal(check("t", dir).unchecked, "DESIGN.md has no parseable token table");
});

test("a project with no DESIGN.md reports as unchecked, not as nothing to report", () => {
  // It used to return null and the CLI dropped the project, so a run where no
  // configured directory had a DESIGN.md printed "0 tokens drifted" and exited 0.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lightbox-tokens-"));
  assert.equal(check("t", dir).unchecked, "no DESIGN.md or docs/DESIGN.md");
});

test("node_modules is not scanned for stylesheets", () => {
  const dir = project(TABLE("| `--bg` | `#0A0A0A` | page |"), {
    "node_modules/pkg/app.css": ":root { --bg: #0A0A0A; }",
  });
  // The only definition is inside a dependency, so the token counts as missing.
  assert.equal(check("t", dir).missing.length, 1);
});

test("a value cell with a trailing gloss is read, not skipped", () => {
  // "`#C8A96E` (gold)". Requiring the whole cell to be backticked skipped the
  // row entirely, which reads as a pass and hid a real drift.
  const md = TABLE("| `--accent` (gold) | `#C8A96E` (gold) | primary accent |");
  assert.equal(documented(md).get("--accent"), "#C8A96E");
  const dir = project(md, { "app/globals.css": ":root { --accent: #F2ECE0; }" });
  assert.equal(check("t", dir).stale.length, 1);
});

test("a token redeclared at three widths is a ladder, and the report says so", () => {
  // A responsive ladder used to be indistinguishable from an override: the
  // scan kept name and value and threw the block away, so `--gap: 8px` in a
  // media query read exactly like a second `:root` fighting the first.
  const dir = project(TABLE("| `--gap` | `24px` | spacing |"), {
    "app.css": ":root { --gap: 8px; }\n@media (min-width: 768px) { :root { --gap: 16px; } }\n@media (min-width: 1200px) { :root { --gap: 24px; } }\n",
  });
  const r = check("t", dir);
  assert.equal(r.stale.length, 0, "24px is painted at the widest step, so nothing has drifted");

  const defs = defined(stylesheets(dir));
  const gap = defs.get("--gap");
  assert.equal(gap.length, 3);
  assert.deepEqual(gap.map((d) => d.conditional), [false, true, true]);
  assert.deepEqual(gap[2].contexts, ["@media (min-width: 1200px)"]);
});

test("the drift report names the block a value came from", () => {
  const dir = project(TABLE("| `--bg` | `#ffffff` | page |"), {
    "app.css": ":root { --bg: #111111; }\n@media (prefers-color-scheme: dark) { :root { --bg: #000000; } }\n",
  });
  const r = check("t", dir);
  assert.equal(r.stale.length, 1);
  assert.match(r.stale[0].got, /#000000 in @media \(prefers-color-scheme: dark\)/);
  assert.equal(r.stale[0].conditionalOnly, false, "one of the two definitions is unconditional");
});

test("a declaration inside a comment is not a declaration", () => {
  const dir = project(TABLE("| `--bg` | `#ffffff` | page |"), {
    "app.css": "/* --bg: #000000; the old value */\n:root { --bg: #ffffff; }\n",
  });
  assert.equal(check("t", dir).stale.length, 0);
});
