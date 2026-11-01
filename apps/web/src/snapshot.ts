import { CHAIN_ID, KEEPER_URL, VERSION } from "./config";

/**
 * Two caches for public chain data, so pages show something at once:
 * - the keeper's snapshot (GET /snapshot, rebuilt every 30 s): one request instead of hundreds of RPC calls;
 * - this browser's copy of the last result, shown instantly on the next visit while fresh data loads.
 * Only public data goes through either. Anything that moves money is read from the chain.
 */

const revive = (_k: string, v: unknown) => (v && typeof v === "object" && "$n" in (v as object) ? BigInt((v as { $n: string }).$n) : v);
const replace = (_k: string, v: unknown) => (typeof v === "bigint" ? { $n: v.toString() } : v);

// ───────────── this browser's copy ─────────────

const key = (k: string) => `cloak.cache.v1.${CHAIN_ID}.${VERSION}.${k}`;

export function saved<T>(k: string): T | undefined {
  try {
    const s = localStorage.getItem(key(k));
    return s ? (JSON.parse(s, revive) as T) : undefined;
  } catch {
    return undefined;
  }
}

export function save(k: string, value: unknown) {
  try {
    localStorage.setItem(key(k), JSON.stringify(value, replace));
  } catch {} // full or blocked storage: the cache is only a speed-up
}

// ───────────── the keeper's snapshot ─────────────

export interface Snapshot {
  at: number;
  block: bigint;
  markets: unknown[];
  launches: unknown[];
  meta: { auction: `0x${string}`; token: `0x${string}`; metadataURI: string }[];
  stats: unknown;
}

const MAX_AGE = 5 * 60_000; // older than this, the keeper is stuck: read the chain instead
let last: { at: number; snap: Promise<Snapshot | null> } | null = null;

/** The keeper's latest snapshot (fetched at most every 15 s), or null if it's unavailable or stale. */
export function getSnapshot(): Promise<Snapshot | null> {
  if (!KEEPER_URL) return Promise.resolve(null);
  if (last && Date.now() - last.at < 15_000) return last.snap;
  const snap = fetch(`${KEEPER_URL}/snapshot`, { signal: AbortSignal.timeout(6000) })
    .then((r) => (r.ok ? r.text() : null))
    .then((t) => (t ? (JSON.parse(t, revive) as Snapshot) : null))
    .then((s) => (s && Date.now() - s.at < MAX_AGE ? s : null))
    .catch(() => null);
  last = { at: Date.now(), snap };
  return snap;
}
