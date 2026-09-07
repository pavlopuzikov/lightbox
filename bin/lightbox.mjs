#!/usr/bin/env node
/**
 * lightbox CLI.
 *
 *   lightbox init [dir...]   write a config by looking at directories
 *   lightbox list            what the config resolves to, without serving
 *   lightbox serve           the hub and every review port
 *
 *   Run `lightbox --help` for the audit subcommands (sweep, diff, tokens,
 *   handover, reviews), which live in src/cli/.
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

const HELP = `lightbox: run every front end you have built, all at once, each carrying the
same review overlay.

  lightbox init <dir...>        write a config by scanning directories
  lightbox list                 what the config resolves to, without serving
  lightbox serve                the hub and every review port

  lightbox sweep [--key <k>]    measure routes at three widths and write
                                .lightbox/audit/<key>.json
  lightbox diff <a> <b>         compare two sweeps; exit 1 if anything regressed
  lightbox summary <file>       re-print a sweep's one-line result
  lightbox login --key <k>      save a storage state for routes behind auth

  lightbox tokens [--key <k>]   DESIGN.md token drift; exit 1 on drift
  lightbox tokens --runtime     what the tokens compute to in a browser,
                                against what the project declares
  lightbox handover             refresh .lightbox/handover.json and HANDOVER.md
  lightbox reviews drain|list   move stored review notes onto disk
  lightbox publish              write a read-only snapshot of the catalogue
                                into the vault, for surfaces that cannot reach
                                the hub on localhost

Config and .lightbox/ always resolve from the current working directory, not
from wherever lightbox itself is installed.

sweep needs Playwright and axe-core, which lightbox does not depend on. Install
them where you run it (npm i -D playwright axe-core && npx playwright install
chromium), or point at another project's copy with --playwright <dir> or
LIGHTBOX_PLAYWRIGHT.

Exit codes: 1 means a real finding (drift, a regression). 2 means the run could
not measure what it was asked to measure, which is not the same as a pass.`;

/** Subcommands that live in src/cli/, loaded only when asked for. */
async function delegate(name, rest) {
  if (name === "sweep") return (await import("../src/cli/sweep.mjs")).main("run", rest);
  if (name === "diff" || name === "summary" || name === "login") {
    return (await import("../src/cli/sweep.mjs")).main(name, rest);
  }
  if (name === "tokens") return (await import("../src/cli/tokens.mjs")).main(rest);
  if (name === "handover") return (await import("../src/cli/handover.mjs")).main(rest);
  if (name === "reviews") return (await import("../src/cli/reviews.mjs")).main(rest);
  if (name === "publish") return (await import("../src/cli/publish.mjs")).main(rest);
  return undefined;
}

const DELEGATED = [
  "sweep",
  "diff",
  "summary",
  "login",
  "tokens",
  "handover",
  "reviews",
  "publish",
];

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
  case "help":
  case "--help":
  case "-h":
    console.log(HELP);
    break;
  case "--version":
  case "-v": {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    console.log(pkg.version);
    break;
  }
  default:
    if (DELEGATED.includes(cmd)) {
      // A delegated command owns its own exit code, and 2 is meaningful.
      const code = await delegate(cmd, rest).catch((e) => {
        // A setup problem the person can fix gets the instruction on its own.
        // A stack trace through lightbox's own frames only buries it.
        console.error(e.expected ? e.message : e.stack || e.message);
        return 1;
      });
      if (typeof code === "number" && code !== 0) process.exit(code);
    } else {
      die(`Unknown command "${cmd}".\n\n${HELP}`);
    }
}
