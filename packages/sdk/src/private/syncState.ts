import type { Address, Hex } from "viem";
import { MerkleTree } from "./tree.js";

/** One leaf of a vault's tree, as its NewCommitment event has it. */
export interface Leaf {
  index: number;
  commitment: bigint;
  memo: Hex;
}

/** A vault's public leaves up to `block` (from a keeper's GET /leaves). */
export interface PublicLeaves {
  pool: Address;
  block: bigint;
  leaves: Leaf[];
}

/** Leaves per tree (each vault starts a new tree, an epoch, when one fills). */
export const LEAVES_PER_EPOCH = 2 ** 20;

/**
 * Every vault's public leaves from a keeper's `GET /leaves`, keyed by lowercase vault address (empty on any error, so
 * callers just scan the chain). Nothing in the request identifies the caller's notes: it is the same for everyone.
 */
export async function fetchLeaves(keeperUrl: string): Promise<Map<string, PublicLeaves>> {
  const out = new Map<string, PublicLeaves>();
  try {
    const r = await fetch(`${keeperUrl.replace(/\/$/, "")}/leaves`);
    if (!r.ok) return out;
    const body = (await r.json()) as { vaults?: { pool: Address; block: string; leaves: [number, string, Hex][] }[] };
    for (const v of body.vaults ?? []) {
      out.set(v.pool.toLowerCase(), { pool: v.pool, block: BigInt(v.block), leaves: v.leaves.map(([index, c, memo]) => ({ index, commitment: BigInt(c), memo })) });
    }
  } catch {}
  return out;
}

/**
 * Whether `leaves` can stand in for scanning the chain: indexes 0, 1, 2… with no gap, all in the first tree, and
 * hashing to `root` (the caller checks the vault knows that root). The memos aren't covered by the root: a bad memo
 * can only hide one of your notes from the scan, never move money, and the next full rescan finds it.
 */
export async function leavesRoot(leaves: Leaf[]): Promise<bigint | null> {
  if (!leaves.length || leaves.length > LEAVES_PER_EPOCH) return null;
  for (let i = 0; i < leaves.length; i++) if (leaves[i].index !== i) return null;
  const t = new MerkleTree();
  t.leaves = leaves.map((l) => l.commitment);
  return t.root();
}

const revive = (_k: string, v: unknown) => (v && typeof v === "object" && "$n" in (v as object) ? BigInt((v as { $n: string }).$n) : v);
const replace = (_k: string, v: unknown) => (typeof v === "bigint" ? { $n: v.toString() } : v);
export const toJson = (v: unknown) => JSON.stringify(v, replace);
export const fromJson = <T>(s: string): T => JSON.parse(s, revive) as T;
