// The launch maths the app shows bidders, matching CloakAuction.settle.
import { test } from "node:test";
import assert from "node:assert/strict";
import { launchOutcome } from "../dist/index.js";

const E = 10n ** 18n;
const l = { saleSupply: 295_000n * E, lpReserve: 205_000n * E, lpBps: 7000, minRaise: 60n * E };

test("a sell-out at the lowest price: fee, pool, creator and unused reserve", () => {
  const o = launchOutcome(l, 2n * 10n ** 14n, 150); // 0.0002 HYPE
  assert.equal(o.raised, 59n * E);
  assert.equal(o.opens, false, "59 HYPE is under the 60 HYPE minimum: it fails");
  const ok = launchOutcome({ ...l, minRaise: 59n * E }, 2n * 10n ** 14n, 150);
  assert.equal(ok.opens, true);
  assert.equal(ok.fee, (59n * E * 150n) / 10_000n);
  assert.equal(ok.poolHype, ((59n * E - ok.fee) * 7000n) / 10_000n);
  assert.equal(ok.poolTokens, (ok.poolHype * E) / (2n * 10n ** 14n));
  assert.equal(ok.creatorHype + ok.poolHype + ok.fee, 59n * E);
  assert.equal(ok.unusedReserve, l.lpReserve - ok.poolTokens);
});

test("a reserve too small caps the pool's tokens, and the pool's HYPE with them", () => {
  const o = launchOutcome({ saleSupply: 100n * E, lpReserve: 10n * E, lpBps: 5000 }, E, 0);
  assert.equal(o.poolTokens, 10n * E);
  assert.equal(o.poolHype, 10n * E);
  assert.equal(o.creatorHype, 90n * E);
});

test("an undersold sale: only what sold counts", () => {
  const o = launchOutcome({ ...l, minRaise: 0n }, 10n ** 15n, 150, 100_000n * E);
  assert.equal(o.raised, 100n * E);
});
