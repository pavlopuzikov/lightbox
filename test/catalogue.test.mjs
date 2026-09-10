import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCatalogue, inspectCommentSearch } from "../src/catalogue.mjs";

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

/* The element inspector shipped under two names, and the two parts were renamed
   independently: the package became `element-review-inspector` and its entry
   file became `src/element-review-inspector.js`, but a clone made before that
   still sits in a directory called `inspect-comment`. On 2026-09-10 the stale
   name switched the inspector off in every review port, silently, because the
   proxy sets `inspect: !!inspectCommentPath` and the overlay then never even
   attempts the import. These tests are the alarm for the next rename. */

function pkg(dirName, entryFile) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lightbox-inspector-"));
  const dir = path.join(root, dirName);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", entryFile), "export function mount() {}");
  return { cwd: path.join(root, "tool"), dir, entry: path.join(dir, "src", entryFile) };
}

test("auto finds the inspector under either directory name and either entry name", () => {
  // Every combination, because the two names moved independently and the real
  // machine is the awkward one: old directory, new entry file.
  for (const dirName of ["element-review-inspector", "inspect-comment"]) {
    for (const entryFile of ["element-review-inspector.js", "inspect-comment.js"]) {
      const { cwd, entry } = pkg(dirName, entryFile);
      fs.mkdirSync(cwd, { recursive: true });
      const found = inspectCommentSearch({ inspectComment: "auto" }, cwd);
      assert.equal(found.path, entry, `${dirName}/src/${entryFile}`);
      assert.equal(found.problem, null);
    }
  }
});

test("an explicit path survives the entry file being renamed under it", () => {
  const { dir, entry } = pkg("inspect-comment", "element-review-inspector.js");
  // What the config actually held: the old filename, which no longer exists.
  const stale = path.join(dir, "src", "inspect-comment.js");
  const found = inspectCommentSearch({ inspectComment: stale });
  assert.equal(found.path, entry, "the sibling entry file is the obvious answer to a rename");
  // And the package root, which is what you get from copying a path out of a
  // file manager. A directory passes existsSync and then fails to be read.
  assert.equal(inspectCommentSearch({ inspectComment: dir }).path, entry);
});

test("a path that resolves to nothing says which path, not just \"missing\"", () => {
  const junk = path.join(os.tmpdir(), "lightbox-no-inspector-here", "nope.js");
  const found = inspectCommentSearch({ inspectComment: junk });
  assert.equal(found.path, null);
  assert.match(found.problem, /does not exist/);
  assert.ok(found.problem.includes(junk), "name the path so a typo is visible");
});

test("the overlay dresses the dock under the host attribute the inspector uses", () => {
  // dressDock's z-index lift IS the fix for the inspector's own stacking bug, so
  // a selector that matches nothing does not merely leave the dock unstyled: it
  // leaves it buried under a dark page, which is indistinguishable from absent.
  const overlay = fs.readFileSync(new URL("../src/overlay.js", import.meta.url), "utf8");
  // Match the querySelector call, not the file. The comment above that code
  // names both attributes, so a substring check on the file passes even with
  // the live selector reverted to the old name only.
  const queried = [...overlay.matchAll(/querySelector\("\[(data-[a-z-]+)\]"\)/g)].map((m) => m[1]);
  for (const attr of ["data-element-review-inspector", "data-inspect-comment"]) {
    assert.ok(queried.includes(attr), `overlay.js does not querySelector [${attr}]: ${queried.join(", ")}`);
  }
});

test("the bridge health check accepts both names the MCP server has reported", () => {
  // The rename reached three files, and this was the quiet one: the check could
  // not pass at all, so the hub called a working bridge dead on every start, and
  // called it a foreign process squatting the port whenever the port was already
  // held. Reviews were landing the whole time. Matching on the name rather than
  // on `ok` alone is deliberate, because that second message exists precisely to
  // catch an unrelated server holding :7391.
  const index = fs.readFileSync(new URL("../src/index.mjs", import.meta.url), "utf8");
  const from = index.indexOf("function bridgeHealthy");
  assert.notEqual(from, -1, "bridgeHealthy was renamed; this guard needs updating");
  const body = index.slice(from, index.indexOf("\nasync function", from));
  const accepted = [...body.matchAll(/"([a-z-]+-mcp)"/g)].map((m) => m[1]);
  for (const name of ["element-review-inspector-mcp", "inspect-comment-mcp"]) {
    assert.ok(accepted.includes(name), `bridgeHealthy does not accept "${name}": ${accepted.join(", ")}`);
  }
});
