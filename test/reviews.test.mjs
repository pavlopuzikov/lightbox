import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drain, keyFromMarkdown, status } from "../src/reviews.mjs";

function fixtureStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lightbox-reviews-"));
  const shotsDir = path.join(root, "bridge", "shots");
  fs.mkdirSync(shotsDir, { recursive: true });
  const shot = path.join(shotsDir, "review-7-note-1.png");
  fs.writeFileSync(shot, "png");
  fs.writeFileSync(path.join(shotsDir, "review-70-note-1.png"), "not ours");
  const store = {
    reviews: [
      {
        id: 8,
        receivedAt: "2026-09-04T16:00:00.000Z",
        page: "http://localhost:4003/colophon",
        viewport: "1036x791@1.25x",
        count: 1,
        shots: 0,
        markdown: "# Review: Avanhard (avanhard) /colophon\n- Project directory: `C:/x`\n\n1. Too tight",
        queue: [{ descriptor: {}, comment: "Too tight", changes: [] }],
        logs: [],
      },
      {
        id: 7,
        receivedAt: "2026-09-04T15:00:00.000Z",
        page: "http://localhost:4016/api/static/dashboard",
        viewport: "390x844@1x",
        count: 1,
        shots: 1,
        markdown: `# Review: Victor (victor) /api/static/dashboard\n\n1. Table overflows\n- Screenshot: ${shot}`,
        queue: [{ descriptor: { shot: { path: shot } }, comment: "Table overflows", changes: [] }],
        logs: [],
      },
      { id: 9, receivedAt: "2026-09-04T17:00:00.000Z", page: "http://localhost:9999/", markdown: "# Review: /\n\n1. no key here", queue: [], logs: [] },
    ],
  };
  const storeFile = path.join(root, "bridge", "reviews.json");
  fs.writeFileSync(storeFile, JSON.stringify(store));
  return { root, storeFile, shotsDir, shot, outDir: path.join(root, "reviews") };
}

test("the project key comes out of the rewritten header", () => {
  assert.deepEqual(keyFromMarkdown("# Review: House Call (housecall) /natal/today\n"), { key: "housecall", route: "/natal/today" });
  assert.deepEqual(keyFromMarkdown("# Review: Two Words (two-words) /"), { key: "two-words", route: "/" });
  assert.equal(keyFromMarkdown("# Review: /about"), null, "an unrewritten header has no key");
});

test("drain copies markdown, queue and shots per key, in id order, and never twice", () => {
  const f = fixtureStore();
  const first = drain(f);
  assert.deepEqual(first.moved.map((m) => [m.id, m.key]), [[7, "victor"], [8, "avanhard"], [9, "unknown"]]);

  const victorMd = fs.readFileSync(path.join(f.outDir, "victor", "review-7.md"), "utf8");
  const copiedShot = path.join(f.outDir, "victor", "shots", "review-7-note-1.png");
  assert.ok(fs.existsSync(copiedShot), "the shot is copied next to the review");
  assert.ok(victorMd.includes(copiedShot) || victorMd.includes(copiedShot.split(path.sep).join("/")), "the markdown points at the copy");
  assert.ok(!fs.existsSync(path.join(f.outDir, "victor", "shots", "review-70-note-1.png")), "review 70's shot is not review 7's");
  const queue = JSON.parse(fs.readFileSync(path.join(f.outDir, "avanhard", "review-8.json"), "utf8"));
  assert.equal(queue.queue[0].comment, "Too tight");
  assert.ok(fs.existsSync(path.join(f.outDir, "unknown", "review-9.md")), "a review without a key is kept, not dropped");

  const second = drain(f);
  assert.equal(second.moved.length, 0, "already drained ids are skipped");
  assert.equal(second.total, 3);

  const rows = status({ storeFile: f.storeFile, drainedFile: path.join(f.outDir, "drained.json") });
  assert.deepEqual(rows.map((r) => [r.id, r.drained]), [[7, true], [8, true], [9, true]]);
});

test("a missing store is an empty drain, not a crash", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lightbox-reviews-"));
  const r = drain({ storeFile: path.join(root, "nope.json"), shotsDir: path.join(root, "shots"), outDir: path.join(root, "out") });
  assert.equal(r.moved.length, 0);
  assert.ok(fs.existsSync(path.join(root, "out", "drained.json")));
});
