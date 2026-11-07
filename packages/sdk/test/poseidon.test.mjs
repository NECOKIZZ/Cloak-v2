// The SDK's Poseidon (poseidon-lite) must give exactly circomlibjs's outputs: it defines keys, note commitments,
// nullifiers and the Merkle tree, so one different digit would break every private balance.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { buildPoseidon } from "circomlibjs";
import { poseidon } from "../dist/private/crypto.js";

const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const rnd = () => BigInt("0x" + randomBytes(32).toString("hex")) % P;
const EDGE = [0n, 1n, 2n, P - 1n, P - 2n, 2n ** 128n - 1n, 2n ** 128n, 2n ** 253n];

test("poseidon matches circomlibjs for 1 to 4 inputs (random and field-edge values)", async () => {
  const ref = await buildPoseidon();
  const R = (xs) => ref.F.toObject(ref(xs));
  let n = 0;
  for (const arity of [1, 2, 3, 4]) {
    const cases = Array.from({ length: 1500 }, () => Array.from({ length: arity }, rnd));
    for (const e of EDGE) cases.push(Array.from({ length: arity }, () => e), Array.from({ length: arity }, (_, j) => (j % 2 ? e : rnd())));
    for (const c of cases) {
      assert.equal(await poseidon(c), R(c), `arity ${arity}: ${c.join(",")}`);
      n++;
    }
  }
  assert.ok(n > 6000);
});

test("poseidon refuses an arity Cloak doesn't use instead of guessing", async () => {
  await assert.rejects(() => poseidon([]), /only 1 to 4/);
  await assert.rejects(() => poseidon([1n, 2n, 3n, 4n, 5n]), /only 1 to 4/);
});
