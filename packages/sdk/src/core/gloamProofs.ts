/**
 * Proofs on Gloam's holder circuits (final keys) from a GloamCore balance, checked on chain by Cloak's contracts:
 *   - joinFundsGate(): enter a launch's allocation gate (CloakFundsGate) by proving a private balance of at least the
 *     gate's threshold, bound to one wallet, without showing the balance or the notes;
 *   - proveReceipt(): a private receipt for a payment this account sent (or holds), checked by CloakReceiptCheck.
 *
 * The provers are passed in (snarkjs on funds.wasm / receipt.wasm and Gloam's final zkeys), like GloamCore's own.
 */
import { encodeFunctionData, parseAbi, toHex, type Address, type Hex } from "viem";
import * as gloam from "@gloamtrade/sdk";
import type { Status } from "../private/common.js";
import type { GloamCore, OwnedGloamNote, SentPayment } from "./gloam.js";

/** snarkjs groth16.fullProve on a circuit: the proof and its public signals. */
export type HolderProver = (input: Record<string, unknown>) => Promise<{ proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] }; publicSignals: string[] }>;

export interface SolidityProof {
  a: [bigint, bigint];
  b: [[bigint, bigint], [bigint, bigint]];
  c: [bigint, bigint];
  pub: bigint[];
}

/** A snarkjs proof as Solidity's Groth16 verifiers take it (b's coordinates swapped). */
export function toSolidityProof(proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] }, publicSignals: string[]): SolidityProof {
  const n = (x: string) => BigInt(x);
  return {
    a: [n(proof.pi_a[0]), n(proof.pi_a[1])],
    b: [
      [n(proof.pi_b[0][1]), n(proof.pi_b[0][0])],
      [n(proof.pi_b[1][1]), n(proof.pi_b[1][0])],
    ],
    c: [n(proof.pi_c[0]), n(proof.pi_c[1])],
    pub: publicSignals.map(n),
  };
}

export const CLOAK_FUNDS_GATE_ABI = parseAbi([
  "function createGate(address asset, uint128 threshold, uint64 closesAt) returns (uint256)",
  "function gates(uint256) view returns (address creator, address asset, uint128 threshold, uint64 closesAt, uint32 entered, uint32 confirmed)",
  "function verifierString(uint256 gateId, address wallet) view returns (string)",
  "function contextFor(uint256 gateId, address vault, address wallet) view returns (uint256)",
  "function enter(uint256 gateId, address vault, address wallet, uint256[2] a, uint256[2][2] b, uint256[2] c, uint256[8] pub)",
  "function isEligible(uint256 gateId, address wallet) view returns (bool)",
  "function isConfirmed(uint256 gateId, address wallet) view returns (bool)",
  "function confirm(uint256 gateId, address wallet)",
  "function wallets(uint256 gateId, uint256 start, uint256 count) view returns (address[])",
]);

export const CLOAK_RECEIPT_CHECK_ABI = parseAbi([
  "function contextFor(address vault, uint64 expiresAt, string verifierName) view returns (uint256)",
  "function check(address vault, uint256[2] a, uint256[2][2] b, uint256[2] c, uint256[7] pub, address asset, uint256 minAmount, uint64 expiresAt, string verifierName) view returns (bool ok, uint256 amount, bytes32 commitment)",
]);

/** The fewest of this account's notes (largest first, at most 4, the circuit's limit) that reach `threshold`. */
export function notesFor(core: GloamCore, asset: Address, threshold: bigint): OwnedGloamNote[] {
  const notes = [...core.ownNotes(asset)].sort((x, y) => (y.amount > x.amount ? 1 : y.amount < x.amount ? -1 : 0));
  const out: OwnedGloamNote[] = [];
  let sum = 0n;
  for (const n of notes) {
    if (sum >= threshold || out.length === gloam.FUNDS_PROOF_SLOTS) break;
    out.push(n);
    sum += n.amount;
  }
  if (sum < threshold) {
    // Gloam's sends take one note in, so notes can't be merged privately: the only way to combine is public
    throw new Error(
      out.length === gloam.FUNDS_PROOF_SLOTS
        ? "A proof can use your four largest private balances, and they don't reach this amount. To combine balances, cash a few out and add them back as one deposit. That step is public."
        : "Not enough private balance for this.",
    );
  }
  return out;
}

/**
 * Enter `wallet` in an allocation gate by proving at least the gate's threshold, from this account's balance in
 * core's vault. The proof's notes must stay unspent until the gate closes, or the wallet drops out.
 */
export async function joinFundsGate(
  core: GloamCore,
  p: { gate: Address; gateId: bigint; wallet: Address; prover: HolderProver },
  onStatus: Status = () => {},
): Promise<{ txHash: Hex; nullifiers: bigint[] }> {
  const pub = core.config.publicClient;
  await core.sync(onStatus);
  const [, asset, threshold, closesAt] = (await pub.readContract({ address: p.gate, abi: CLOAK_FUNDS_GATE_ABI, functionName: "gates", args: [p.gateId] })) as readonly [Address, Address, bigint, bigint, number, number];
  const verifier = (await pub.readContract({ address: p.gate, abi: CLOAK_FUNDS_GATE_ABI, functionName: "verifierString", args: [p.gateId, p.wallet] })) as string;
  const context = gloam.proofContext({ kind: "funds", chainId: core.config.chainId, pool: core.config.pool, verifier, expiresAt: Number(closesAt) });
  const onChain = (await pub.readContract({ address: p.gate, abi: CLOAK_FUNDS_GATE_ABI, functionName: "contextFor", args: [p.gateId, core.config.pool, p.wallet] })) as bigint;
  if (onChain !== context) throw new Error("This gate computes its proof context differently from Gloam's SDK; not proving.");
  const notes = notesFor(core, asset, threshold);
  const inputs = [];
  for (const n of notes) inputs.push({ secretHex: toHex(n.secret, { size: 32 }), amount: n.amount, path: await core.pathOf(n.commitment) });
  const w = await gloam.buildFundsWitness({ asset, threshold, context, notes: inputs });
  if (w.blocker) throw new Error(w.blocker);
  onStatus("Proving your balance (it stays private)");
  const { proof, publicSignals } = await p.prover(w.circomInput);
  const sp = toSolidityProof(proof, publicSignals);
  onStatus("Joining the gate");
  const data = encodeFunctionData({
    abi: CLOAK_FUNDS_GATE_ABI,
    functionName: "enter",
    args: [p.gateId, core.config.pool, p.wallet, sp.a, sp.b, sp.c, sp.pub as unknown as readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint]],
  });
  const txHash = await core.config.submit({ kind: "escrow", to: p.gate, data });
  return { txHash, nullifiers: w.publicInputs.nullifiers };
}

/**
 * A private receipt for `payment` (from core.sentPayments(), or a note this account holds), for `verifierName` until
 * `expiresAt`. With reveal, the exact amount shows; without, only that it was at least `minAmount`. The receipt is the
 * proof plus these fields: hand them to the reader, who checks them with CloakReceiptCheck.check (or off chain).
 */
export async function proveReceipt(
  core: GloamCore,
  payment: Pick<SentPayment, "commitment" | "secret" | "asset" | "amount">,
  p: { verifierName: string; expiresAt: number; reveal: boolean; minAmount?: bigint; prover: HolderProver },
): Promise<{ vault: Address; asset: Address; minAmount: bigint; expiresAt: number; verifierName: string; proof: SolidityProof }> {
  const context = gloam.proofContext({ kind: "payment", chainId: core.config.chainId, pool: core.config.pool, verifier: p.verifierName, expiresAt: p.expiresAt });
  const w = await gloam.buildReceiptWitness({
    secretHex: toHex(payment.secret, { size: 32 }),
    amount: payment.amount,
    asset: payment.asset,
    path: await core.pathOf(payment.commitment),
    reveal: p.reveal,
    minAmount: p.minAmount,
    context,
  });
  if (w.blocker) throw new Error(w.blocker);
  const { proof, publicSignals } = await p.prover(w.circomInput);
  return { vault: core.config.pool, asset: payment.asset, minAmount: w.publicInputs.minAmount, expiresAt: p.expiresAt, verifierName: p.verifierName, proof: toSolidityProof(proof, publicSignals) };
}
