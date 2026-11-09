import { parseAbi, toHex, type Address, type PublicClient } from "viem";
import * as gloam from "@gloamtrade/sdk";
import type { RawGroth16 } from "./prover.js";
import { GLOAM_FUNDS_VERIFYING_KEY } from "./gloamFundsVk.js";
export { GLOAM_FUNDS_VERIFYING_KEY };

const GLOAM_VAULT_READS = parseAbi(["function isKnownRoot(bytes32) view returns (bool)", "function isSpent(bytes32) view returns (bool)"]);

/**
 * Proof of funds: "this vault holds at least `threshold` for me, as of block `block`", from up to 4 of the prover's
 * notes (Gloam's funds circuit, final keys), without the balance, the notes or the owner. The proof reveals those
 * notes' nullifiers, so the verifier can check none was spent; the flip side is that the verifier could notice when
 * they're spent later, which is why the app offers to refresh them (a private send to yourself) after proving.
 *
 * `context` binds a proof to one purpose: the chain, the vault, a free-text label (who it's for) and an expiry. A proof
 * shown with a different label or after its expiry fails.
 */
export interface FundsProof {
  /** 2: Cloak v2 on Gloam (Gloam's funds circuit, final keys, 4 notes). */
  v: 2;
  chainId: number;
  pool: Address;
  /** the vault's asset, for display */
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
  /** the asset as Gloam's circuit carries it (address 0 for HYPE) */
  asset?: string;
}

/** Public signals in the circuit's order: root, asset, threshold, context, nullifier[4]. */
export const fundsSignals = (p: FundsProof) => [p.root, p.asset ?? "0", p.threshold, p.context, ...p.nullifiers];

/** Gloam's proofContext, kind "funds", for this vault, label and expiry. */
export function gloamFundsContext(chainId: number, pool: Address, label: string, expiresAt: number): bigint {
  return gloam.proofContext({ kind: "funds", chainId, pool, verifier: label, expiresAt });
}

/** A proof as a short shareable string (base64url JSON), for a link like `<site>/proof#<this>`. */
export function encodeFundsProof(p: FundsProof): string {
  const b = new TextEncoder().encode(JSON.stringify(p));
  return btoa(Array.from(b, (c) => String.fromCharCode(c)).join("")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function decodeFundsProof(s: string): FundsProof {
  const b = Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const p = JSON.parse(new TextDecoder().decode(b)) as FundsProof;
  if (!(p?.v === 2 && Array.isArray(p.nullifiers) && p.nullifiers.length === 4)) throw new Error("not a Cloak proof of funds");
  return p;
}

export interface FundsCheck {
  ok: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
  /** a backing note was spent after the proof's block (the claim held when made, not now) */
  spentSince: boolean;
}

/**
 * Check a proof of funds: the zero-knowledge proof itself (against `vk`, by default Gloam's funds key built into the
 * SDK), that it's bound to this chain, vault, label and expiry, that the vault knows the root, and that no backing note
 * was spent as of the proof's block. A note spent since is reported, not failed: the claim was true when made.
 */
export async function verifyFundsProof(publicClient: PublicClient, p: FundsProof, vk: unknown = GLOAM_FUNDS_VERIFYING_KEY, opts: { now?: number } = {}): Promise<FundsCheck> {
  const checks: FundsCheck["checks"] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const chainId = publicClient.chain?.id ?? (await publicClient.getChainId());
  add("Right network", chainId === p.chainId, chainId === p.chainId ? "The proof is for this chain." : `The proof is for chain ${p.chainId}.`);
  const ctx = gloamFundsContext(p.chainId, p.pool, p.label, p.expiresAt).toString();
  add("Made for this purpose", ctx === p.context, ctx === p.context ? `Label "${p.label}".` : "The label, vault or expiry was changed after proving.");
  add("Not expired", p.expiresAt > now, p.expiresAt > now ? `Valid until ${new Date(p.expiresAt * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC.` : "This proof has expired.");
  const snarkjs = await import("snarkjs");
  const valid = await snarkjs.groth16.verify(vk as never, fundsSignals(p), p.proof as never).catch(() => false);
  add("Valid zero-knowledge proof", valid, valid ? "The math checks out: the notes exist and add up." : "The proof doesn't verify.");
  const h32 = (x: string) => toHex(BigInt(x), { size: 32 });
  const rootOk = await publicClient.readContract({ address: p.pool, abi: GLOAM_VAULT_READS, functionName: "isKnownRoot", args: [h32(p.root)] }).catch(() => false);
  add("Real vault state", rootOk, rootOk ? "The vault knows the tree the notes are in." : "The vault doesn't know this tree.");
  const live = p.nullifiers.filter((n) => n !== "0");
  const block = BigInt(p.block);
  const spentAt = (n: string, blockNumber?: bigint) => publicClient.readContract({ address: p.pool, abi: GLOAM_VAULT_READS, functionName: "isSpent", args: [h32(n)], ...(blockNumber ? { blockNumber } : {}) });
  const atBlock = await Promise.all(live.map((n) => spentAt(n, block).catch(() => spentAt(n))));
  const unspentThen = atBlock.every((x) => !x);
  add("Unspent when proved", unspentThen && live.length > 0, unspentThen ? `None of the ${live.length} backing note${live.length > 1 ? "s" : ""} had been spent at block ${block}.` : "A backing note had already been spent when the proof was made.");
  const nowSpent = await Promise.all(live.map((n) => spentAt(n).catch(() => false)));
  const spentSince = nowSpent.some(Boolean);
  return { ok: checks.every((c) => c.ok), checks, spentSince };
}
