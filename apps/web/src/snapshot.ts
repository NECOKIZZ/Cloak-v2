import { CHAIN_ID } from "./config";

/**
 * This browser's copy of the last public data a page showed (launches, markets, stats), shown at once on the next
 * visit while fresh data loads. Only public data goes in it. Anything that moves money is read from the chain.
 */

const revive = (_k: string, v: unknown) => (v && typeof v === "object" && "$n" in (v as object) ? BigInt((v as { $n: string }).$n) : v);
const replace = (_k: string, v: unknown) => (typeof v === "bigint" ? { $n: v.toString() } : v);

// ───────────── this browser's copy ─────────────

// "v2": Cloak v2's own launches and markets, apart from anything a Cloak v1 visit saved here
const key = (k: string) => `cloak.cache.v2.${CHAIN_ID}.${k}`;

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
