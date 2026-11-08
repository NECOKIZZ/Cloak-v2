// Batch orders on Gloam spend one note each: standardSizesFor sizes orders by the notes actually held.
import { test } from "node:test";
import assert from "node:assert/strict";
import { standardSizesFor } from "../dist/index.js";

const sum = (xs) => xs.reduce((a, b) => a + b, 0n);
const std = (x) => {
  let p = 1n;
  while (p * 10n <= x) p *= 10n;
  return x === p || x === 2n * p || x === 5n * p;
};

test("one big note: the usual 1, 2, 5 split", () => {
  const r = standardSizesFor(37n, [100n], 6);
  assert.deepEqual(r.sizes, [20n, 10n, 5n, 2n]);
  assert.equal(r.rest, 0n);
});

test("a balance spread over notes smaller than the amount still goes in", () => {
  // 52 over six notes, the largest 40: a plain split would ask for a 50 that no note holds
  const notes = [40n, 8n, 1n, 1n, 1n, 1n];
  const r = standardSizesFor(52n, notes, 6);
  assert.ok(r.sizes.every(std), "every order is a standard size");
  assert.ok(r.sizes.every((s) => s <= 40n), "no order is bigger than the largest note");
  assert.equal(sum(r.sizes) + r.rest, 52n);
  assert.ok(sum(r.sizes) >= 48n, `most of it goes in (${sum(r.sizes)})`);
});

test("never more than max orders, never more than held", () => {
  const r = standardSizesFor(1000n, [3n, 3n, 3n], 6);
  assert.ok(r.sizes.length <= 6);
  assert.ok(sum(r.sizes) <= 9n);
  assert.equal(sum(r.sizes) + r.rest, 1000n);
});

test("no notes, no orders", () => {
  assert.deepEqual(standardSizesFor(10n, [], 6), { sizes: [], rest: 10n });
});
