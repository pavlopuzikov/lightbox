import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildManifest } from "../src/cli/publish.mjs";

/**
 * A static project with three real files on disk, so routesFor has something
 * to discover rather than being mocked into agreeing with the test.
 */
function fixture(progress) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lb-publish-"));
  const site = path.join(dir, "site");
  fs.mkdirSync(path.join(site, "about"), { recursive: true });
  fs.writeFileSync(path.join(site, "index.html"), "<h1>home</h1>");
  fs.writeFileSync(path.join(site, "about", "index.html"), "<h1>about</h1>");
  fs.writeFileSync(path.join(site, "colophon.html"), "<h1>colophon</h1>");

  fs.mkdirSync(path.join(dir, ".lightbox"), { recursive: true });
  if (progress) {
    fs.writeFileSync(
      path.join(dir, ".lightbox", "progress.json"),
      JSON.stringify(progress)
    );
  }

  const config = {
    hubPort: 4000,
    groups: [{ id: "tools", title: "Tools" }],
    projects: [
      {
        key: "demo",
        name: "Demo",
        dir: site.split(path.sep).join("/"),
        kind: "static",
        group: "tools",
        system: "Broadside",
        note: "A fixture.",
      },
    ],
  };
  return { dir, config };
}

test("the snapshot counts pages against the routes that exist now", () => {
  // routesFor returns records, not paths. Comparing stored paths against the
  // records themselves matches nothing and publishes every project as zero,
  // which reads as an empty catalogue rather than as a bug. This is the test
  // that failed when it did.
  const { dir, config } = fixture({ demo: ["/", "/about"] });
  const m = buildManifest(config, dir);
  const p = m.projects[0];
  assert.equal(p.routes, 3);
  assert.equal(p.reviewed, 2);
  assert.equal(m.totals.reviewed, 2);
});

test("progress for a page that no longer exists is not counted", () => {
  // Progress outlives the routes it was recorded for. Taking the stored length
  // is what leaves a project reading 18 of 3 forever.
  const { dir, config } = fixture({ demo: ["/", "/deleted", "/also-gone"] });
  const p = buildManifest(config, dir).projects[0];
  assert.equal(p.routes, 3);
  assert.equal(p.reviewed, 1);
  assert.ok(p.reviewed <= p.routes);
});

test("the snapshot carries no absolute path from this machine", () => {
  // The manifest is committed to the vault, so every field in it is published.
  // project.dir is where forty repos live on this disk and the consumer has no
  // use for it.
  const { dir, config } = fixture({ demo: ["/"] });
  const json = JSON.stringify(buildManifest(config, dir));
  assert.ok(!json.includes(config.projects[0].dir), "the project directory is in the manifest");
  // A drive letter, not just "<letter>:/", which the hub's own http:// URL
  // matches. The first version of this assertion failed on that and looked
  // like a leak.
  assert.ok(
    !/(^|[^A-Za-z0-9])[A-Za-z]:[\\/]/.test(json),
    "a Windows absolute path is in the manifest"
  );
});

test("a project with no stored progress publishes as zero, not as missing", () => {
  const { dir, config } = fixture(null);
  const p = buildManifest(config, dir).projects[0];
  assert.equal(p.reviewed, 0);
  assert.equal(p.routes, 3);
  assert.equal(p.missing, false);
});

test("the manifest is versioned and dated", () => {
  // The consumer refuses a version it does not know, and shows the date rather
  // than pretending the snapshot is current. Both need these two fields.
  const { dir, config } = fixture(null);
  const m = buildManifest(config, dir, new Date("2026-09-07T10:00:00.000Z"));
  assert.equal(m.version, 1);
  assert.equal(m.generatedAt, "2026-09-07T10:00:00.000Z");
  assert.equal(m.hub.port, 4000);
});

test("only groups that have projects in them are published", () => {
  const { dir, config } = fixture(null);
  config.groups.push({ id: "empty", title: "Nothing here" });
  const m = buildManifest(config, dir);
  assert.deepEqual(
    m.groups.map((g) => g.id),
    ["tools"]
  );
});
