#!/usr/bin/env node
/**
 * lightbox CLI.
 *
 *   lightbox init [dir...]   write a config by looking at directories
 *   lightbox list            what the config resolves to, without serving
 *   lightbox serve           the hub and every review port
 */

import fs from "node:fs";
import path from "node:path";
import { buildCatalogue, classify, DEFAULTS, loadConfig } from "../src/catalogue.mjs";
import { serve } from "../src/index.mjs";
import { routesFor } from "../src/routes.mjs";

const [, , cmd = "serve", ...rest] = process.argv;
const cwd = process.cwd();

const die = (msg) => {
  console.error(msg);
  process.exit(1);
};

/* ------------------------------------------------------------------ */

async function cmdInit() {
  const target = path.join(cwd, "lightbox.config.json");
  if (fs.existsSync(target) && !rest.includes("--force")) {
    die(`${target} already exists. Pass --force to overwrite it.`);
  }
  const dirs = rest.filter((a) => !a.startsWith("--"));
  if (!dirs.length) {
    die(
      "Give init one or more directories to scan.\n" +
        "  lightbox init ~/projects\n" +
        "  lightbox init ~/personal-repos ~/work-repos"
    );
  }

  const scan = dirs.map((d) => ({
    dir: path.resolve(d).split(path.sep).join("/"),
    depth: 2,
    group: path.basename(path.resolve(d)),
  }));
  const config = { ...DEFAULTS, scan, projects: [], groups: [] };
  const { projects } = buildCatalogue(config);

  fs.writeFileSync(target, JSON.stringify(config, null, 2) + "\n");
  console.log(`Wrote ${target}`);
  console.log(`It finds ${projects.length} project(s) today:`);
  for (const p of projects) console.log(`  ${p.kind.padEnd(7)} ${p.name}`);
  console.log(
    "\nAdd `projects` entries for anything the scan missed, or to give a project a\n" +
      "note, a fixed port, or `params` for its dynamic routes."
  );
}

async function cmdList() {
  const { config, from } = await loadConfig(cwd).catch((e) => die(e.message));
  const { projects, groups } = buildCatalogue(config);
  console.log(`config  ${from}`);
  for (const g of groups) {
    const items = projects.filter((p) => p.group === g.id);
    if (!items.length) continue;
    console.log(`\n${g.title}`);
    for (const p of items) {
      const routes = routesFor(p);
      const flags = [
        p.exists ? null : "MISSING",
        p.kind === "node" && !p.hasModules ? "no node_modules" : null,
      ].filter(Boolean);
      console.log(
        `  :${p.port}  ${p.name.padEnd(30)} ${String(routes.length).padStart(3)} pages  ` +
          `${p.kind === "node" ? (p.command ? "command" : p.runner) : "static"}${flags.length ? "  [" + flags.join(", ") + "]" : ""}`
      );
    }
  }
  const total = projects.reduce((n, p) => n + routesFor(p).length, 0);
  console.log(`\n${projects.length} projects, ${total} pages.`);
}

async function cmdServe() {
  const { config } = await loadConfig(cwd).catch((e) => die(e.message));
  const run = await serve(config, cwd);

  let closing = false;
  const bye = async () => {
    if (closing) return;
    closing = true;
    console.log("\nstopping dev servers…");
    await run.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
}

switch (cmd) {
  case "init":
    await cmdInit();
    break;
  case "list":
    await cmdList();
    break;
  case "serve":
    await cmdServe();
    break;
  default:
    die(`Unknown command "${cmd}". Try init, list or serve.`);
}
