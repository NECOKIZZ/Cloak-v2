import { encodeAbiParameters, keccak256, zeroAddress, type Address, type Hex } from "viem";
import { FIELD_SIZE, LEVELS, MAX_NOTE_AMOUNT, noteCommitment, nullifierOf, poseidon, randomField } from "./crypto.js";
import type { MerkleTree } from "./tree.js";
import type { ProofArgs, Prover } from "./prover.js";

export interface ExtData {
  recipient: Address;
  extAmount: bigint;
  relayer: Address;
  fee: bigint;
  encryptedOutput1: Hex;
  encryptedOutput2: Hex;
  data: Hex;
}

/** A note we can spend: leaf position + the spending key it belongs to. */
export interface OwnedNote {
  amount: bigint;
  pubKey: bigint;
  blinding: bigint;
  leafIndex: number; // position inside its tree epoch
  epoch?: number;
  keyIndex: number;
  privKey: bigint;
  commitment: bigint;
  nullifier: bigint;
  spent: boolean;
}

export interface OutputNote {
  amount: bigint;
  pubKey: bigint;
  blinding?: bigint;
  memo: (blinding: bigint) => Hex;
}

const EXT_DATA_ABI = [
  {
    type: "tuple",
    components: [
      { name: "recipient", type: "address" },
      { name: "extAmount", type: "int256" },
      { name: "relayer", type: "address" },
      { name: "fee", type: "uint256" },
      { name: "encryptedOutput1", type: "bytes" },
      { name: "encryptedOutput2", type: "bytes" },
      { name: "data", type: "bytes" },
    ],
  },
] as const;

export const SWAP_DATA_ABI = [
  {
    type: "tuple",
    components: [
      { name: "pair", type: "address" },
      { name: "poolOut", type: "address" },
      { name: "minOut", type: "uint256" },
      { name: "outPubKey", type: "uint256" },
      { name: "outBlinding", type: "uint256" },
      { name: "outMemo", type: "bytes" },
      { name: "deadline", type: "uint64" },
    ],
  },
] as const;

export const ORDER_DATA_ABI = [
  {
    type: "tuple",
    components: [
      { name: "token", type: "address" },
      { name: "outPubKey", type: "uint256" },
      { name: "outBlinding", type: "uint256" },
      { name: "outMemo", type: "bytes" },
    ],
  },
] as const;

/** `CloakMigrator.MoveData`: where a moved balance lands in the new deployment. */
export const MOVE_DATA_ABI = [
  {
    type: "tuple",
    components: [
      { name: "outPubKey", type: "uint256" },
      { name: "outBlinding", type: "uint256" },
      { name: "outMemo", type: "bytes" },
    ],
  },
] as const;

/**
 * Split an amount into at most `maxOrders` standard sizes (1, 2, 5 × 10ⁿ), largest first. Everyone's orders come
 * from the same small set of sizes, so no order stands out.
 */
export function splitStandard(amount: bigint, maxOrders = 6): { sizes: bigint[]; rest: bigint } {
  const sizes: bigint[] = [];
  let rest = amount;
  while (rest > 0n && sizes.length < maxOrders) {
    const pow = 10n ** BigInt(rest.toString().length - 1);
    const lead = rest / pow; // 1..9
    const d = lead >= 5n ? 5n : lead >= 2n ? 2n : 1n;
    sizes.push(d * pow);
    rest -= d * pow;
  }
  return { sizes, rest };
}

export function hashExtData(ext: ExtData): bigint {
  return BigInt(keccak256(encodeAbiParameters(EXT_DATA_ABI, [ext]))) % FIELD_SIZE;
}

const fieldMod = (x: bigint) => ((x % FIELD_SIZE) + FIELD_SIZE) % FIELD_SIZE;

/**
 * Build and prove a 2-in/2-out shielded transaction. `data` is bound into the proof through `extDataHash`, which is
 * what lets the router act on a withdrawal without trusting whoever submits it.
 */
export async function buildTransaction(p: {
  tree: MerkleTree;
  inputs: OwnedNote[];
  outputs: OutputNote[];
  extAmount?: bigint;
  fee?: bigint;
  recipient?: Address;
  relayer?: Address;
  data?: Hex;
  dummyPubKey: bigint;
  dummyMemo: (blinding: bigint) => Hex;
  prover: Prover;
}): Promise<{ proof: ProofArgs; extData: ExtData }> {
  const extAmount = p.extAmount ?? 0n;
  const fee = p.fee ?? 0n;
  if (p.inputs.length > 2 || p.outputs.length > 2) throw new Error("max 2 inputs and 2 outputs");

  const ins: { amount: bigint; pubKey: bigint; blinding: bigint; leafIndex: number; privKey: bigint }[] = [...p.inputs];
  while (ins.length < 2) {
    const privKey = randomField();
    ins.push({ amount: 0n, privKey, pubKey: await poseidon([privKey]), blinding: randomField(), leafIndex: 0 });
  }
  const outs = p.outputs.map((o) => ({ ...o, blinding: o.blinding ?? randomField() }));
  while (outs.length < 2) outs.push({ amount: 0n, pubKey: p.dummyPubKey, blinding: randomField(), memo: p.dummyMemo });
  for (const o of outs) if (o.amount < 0n || o.amount >= MAX_NOTE_AMOUNT) throw new Error("output amount out of range");

  const sumIn = ins.reduce((s, n) => s + n.amount, 0n);
  const sumOut = outs.reduce((s, n) => s + n.amount, 0n);
  if (sumIn + extAmount - fee !== sumOut) throw new Error("unbalanced transaction");

  const root = await p.tree.root();
  const inPathElements: bigint[][] = [];
  for (const n of ins) {
    if (n.amount === 0n) {
      inPathElements.push(new Array(LEVELS).fill(0n));
      continue;
    }
    const path = await p.tree.path(n.leafIndex);
    if (path.root !== root) throw new Error("merkle path does not match root");
    inPathElements.push(path.pathElements);
  }

  const extData: ExtData = {
    recipient: p.recipient ?? zeroAddress,
    extAmount,
    relayer: p.relayer ?? zeroAddress,
    fee,
    encryptedOutput1: outs[0].memo(outs[0].blinding),
    encryptedOutput2: outs[1].memo(outs[1].blinding),
    data: p.data ?? "0x",
  };

  const proof = await p.prover({
    root,
    publicAmount: fieldMod(extAmount - fee),
    extDataHash: hashExtData(extData),
    inputNullifier: await Promise.all(ins.map((n) => nullifierOf(n, n.leafIndex, n.privKey))),
    outputCommitment: await Promise.all(outs.map((o) => noteCommitment(o))),
    inAmount: ins.map((n) => n.amount),
    inPrivateKey: ins.map((n) => n.privKey),
    inBlinding: ins.map((n) => n.blinding),
    inPathIndices: ins.map((n) => BigInt(n.leafIndex)),
    inPathElements,
    outAmount: outs.map((o) => o.amount),
    outPubkey: outs.map((o) => o.pubKey),
    outBlinding: outs.map((o) => o.blinding),
  });
  return { proof, extData };
}

/** Pick 1–2 notes covering `target` (smallest single note, else the tightest pair). */
export function selectNotes(notes: OwnedNote[], target: bigint): { inputs: OwnedNote[] } | { merge: OwnedNote[] } {
  const live = notes.filter((n) => !n.spent).sort((a, b) => (a.amount < b.amount ? -1 : 1));
  const single = live.find((n) => n.amount >= target);
  if (single) return { inputs: [single] };
  let best: OwnedNote[] | null = null;
  let bestSum = 0n;
  for (let i = 0; i < live.length; i++)
    for (let j = i + 1; j < live.length; j++) {
      const s = live[i].amount + live[j].amount;
      if (s >= target && (!best || s < bestSum)) {
        best = [live[i], live[j]];
        bestSum = s;
      }
    }
  if (best) return { inputs: best };
  const total = live.reduce((s, n) => s + n.amount, 0n);
  if (total < target || live.length < 2) throw new Error("insufficient private balance");
  return { merge: live.slice(-2) };
}
