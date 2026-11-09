import { test } from "node:test";
import assert from "node:assert/strict";
import { sealBid, unsealBid, drandRoundAt, drandRoundTime, commitmentOf, Cloak, bucketDeposit, budgetBuckets } from "../dist/index.js";

const preimage = {
  auction: "0x1111111111111111111111111111111111111111",
  bidder: "0x2222222222222222222222222222222222222222",
  tick: 42,
  quantity: 123456789000000000000n,
  salt: "0x" + "ab".repeat(32),
};

test("sealed bid opens once its drand round has passed", async () => {
  const pastRound = drandRoundAt(Math.floor(Date.now() / 1000) - 60);
  const sealed = await sealBid(preimage, pastRound);
  const opened = await unsealBid(sealed);
  assert.deepEqual(opened, preimage);
});

test("sealed bid cannot be opened before its round", async () => {
  const futureRound = drandRoundAt(Math.floor(Date.now() / 1000) + 3600);
  assert.ok(drandRoundTime(futureRound) > Date.now() / 1000);
  const sealed = await sealBid(preimage, futureRound);
  await assert.rejects(unsealBid(sealed));
});

test("quote picks the tick at or below max price and buckets the deposit", () => {
  const c = new Cloak(/** @type any */ ({}));
  const q = c.quoteBid({ minPrice: 10n ** 14n, tickSize: 10n ** 14n, numTicks: 100 }, 25n * 10n ** 13n, 1000n * 10n ** 18n);
  assert.equal(q.tick, 1); // 0.00025 → tick 1 (0.0002)
  assert.equal(q.cost, 2n * 10n ** 17n);
  assert.equal(q.deposit, 2n * 10n ** 17n);
  assert.equal(bucketDeposit(3n * 10n ** 18n), 5n * 10n ** 18n);
  assert.equal(bucketDeposit(26n * 10n ** 13n), 5n * 10n ** 14n);
  assert.equal(bucketDeposit(10n ** 15n), 10n ** 15n);
  assert.deepEqual(budgetBuckets(3n, 4), [5n, 10n, 20n, 50n]);
});

test("commitment matches the contract encoding shape", () => {
  const h = commitmentOf(preimage.auction, preimage.bidder, preimage.tick, preimage.quantity, preimage.salt);
  assert.match(h, /^0x[0-9a-f]{64}$/);
});
