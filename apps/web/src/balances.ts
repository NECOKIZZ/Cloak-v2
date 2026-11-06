import { useEffect, useState } from "react";
import { type Address } from "viem";
import { fetchLeaves, type CloakPrivate, type SharedVaultClient } from "@cloakely/sdk";
import { openBox, sealBox } from "./deviceBox";
import { ASSETS, KEEPER_URL } from "./config";
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
  /** the vault scan's starting point, loaded once (see restoreSync) */
  restored?: Promise<void>;
  /** the sync progress last saved on this device */
  savedSync?: string;
}

const stores = new WeakMap<CloakPrivate, Store>();

// ───────────── the encrypted copies on this device ─────────────

async function readSaved(p: CloakPrivate): Promise<Bals | null> {
  const s = await openBox(p, "balance");
  if (!s) return null;
  try {
    return Object.fromEntries(Object.entries(JSON.parse(s) as Record<string, string>).map(([k, v]) => [k, BigInt(v)]));
  } catch {
    return null;
  }
}
const writeSaved = (p: CloakPrivate, b: Bals) => sealBox(p, "balance", JSON.stringify(Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.toString()]))));

/**
 * Where the vault scan starts on unlock: this device's saved sync progress (only new blocks get scanned), else the
 * keeper's public note list (one download instead of every vault's history, used only if it matches a root the vault
 * knows), else the chain from the start.
 */
async function restoreSync(p: CloakPrivate, shared: SharedVaultClient | null, pools: Address[]) {
  const saved = await openBox(p, "sync");
  if (saved) {
    try {
      const o = JSON.parse(saved) as { p?: string; s?: string };
      const ok = (o.p ? await p.importSync(o.p) : false) && (!shared || !o.s || (await shared.importSync(o.s)));
      if (ok) return;
    } catch {}
  }
  if (!KEEPER_URL) return;
  const leaves = await fetchLeaves(KEEPER_URL);
  await Promise.all([
    ...pools.map((pool) => (leaves.get(pool.toLowerCase()) ? p.seedLeaves(pool, leaves.get(pool.toLowerCase())!).catch(() => false) : false)),
    ...(shared && leaves.get(shared.vault.toLowerCase()) ? [shared.seedLeaves(leaves.get(shared.vault.toLowerCase())!).catch(() => false)] : []),
  ]);
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
    await (s.restored ??= restoreSync(p, shared, jobs.map(([, pool]) => pool)).catch(() => {}));
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
    // and how far the scan got, so the next visit only reads new blocks
    const st = JSON.stringify({ p: p.exportSync(), s: shared?.exportSync() });
    if (st !== s.savedSync) {
      s.savedSync = st;
      sealBox(p, "sync", st);
    }
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
