#!/usr/bin/env node
/**
 * The constraint check.
 *
 * lightbox has no runtime dependencies, and that is load-bearing rather
 * than tidy: the tool's entire job is booting other people's projects, on
 * machines where the install that would carry its own dependencies is the thing
 * most likely to be broken. It has to run from a clone with an empty
 * node_modules.
 *
 * So: fail on a dependencies block, and fail on any bare import specifier in
 * src/ or bin/ that is not a node: builtin.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const problems = [];

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
if (pkg.dependencies && Object.keys(pkg.dependencies).length) {
  problems.push(
    `package.json has ${Object.keys(pkg.dependencies).length} runtime dependencies: ` +
      Object.keys(pkg.dependencies).join(", ")
  );
}

const IMPORT = /(?:^|\n)\s*import\s+(?:[^'"]*?from\s+)?["']([^"']+)["']|(?:\bimport\(\s*["']([^"']+)["'])/g;

function checkFile(file) {
  const src = fs.readFileSync(file, "utf8");
  let m;
  while ((m = IMPORT.exec(src))) {
    const spec = m[1] || m[2];
    if (!spec) continue;
    if (spec.startsWith("node:")) continue;
    if (spec.startsWith(".") || spec.startsWith("/")) continue;
    problems.push(`${path.relative(ROOT, file)} imports "${spec}"`);
  }
}

for (const dir of ["src", "bin", "scripts"]) {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) continue;
  for (const name of fs.readdirSync(full)) {
    if (!/\.(mjs|js)$/.test(name)) continue;
    // overlay.js runs in the browser, not in node, and its one dynamic import
    // is a URL the proxy serves.
    if (name === "overlay.js") continue;
    checkFile(path.join(full, name));
  }
}

if (problems.length) {
  console.error("check failed:\n" + problems.map((p) => "  " + p).join("\n"));
  process.exit(1);
}
console.log("check ok: no runtime dependencies, no bare imports.");
