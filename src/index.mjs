/**
 * Wiring. Everything above this file does one job; this one starts them in the
 * right order and reports honestly about what did not come up.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCatalogue, inspectCommentSearch } from "./catalogue.mjs";
import { createHubServer } from "./hub.mjs";
import { Handover } from "./handover.mjs";
import { Progress } from "./progress.mjs";
import { Notes, countNotes } from "./notes.mjs";
import { Shots } from "./shots.mjs";
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
          // Both names the MCP server has reported. It calls itself
          // element-review-inspector-mcp since the 3.0.0 rename and
          // inspect-comment-mcp before it. Pinning the old one made this
          // check unpassable, and the two things it then said were both false and
          // both alarming: "did not come up" on a bridge that was answering
          // {"ok":true}, or, when the port was already held, "held by something
          // that is not inspect-comment; reviews cannot land". Reviews landed
          // fine. Checking `ok` alone would pass for any JSON server that
          // happens to hold the port, which is the case that message exists for.
          const name = JSON.parse(body).name;
          resolve(name === "element-review-inspector-mcp" || name === "inspect-comment-mcp");
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

/**
 * Every review is appended to .lightbox/reviews/<key>/inbox.md before it is
 * forwarded. The bridge keeps only its last twenty; a long sitting across many
 * projects would otherwise lose the early ones before anyone read them.
 */
function archiveReview(stateDir, notes) {
  return (project, payload) => {
    if (typeof payload.markdown !== "string" || !payload.markdown.trim()) return;
    const dir = path.join(stateDir, "reviews", project.key);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(
        path.join(dir, "inbox.md"),
        `\n<!-- ${new Date().toISOString()} ${payload.page || ""} -->\n${payload.markdown.trim()}\n`
      );
    } catch {
      /* the forward still happens; the archive is a safety net, not the path */
    }
    // The prose is written first and unconditionally. The counts are derived
    // from it, so they come second and may fail on their own.
    try {
      if (notes && payload.page) {
        notes.record(project.key, new URL(payload.page).pathname, countNotes(payload.markdown));
      }
    } catch {
      /* a page value that is not a URL leaves the counts where they were */
    }
  };
}

export async function serve(config, cwd = process.cwd(), opts = {}) {
  const log = opts.log || ((...a) => console.log(...a));
  const stateDir = path.join(cwd, ".lightbox");
  fs.mkdirSync(stateDir, { recursive: true });

  const catalogue = buildCatalogue(config);
  const supervisor = new Supervisor({ logDir: path.join(stateDir, "logs") });
  // A dead server must stop reporting ready. See Supervisor.checkHealth.
  supervisor.watchHealth();
  const progress = new Progress(path.join(stateDir, "progress.json"));
  const handover = new Handover(path.join(stateDir, "handover.json"));
  const notes = new Notes(path.join(stateDir, "reviews"));
  const shots = new Shots(path.join(stateDir, "reviews"));
  const inspectSearch = inspectCommentSearch(config, cwd);
  const inspectCommentPath = inspectSearch.path;
  const hubUrl = `http://localhost:${config.hubPort}/`;
  const overlayPath = path.join(HERE, "overlay.js");

  if (!inspectCommentPath) {
    // Say which of the two failures this is. "missing" sent the last reader to
    // reinstall a package that was installed and had simply been renamed, and the
    // button that starts a selection stayed gone for a day.
    log(
      `warn    no element inspector: ${inspectSearch.problem}.\n` +
        "        Pages carry the route walker but nothing to select an element with.\n" +
        "        Fix by pointing `inspectComment` in the config at the package's\n" +
        "        src/element-review-inspector.js (it was src/inspect-comment.js before\n" +
        "        the 3.0.0 rename), or set it to auto and let both names be searched."
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
      shots,
      hubUrl,
      bridge: config.bridge,
      overlayPath,
      inspectCommentPath,
      onReview: opts.onReview || archiveReview(stateDir, notes),
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
    handover,
    notes,
    hubUrl,
    hubPort: config.hubPort,
    hubOrigins: config.hubOrigins || [],
    bridge: config.bridge,
    inspectCommentPath,
  });
  const hubResult = await listen(hub, config.hubPort);
  if (!hubResult.ok) {
    const err = new Error(
      `The hub could not bind :${config.hubPort} (${hubResult.error.code}). ` +
        `Something else is using it, or a previous lightbox is still running.`
    );
    /* scripts/hub-loop.cmd restarts this forever, and it has to tell two
       failures apart: another hub already holds the port, which means wait and
       leave it alone, versus this hub crashed, which means restart. Exit 3 is
       the first. Without it the loop read a healthy neighbour as a crash and
       retried every ten seconds, which is how serve.log reached 82 failures. */
    err.exitCode = hubResult.error.code === "EADDRINUSE" ? 3 : 1;
    throw err;
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
    handover.flush();
    await supervisor.stopAll(catalogue.projects).catch(() => {});
    bridgeChild?.kill();
    for (const s of servers) s.server.close();
    hub.close();
  };

  return {
    catalogue,
    supervisor,
    progress,
    handover,
    notes,
    shots,
    servers,
    hub,
    shutdown,
    skipped,
    inspectCommentPath,
  };
}

export { buildCatalogue, routesFor };
