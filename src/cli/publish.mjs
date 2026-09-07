/**
 * lightbox publish: write a snapshot of the catalogue into the vault.
 *
 * The hub answers on localhost and only while `lightbox serve` is running, so
 * anything that wants to show this state from somewhere else cannot ask the
 * hub for it. This writes a derived, read-only copy into the vault instead,
 * where a deployed app can read it without depending on this machine being
 * awake, and without a write-capable tool ever being reachable from outside.
 *
 * The shape is deliberately the same as reference-library's publish: a
 * versioned manifest under `published/`, carrying no bytes and no secrets, with
 * the date it was generated so a viewer can say "synced 2026-09-07" rather than
 * pretending to be current.
 *
 * What it does NOT carry, on purpose:
 *  - absolute paths. `project.dir` is where forty repos live on this disk; the
 *    consumer has no use for it and it names the machine's owner in every row.
 *  - review notes. Those are prose about unfinished work in `.lightbox/reviews`
 *    and they are not part of a status board.
 *  - anything from the supervisor. Whether a dev server is up is true for about
 *    a minute, so publishing it would be publishing a stale claim; the live
 *    half of that is the consumer's job, by asking the hub directly.
 */

import fs from "node:fs";
import path from "node:path";
import { buildCatalogue, loadConfig } from "../catalogue.mjs";
import { routesFor } from "../routes.mjs";
import { summarise } from "../handover.mjs";

/** Must match SUPPORTED_VERSION in arios/apps/ari-app/lib/lightbox.ts. */
const VERSION = 1;

const DEFAULT_VAULT = "C:/Users/ppuzi/OneDrive/Desktop/KW/Knowledge Web Vault";

/** Where this writes, relative to the vault root. */
export const PUBLISHED_DIR = path.posix.join("04 - Projects & Outputs", "Lightbox", "published");

/** Read a JSON file, or return the fallback. Never throws: every input here is
 *  optional state that a fresh clone legitimately does not have yet. */
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function buildManifest(config, cwd, now = new Date()) {
  const { projects, groups } = buildCatalogue(config);
  const stateDir = path.join(cwd, ".lightbox");
  const progress = readJson(path.join(stateDir, "progress.json"), {});
  const handover = readJson(path.join(stateDir, "handover.json"), {});

  const rows = projects.map((p) => {
    // routesFor returns records, not paths. Comparing the stored paths against
    // the records themselves silently matches nothing, which publishes every
    // project as zero reviewed and looks like an empty catalogue rather than a
    // bug.
    const paths = new Set(routesFor(p).map((r) => r.path));
    const reviewed = (progress[p.key] || []).filter((r) => paths.has(r));
    return {
      key: p.key,
      name: p.name,
      group: p.group,
      kind: p.kind,
      runner: p.kind === "node" ? p.command || p.runner || null : null,
      system: p.system || null,
      note: p.note || null,
      port: p.port,
      upstream: p.upstream ?? null,
      routes: paths.size,
      // Counted against the CURRENT route list rather than taken as the stored
      // length. Progress outlives the routes it was recorded for, so a deleted
      // page otherwise leaves a project reading 18 of 15 forever.
      reviewed: reviewed.length,
      missing: !p.exists,
      hand: summarise(handover[p.key]),
    };
  });

  return {
    version: VERSION,
    generatedAt: now.toISOString(),
    hub: {
      port: config.hubPort ?? 4000,
      url: `http://127.0.0.1:${config.hubPort ?? 4000}/`,
    },
    totals: {
      projects: rows.length,
      routes: rows.reduce((n, r) => n + r.routes, 0),
      reviewed: rows.reduce((n, r) => n + r.reviewed, 0),
    },
    groups: groups
      .filter((g) => rows.some((r) => r.group === g.id))
      .map((g) => ({ id: g.id, title: g.title })),
    projects: rows,
  };
}

export async function main(argv = []) {
  const cwd = process.cwd();
  const { config } = await loadConfig(cwd);

  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const vault = (flag("--vault") || process.env.LIGHTBOX_VAULT_PATH || DEFAULT_VAULT).replace(
    /[\\/]$/,
    ""
  );
  if (!fs.existsSync(vault)) {
    const e = new Error(
      `No vault at ${vault}.\n` +
        "Point at it with --vault <dir> or LIGHTBOX_VAULT_PATH."
    );
    e.expected = true;
    throw e;
  }

  const manifest = buildManifest(config, cwd);
  const outDir = path.join(vault, ...PUBLISHED_DIR.split("/"));
  const outFile = path.join(outDir, "manifest.json");

  if (argv.includes("--dry-run")) {
    console.log(JSON.stringify(manifest, null, 2));
    console.error(`\n(dry run, nothing written; would be ${outFile})`);
    return 0;
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  const size = fs.statSync(outFile).size;
  const t = manifest.totals;
  console.log(`wrote ${outFile} (${(size / 1024).toFixed(1)} KB)`);
  console.log(`  ${t.projects} projects, ${t.reviewed} of ${t.routes} pages reviewed`);
  console.log("\nCommit the vault to make it visible to anything reading the snapshot.");
  return 0;
}
