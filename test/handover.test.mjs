import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Handover, EMPTY, summarise } from "../src/handover.mjs";

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lightbox-handover-")), "handover.json");

test("an entry round-trips through flush and keeps every default field", () => {
  const file = tmp();
  const a = new Handover(file);
  assert.equal(a.get("site"), null, "nothing recorded is null, not an empty entry");
  a.set("site", { branch: "audit/x", commits: [{ sha: "abc1234", subject: "fix(tokens): rename" }] });
  a.flush();
  clearInterval(a.timer);

  const b = new Handover(file);
  const e = b.get("site");
  assert.equal(e.branch, "audit/x");
  assert.equal(e.commits.length, 1);
  assert.equal(e.approved, false);
  assert.deepEqual(e.tierC, []);
  assert.deepEqual(Object.keys(e).sort(), Object.keys(EMPTY).sort(), "the on-disk shape never loses a field");
  clearInterval(b.timer);
});

test("set merges shallowly, so a refresh from git keeps hand-written proposals and the approval", () => {
  const h = new Handover(tmp());
  h.set("site", { tierC: [{ title: "hero gradient", route: "/", width: 1440, shot: "x.png", proposal: "flat ink" }] });
  h.approve("site", new Date("2026-09-05T10:00:00Z"));
  h.set("site", { commits: [{ sha: "1", subject: "a" }, { sha: "2", subject: "b" }], sweep: { routes: 3 } });
  const e = h.get("site");
  assert.equal(e.tierC.length, 1);
  assert.equal(e.approved, true);
  assert.equal(e.approvedAt, "2026-09-05T10:00:00.000Z");
  assert.equal(e.commits.length, 2);
  h.unapprove("site");
  assert.equal(h.get("site").approved, false);
  assert.equal(h.get("site").approvedAt, null);
  clearInterval(h.timer);
});

test("a corrupt or missing file starts empty and the parent directory is created on flush", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lightbox-handover-"));
  const corrupt = path.join(dir, "handover.json");
  fs.writeFileSync(corrupt, "[1,2,3]");
  const a = new Handover(corrupt);
  assert.deepEqual(a.all(), {}, "an array is not a handover file");
  clearInterval(a.timer);

  const nested = path.join(dir, "deeper", "handover.json");
  const b = new Handover(nested);
  b.set("x", { note: "audit only" });
  b.flush();
  assert.ok(fs.existsSync(nested));
  clearInterval(b.timer);
});

test("summarise says only what is there", () => {
  assert.deepEqual(summarise(null), []);
  assert.deepEqual(summarise({ ...EMPTY }), []);
  const lines = summarise({
    ...EMPTY,
    branch: "audit/front-end-2026-09",
    commits: [{ sha: "1", subject: "a" }],
    sweep: { routes: 12, consoleErrors: 0, overflow: 2, contrast: 1 },
    tierC: [{}, {}, {}],
  });
  assert.deepEqual(lines, [
    "audit/front-end-2026-09 · 1 commit",
    "sweep: 12 routes, 0 errors, 2 overflow, 1 contrast",
    "3 proposals",
  ]);
});

test("an external rewrite while the hub runs survives the next approve", () => {
  // scripts/handover.mjs rewrites this file every time a batch finishes. The
  // hub had loaded it once at startup, so an Approve press wrote a copy from
  // minutes ago back over it and dropped every commit list recorded since.
  const file = tmp();
  fs.writeFileSync(file, JSON.stringify({ site: { branch: "audit/x", commits: [] } }));
  const hub = new Handover(file);
  assert.equal(hub.get("site").commits.length, 0);

  // A script rewrites the file underneath the running hub.
  fs.writeFileSync(
    file,
    JSON.stringify({
      site: { branch: "audit/x", commits: [{ sha: "abc1234", subject: "fix(meta): title" }], note: "from the script" },
      other: { branch: "audit/y", commits: [{ sha: "def5678", subject: "fix(alt): logo" }] },
    }),
  );

  // The hub sees the new state without a restart.
  assert.equal(hub.get("site").commits.length, 1, "re-read after the file changed");
  assert.equal(hub.get("site").note, "from the script");
  assert.ok(hub.get("other"), "a key added by the script is visible");

  // Approving writes the approval without discarding what the script wrote.
  hub.approve("site");
  hub.flush();
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(onDisk.site.approved, true);
  assert.equal(onDisk.site.commits.length, 1, "the script's commits survived the approve");
  assert.equal(onDisk.site.note, "from the script");
  assert.equal(onDisk.other.commits.length, 1, "an untouched key is left alone");
});

test("a script write that lands between an approve and its flush is kept", () => {
  const file = tmp();
  fs.writeFileSync(file, JSON.stringify({ site: { branch: "audit/x", commits: [] } }));
  const hub = new Handover(file);
  hub.approve("site"); // dirty from here on, so refresh() must not clobber it
  fs.writeFileSync(
    file,
    JSON.stringify({ site: { branch: "audit/x", commits: [{ sha: "aaa", subject: "fix(lang): html" }] } }),
  );
  hub.flush();
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(onDisk.site.approved, true, "the approval was not lost");
  assert.equal(onDisk.site.commits.length, 1, "nor was the write that raced it");
});
