#!/usr/bin/env node
/**
 * Report DESIGN.md token drift for every configured project.
 *
 *   lightbox tokens [--key <key>] [--json <file>]
 *   lightbox tokens --runtime [--key <key>] [--path /] [--playwright <dir>]
 *
 * The comparison itself lives in src/tokens.mjs; this is the CLI around it.
 * Exits 1 when any stale or missing token is found, so it can gate a commit,
 * and 2 when nothing could be checked at all.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, buildCatalogue } from "../catalogue.mjs";
import { check, defined, stylesheets } from "../tokens.mjs";

/** Config and .lightbox/ come from the working directory. See src/cli/sweep.mjs. */
const ROOT = process.cwd();

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    out[a.slice(2)] = next && !next.startsWith("--") ? argv[++i] : true;
  }
  return out;
}

/**
 * `--runtime`: ask a browser instead of the files.
 *
 * The static check cannot see a stylesheet it does not read, which is exactly
 * where an override comes from. This loads one route through the project's
 * review port and compares each token the project declares against what the
 * page computed. See src/runtime-tokens.mjs for why the comparison goes
 * through the browser rather than through string equality.
 */
async function runtime(args, projects) {
  const { loadPlaywright, ensureUp } = await import("./sweep.mjs");
  const { readTokensInPage, classify } = await import("../runtime-tokens.mjs");
  const hub = args.hub || "http://localhost:4000";
  const route = args.path || "/";

  const pw = await loadPlaywright(args.playwright);
  const browser = await pw.chromium.launch({ headless: true });
  let bad = 0;
  try {
    for (const p of projects) {
      if (!fs.existsSync(p.dir)) {
        console.log(`${p.key.padEnd(14)} not checked: directory not found`);
        continue;
      }
      const list = [...defined(stylesheets(p.dir)).entries()].map(([name, defs]) => ({ name, declared: defs.map((d) => d.value) }));
      if (!list.length) {
        console.log(`${p.key.padEnd(14)} not checked: no custom properties in any stylesheet`);
        continue;
      }
      const st = await ensureUp(p, hub);
      if (p.kind === "node" && st.state !== "ready") {
        console.log(`${p.key.padEnd(14)} not checked: dev server ${st.state}`);
        continue;
      }
      const base = `http://127.0.0.1:${p.port}`;
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
      await context.route((url) => url.origin === base, (r) => r.continue({ headers: { ...r.request().headers(), "x-lightbox-bare": "1" } }));
      const page = await context.newPage();
      try {
        const res = await page.goto(base + route, { waitUntil: "networkidle", timeout: Number(args.timeout || 45000) });
        // A route that 500s still has a document, and every token on it reads
        // as unset. That is a failed measurement wearing the costume of a
        // result, which is the thing this pass exists to stop.
        if (res && !res.ok()) {
          console.log(`${p.key.padEnd(14)} not checked: ${route} returned HTTP ${res.status()}`);
          continue;
        }
        const rows = await page.evaluate(readTokensInPage, list);
        const { overridden, unset, agreed } = classify(rows);
        bad += overridden.length;
        console.log(`${p.key.padEnd(14)} ${String(rows.length).padStart(3)} declared, ${agreed.length} agree, ${overridden.length} overridden, ${unset.length} not set at :root  (${route} at 1440)`);
        for (const o of overridden) {
          console.log(`    overridden  ${o.name}: computes ${o.computed}, this project declares ${o.declared.map((d) => d.value).join(" / ")}`);
        }
      } catch (e) {
        console.log(`${p.key.padEnd(14)} not checked: ${e.message.split("\n")[0]}`);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  return bad ? 1 : 0;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const { config } = await loadConfig(ROOT);
  const { projects: all } = buildCatalogue(config);
  const projects = all.filter((p) => (args.key ? p.key === args.key : true));

  if (args.runtime) return runtime(args, projects);

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
  if (bad) return 1;
  return results.length === 0 && projects.length > 0 ? 2 : 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exit(await main());
}
