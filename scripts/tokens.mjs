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
const unchecked = [];
for (const p of projects) {
  // A directory that is not on this machine is not a project that passed. On a
  // fresh clone every configured path misses, and this used to print
  // "0 tokens drifted" and exit 0 for a run that checked nothing at all.
  if (!fs.existsSync(p.dir)) {
    unchecked.push({ key: p.key, name: p.name, reason: `directory not found: ${p.dir}` });
    continue;
  }
  const r = check(p.key, p.dir);
  if (r.unchecked) unchecked.push({ key: p.key, name: p.name, reason: r.unchecked, skippedRows: r.skippedRows });
  else results.push({ ...r, name: p.name });
}

let bad = 0;
let skippedRows = 0;
for (const r of results) {
  const n = r.stale.length + r.missing.length;
  if (n) bad += n;
  skippedRows += r.skippedRows.length;
  const head = `${r.key.padEnd(14)} ${String(r.documented).padStart(3)} documented, ${String(r.definedCount).padStart(3)} in css`;
  console.log(`${head}  ->  ${n ? `${r.stale.length} stale, ${r.missing.length} missing` : "matches"}${r.undocumented.length ? `  (${r.undocumented.length} undocumented)` : ""}`);
  for (const s of r.stale) console.log(`    stale    ${s.name}: DESIGN.md says ${s.want}, ${s.file} says ${s.got}`);
  for (const m of r.missing) console.log(`    missing  ${m.name}: documented as ${m.want}, defined in no stylesheet`);
  // Not a defect, but not a pass either: the row named a token and no value
  // could be read out of it, so nothing about that token was compared.
  for (const s of r.skippedRows) {
    console.log(`    unread   ${s.names.join(", ")}: no value parsed from ${JSON.stringify(s.cells)}`);
  }
}

if (unchecked.length) {
  console.log(`\nnot checked (${unchecked.length})`);
  for (const u of unchecked) console.log(`  ${u.key.padEnd(14)} ${u.reason}`);
}

if (args.json) {
  fs.writeFileSync(path.resolve(String(args.json)), JSON.stringify({ results, unchecked }, null, 2));
  console.log(`\nwrote ${args.json}`);
}

console.log(
  `\n${results.length} of ${projects.length} projects checked, ${bad} tokens drifted` +
    (skippedRows ? `, ${skippedRows} table rows unread` : "") +
    (unchecked.length ? `, ${unchecked.length} not checked` : "")
);
// Exit 2 when nothing could be checked. Reporting no drift across zero
// projects is not the same answer as reporting no drift across all of them.
if (bad) process.exit(1);
process.exit(results.length === 0 && projects.length > 0 ? 2 : 0);
