#!/usr/bin/env node
/**
 *   lightbox reviews drain   copy every stored review into .lightbox/reviews/<key>/
 *   lightbox reviews list    what the bridge holds and what has been drained
 *
 * Run `drain` at the start of every coding batch. See src/reviews.mjs for why.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import { drain, status } from "../reviews.mjs";

/** Reviews land under the working directory, like every other piece of state. */
const ROOT = process.cwd();

export async function main(argv = process.argv.slice(2)) {
  const REVIEWS = path.join(ROOT, ".lightbox", "reviews");
  const paths = {
    storeFile: path.join(REVIEWS, "reviews.json"),
    shotsDir: path.join(REVIEWS, "shots"),
    outDir: REVIEWS,
    drainedFile: path.join(REVIEWS, "drained.json"),
  };

  const sub = argv[0] || "list";
  if (sub === "drain") {
    const r = drain(paths);
    for (const m of r.moved) console.log(`#${m.id}  ${m.key.padEnd(16)} ${m.route || ""}  ${m.shots} shot${m.shots === 1 ? "" : "s"}  -> ${path.relative(process.cwd(), m.file)}`);
    console.log(`${r.moved.length} new, ${r.total} drained in total, ${r.stored} still in the bridge store.`);
    return 0;
  }
  if (sub === "list") {
    const rows = status(paths);
    for (const r of rows) console.log(`#${String(r.id).padStart(3)}  ${r.drained ? "drained" : "new    "}  ${r.key.padEnd(16)} ${r.route || ""}  ${r.receivedAt || ""}`);
    console.log(`${rows.length} in store, ${rows.filter((r) => !r.drained).length} not yet drained.`);
    return 0;
  }
  console.error(`unknown subcommand "${sub}"; use drain or list`);
  return 2;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exit(await main());
}
