import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { familiesOf, routesFor } from "../src/routes.mjs";

/** Write a fixture tree from { "rel/path": body } and return its root. */
function tree(spec) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lightbox-routes-"));
  for (const [rel, body] of Object.entries(spec)) {
    const full = path.join(root, ...rel.split("/"));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body ?? "");
  }
  return root;
}

let n = 0;
const key = (name) => `${name}-${process.pid}-${n++}`;
const posix = (p) => p.split(path.sep).join("/");

test("App Router: pages become routes, groups vanish, slots and api are skipped", () => {
  const dir = tree({
    "app/layout.tsx": "",
    "app/page.tsx": "",
    "app/(marketing)/pricing/page.tsx": "",
    "app/admin/layout.tsx": "",
    "app/admin/page.tsx": "",
    "app/admin/users/[id]/page.tsx": "",
    "app/@modal/page.tsx": "",
    "app/api/health/route.ts": "",
    "app/blog/[slug]/page.tsx": "",
  });
  const routes = routesFor({ key: key("app"), dir, kind: "node", params: { id: "7" } });
  const paths = routes.map((r) => r.path);

  assert.equal(paths[0], "/", "the root leads the walk");
  assert.deepEqual(
    [...paths].sort(),
    ["/", "/admin", "/admin/users/7", "/blog/[slug]", "/pricing"].sort()
  );

  const users = routes.find((r) => r.path === "/admin/users/7");
  assert.equal(users.family, "/admin", "family is the first segment");
  assert.equal(users.layout, "/admin", "layout is the nearest layout.tsx above");
  assert.equal(users.dynamic, false, "a filled segment is no longer dynamic");
  assert.equal(posix(users.file), "app/admin/users/[id]/page.tsx");

  const blog = routes.find((r) => r.path === "/blog/[slug]");
  assert.equal(blog.dynamic, true, "an unfilled segment keeps its brackets");
  assert.equal(blog.layout, "/");

  assert.equal(routes.find((r) => r.path === "/pricing").family, "/pricing");
});

test("families are contiguous in walk order and familiesOf accounts for every route", () => {
  const dir = tree({
    "app/page.tsx": "",
    "app/admin/page.tsx": "",
    "app/admin/users/page.tsx": "",
    "app/admin/settings/page.tsx": "",
    "app/about/page.tsx": "",
  });
  const routes = routesFor({ key: key("fam"), dir, kind: "node" });
  const fams = familiesOf(routes);

  for (const f of fams) {
    for (let i = f.first; i < f.first + f.count; i++) {
      assert.equal(routes[i].family, f.family, `${f.family} is one contiguous block`);
    }
  }
  assert.equal(fams.find((f) => f.family === "/admin").count, 3);
  assert.equal(
    fams.reduce((sum, f) => sum + f.count, 0),
    routes.length
  );
});

test("declared routes lead the walk, deduplicated against discovery", () => {
  const dir = tree({
    "app/page.tsx": "",
    "app/about/page.tsx": "",
    "app/people/[person]/page.tsx": "",
  });
  const routes = routesFor({
    key: key("declared"),
    dir,
    kind: "node",
    routes: ["/people/[person]", "/about"],
    params: { person: "ada" },
  });
  const paths = routes.map((r) => r.path);
  assert.equal(paths[0], "/people/ada");
  assert.equal(paths[1], "/about");
  assert.equal(paths.filter((p) => p === "/about").length, 1, "no duplicate");
  assert.equal(paths.length, 3);
});

test("Pages Router: index folds into its directory, _app and api are skipped", () => {
  const dir = tree({
    "pages/index.tsx": "",
    "pages/_app.tsx": "",
    "pages/_document.tsx": "",
    "pages/about.tsx": "",
    "pages/api/hello.ts": "",
    "pages/posts/index.tsx": "",
    "pages/posts/[id].tsx": "",
  });
  const routes = routesFor({ key: key("pages"), dir, kind: "node" });
  const paths = routes.map((r) => r.path);
  assert.deepEqual([...paths].sort(), ["/", "/about", "/posts", "/posts/[id]"].sort());
  assert.ok(!paths.some((p) => p.startsWith("/api")), "api/ is not a page");
});

test("a project with nothing discoverable still has a root route", () => {
  const dir = tree({ "package.json": "{}" });
  const routes = routesFor({ key: key("empty"), dir, kind: "node" });
  assert.deepEqual(routes, [{ path: "/", dynamic: false, family: "/", layout: null, file: null }]);
});

test("static: .html files become clean routes, index folds, the root leads, families are directories", () => {
  const dir = tree({
    "index.html": "",
    "about.html": "",
    "docs/index.html": "",
    "docs/guide.html": "",
    "assets/site.css": "",
    "node_modules/pkg/index.html": "",
  });
  const routes = routesFor({ key: key("static"), dir, kind: "static" });
  const paths = routes.map((r) => r.path);
  assert.equal(paths[0], "/");
  assert.deepEqual([...paths].sort(), ["/", "/about", "/docs", "/docs/guide"].sort());
  const guide = routes.find((r) => r.path === "/docs/guide");
  assert.equal(guide.family, "/docs");
  assert.equal(posix(guide.file), "docs/guide.html");
  assert.equal(posix(routes.find((r) => r.path === "/docs").file), "docs/index.html");
});
