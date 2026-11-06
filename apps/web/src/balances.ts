import { useEffect, useState } from "react";
import { keccak256, toBytes, toHex, type Address } from "viem";
import type { CloakPrivate, SharedVaultClient } from "@cloakely/sdk";
import { ASSETS, CHAIN_ID } from "./config";
import { useApp } from "./state";
import { useMarkets, type Market } from "./pages/markets";

/**
 * Private balances, the way big wallets show them: the last balance this device saw appears the moment the account
 * unlocks, a full sync runs behind it, and the new numbers replace the old ones all at once (never vault by vault).
 * One store per private account, shared by every page, so moving between pages doesn't sync again.
 *
 * The saved copy is encrypted with a key derived from the account's view key, which only exists after the wallet
 * signs to unlock. Anyone reading this browser's storage sees an opaque blob, not balances.
 */

type Bals = Record<string, bigint>;
interface Store {
  bals: Bals;
  /** a balance is known: from this device's saved copy or a finished sync */
  loaded: boolean;
  /** a sync has finished since unlocking (the numbers are current) */
  synced: boolean;
  syncing: boolean;
  /** asked to sync again while one was running (after a trade): run once more when it ends */
  again: boolean;
  subs: Set<() => void>;
  ready: Promise<void>;
}

const stores = new WeakMap<CloakPrivate, Store>();

// ───────────── the encrypted copy on this device ─────────────

const slot = (p: CloakPrivate) => `cloak.bals.v1.${CHAIN_ID}.${keccak256(p.keys.encPub).slice(2, 18)}`;
async function aesKey(p: CloakPrivate) {
  const raw = toBytes(keccak256(new Uint8Array([...toBytes("cloak-balance-cache-v1"), ...p.keys.encPriv])));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function readSaved(p: CloakPrivate): Promise<Bals | null> {
  try {
    const s = localStorage.getItem(slot(p));
    if (!s) return null;
    const { iv, ct } = JSON.parse(s);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: toBytes(iv) }, await aesKey(p), toBytes(ct));
    const o = JSON.parse(new TextDecoder().decode(plain)) as Record<string, string>;
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, BigInt(v)]));
  } catch {
    return null; // missing, blocked or from another key: just sync
  }
}

async function writeSaved(p: CloakPrivate, b: Bals) {
  try {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = new TextEncoder().encode(JSON.stringify(Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.toString()]))));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(p), plain));
    localStorage.setItem(slot(p), JSON.stringify({ iv: toHex(iv), ct: toHex(ct) }));
  } catch {} // full or blocked storage: the copy is only a speed-up
}

// ───────────── the store ─────────────

function storeFor(p: CloakPrivate): Store {
  let s = stores.get(p);
  if (!s) {
    const st: Store = { bals: {}, loaded: false, synced: false, syncing: false, again: false, subs: new Set(), ready: Promise.resolve() };
    st.ready = readSaved(p).then((b) => {
      if (b && !st.synced) {
        st.bals = b;
        st.loaded = true;
        emit(st);
      }
    });
    stores.set(p, (s = st));
  }
  return s;
}
const emit = (s: Store) => s.subs.forEach((f) => f());
const same = (a: Bals, b: Bals) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => a[k] === b[k]);

/** Sync every vault, then show every balance at once. A vault that fails keeps its last known balance. */
async function sync(p: CloakPrivate, shared: SharedVaultClient | null, markets: Market[], queue = false) {
  const s = storeFor(p);
  if (s.syncing) return void (queue && (s.again = true));
  s.syncing = true;
  s.again = false;
  emit(s);
  try {
    await s.ready;
    const next: Bals = { ...s.bals };
    const put = (k: string) => (b: bigint) => void (next[k] = b);
    let hypeOk = false;
    // hypeMarket throws while the account is still loading its markets right after unlocking
    const jobs: [string, Address][] = [["HYPE", p.hypeMarket.pool], ...markets.filter((m) => !m.shared).map((m): [string, Address] => [m.token, m.pool]), ...ASSETS.map((x): [string, Address] => [x.token, x.pool])];
    await Promise.all([
      ...jobs.map(([k, pool]) => p.balance(pool).then((b) => (put(k)(b), k === "HYPE" && (hypeOk = true))).catch(() => {})),
      // the shared launch-token vault: one scan, every token's balance
      ...(shared ? [shared.sync().then(() => Promise.all(markets.filter((m) => m.shared).map((m) => shared.balance(m.token).then(put(m.token))))).catch(() => {})] : []),
    ]);
    if (!hypeOk && !s.loaded) return; // nothing trustworthy to show yet: keep the skeleton and try again
    const changed = !same(next, s.bals);
    s.bals = next;
    s.loaded = true;
    s.synced = true;
    if (changed) writeSaved(p, next);
  } catch {
  } finally {
    s.syncing = false;
    emit(s);
    if (s.again) sync(p, shared, markets);
  }
}

/** Every private balance of the unlocked account, refreshed every 8 seconds while a page shows it. */
export function usePrivateBalances() {
  const { priv, shared } = useApp();
  const { markets } = useMarkets();
  const [, tick] = useState(0);
  useEffect(() => {
    if (!priv) return;
    const s = storeFor(priv);
    const f = () => tick((n) => n + 1);
    s.subs.add(f);
    return () => void s.subs.delete(f);
  }, [priv]);
  useEffect(() => {
    if (!priv || !markets) return;
    const go = () => sync(priv, shared, markets);
    go();
    const t = setInterval(go, 8000);
    return () => clearInterval(t);
  }, [priv, shared, markets]);
  const s = priv ? storeFor(priv) : null;
  const refresh = () => (priv && markets ? sync(priv, shared, markets, true) : Promise.resolve());
  return { bals: s?.bals ?? {}, loaded: !!s?.loaded, synced: !!s?.synced, syncing: !!s?.syncing, refresh };
}
