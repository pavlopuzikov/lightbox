import { test } from "node:test";
import assert from "node:assert/strict";
import { checksOf, totalsOf, coverageLine, coverageShort, provenanceLines } from "../src/cli/sweep.mjs";

/** One width cell as sweepRoute records it, with everything passing. */
const cell = (over = {}) => ({
  status: 200,
  console: { errors: [], pageErrors: [] },
  requests: { failed: [], bad: [] },
  overflow: { scrollWidth: 390, innerWidth: 390, over: false, culprits: [] },
  meta: { lang: "en", title: "T", description: 12, viewport: true, h1: 1 },
  focus: { stops: 4, positiveTabindex: 0, first: { landed: true, visible: true } },
  motion: { keyframes: 2, animated: 1, transitions: 3, reducedMotionRule: true, unreadableSheets: 0, runningUnderReduce: 0, framer: false },
  axe: { violations: [], contrast: 0, seriousOrCritical: 0 },
  ...over,
});

const route = (widths) => [{ path: "/", family: "/", file: null, widths }];

test("a cell that never loaded reports every check as unmeasured, not as zero", () => {
  // The whole point. 36 of 36 loads failing used to produce `contrast 0`,
  // which is the same string a clean page produces.
  const t = totalsOf(route({ 390: { error: "net::ERR_CONNECTION_REFUSED" } }), [390]);
  assert.equal(t.contrast, 0, "the counter is still zero, because nothing was added to it");
  assert.equal(t.coverage.complete, false, "but coverage says that zero is not a result");
  assert.equal(t.coverage.failedLoads, 1);
  assert.equal(t.coverage.byCheck.contrast.measured, 0);
  assert.equal(t.coverage.byCheck.contrast.unmeasured, 1);
  assert.match(coverageLine(t), /INCOMPLETE/);
  assert.match(coverageLine(t), /1 load failed/);
});

test("a 500 counts as a failed load even though the request itself succeeded", () => {
  const t = totalsOf(route({ 390: cell({ status: 500 }) }), [390]);
  assert.equal(t.coverage.failedLoads, 1);
  assert.equal(t.coverage.complete, false);
});

test("an axe crash is unmeasured contrast, not clean contrast", () => {
  const c = checksOf(cell({ axe: { violations: [], contrast: 0, seriousOrCritical: 0, error: "axe.run timed out" } }));
  assert.equal(c.loaded, true, "the page loaded fine");
  assert.equal(c.axeMeasured, false);
  assert.equal(c.contrast, null, "null, so a caller cannot add it to a total by accident");
  assert.equal(c.axeError, "axe.run timed out");

  const t = totalsOf(route({ 390: cell({ axe: { violations: [], contrast: 0, seriousOrCritical: 0, error: "boom" } }) }), [390]);
  assert.equal(t.coverage.axeErrors, 1);
  assert.equal(t.coverage.byCheck.contrast.unmeasured, 1);
  // Everything else on that cell did run, and still counts.
  assert.equal(t.coverage.byCheck.overflow.measured, 1);
  assert.equal(t.coverage.complete, false);
});

test("a stylesheet the page cannot read makes motion unmeasured, not undeclared", () => {
  // A cross-origin sheet with no CORS header throws on .cssRules, so its
  // keyframes were never counted. Calling that "declares no motion" is a
  // claim the cell is not entitled to make.
  const c = checksOf(cell({ motion: { keyframes: 0, animated: 0, transitions: 0, reducedMotionRule: false, unreadableSheets: 2, runningUnderReduce: 0, framer: false } }));
  assert.equal(c.motionMeasured, false);
  assert.equal(c.motionOk, null, "not true, which is what an unread sheet used to produce");
  assert.equal(c.unreadableSheets, 2);

  const t = totalsOf(route({ 390: cell({ motion: { keyframes: 0, animated: 0, transitions: 0, reducedMotionRule: false, unreadableSheets: 2, runningUnderReduce: 0, framer: false } }) }), [390]);
  assert.equal(t.motion, 0, "no failure is recorded");
  assert.equal(t.coverage.unreadableSheetCells, 1, "but the gap is");
  assert.equal(t.coverage.complete, false);
});

test("a fully measured sweep reports complete coverage", () => {
  const t = totalsOf(route({ 390: cell(), 768: cell() }), [390, 768]);
  assert.equal(t.coverage.complete, true);
  assert.equal(t.coverage.cells, 2);
  assert.equal(t.coverage.loaded, 2);
  assert.equal(coverageShort(t), "complete");
  assert.match(coverageLine(t), /^coverage: complete, 2 cells$/);
  for (const k of Object.keys(t.coverage.byCheck)) {
    assert.equal(t.coverage.byCheck[k].unmeasured, 0, `${k} left nothing unmeasured`);
  }
});

test("a sweep with no routes at all is not complete coverage", () => {
  // `run` writes this shape when the dev server never booted.
  const t = totalsOf([], [390]);
  assert.equal(t.coverage.complete, false);
  assert.equal(t.coverage.cells, 0);
});

test("a skipped route is not counted as a cell either way", () => {
  const routes = [{ path: "/x/[id]", skipped: "dynamic segment without a params fill", widths: {} }];
  const t = totalsOf(routes, [390]);
  assert.equal(t.coverage.cells, 0);
  assert.equal(t.coverage.failedLoads, 0);
});

test("real failures still count, so unmeasured is not a way to hide findings", () => {
  const bad = cell({
    overflow: { scrollWidth: 500, innerWidth: 390, over: true, culprits: [] },
    axe: { violations: [{ id: "color-contrast", nodes: 7 }], contrast: 7, seriousOrCritical: 2 },
  });
  const t = totalsOf(route({ 390: bad }), [390]);
  assert.equal(t.overflow, 1);
  assert.equal(t.contrast, 7);
  assert.equal(t.axeSerious, 2);
  assert.equal(t.coverage.complete, true);
});

test("contrast provenance says which ancestor painted the background, and through what", () => {
  const lines = provenanceLines({
    axe: {
      provenance: [
        {
          target: "p.label",
          found: true,
          sel: "p.label",
          color: "rgb(255, 255, 255)",
          ownBackground: "rgba(0, 0, 0, 0)",
          backgroundFrom: "div.luxury-card",
          background: "rgb(255, 255, 255)",
          fadedBy: null,
          animatingBy: null,
          varChain: [{ rule: ".luxury-card", prop: "background", declared: "var(--bg-card)", resolves: [{ name: "--bg-card", computed: "#fff" }] }],
          unreadableSheets: 0,
        },
      ],
    },
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /from div\.luxury-card/);
  assert.match(lines[0], /var\(--bg-card\) on \.luxury-card which computed #fff/);
});

test("a reading taken mid-fade is flagged as doubtful, not reported as a finding", () => {
  // The afternoon this is for: a white card chased through five browser probes
  // on a theory about animation, which turned out to be wrong. The measurement
  // now carries whether it had any reason to be doubted.
  const lines = provenanceLines({
    axe: {
      provenance: [
        {
          target: "p",
          found: true,
          sel: "p",
          color: "#fff",
          backgroundFrom: "div.card",
          background: "#fff",
          fadedBy: { sel: "div.card", opacity: "0.4" },
          animatingBy: "div.card",
          varChain: [],
          unreadableSheets: 2,
        },
      ],
    },
  });
  assert.match(lines[0], /mid-fade: div\.card at opacity 0\.4/);
  assert.match(lines[0], /still animating: div\.card/);
  assert.match(lines[0], /2 stylesheets could not be read/);
});

test("a cell with no contrast failures prints no provenance", () => {
  assert.deepEqual(provenanceLines(cell()), []);
  assert.deepEqual(provenanceLines({ error: "net::ERR_CONNECTION_REFUSED" }), []);
});
