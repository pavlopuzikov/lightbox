import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Supervisor, portOpen, loopbackOpen } from "../src/supervisor.mjs";

const logDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "lightbox-sup-"));

/** A bare TCP listener standing in for somebody else's dev server. */
function listener() {
  const server = net.createServer(() => {});
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}
const close = (server) => new Promise((r) => server.close(r));

test("portOpen answers for a listening port and for a closed one", async () => {
  const { server, port } = await listener();
  assert.equal(await portOpen(port), true);
  await close(server);
  assert.equal(await portOpen(port, "127.0.0.1", 300), false);
});

test("loopbackOpen reports which loopback answered", async () => {
  // Vite binds only ::1 by default on Node 17+, so probing 127.0.0.1 alone
  // calls a running server absent. Both are tried, and the winner is returned.
  const { server, port } = await listener();
  assert.equal(await loopbackOpen(port), "127.0.0.1");
  await close(server);
  assert.equal(await loopbackOpen(port, 300), null);
});

test("a server already on the port is adopted, and the row says so", async () => {
  const { server, port } = await listener();
  const s = new Supervisor({ logDir: logDir() });
  const project = { key: "x", dir: process.cwd(), upstream: port, kind: "node" };

  assert.equal(await s.start(project), "ready");
  const st = s.state(project);
  assert.equal(st.state, "ready");
  assert.equal(st.adopted, true, "lightbox did not start this and must not imply it did");
  assert.equal(st.pid, null, "there is no child, which is why nothing notices it dying");
  assert.match(st.note, /did not start it/);
  await close(server);
  s.stopWatchingHealth();
});

test("an adopted server that dies stops reporting ready", async () => {
  // The failure this exists for. `ready` was a one-time latch. A spawned child
  // has an exit event to correct it; an adopted one has no child at all, so a
  // dev server that died went on reporting ready while the proxy 503d, and a
  // sweep against it recorded 36 failed loads and called the project clean.
  const { server, port } = await listener();
  const s = new Supervisor({ logDir: logDir() });
  const project = { key: "x", dir: process.cwd(), upstream: port, kind: "node" };
  await s.start(project);
  assert.equal(s.state(project).state, "ready");

  await close(server);

  // One miss is not enough: a dev server rebinding its port would flap.
  await s.checkHealth();
  assert.equal(s.state(project).state, "ready", "one miss is tolerated");
  await s.checkHealth();

  const st = s.state(project);
  assert.equal(st.state, "failed");
  assert.match(st.error, /Nothing is listening/);
  assert.match(st.error, /no exit code to report/, "it says why there is no exit code");
  s.stopWatchingHealth();
});

test("a health check that finds the port open again clears the miss count", async () => {
  const { server, port } = await listener();
  const s = new Supervisor({ logDir: logDir() });
  const project = { key: "x", dir: process.cwd(), upstream: port, kind: "node" };
  await s.start(project);

  await s.checkHealth();
  await s.checkHealth();
  await s.checkHealth();
  assert.equal(s.state(project).state, "ready", "a live server stays ready across many checks");
  await close(server);
  s.stopWatchingHealth();
});

test("a stopped project is not probed, so stopping does not read as a crash", async () => {
  const s = new Supervisor({ logDir: logDir() });
  const project = { key: "x", dir: process.cwd(), upstream: 1, kind: "node" };
  await s.checkHealth();
  assert.equal(s.state(project).state, "stopped");
  assert.equal(s.state(project).error, null);
  s.stopWatchingHealth();
});

test("restart refuses to claim it restarted a server it did not start", async () => {
  const { server, port } = await listener();
  const s = new Supervisor({ logDir: logDir() });
  const project = { key: "x", dir: process.cwd(), upstream: port, kind: "node" };
  await s.start(project);

  assert.equal(await s.restart(project), "ready");
  const st = s.state(project);
  assert.equal(st.adopted, true);
  assert.match(st.note, /was not restarted/);
  assert.equal(await loopbackOpen(port), "127.0.0.1", "and it left the server alone");
  await close(server);
  s.stopWatchingHealth();
});

test("stop clears the adoption, so the next start is not reported as adopted from memory", async () => {
  const { server, port } = await listener();
  const s = new Supervisor({ logDir: logDir() });
  const project = { key: "x", dir: process.cwd(), upstream: port, kind: "node" };
  await s.start(project);
  await close(server);
  await s.stop(project);
  const st = s.state(project);
  assert.equal(st.state, "stopped");
  assert.equal(st.adopted, false);
  assert.equal(st.note, null);
  s.stopWatchingHealth();
});

test("start reports failed rather than hanging when there is no node_modules", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lightbox-nomods-"));
  const s = new Supervisor({ logDir: logDir() });
  // Port 1 is never a dev server, so adoption cannot fire and the check below
  // is the one that answers.
  const project = { key: "x", dir, upstream: 1, kind: "node", runner: "next" };
  assert.equal(await s.start(project), "failed");
  assert.match(s.state(project).error, /No node_modules/);
  s.stopWatchingHealth();
});

test("watchHealth is idempotent and stops cleanly", () => {
  const s = new Supervisor({ logDir: logDir(), healthIntervalMs: 60_000 });
  s.watchHealth();
  const first = s.healthTimer;
  s.watchHealth();
  assert.equal(s.healthTimer, first, "a second call does not stack a second interval");
  s.stopWatchingHealth();
  assert.equal(s.healthTimer, null);
});
