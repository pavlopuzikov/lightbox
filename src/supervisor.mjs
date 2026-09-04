/**
 * Child process supervision: start a project's dev server, wait for its port,
 * stop it again, and install its dependencies when it has none.
 *
 * Nothing here runs eagerly. Forty dev servers at once is not a review setup,
 * it is a way to run a machine out of memory, so a project starts when you open
 * it and stops when you say so.
 *
 * Windows note: dev binaries land in node_modules/.bin as .cmd shims, which
 * cannot be exec'd directly, and a .cmd killed with SIGTERM leaves the node it
 * spawned behind. Both are handled below; see spawnDev and stop.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const WIN = process.platform === "win32";
const START_TIMEOUT_MS = 180_000;
const INSTALL_TIMEOUT_MS = 900_000;
const LOG_TAIL = 400;

/** Is anything listening? Resolves, never throws. */
export function portOpen(port, host = "127.0.0.1", timeout = 800) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeout);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
    sock.connect(port, host);
  });
}

async function waitForPort(port, timeoutMs, isDead) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portOpen(port)) return true;
    if (isDead && isDead()) return false;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/**
 * Find a locally installed binary, walking up for pnpm and npm workspaces where
 * the shim lives at the workspace root rather than beside the app.
 */
function resolveBin(dir, name) {
  let cur = path.resolve(dir);
  for (let i = 0; i < 6; i++) {
    for (const file of WIN ? [`${name}.cmd`, `${name}.CMD`, name] : [name]) {
      const p = path.join(cur, "node_modules", ".bin", file);
      if (fs.existsSync(p)) return p;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

/** The command line for one runner, given a port. */
function commandFor(project, port) {
  const { runner, dir } = project;
  const bin = (name) => resolveBin(dir, name);

  // An explicit `command` in the config wins over runner detection: an argv
  // array, or one string split on spaces, with {port} substituted. The first
  // word is looked up in node_modules/.bin, so "storybook dev -p {port}" works
  // without a path. PORT is set as well for scripts that read it instead.
  if (project.command) {
    const argv = Array.isArray(project.command)
      ? project.command
      : String(project.command).split(" ").filter(Boolean);
    const [head, ...rest] = argv.map((a) => String(a).replaceAll("{port}", String(port)));
    const cmd = bin(head) || (WIN && head === "npm" ? "npm.cmd" : head);
    return { cmd, args: rest, env: { PORT: String(port) } };
  }

  switch (runner) {
    case "next": {
      const b = bin("next");
      if (!b) return null;
      return { cmd: b, args: ["dev", "-p", String(port)], env: {} };
    }
    case "vite": {
      const b = bin("vite");
      if (!b) return null;
      return { cmd: b, args: ["--port", String(port), "--strictPort"], env: {} };
    }
    case "astro": {
      const b = bin("astro");
      if (!b) return null;
      return { cmd: b, args: ["dev", "--port", String(port)], env: {} };
    }
    case "nuxt": {
      const b = bin("nuxt");
      if (!b) return null;
      return { cmd: b, args: ["dev", "--port", String(port)], env: {} };
    }
    case "remix": {
      const b = bin("remix");
      if (!b) return null;
      return { cmd: b, args: ["vite:dev", "--port", String(port)], env: {} };
    }
    case "cra": {
      const b = bin("react-scripts");
      if (!b) return null;
      return {
        cmd: b,
        args: ["start"],
        // CRA opens a browser tab per project otherwise, and older ones die on
        // Node 18+ without the legacy provider.
        env: { PORT: String(port), BROWSER: "none", NODE_OPTIONS: "--openssl-legacy-provider" },
      };
    }
    default:
      // Unknown framework: run the project's own dev script and hope it reads
      // PORT. Many do. The ones that do not will bind their hardcoded port,
      // which the health check will notice and report rather than hang on.
      return { cmd: WIN ? "npm.cmd" : "npm", args: ["run", "dev"], env: { PORT: String(port) } };
  }
}

/* ------------------------------------------------------------------ *
 * Supervisor
 * ------------------------------------------------------------------ */

export class Supervisor {
  constructor({ logDir }) {
    this.logDir = logDir;
    /** @type {Map<string, {state:string, child:any, log:string[], error:string|null, startedAt:number|null}>} */
    this.procs = new Map();
    fs.mkdirSync(logDir, { recursive: true });
  }

  entry(key) {
    if (!this.procs.has(key)) {
      this.procs.set(key, {
        state: "stopped",
        child: null,
        log: [],
        error: null,
        startedAt: null,
      });
    }
    return this.procs.get(key);
  }

  state(project) {
    const e = this.entry(project.key);
    return {
      state: e.state,
      error: e.error,
      startedAt: e.startedAt,
      pid: e.child ? e.child.pid : null,
    };
  }

  log(key, line) {
    const e = this.entry(key);
    for (const l of String(line).split(/\r?\n/)) {
      if (!l.trim()) continue;
      e.log.push(l);
    }
    if (e.log.length > LOG_TAIL) e.log.splice(0, e.log.length - LOG_TAIL);
    try {
      fs.appendFileSync(path.join(this.logDir, `${key}.log`), line);
    } catch {
      /* a log that cannot be written is not worth crashing a review over */
    }
  }

  tail(key, n = 120) {
    return this.entry(key).log.slice(-n).join("\n");
  }

  /* ---------------------------------------------------------------- */

  async install(project) {
    const e = this.entry(project.key);
    if (e.state === "installing" || e.state === "starting") return e.state;
    e.state = "installing";
    e.error = null;
    this.log(project.key, `\n=== npm install in ${project.dir}\n`);

    const npm = WIN ? "npm.cmd" : "npm";
    const child = spawn(npm, ["install", "--no-audit", "--no-fund"], {
      cwd: project.dir,
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ADBLOCK: "1" },
      shell: WIN,
      windowsHide: true,
    });
    e.child = child;
    child.stdout.on("data", (d) => this.log(project.key, d.toString()));
    child.stderr.on("data", (d) => this.log(project.key, d.toString()));

    const timer = setTimeout(() => child.kill(), INSTALL_TIMEOUT_MS);
    const code = await new Promise((resolve) => {
      child.on("exit", (c) => resolve(c));
      child.on("error", (err) => {
        this.log(project.key, `spawn error: ${err.message}\n`);
        resolve(-1);
      });
    });
    clearTimeout(timer);
    e.child = null;

    const ok = code === 0 && fs.existsSync(path.join(project.dir, "node_modules"));
    e.state = "stopped";
    if (!ok) {
      e.state = "failed";
      e.error = `npm install exited ${code}. See the log.`;
    }
    return ok;
  }

  async start(project) {
    const e = this.entry(project.key);
    if (e.state === "ready" || e.state === "starting") return e.state;

    // Something else may already own the port: another session's dev server,
    // or a previous run of this tool. Adopt it rather than fighting it.
    if (await portOpen(project.upstream)) {
      e.state = "ready";
      e.error = null;
      e.adopted = true;
      e.startedAt = Date.now();
      this.log(project.key, `\n=== adopted an existing server on :${project.upstream}\n`);
      return "ready";
    }

    if (!fs.existsSync(path.join(project.dir, "node_modules"))) {
      e.state = "failed";
      e.error = "No node_modules. Install first.";
      return "failed";
    }

    const spec = commandFor(project, project.upstream);
    if (!spec) {
      e.state = "failed";
      e.error = `Could not find the ${project.command ? String(project.command).split(",")[0] : project.runner} binary under ${project.dir}. Install may be incomplete.`;
      return "failed";
    }

    e.state = "starting";
    e.error = null;
    e.adopted = false;
    e.startedAt = Date.now();
    this.log(
      project.key,
      `\n=== ${new Date().toISOString()} ${spec.cmd} ${spec.args.join(" ")} (cwd ${project.dir})\n`
    );

    const child = spawn(spec.cmd, spec.args, {
      cwd: project.dir,
      env: {
        ...process.env,
        ...spec.env,
        NEXT_TELEMETRY_DISABLED: "1",
        BROWSER: "none",
        FORCE_COLOR: "0",
        CI: "",
      },
      shell: WIN, // .cmd shims are not executables
      windowsHide: true,
      detached: false,
    });
    e.child = child;

    child.stdout.on("data", (d) => this.log(project.key, d.toString()));
    child.stderr.on("data", (d) => this.log(project.key, d.toString()));
    child.on("exit", (code, signal) => {
      this.log(project.key, `\n=== exited code=${code} signal=${signal}\n`);
      e.child = null;
      if (e.state !== "stopping") {
        e.state = "failed";
        e.error = e.error || `Dev server exited with code ${code}.`;
      } else {
        e.state = "stopped";
        e.error = null;
      }
    });
    child.on("error", (err) => {
      this.log(project.key, `spawn error: ${err.message}\n`);
      e.state = "failed";
      e.error = err.message;
    });

    const up = await waitForPort(
      project.upstream,
      START_TIMEOUT_MS,
      () => e.state === "failed" || !e.child
    );
    if (up) {
      e.state = "ready";
      e.error = null;
    } else if (e.state !== "failed") {
      e.state = "failed";
      e.error = `Nothing was listening on :${project.upstream} within ${
        START_TIMEOUT_MS / 1000
      }s. See the log.`;
    }
    return e.state;
  }

  async stop(project) {
    const e = this.entry(project.key);
    const child = e.child;
    if (!child) {
      e.state = "stopped";
      e.error = null;
      return;
    }
    e.state = "stopping";
    if (WIN) {
      // A .cmd shim spawns node as a grandchild; killing the shim orphans it,
      // and the orphan keeps the port. taskkill /T takes the whole tree.
      await new Promise((resolve) => {
        const t = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          windowsHide: true,
        });
        t.on("exit", resolve);
        t.on("error", resolve);
      });
    } else {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 4000).unref?.();
    }
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && (await portOpen(project.upstream))) {
      await new Promise((r) => setTimeout(r, 300));
    }
    e.child = null;
    e.state = "stopped";
    e.error = null;
  }

  async stopAll(projects) {
    await Promise.all(
      projects.filter((p) => p.kind === "node").map((p) => this.stop(p).catch(() => {}))
    );
  }

  runningCount() {
    let n = 0;
    for (const e of this.procs.values()) if (e.state === "ready" || e.state === "starting") n++;
    return n;
  }
}
