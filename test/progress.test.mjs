import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Progress } from "../src/progress.mjs";

test("marks round-trip through flush, unmarking removes, clear empties", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lightbox-progress-")), "progress.json");

  const a = new Progress(file);
  a.set("site", "/", true);
  a.set("site", "/about", true);
  a.set("site", "/", false);
  assert.equal(a.countFor("site"), 1);
  a.flush();
  clearInterval(a.timer);

  const b = new Progress(file);
  assert.deepEqual(b.get("site"), ["/about"]);
  assert.deepEqual(b.get("other"), [], "an unknown key is an empty list, not undefined");
  b.clear("site");
  b.flush();
  clearInterval(b.timer);

  const c = new Progress(file);
  assert.deepEqual(c.get("site"), []);
  clearInterval(c.timer);
});

test("a missing or corrupt file starts empty instead of throwing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lightbox-progress-"));
  const corrupt = path.join(dir, "progress.json");
  fs.writeFileSync(corrupt, "{ not json");
  const p = new Progress(corrupt);
  assert.deepEqual(p.get("x"), []);
  clearInterval(p.timer);

  const q = new Progress(path.join(dir, "missing", "progress.json"));
  q.set("x", "/", true);
  q.flush();
  assert.ok(fs.existsSync(path.join(dir, "missing", "progress.json")), "parent directories are created");
  clearInterval(q.timer);
});
