/**
 * Wiring. Everything above this file does one job; this one starts them in the
 * right order and reports honestly about what did not come up.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCatalogue, resolveInspectComment } from "./catalogue.mjs";
import { createHubServer } from "./hub.mjs";
import { Progress } from "./progress.mjs";
import { createProjectServer } from "./proxy.mjs";
import { routesFor } from "./routes.mjs";
import { Supervisor, portOpen } from "./supervisor.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function listen(server, port) {
  return new Promise((resolve) => {
    const onError = (err) => {
      server.removeListener("listening", onOk);
      resolve({ ok: false, error: err });
    };
    const onOk = () => {
      server.removeListener("error", onError);
      resolve({ ok: true });
    };
    server.once("error", onError);
    server.once("listening", onOk);
    server.listen(port, "0.0.0.0");
  });
}

/**
 * Run the inspect-comment MCP server ourselves when nothing is on the port.
 *
 * It reads stdin for JSON-RPC and exits on end-of-stream, so the pipe is opened
 * and deliberately left open. IC_MCP_DIR is pointed into .lightbox/ so the
 * reviews land somewhere a coding agent can read without being told where the
 * system temp directory is on this machine.
 *
 * An open port is not proof of our bridge: anything could be on 7391, and a
 * TCP connect cannot tell. /health names the server, so that is what is
 * checked. The child's output goes to .lightbox/logs/bridge.log and an exit is
 * logged and retried, because a bridge that dies quietly after the start-up
 * probe looks exactly like one that is up until the first review vanishes.
 */
function bridgeHealthy(bridge, timeout = 800) {
  return new Promise((resolve) => {
    const req = http.get(new URL("/health", bridge), (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body).name === "inspect-comment-mcp");
        } catch {
          resolve(false);
        }
      });
    });
    req.setTimeout(timeout, () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

async function ensureBridge(bridge, inspectCommentPath, stateDir, log) {
  const url = new URL(bridge);
  if (await portOpen(Number(url.port), url.hostname)) {
    if (await bridgeHealthy(bridge)) log(`bridge  already listening on ${bridge}`);
    else
      log(
        `bridge  :${url.port} is held by something that is not inspect-comment; ` +
          "reviews cannot land until it is freed and lightbox restarted"
      );
    return null;
  }
  if (!inspectCommentPath) return null;

  const serverFile = path.join(path.dirname(path.dirname(inspectCommentPath)), "mcp", "server.mjs");
  if (!fs.existsSync(serverFile)) {
    log(`bridge  not started: ${serverFile} does not exist`);
    return null;
  }

  const reviewDir = path.join(stateDir, "reviews");
  const logFile = path.join(stateDir, "logs", "bridge.log");
  fs.mkdirSync(reviewDir, { recursive: true });
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const out = fs.createWriteStream(logFile, { flags: "a" });

  const handle = {
    child: null,
    stopped: false,
    attempts: 0,
    kill() {
      this.stopped = true;
      this.child?.kill();
      out.end();
    },
  };

  const start = () => {
    out.write(`\n--- ${new Date().toISOString()} spawn (attempt ${handle.attempts + 1})\n`);
    const child = spawn(process.execPath, [serverFile], {
      env: { ...process.env, IC_MCP_PORT: url.port, IC_MCP_DIR: reviewDir },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    handle.child = child;
    child.stdout.pipe(out, { end: false });
    child.stderr.pipe(out, { end: false });
    child.on("error", (e) => log(`bridge  failed to spawn: ${e.message}`));
    child.on("exit", (code, signal) => {
      if (handle.stopped) return;
      const why = signal ? `signal ${signal}` : `code ${code}`;
      if (handle.attempts < 3) {
        handle.attempts += 1;
        log(`bridge  exited (${why}), restarting in ${handle.attempts}s; see ${logFile}`);
        setTimeout(start, 1000 * handle.attempts);
      } else {
        log(`bridge  exited (${why}) and will not be restarted again; see ${logFile}`);
      }
    });
  };
  start();

  const up = await (async () => {
    for (let i = 0; i < 20; i++) {
      if (await bridgeHealthy(bridge)) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  })();
  log(
    up
      ? `bridge  started on ${bridge}, reviews land in ${reviewDir}`
      : `bridge  did not come up on ${bridge}; see ${logFile}`
  );
  return handle;
}

export async function serve(config, cwd = process.cwd(), opts = {}) {
  const log = opts.log || ((...a) => console.log(...a));
  const stateDir = path.join(cwd, ".lightbox");
  fs.mkdirSync(stateDir, { recursive: true });

  const catalogue = buildCatalogue(config);
  const supervisor = new Supervisor({ logDir: path.join(stateDir, "logs") });
  const progress = new Progress(path.join(stateDir, "progress.json"));
  const inspectCommentPath = resolveInspectComment(config, cwd);
  const hubUrl = `http://localhost:${config.hubPort}/`;
  const overlayPath = path.join(HERE, "overlay.js");

  if (!inspectCommentPath) {
    log(
      "warn    inspect-comment was not found, so pages will carry the route walker but no\n" +
        "        element inspector. Fix with `npm i -D inspect-comment`, or set\n" +
        "        `inspectComment` in the config to the path of its src/inspect-comment.js."
    );
  }

  const bridgeChild = await ensureBridge(config.bridge, inspectCommentPath, stateDir, log);

  /* One server per project. A port already taken is reported and skipped rather
     than taken as fatal: with forty of them, one collision should not stop the
     other thirty-nine. */
  const servers = [];
  const skipped = [];
  for (const project of catalogue.projects) {
    const ctx = {
      project,
      supervisor,
      progress,
      hubUrl,
      bridge: config.bridge,
      overlayPath,
      inspectCommentPath,
      onReview: opts.onReview,
    };
    const server = createProjectServer(ctx);
    const r = await listen(server, project.port);
    if (r.ok) servers.push({ project, server });
    else {
      skipped.push({ project, error: r.error });
      project.portConflict = true;
    }
  }

  const hub = createHubServer({
    catalogue,
    supervisor,
    progress,
    hubUrl,
    bridge: config.bridge,
    inspectCommentPath,
  });
  const hubResult = await listen(hub, config.hubPort);
  if (!hubResult.ok) {
    throw new Error(
      `The hub could not bind :${config.hubPort} (${hubResult.error.code}). ` +
        `Something else is using it, or a previous lightbox is still running.`
    );
  }

  const pages = catalogue.projects.reduce((n, p) => n + routesFor(p).length, 0);
  log("");
  log(`lightbox  ${hubUrl}`);
  log(
    `              ${catalogue.projects.length} projects, ${pages} pages, ` +
      `${servers.length} review ports live`
  );
  if (skipped.length) {
    log("");
    log(`  ${skipped.length} port(s) already in use, those projects have no review port:`);
    for (const s of skipped) log(`    :${s.project.port}  ${s.project.name}  (${s.error.code})`);
  }
  const missing = catalogue.projects.filter((p) => !p.exists);
  if (missing.length) {
    log("");
    log(`  ${missing.length} configured project(s) are not on disk:`);
    for (const p of missing) log(`    ${p.name}  ${p.dir}`);
  }
  const noModules = catalogue.projects.filter((p) => p.kind === "node" && p.exists && !p.hasModules);
  if (noModules.length) {
    log("");
    log(`  ${noModules.length} project(s) need npm install before they will start:`);
    for (const p of noModules) log(`    ${p.name}`);
  }
  log("");

  const shutdown = async () => {
    progress.flush();
    await supervisor.stopAll(catalogue.projects).catch(() => {});
    bridgeChild?.kill();
    for (const s of servers) s.server.close();
    hub.close();
  };

  return { catalogue, supervisor, progress, servers, hub, shutdown, skipped, inspectCommentPath };
}

export { buildCatalogue, routesFor };
