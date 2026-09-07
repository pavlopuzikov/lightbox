#!/usr/bin/env node
/**
 * Report DESIGN.md token drift for every configured project.
 *
 *   node scripts/tokens.mjs [--key <key>] [--json <file>]
 *
 * The comparison itself lives in src/tokens.mjs; this is the CLI around it.
 * Exits 1 when any stale or missing token is found, so it can gate a commit.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, buildCatalogue } from "../src/catalogue.mjs";
import { check } from "../src/tokens.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) {
    const next = process.argv[i + 1];
    args[a.slice(2)] = next && !next.startsWith("--") ? process.argv[++i] : true;
  }
}

const { config } = await loadConfig(ROOT);
const { projects: all } = buildCatalogue(config);
const projects = all.filter((p) => (args.key ? p.key === args.key : true));

const results = [];
for (const p of projects) {
  if (!fs.existsSync(p.dir)) continue;
  const r = check(p.key, p.dir);
  if (r) results.push({ ...r, name: p.name });
}

let bad = 0;
for (const r of results) {
  if (r.skipped) {
    console.log(`${r.key.padEnd(14)} ${r.doc}: ${r.skipped}`);
    continue;
  }
  const n = r.stale.length + r.missing.length;
  if (n) bad += n;
  const head = `${r.key.padEnd(14)} ${String(r.documented).padStart(3)} documented, ${String(r.definedCount).padStart(3)} in css`;
  console.log(`${head}  ->  ${n ? `${r.stale.length} stale, ${r.missing.length} missing` : "matches"}${r.undocumented.length ? `  (${r.undocumented.length} undocumented)` : ""}`);
  for (const s of r.stale) console.log(`    stale    ${s.name}: DESIGN.md says ${s.want}, ${s.file} says ${s.got}`);
  for (const m of r.missing) console.log(`    missing  ${m.name}: documented as ${m.want}, defined in no stylesheet`);
}

if (args.json) {
  fs.writeFileSync(path.resolve(String(args.json)), JSON.stringify(results, null, 2));
  console.log(`\nwrote ${args.json}`);
}

console.log(`\n${results.length} projects with a DESIGN.md token table, ${bad} tokens drifted`);
process.exit(bad ? 1 : 0);
