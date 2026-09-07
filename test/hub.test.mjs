import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHubServer } from "../src/hub.mjs";
import { Supervisor } from "../src/supervisor.mjs";
import { Progress } from "../src/progress.mjs";
import { Handover } from "../src/handover.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lightbox-hub-"));

const project = {
  key: "site",
  name: "Site",
  kind: "node",
  dir,
  port: 4101,
  // Port 1 is never a dev server, so nothing here can adopt a real process.
  upstream: 1,
  runner: "next",
  exists: true,
  hasModules: true,
  group: "personal",
};

const supervisor = new Supervisor({ logDir: path.join(dir, "logs") });
const handover = new Handover(path.join(dir, "handover.json"));
const server = createHubServer({
  catalogue: { projects: [project], groups: [{ id: "personal", title: "Personal" }] },
  supervisor,
  progress: new Progress(path.join(dir, "progress.json")),
  handover,
  hubUrl: "http://localhost:4000/",
  bridge: null,
  inspectCommentPath: null,
});

const base = await new Promise((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
});

after(() => {
  server.close();
  supervisor.stopWatchingHealth();
  clearInterval(handover.timer);
});

const post = (p, body) =>
  fetch(base + p, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

test("restart is routed, and only over POST", async () => {
  // There was no restart endpoint at all: the allowlist ran
  // start|stop|install|stopall|approve|unapprove|status, so a dead dev server
  // could only be recovered by stopping and starting it in two presses.
  assert.equal((await post("/api/restart/site")).status, 202);
  assert.equal((await fetch(base + "/api/restart/site")).status, 404, "a GET is still not a route");
});

test("every action rejects an unknown key rather than acting on nothing", async () => {
  for (const action of ["start", "stop", "restart", "install", "approve", "status"]) {
    const r = await post(`/api/${action}/nope`, { status: "" });
    assert.equal(r.status, 404, `${action} on an unknown key`);
  }
});

test("an action outside the allowlist is not a route", async () => {
  for (const p of ["/api/kill/site", "/api/start", "/api/../start/site", "/api/restart"]) {
    assert.equal((await post(p)).status, 404, p);
  }
});

test("stopall needs no key and answers without one", async () => {
  const r = await post("/api/stopall");
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
});

test("api/state carries whether a server was adopted, not just that it is ready", async () => {
  const r = await fetch(base + "/api/state");
  const s = await r.json();
  assert.equal(r.status, 200);
  assert.equal(s.projects.site.adopted, false);
  assert.ok("note" in s.projects.site, "the note field is present even when empty");
});

test("a status the model does not define clears the label rather than being stored", async () => {
  const ok = await (await post("/api/status/site", { status: "paused" })).json();
  assert.equal(ok.status, "paused");
  const junk = await (await post("/api/status/site", { status: "not-a-status" })).json();
  assert.equal(junk.status, "");
});

test("the page withholds the Open link for a project whose review port is taken", async () => {
  // `portConflict` was set by src/index.mjs and read by nothing, so the hub
  // went on offering a link to a port lightbox does not own.
  const before = await (await fetch(base + "/")).text();
  assert.match(before, /href="\/go\/site"/);

  project.portConflict = true;
  const after = await (await fetch(base + "/")).text();
  assert.doesNotMatch(after, /href="\/go\/site"/);
  assert.match(after, /could not bind the review port/);
  delete project.portConflict;
});
