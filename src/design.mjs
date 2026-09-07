/**
 * Read the design system out of src/design.css and hand it to both surfaces.
 *
 * The hub renders a whole document and can just serve the stylesheet. The
 * overlay cannot: it lives in a shadow root inside somebody else's page, with
 * `all: initial` on the host, so it has to declare the same custom properties
 * on `:host` or inherit nothing. Those are two different selectors carrying
 * one set of values, and the obvious way to write that is to type the values
 * twice, which is how the old chrome ended up with `#1f6e7a` hardcoded in
 * eleven places across two files and no way to change it in one.
 *
 * So the values are parsed out of the stylesheet once, here, and both
 * selectors are generated from the result. There is exactly one place to edit
 * a colour, and `test/design.test.mjs` asserts the two surfaces agree.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { declarations } from "./tokens.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const CSS_PATH = path.join(HERE, "design.css");

/**
 * Every custom property design.css defines, as a plain object.
 *
 * Read once at import. A missing file is fatal and says so: the chrome cannot
 * be drawn without it, and a half-drawn hub in the system colours would look
 * like a styling bug rather than a missing file.
 */
function readTokens() {
  let css;
  try {
    css = fs.readFileSync(CSS_PATH, "utf8");
  } catch (e) {
    const err = new Error(
      `lightbox could not read its own stylesheet at ${CSS_PATH}\n` +
        `This file ships in the package; a missing copy means a broken install.\n` +
        `  ${e.message}`
    );
    err.expected = true;
    throw err;
  }
  const out = {};
  for (const d of declarations(css)) {
    // Whitespace is collapsed because the font stacks are written across
    // several lines for readability and a newline inside an inline style
    // attribute is a needless byte.
    out[d.name] = d.value.replace(/\s+/g, " ").trim();
  }
  return out;
}

export const TOKENS = readTokens();

/** `--paper` etc, ready to drop into any selector body. */
export function declarationsText() {
  return Object.entries(TOKENS)
    .map(([k, v]) => `${k}:${v}`)
    .join(";");
}

/** The token block for a normal document. Used by the hub. */
export function rootCss() {
  return `:root{${declarationsText()}}`;
}

/** The same values for a shadow root, where :root does not reach. */
export function hostCss() {
  return `:host{${declarationsText()}}`;
}

/**
 * One token, by name, for the few places that need a value rather than a
 * reference: an SVG favicon, a JSON payload, a canvas fill.
 */
export function token(name) {
  const key = name.startsWith("--") ? name : `--${name}`;
  if (!(key in TOKENS)) throw new Error(`no such design token: ${key}`);
  return TOKENS[key];
}
