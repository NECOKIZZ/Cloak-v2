// GLOAK's surcharge maths, matching GloakToken: what burns, what arrives, and what to send for an exact amount.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gloakSurcharge, gloakArrives, gloakGrossFor, GLOAK_ROLES } from "../dist/index.js";

const E = 10n ** 18n;

test("10% of a move to a public address burns, rounded down as the token does", () => {
  assert.equal(gloakSurcharge(1_000n * E, 1000), 100n * E);
  assert.equal(gloakArrives(1_000n * E, 1000), 900n * E);
  assert.equal(gloakSurcharge(9n, 1000), 0n, "9 wei: floor(0.9) = 0 burned");
  assert.equal(gloakArrives(19n, 1000), 18n);
});

test("a lowered surcharge, and none", () => {
  assert.equal(gloakArrives(1_000n * E, 500), 950n * E);
  assert.equal(gloakArrives(1_000n * E, 0), 1_000n * E);
});

test("gross-up: the smallest send that delivers at least the amount", () => {
  for (const net of [1n, 9n, 10n, 999n, 1_000n * E, 123_456_789n * E + 7n]) {
    for (const bps of [1000, 500, 1, 0]) {
      const g = gloakGrossFor(net, bps);
      assert.ok(gloakArrives(g, bps) >= net, `enough arrives (${net} at ${bps})`);
      assert.ok(g === 0n || gloakArrives(g - 1n, bps) < net, `and it's the smallest (${net} at ${bps})`);
    }
  }
  // the token rounds the burn down, so one wei under 1,000 already delivers exactly 900
  assert.equal(gloakGrossFor(900n * E, 1000), 1_000n * E - 1n);
  assert.equal(gloakArrives(1_000n * E - 1n, 1000), 900n * E);
  assert.equal(gloakGrossFor(0n, 1000), 0n);
  assert.throws(() => gloakGrossFor(1n, 10_000));
});

test("roles match the token's bits", () => {
  assert.deepEqual(GLOAK_ROLES, { receive: 1, send: 2, feed: 4, swap: 8, vault: 16, payee: 32 });
});
