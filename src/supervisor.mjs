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
const HEALTH_INTERVAL_MS = 5_000;
/* Two consecutive misses before calling a server dead. A dev server that
   rebinds its port on a config change would otherwise flap to failed. */
const HEALTH_MISSES = 2;
/* Budget for the adopt-time identity probe. Generous on purpose: the thing it
   asks is a Next/Vite dev server for its root, and a cold route compile there
   is tens of seconds, not milliseconds. A tight budget does not fail safe, it
   fails confusingly. */
const IDENTITY_TIMEOUT_MS = 45_000;
/* Vite 5+ on Node 17+ binds only the IPv6 loopback by default, so a probe of
   127.0.0.1 alone reports a running server as absent. Try both. */
const LOOPBACKS = ["127.0.0.1", "::1"];

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

/** The loopback address something answers on, or null. */
export async function loopbackOpen(port, timeout = 800) {
  for (const host of LOOPBACKS) if (await portOpen(port, host, timeout)) return host;
  return null;
}

/**
 * Does the server on this port serve a page containing `marker`?
 *
 * The adopt path below used to say an identity check could not be cheap,
 * because a TCP connect says something answers and not what. That is true of a
 * TCP connect and not of an HTTP GET. One request to the root, one substring,
 * a couple of hundred milliseconds.
 *
 * Opt-in per project, via `identity` in the config, because a marker is a claim
 * about a specific app: there is no string that identifies "the right project"
 * in general. A project without one keeps the old behaviour exactly.
 *
 * Why it earns its keep: the config assigns each project a unique upstream
 * precisely because the projects' own dev scripts collide (three declare 3005,
 * three 3010, three 3020). The moment a project is pointed at its real port so
 * lightbox can adopt a running server, "something is listening" stops being
 * good enough, because the something might be one of the other two.
 */
async function servesIdentity(port, host, marker, timeoutMs = IDENTITY_TIMEOUT_MS) {
  const hostPart = host && host.includes(":") ? `[${host}]` : (host || "127.0.0.1");
  const ac = new AbortController();
  const cut = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${hostPart}:${port}/`, { signal: ac.signal, redirect: "follow" });
    // A gate that redirects to a login page still identifies the app, so read
    // the body whatever the status.
    return (await res.text()).includes(marker) ? "yes" : "no";
  } catch {
    // Timed out or refused. NOT the same as serving the wrong thing, and
    // collapsing the two is how this check first went wrong: the budget was
    // 3s, a dev server compiling its root took longer, and lightbox reported
    // ":3020 is held by something that is not AriOS" about AriOS.
    return "unknown";
  } finally {
    clearTimeout(cut);
  }
}

/** Resolves to the loopback host the server came up on, or null. */
async function waitForPort(port, timeoutMs, isDead) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const host = await loopbackOpen(port);
    if (host) return host;
    if (isDead && isDead()) return false;
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
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
  constructor({ logDir, healthIntervalMs = HEALTH_INTERVAL_MS }) {
    this.logDir = logDir;
    /** @type {Map<string, {state:string, child:any, log:string[], error:string|null, startedAt:number|null}>} */
    this.procs = new Map();
    this.healthIntervalMs = healthIntervalMs;
    this.healthTimer = null;
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
        adopted: false,
        note: null,
        upstream: null,
        healthMisses: 0,
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
      host: e.host || null,
      // Whether lightbox started this server or found it already listening.
      // An adopted entry has no child, so nothing tells it the process died;
      // that is what the health check below is for, and a reviewer looking at
      // a row deserves to know which kind of "ready" they are reading.
      adopted: !!e.adopted,
      note: e.note || null,
    };
  }

  /* ---------------------------------------------------------------- *
   * Health
   *
   * `ready` used to be a latch: one successful TCP connect and the state
   * stayed ready for the life of the process. For a server lightbox spawned,
   * the child's `exit` event corrected it. For an adopted one there is no
   * child and no exit event, so a dev server that died went on reporting
   * ready while every proxied request returned 503. A sweep run against it
   * recorded 36 failed loads and called the project clean.
   * ---------------------------------------------------------------- */

  watchHealth() {
    if (this.healthTimer) return;
    this.healthTimer = setInterval(() => {
      this.checkHealth().catch(() => {});
    }, this.healthIntervalMs);
    this.healthTimer.unref?.();
  }

  stopWatchingHealth() {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
  }

  async checkHealth() {
    for (const [key, e] of this.procs) {
      // Only a settled `ready` is worth probing: `starting` has its own wait
      // loop and `stopping` is expected to go quiet.
      if (e.state !== "ready" || !e.upstream) continue;
      const host = await loopbackOpen(e.upstream, 500);
      if (host) {
        e.host = host;
        e.healthMisses = 0;
        continue;
      }
      if (++e.healthMisses < HEALTH_MISSES) continue;
      e.state = "failed";
      e.error = e.adopted
        ? `Nothing is listening on :${e.upstream} any more. lightbox adopted this server rather than starting it, so there is no exit code to report.`
        : `Nothing is listening on :${e.upstream} any more.`;
      this.log(key, `\n=== health check: nothing listening on :${e.upstream}\n`);
    }
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
    const adoptedOn = await loopbackOpen(project.upstream);
    if (adoptedOn) {
      // A project that declares `identity` refuses to adopt a stranger. It
      // cannot start its own server either, because the port is taken, so this
      // is a failure with a name rather than a silent review of the wrong app.
      const who = project.identity
        ? await servesIdentity(project.upstream, adoptedOn, project.identity)
        : "skipped";
      if (who === "no" || who === "unknown") {
        e.state = "failed";
        e.error = who === "no"
          ? `:${project.upstream} is held by something that is not ${project.name || project.key}`
            + ` (no "${project.identity}" in what it serves). Stop it, or give this project a free port.`
          // Refusing on "unknown" is still the safe call, but it has to read as
          // what it is. Reviewing the wrong app silently is the worse outcome.
          : `Something holds :${project.upstream} but did not answer in time, so lightbox could not confirm it is`
            + ` ${project.name || project.key}. Retry once it has finished compiling.`;
        this.log(project.key, `\n=== refused to adopt :${project.upstream}: identity ${who}\n`);
        return "failed";
      }
      e.state = "ready";
      e.error = null;
      e.adopted = true;
      e.note = project.identity
        ? `Adopted the server already listening on :${project.upstream}. It serves "${project.identity}", so it is this project.`
        // Without a marker a TCP connect says something answers, not what. Say
        // so on the row rather than presenting it as this project's dev server.
        : `Adopted a server already listening on :${project.upstream}. lightbox did not start it and cannot confirm it is this project.`;
      e.host = adoptedOn;
      e.upstream = project.upstream;
      e.healthMisses = 0;
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
    e.note = null;
    e.upstream = project.upstream;
    e.healthMisses = 0;
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
      e.host = up;
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
      // An adopted entry always takes this path, since there is no child to
      // kill. Clearing the adoption matters: leaving it set made the entry go
      // on describing itself as adopted after it had been stopped.
      e.state = "stopped";
      e.error = null;
      e.host = null;
      e.adopted = false;
      e.note = null;
      e.healthMisses = 0;
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
    while (Date.now() < deadline && (await loopbackOpen(project.upstream))) {
      await new Promise((r) => setTimeout(r, 300));
    }
    e.child = null;
    e.host = null;
    e.state = "stopped";
    e.error = null;
    e.adopted = false;
    e.note = null;
    e.healthMisses = 0;
  }

  /**
   * Stop and start again.
   *
   * An adopted server is the exception: lightbox did not spawn it, `stop` has
   * no child to kill, and it will still be listening afterwards. Re-adopting
   * it and reporting "restarted" would be false, so this says what happened
   * instead.
   */
  async restart(project) {
    const before = this.entry(project.key);
    const wasAdopted = !!before.adopted && !before.child;
    await this.stop(project);

    if (wasAdopted && (await loopbackOpen(project.upstream))) {
      const e = this.entry(project.key);
      e.state = "ready";
      e.adopted = true;
      e.upstream = project.upstream;
      e.host = await loopbackOpen(project.upstream);
      e.healthMisses = 0;
      e.startedAt = Date.now();
      e.note = `Still listening on :${project.upstream}. lightbox did not start this server, so it was not restarted. Stop it where it was started.`;
      this.log(project.key, `\n=== restart skipped: adopted server on :${project.upstream} is not ours to kill\n`);
      return "ready";
    }
    return this.start(project);
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
