import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Shots, linkShots } from "../src/shots.mjs";

// A 1x1 JPEG. Small enough to inline, real enough that the decoder is exercised.
const PIXEL =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsL" +
  "DBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAAB" +
  "AAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

const NOTE = (n, sel) =>
  `## ${n}. PageShell > Now\n- Element: \`<h1>\`\n- Selector: \`${sel}\`\n\n**Comment:** note ${n}\n\n`;

const REVIEW = `# Review: AriOS (arios) /\n- Project directory: \`C:/x\`\n\n` + NOTE(1, "h1") + NOTE(2, "nav > span");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lightbox-shots-"));
}

test("a frame is written to the project's own shots directory", () => {
  const dir = tmp();
  const s = new Shots(dir);
  const r = s.save("arios", { selector: "h1", dataUrl: PIXEL, frame: "f1" });

  assert.ok(r.file, "a path comes back");
  assert.ok(r.file.includes(path.join("arios", "shots")), "beside inbox.md, not in a temp dir");
  assert.equal(fs.readFileSync(r.file).length > 0, true);
  assert.equal(path.extname(r.file), ".jpg");
});

test("a second note on the same screen references the first frame instead of rewriting it", () => {
  const dir = tmp();
  const s = new Shots(dir);
  const first = s.save("arios", { selector: "h1", dataUrl: PIXEL, frame: "same" });
  const second = s.save("arios", { selector: "nav > span", ref: "same" });

  assert.equal(second.file, first.file, "one screen is one file");
  assert.equal(
    fs.readdirSync(path.join(dir, "arios", "shots")).length,
    1,
    "a nine-note pass over one screen must not leave nine copies of it"
  );
  assert.equal(s.take("arios").length, 2, "but both notes are still pending");
});

test("a body that is not an image is refused rather than written", () => {
  const dir = tmp();
  const s = new Shots(dir);
  assert.equal(s.save("arios", { selector: "h1", dataUrl: "data:text/html;base64,PHA+" }).file, null);
  assert.equal(s.save("arios", { selector: "h1", dataUrl: "not a data url" }).file, null);
  assert.equal(fs.existsSync(path.join(dir, "arios", "shots")), false);
});

test("pending frames are bounded and taken once", () => {
  const s = new Shots(tmp(), 3);
  for (let i = 0; i < 5; i++) s.save("arios", { selector: "h" + i });
  const got = s.take("arios");
  assert.equal(got.length, 3, "an armed tab left open all afternoon does not grow forever");
  assert.deepEqual(got.map((g) => g.selector), ["h2", "h3", "h4"], "the oldest go first");
  assert.deepEqual(s.take("arios"), [], "and taking clears");
});

test("each note gets the frame that matches its selector, by selector and not by position", () => {
  const md = linkShots(REVIEW, [
    // Deliberately out of order: the reviewer deleted a note between capturing
    // and submitting, so positional pairing would put these on the wrong notes.
    { selector: "nav > span", file: "C:/shots/b.jpg", rect: { x: 4, y: 8, width: 31, height: 18 }, viewport: { width: 1536, height: 838 } },
    { selector: "h1", file: "C:/shots/a.jpg", rect: { x: 0, y: 0, width: 831, height: 86 }, viewport: { width: 1536, height: 838 } },
  ]);

  const one = md.slice(md.indexOf("## 1."), md.indexOf("## 2."));
  const two = md.slice(md.indexOf("## 2."));
  assert.match(one, /- Shot: C:\/shots\/a\.jpg · element at 0,0 831x86 · viewport 1536x838/);
  assert.match(two, /- Shot: C:\/shots\/b\.jpg · element at 4,8 31x18/);
  assert.ok(one.indexOf("- Shot:") < one.indexOf("**Comment:**"), "the path sits above the comment");
});

test("a note with no frame, and a frame with no note, both leave the markdown alone", () => {
  const only = linkShots(REVIEW, [{ selector: "h1", file: "C:/shots/a.jpg" }]);
  assert.equal((only.match(/- Shot:/g) || []).length, 1);
  assert.ok(only.includes("**Comment:** note 2"), "the unmatched note is untouched");

  assert.equal(linkShots(REVIEW, []), REVIEW);
  assert.equal(linkShots(REVIEW, [{ selector: "footer", file: "C:/x.jpg" }]), REVIEW);
  // A capture whose write failed carries no path and must not emit "- Shot: null".
  assert.equal(linkShots(REVIEW, [{ selector: "h1", file: null }]), REVIEW);
});

test("two notes on the same selector take two different frames", () => {
  const md = linkShots(REVIEW.replace("nav > span", "h1"), [
    { selector: "h1", file: "C:/shots/a.jpg" },
    { selector: "h1", file: "C:/shots/b.jpg" },
  ]);
  assert.ok(md.includes("C:/shots/a.jpg"));
  assert.ok(md.includes("C:/shots/b.jpg"), "the second is not dropped as a duplicate");
});
