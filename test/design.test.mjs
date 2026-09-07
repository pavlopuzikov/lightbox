import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TOKENS, rootCss, hostCss, token } from "../src/design.mjs";
import { check } from "../src/tokens.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

/* Every file that draws lightbox's own chrome. The proxy is in here because
   the pages it serves itself, the directory index and the 404 and the "not
   running" page, are the ones you land on when something is wrong, and they
   were the last surfaces still styled from hex literals typed inline. */
const SURFACES = ["src/hub.mjs", "src/overlay.js", "src/proxy.mjs"];

test("the design system defines something, so the checks below are not vacuous", () => {
  // Every assertion in this file is of the form "the chrome contains no X" or
  // "everything it references is defined". Both pass trivially against an
  // empty token set or an empty file, so pin the sizes first.
  assert.ok(Object.keys(TOKENS).length >= 20, "expected the full token set");
  assert.equal(TOKENS["--paper"], "#f7f3e0");
  assert.equal(TOKENS["--vermilion"], "#c4161c");
  for (const f of SURFACES) assert.ok(read(f).length > 5000, `${f} is suspiciously small`);
});

test("no surface hardcodes a colour", () => {
  // The whole reason this system exists. Before it, #1f6e7a was typed into
  // eleven places across these two files and there was no way to change the
  // accent without finding all eleven.
  for (const f of SURFACES) {
    const hits = [...read(f).matchAll(/#[0-9a-f]{3,8}\b/gi)].map((m) => m[0]);
    assert.deepEqual(hits, [], `${f} still names colours directly: ${hits.join(", ")}`);
  }
});

test("every token the chrome references is defined in design.css", () => {
  const referenced = new Set();
  for (const f of SURFACES) {
    for (const m of read(f).matchAll(/var\((--[a-z0-9-]+)/gi)) referenced.add(m[1]);
  }
  assert.ok(referenced.size >= 15, `only found ${referenced.size} var() references`);
  const undefinedOnes = [...referenced].filter((n) => !(n in TOKENS));
  assert.deepEqual(undefinedOnes, [], `referenced but never defined: ${undefinedOnes.join(", ")}`);
});

test("the document and the shadow root are handed identical values", () => {
  // Two selectors, one set of values. A shadow root under `all: initial`
  // inherits nothing, so :host has to carry its own copy of every custom
  // property; the point is that the copy is generated, not typed.
  const body = (css) => css.slice(css.indexOf("{") + 1, -1);
  assert.equal(body(rootCss()), body(hostCss()));
  assert.ok(rootCss().startsWith(":root{"));
  assert.ok(hostCss().startsWith(":host{"));
  assert.ok(rootCss().includes("--vermilion:#c4161c"));
});

test("no ornament value contains a semicolon", () => {
  // src/tokens.mjs splits declarations on ";", so a base64 data URI would be
  // read as two broken declarations and the ornament would silently vanish
  // from both surfaces. Percent-encoding is what keeps that from happening,
  // and nothing else enforces it.
  const ornaments = Object.entries(TOKENS).filter(([, v]) => v.startsWith("url("));
  assert.ok(ornaments.length >= 2);
  for (const [name, value] of ornaments) {
    assert.ok(!value.includes(";"), `${name} contains a semicolon`);
    assert.ok(value.startsWith("url("), `${name} is not a url()`);
  }
});

test("DESIGN.md still describes the stylesheet it points at", () => {
  // lightbox audited by lightbox: the same check it runs against every other
  // project in the catalogue, run against this repo. It has caught the table
  // going stale in other repos and there is no reason this one is immune.
  const r = check("lightbox", ROOT);
  assert.equal(r.unchecked, undefined);
  assert.ok(r.documented >= 15, `only ${r.documented} tokens documented`);
  assert.deepEqual(r.stale, [], "DESIGN.md quotes a value the stylesheet no longer has");
  assert.deepEqual(r.missing, [], "DESIGN.md documents a token that is defined nowhere");
  assert.deepEqual(r.skippedRows, [], "a DESIGN.md row named a token but no value could be read");
});

test("token() names the token it could not find", () => {
  assert.equal(token("--paper"), TOKENS["--paper"]);
  assert.equal(token("paper"), TOKENS["--paper"]);
  assert.throws(() => token("--nope"), /--nope/);
});
