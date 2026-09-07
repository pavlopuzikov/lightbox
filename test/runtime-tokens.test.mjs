import { test } from "node:test";
import assert from "node:assert/strict";
import { classify } from "../src/runtime-tokens.mjs";

/** One row as readTokensInPage returns it. */
const row = (over = {}) => ({ name: "--x", computed: "#111111", declared: [{ value: "#111111", canon: "color:rgb(17, 17, 17)" }], unset: false, matches: true, ...over });

test("a token the project declares and the browser agrees with is not a finding", () => {
  const { overridden, agreed, unset } = classify([row()]);
  assert.equal(overridden.length, 0);
  assert.equal(agreed.length, 1);
  assert.equal(unset.length, 0);
});

test("a token the browser computes to something the project never declares is the finding", () => {
  const { overridden } = classify([row({ computed: "#ff0000", matches: false })]);
  assert.equal(overridden.length, 1);
  assert.equal(overridden[0].computed, "#ff0000");
});

test("a token that is not set at :root is neither a pass nor a finding", () => {
  // Predicting overrides by comparing :root blocks across two repos said 32
  // tokens were overridden in one app. Measured, it was 0. Everything that is
  // not a measured disagreement has to stay out of that count.
  const { overridden, agreed, unset } = classify([row({ computed: "", unset: true, matches: false })]);
  assert.equal(overridden.length, 0);
  assert.equal(agreed.length, 0);
  assert.equal(unset.length, 1);
});

test("a token with two declared values matches if the browser computed either", () => {
  const light = { value: "#ffffff", canon: "color:rgb(255, 255, 255)" };
  const dark = { value: "#000000", canon: "color:rgb(0, 0, 0)" };
  const { overridden } = classify([row({ computed: "#000000", declared: [light, dark], matches: true })]);
  assert.equal(overridden.length, 0);
});
