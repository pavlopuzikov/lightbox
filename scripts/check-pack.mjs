#!/usr/bin/env node
/**
 * Assert that `npm pack` ships every file the CLI can reach.
 *
 * This exists because it did not, for the entire life of the tool up to
 * 0.1.0. `files` listed bin/ and src/, the four audit commands lived in
 * scripts/, and so an installed copy had no sweep, no tokens, no handover and
 * no reviews, while the README documented all four. Nothing failed: the
 * tarball built fine, the tests passed, and the gap only showed up when
 * someone other than the author tried to run it.
 *
 * So the check is not "is scripts/ in files" but "can every dispatched
 * subcommand find its module in the tarball", which stays true through
 * whatever the next reorganisation is.
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bin = fs.readFileSync(path.join(ROOT, "bin", "lightbox.mjs"), "utf8");

/* Every relative module bin/lightbox.mjs imports, static or dynamic. */
const wanted = new Set(["bin/lightbox.mjs"]);
for (const m of bin.matchAll(/from\s+"(\.\.\/[^"]+)"|import\("(\.\.\/[^"]+)"\)/g)) {
  const rel = m[1] || m[2];
  wanted.add(path.posix.normalize(path.posix.join("bin", rel)));
}
/* And what those in turn import, one level in, which is where src/cli/ sits. */
for (const f of [...wanted]) {
  const full = path.join(ROOT, f);
  if (!fs.existsSync(full)) continue;
  const src = fs.readFileSync(full, "utf8");
  for (const m of src.matchAll(/from\s+"(\.[^"]+)"|import\("(\.[^"]+)"\)/g)) {
    const rel = m[1] || m[2];
    wanted.add(path.posix.normalize(path.posix.join(path.posix.dirname(f), rel)));
  }
}

// execSync, not execFileSync: npm on Windows is npm.cmd, and Node 24 refuses
// to spawn a .cmd without a shell. The command is a fixed literal.
const out = execSync("npm pack --dry-run --json", { cwd: ROOT, encoding: "utf8" });
const shipped = new Set(JSON.parse(out)[0].files.map((f) => f.path.split(path.sep).join("/")));

const missing = [...wanted].filter((f) => !shipped.has(f));
if (missing.length) {
  console.error("npm pack would ship a CLI that cannot run. Missing from the tarball:");
  for (const f of missing) console.error(`  ${f}`);
  console.error(`\nAdd the directory to "files" in package.json.`);
  process.exit(1);
}
console.log(`pack ok: all ${wanted.size} CLI modules are in the tarball (${shipped.size} files total).`);
