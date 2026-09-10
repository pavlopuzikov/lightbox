import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Notes, countNotes } from "../src/notes.mjs";

const REVIEW = `# Review: AriOS (arios) /
- Project directory: \`C:/x\`
Viewport 1536x838 @1.25x · 2 items

## 1. PageShell > Now
- Element: \`<h1>\`

**Comment:** element rounding is not consistent

## 2. PageNav > Nav
- Element: \`<span>\`

**Comment:** redundent repetition
`;

test("notes are counted per comment, not per heading", () => {
  assert.equal(countNotes(REVIEW), 2);
  assert.equal(countNotes("# Review: /\n"), 0, "a review with no notes counts zero");
  assert.equal(countNotes(undefined), 0);
  // The marker has to start the line. A reviewer quoting the word in a comment
  // must not inflate the count.
  assert.equal(countNotes("**Comment:** see **Comment:** below\n"), 1);
});

test("counts accumulate per route and survive a reload", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lightbox-notes-"));
  const a = new Notes(dir);

  assert.equal(a.countFor("arios", "/"), 0, "an unseen route is zero, not undefined");
  assert.equal(a.lastFor("arios", "/"), null);

  a.record("arios", "/", 2);
  a.record("arios", "/", 3);
  a.record("arios", "/career", 4);
  assert.equal(a.countFor("arios", "/"), 5, "a second sitting adds to the first");
  assert.equal(a.totalFor("arios"), 9);
  assert.match(a.lastFor("arios", "/"), /^\d{4}-\d\d-\d\dT/);

  const b = new Notes(dir);
  assert.equal(b.countFor("arios", "/career"), 4);
  assert.equal(b.totalFor("other"), 0, "an unknown project is zero, not a throw");
});

test("with no index, the counts are rebuilt from the archive", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lightbox-notes-"));
  fs.mkdirSync(path.join(dir, "arios"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "arios", "inbox.md"),
    `\n<!-- 2026-09-09T18:05:33.151Z http://localhost:4008/login?next=%2F -->\n` +
      `# Review: /login\n\n**Comment:** remove this logo\n` +
      `\n<!-- 2026-09-10T05:47:07.051Z http://localhost:4008/ -->\n${REVIEW}` +
      `\n<!-- 2026-09-10T05:57:00.000Z http://localhost:4008/ -->\n${REVIEW}`
  );

  const n = new Notes(dir);
  assert.equal(n.countFor("arios", "/"), 4, "two sittings on / at two notes each");
  assert.equal(n.countFor("arios", "/login"), 1, "the query string is not part of the route");
  assert.equal(n.lastFor("arios", "/"), "2026-09-10T05:57:00.000Z", "the latest sitting wins");
  assert.equal(n.totalFor("arios"), 5);
});

test("a zero-note review writes nothing, and a corrupt index reads as empty", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lightbox-notes-"));
  const a = new Notes(dir);
  a.record("arios", "/", 0);
  assert.equal(fs.existsSync(path.join(dir, "arios", "index.json")), false);

  fs.mkdirSync(path.join(dir, "brand"), { recursive: true });
  fs.writeFileSync(path.join(dir, "brand", "index.json"), "{ not json");
  const b = new Notes(dir);
  assert.equal(b.totalFor("brand"), 0);
  b.record("brand", "/", 1);
  assert.equal(b.countFor("brand", "/"), 1, "and it recovers rather than staying broken");
});
