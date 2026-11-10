// Reading logs up to the head on a load-balanced RPC (head.ts): to the head first, 3 blocks back only when a lagging
// node refuses the range, pieces only where the RPC caps ranges.
import { test } from "node:test";
import assert from "node:assert/strict";
import { HEAD_LAG, isBehindHead, logsToHead, readToHead } from "../dist/index.js";

const client = (head) => ({ getBlockNumber: async () => head });
const behind = Object.assign(new Error("Missing or invalid parameters."), { details: "invalid block range params" });

test("reads to the head when the node has it (no fixed lag)", async () => {
  const r = await readToHead(client(100n), async (to) => to);
  assert.deepEqual(r, { to: 100n, value: 100n });
});

test("a node behind the head: read again 3 blocks back, and say so", async () => {
  let calls = 0;
  const r = await readToHead(client(100n), async (to) => {
    calls++;
    if (to === 100n) throw behind;
    return to;
  });
  assert.equal(r.to, 100n - HEAD_LAG);
  assert.equal(calls, 2);
});

test("any other error is not retried", async () => {
  await assert.rejects(readToHead(client(100n), async () => { throw new Error("execution reverted"); }), /reverted/);
  assert.equal(isBehindHead(new Error("execution reverted")), false);
  assert.equal(isBehindHead(behind), true);
});

test("logsToHead: one call; pieces only when the RPC caps ranges, ending 3 back", async () => {
  const seen = [];
  const get = async (a, b) => {
    seen.push([a, b]);
    if (b - a > 50n) throw new Error("query exceeds max block range");
    return [b];
  };
  const out = await logsToHead(client(100n), 0n, get, { step: 50n });
  assert.deepEqual(seen.slice(0, 1), [[0n, 100n]]);
  assert.deepEqual(out, [49n, 97n]);
});
