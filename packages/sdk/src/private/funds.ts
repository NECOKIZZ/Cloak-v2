import { encodeAbiParameters, keccak256, type Address, type PublicClient } from "viem";
import { cloakVaultsAbi, shieldedPoolAbi } from "../abis.js";
import { FIELD_SIZE } from "./crypto.js";
import type { RawGroth16 } from "./prover.js";
import { FUNDS_VERIFYING_KEY } from "./fundsVk.js";
export { FUNDS_VERIFYING_KEY };

/**
 * Proof of funds: "this vault holds at least `threshold` for me, as of block `block`", from up to 3 of the prover's
 * notes, without the balance, the notes or the owner. The proof reveals those notes' nullifiers, so the verifier can
 * check none was spent; the flip side is that the verifier could notice when they're spent later, which is why the
 * app offers to refresh them (a private send to yourself) after proving.
 *
 * `context` binds a proof to one purpose: the chain, the vault, a free-text label (who it's for) and an expiry. A proof
 * shown with a different label or after its expiry fails.
 */
export const FUNDS_NOTES = 3;

export interface FundsProof {
  v: 1;
  chainId: number;
  pool: Address;
  /** the vault's asset, for display (WHYPE for HYPE) */
  token: Address;
  symbol: string;
  decimals: number;
  threshold: string;
  label: string;
  /** unix seconds */
  expiresAt: number;
  /** the block the notes were checked unspent at, when proving */
  block: string;
  root: string;
  context: string;
  nullifiers: string[];
  proof: RawGroth16;
}

export function fundsContext(chainId: number, pool: Address, label: string, expiresAt: number): bigint {
  return BigInt(keccak256(encodeAbiParameters([{ type: "string" }, { type: "uint256" }, { type: "address" }, { type: "string" }, { type: "uint64" }], ["cloak-funds-v1", BigInt(chainId), pool, label, BigInt(expiresAt)]))) % FIELD_SIZE;
}

/** Public signals in the circuit's order: root, threshold, context, nullifier[3]. */
export const fundsSignals = (p: FundsProof) => [p.root, p.threshold, p.context, ...p.nullifiers];

/** A proof as a short shareable string (base64url JSON), for a link like `cloak.boblabs.tech/proof#<this>`. */
export function encodeFundsProof(p: FundsProof): string {
  const b = new TextEncoder().encode(JSON.stringify(p));
  return btoa(Array.from(b, (c) => String.fromCharCode(c)).join("")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function decodeFundsProof(s: string): FundsProof {
  const b = Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const p = JSON.parse(new TextDecoder().decode(b)) as FundsProof;
  if (p?.v !== 1 || !Array.isArray(p.nullifiers) || p.nullifiers.length !== FUNDS_NOTES) throw new Error("not a Cloak proof of funds");
  return p;
}

export interface FundsCheck {
  ok: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
  /** a backing note was spent after the proof's block (the claim held when made, not now) */
  spentSince: boolean;
}

/**
 * Check a proof of funds: the zero-knowledge proof itself (against `vk`, by default the key built into the SDK), that it's bound
 * to this chain, vault, label and expiry, that the vault is a Cloak vault and knows the root, and that no backing note
 * was spent as of the proof's block. A note spent since is reported, not failed: the claim was true when made.
 */
export async function verifyFundsProof(publicClient: PublicClient, p: FundsProof, vk: unknown = FUNDS_VERIFYING_KEY, opts: { vaults?: Address; now?: number } = {}): Promise<FundsCheck> {
  const checks: FundsCheck["checks"] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const chainId = publicClient.chain?.id ?? (await publicClient.getChainId());
  add("Right network", chainId === p.chainId, chainId === p.chainId ? "The proof is for this chain." : `The proof is for chain ${p.chainId}.`);
  const ctx = fundsContext(p.chainId, p.pool, p.label, p.expiresAt).toString();
  add("Made for this purpose", ctx === p.context, ctx === p.context ? `Label "${p.label}".` : "The label, vault or expiry was changed after proving.");
  add("Not expired", p.expiresAt > now, p.expiresAt > now ? `Valid until ${new Date(p.expiresAt * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC.` : "This proof has expired.");
  const snarkjs = await import("snarkjs");
  const valid = await snarkjs.groth16.verify(vk as never, fundsSignals(p), p.proof as never).catch(() => false);
  add("Valid zero-knowledge proof", valid, valid ? "The math checks out: the notes exist and add up." : "The proof doesn't verify.");
  if (opts.vaults) {
    const isPool = await publicClient.readContract({ address: opts.vaults, abi: cloakVaultsAbi, functionName: "isPool", args: [p.pool] }).catch(() => false);
    add("A Cloak vault", isPool, isPool ? "The notes are in one of Cloak's permanent vaults." : "That address isn't a Cloak vault.");
  }
  const rootOk = await publicClient.readContract({ address: p.pool, abi: shieldedPoolAbi, functionName: "isKnownRoot", args: [BigInt(p.root)] }).catch(() => false);
  add("Real vault state", rootOk, rootOk ? "The vault knows the tree the notes are in." : "The vault doesn't know this tree.");
  const live = p.nullifiers.filter((n) => n !== "0");
  const block = BigInt(p.block);
  const spentAt = (n: string, blockNumber?: bigint) => publicClient.readContract({ address: p.pool, abi: shieldedPoolAbi, functionName: "isSpent", args: [BigInt(n)], ...(blockNumber ? { blockNumber } : {}) });
  const atBlock = await Promise.all(live.map((n) => spentAt(n, block).catch(() => spentAt(n))));
  const unspentThen = atBlock.every((x) => !x);
  add("Unspent when proved", unspentThen && live.length > 0, unspentThen ? `None of the ${live.length} backing note${live.length > 1 ? "s" : ""} had been spent at block ${block}.` : "A backing note had already been spent when the proof was made.");
  const nowSpent = await Promise.all(live.map((n) => spentAt(n).catch(() => false)));
  const spentSince = nowSpent.some(Boolean);
  return { ok: checks.every((c) => c.ok), checks, spentSince };
}

