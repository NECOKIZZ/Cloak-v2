import type { Address, Hex } from "viem";

/** Progress messages for long actions ("Proving…", "Posting the sealed note"). */
export type Status = (msg: string) => void;

const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

/**
 * A Gloam vault cash out proved ahead of time: `data` is the vault's unshield call, whose proof fixes the recipient
 * and amount. Gloam's vault keeps every root valid for good, so it stays sendable until its note is spent.
 */
export interface GloamScheduledCall {
  kind: "gloamUnshield";
  /** the vault */
  to: Address;
  data: Hex;
  /** the note it spends, to check whether it went out */
  nullifier: Hex;
}

/** One piece of a split withdrawal: a proved call, and the earliest time a relayer may send it (unix seconds). */
export interface ScheduledPiece {
  call: GloamScheduledCall;
  notBefore: number;
  /** what this piece withdraws (before the vault's withdrawal fee) */
  amount: bigint;
  to: Address;
}

/**
 * `amount` in `k` pieces of different, ordinary-looking sizes: random shares rounded to 2 significant digits, the
 * last one taking the remainder. Every piece is above zero.
 */
export function splitAmount(amount: bigint, k: number): bigint[] {
  if (amount < BigInt(k) * 100n) return [amount];
  const w = Array.from({ length: k }, () => 0.6 + Math.random());
  const sum = w.reduce((a, b) => a + b, 0);
  const round2 = (x: bigint) => {
    const d = x.toString().length;
    const unit = d > 2 ? 10n ** BigInt(d - 2) : 1n;
    return (x / unit) * unit;
  };
  const out: bigint[] = [];
  let left = amount;
  for (let i = 0; i < k - 1; i++) {
    const x = round2((amount * BigInt(Math.round((w[i] / sum) * 1e6))) / 1_000_000n);
    out.push(x);
    left -= x;
  }
  out.push(left);
  return out.every((x) => x > 0n) ? out : [amount];
}

/** Hand split-withdrawal pieces to Cloak's relayer (`POST /schedule`). Returns an id per piece, for `scheduleStatus`. */
export async function scheduleRelay(url: string, pieces: ScheduledPiece[]): Promise<string[]> {
  const res = await fetch(`${url.replace(/\/$/, "")}/schedule`, { method: "POST", headers: { "content-type": "application/json" }, body: json({ pieces: pieces.map((p) => ({ call: p.call, notBefore: p.notBefore })) }), signal: AbortSignal.timeout(120_000) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error ?? `scheduling failed (${res.status})`);
  return out.ids as string[];
}

export interface ScheduledStatus {
  id: string;
  state: "waiting" | "sent" | "dropped" | "unknown";
  notBefore?: number;
  txHash?: Hex;
  error?: string;
}

/** Where a relayer's scheduled pieces stand (`GET /schedule?ids=`). "unknown": it doesn't have it (re-send it). */
export async function scheduleStatus(url: string, ids: string[]): Promise<ScheduledStatus[]> {
  const res = await fetch(`${url.replace(/\/$/, "")}/schedule?ids=${ids.join(",")}`, { signal: AbortSignal.timeout(30_000) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error ?? `status failed (${res.status})`);
  return out.pieces as ScheduledStatus[];
}

/** JSON with bigints, and back ({ $n: "123" }): for state kept on a device. */
const revive = (_k: string, v: unknown) => (v && typeof v === "object" && "$n" in (v as object) ? BigInt((v as { $n: string }).$n) : v);
const replace = (_k: string, v: unknown) => (typeof v === "bigint" ? { $n: v.toString() } : v);
export const toJson = (v: unknown) => JSON.stringify(v, replace);
export const fromJson = <T>(s: string): T => JSON.parse(s, revive) as T;
