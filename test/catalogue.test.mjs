import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCatalogue } from "../src/catalogue.mjs";

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lightbox-catalogue-"));
  for (const [rel, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
}

test("review ports are assigned in order, pinned ports respected, upstreams only for node", () => {
  const html = fixture({ "index.html": "<html></html>" });
  const { projects, groups } = buildCatalogue({
    reviewPortBase: 4001,
    upstreamPortBase: 3100,
    projects: [
      { key: "a", name: "A", dir: html },
      { key: "b", name: "B", dir: html, command: ["storybook", "dev", "-p", "{port}"], port: 4010 },
      { key: "c", name: "C", dir: html, command: "vite --port {port}" },
      { key: "d", name: "D", dir: html, group: "g" },
    ],
    groups: [{ id: "g", title: "Named", blurb: "" }],
  });
  const by = Object.fromEntries(projects.map((p) => [p.key, p]));

  assert.equal(by.a.kind, "static");
  assert.equal(by.a.port, 4001);
  assert.equal(by.a.upstream, undefined, "a static site has no dev server");

  assert.equal(by.b.kind, "node", "a command means there is something to start");
  assert.equal(by.b.port, 4010, "a pinned port is kept");
  assert.equal(by.b.upstream, 3100);

  assert.equal(by.c.kind, "node");
  assert.equal(by.c.port, 4011, "assignment resumes above the pinned port");
  assert.equal(by.c.upstream, 3101);

  assert.equal(by.d.port, 4012);
  assert.equal(by.a.group, "ungrouped");
  assert.deepEqual(
    groups.map((g) => g.id),
    ["g", "ungrouped"],
    "groups referenced but not declared are appended after the declared ones"
  );
  assert.equal(groups[0].title, "Named");
});

test("package.json decides the runner, and an explicit kind overrides it", () => {
  const next = fixture({
    "package.json": JSON.stringify({ dependencies: { next: "16.0.0" } }),
    "index.html": "<html></html>",
  });
  const { projects } = buildCatalogue({
    projects: [
      { key: "auto", name: "Auto", dir: next },
      { key: "forced", name: "Forced", dir: next, kind: "static" },
    ],
  });
  const [auto, forced] = projects;
  assert.equal(auto.kind, "node");
  assert.equal(auto.runner, "next");
  assert.equal(auto.hasModules, false, "no node_modules, so the hub offers an install");
  assert.equal(forced.kind, "static");
  assert.equal(forced.upstream, undefined);
});

test("a configured directory that is not on disk is reported, not dropped", () => {
  const { projects } = buildCatalogue({
    projects: [{ key: "ghost", name: "Ghost", dir: path.join(os.tmpdir(), "lightbox-does-not-exist") }],
  });
  assert.equal(projects.length, 1);
  assert.equal(projects[0].exists, false);
});
