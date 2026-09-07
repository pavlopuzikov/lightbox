import { test } from "node:test";
import assert from "node:assert/strict";
import { createHubServer } from "../src/hub.mjs";

/**
 * A hub with just enough around it to answer a request. The point of these
 * tests is the header policy, so everything else is the smallest thing that
 * does not throw.
 */
function hub(hubOrigins) {
  const project = {
    key: "demo",
    name: "Demo",
    dir: "/tmp/demo",
    kind: "static",
    group: "tools",
    port: 4001,
  };
  return createHubServer({
    catalogue: { projects: [project], groups: [{ id: "tools", title: "Tools" }] },
    supervisor: { state: () => ({ state: "static" }), tail: () => "" },
    progress: { get: () => [], countFor: () => 0 },
    handover: { get: () => null, refresh: () => {} },
    hubUrl: "http://127.0.0.1:4000/",
    hubPort: 4000,
    hubOrigins,
    bridge: "http://127.0.0.1:65535",
  });
}

/** Start on an ephemeral port, run one request, shut down. */
async function once(server, path, init) {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    return await fetch(`http://127.0.0.1:${port}${path}`, init);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test("with no allowlist, a cross-origin read gets no CORS headers", async () => {
  // The default. The hub is on loopback, which any page in the browser can
  // address, so an unlisted origin must not be able to read the catalogue.
  const res = await once(hub([]), "/api/state", {
    headers: { origin: "https://evil.example" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), null);
});

test("an origin the config names may read the state", async () => {
  const res = await once(hub(["http://localhost:3020"]), "/api/state", {
    headers: { origin: "http://localhost:3020" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:3020");
  assert.equal(res.headers.get("vary"), "Origin");
  // Chrome refuses a public page's request to a loopback address without this,
  // and the failure looks identical to the hub being down.
  assert.equal(res.headers.get("access-control-allow-private-network"), "true");
});

test("an allowlist does not admit every origin", async () => {
  // The pairing that matters: the same server that answers one origin must
  // refuse another, or the test above passes against a blanket allow.
  const server = hub(["http://localhost:3020"]);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    const ok = await fetch(`http://127.0.0.1:${port}/api/state`, {
      headers: { origin: "http://localhost:3020" },
    });
    const no = await fetch(`http://127.0.0.1:${port}/api/state`, {
      headers: { origin: "http://localhost:9999" },
    });
    assert.equal(ok.headers.get("access-control-allow-origin"), "http://localhost:3020");
    assert.equal(no.headers.get("access-control-allow-origin"), null);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("only GET is offered, so a permitted origin can watch and not touch", async () => {
  const res = await once(hub(["http://localhost:3020"]), "/api/state", {
    method: "OPTIONS",
    headers: { origin: "http://localhost:3020" },
  });
  assert.equal(res.status, 204);
  const methods = res.headers.get("access-control-allow-methods") || "";
  assert.ok(methods.includes("GET"));
  assert.ok(!methods.includes("POST"), `POST is offered: ${methods}`);
});

test("the endpoints that start and stop servers are never cross-origin", async () => {
  // The read endpoint carries the headers; a POST route must not, whatever the
  // origin. Otherwise a listed origin could start processes on this machine.
  const res = await once(hub(["http://localhost:3020"]), "/api/start/demo", {
    method: "POST",
    headers: { origin: "http://localhost:3020" },
  });
  assert.equal(res.headers.get("access-control-allow-origin"), null);
});

test("a preflight from an unlisted origin is refused, not answered blank", async () => {
  const res = await once(hub([]), "/api/state", {
    method: "OPTIONS",
    headers: { origin: "https://evil.example" },
  });
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("access-control-allow-origin"), null);
});
