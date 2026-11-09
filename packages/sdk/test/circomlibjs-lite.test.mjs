// The browser stand-in for circomlibjs (Gloam's SDK hashes with it) must give exactly circomlibjs's outputs: Gloam's
// note commitments, nullifiers and Merkle tree depend on it, so one different digit would break every balance.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { buildPoseidon as real } from "circomlibjs";
import { buildPoseidon as lite } from "../dist/circomlibjsLite.js";

const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const rnd = () => BigInt("0x" + randomBytes(32).toString("hex")) % P;
const EDGE = [0n, 1n, 2n, P - 1n, P - 2n, 2n ** 128n - 1n, 2n ** 128n, 2n ** 253n];

test("buildPoseidon stand-in matches circomlibjs, used the way Gloam's SDK uses it", async () => {
  const [a, b] = [await real(), await lite()];
  let n = 0;
  for (const arity of [1, 2, 3, 4]) {
    const cases = Array.from({ length: 1500 }, () => Array.from({ length: arity }, rnd));
    for (const e of EDGE) cases.push(Array.from({ length: arity }, () => e), Array.from({ length: arity }, (_, j) => (j % 2 ? e : rnd())));
    for (const c of cases) {
      assert.equal(b.F.toObject(b(c)), a.F.toObject(a(c)), `arity ${arity}: ${c.join(",")}`);
      n++;
    }
  }
  assert.ok(n > 6000);
});

test("Gloam's own helpers give the same commitments and tree on the stand-in", async () => {
  // Gloam's poseidon2/poseidon3 call buildPoseidon(), then poseidon([..]) and F.toObject: the same shape as above
  const [a, b] = [await real(), await lite()];
  const zerosA = [0n], zerosB = [0n];
  for (let i = 0; i < 20; i++) {
    zerosA.push(a.F.toObject(a([zerosA[i], zerosA[i]])));
    zerosB.push(b.F.toObject(b([zerosB[i], zerosB[i]])));
  }
  assert.deepEqual(zerosB, zerosA, "the empty tree's 20 levels");
});

test("an arity Gloam doesn't use is refused instead of guessed", async () => {
  const b = await lite();
  assert.throws(() => b([]), /1 to 4/);
  assert.throws(() => b([1n, 2n, 3n, 4n, 5n]), /1 to 4/);
});
