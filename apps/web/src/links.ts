import { GloamPrivate, gloamLinkAddress, gloamLinkCheck, gloamLinkKeys, gloamRelaySubmitter, openGloamLinkKeys, type ClaimLink, type LinkToken } from "@cloakely/sdk";
import { keccak256, concat, toBytes, formatUnits, type Address, type Hex } from "viem";
import { ASSETS, GLOAM, RELAYER_URL, chain } from "./config";
import { gloamProvers } from "./gloam";
import type { Priv } from "./state";
import { publicClient } from "./wallet";
import { Hint } from "./errors";

export const TOKEN_DECIMALS: Record<LinkToken, number> = { HYPE: 18, USDC: 6 };

/**
 * The private client of the account a claim link opens. No wallet: the relayer submits, so claiming needs no gas.
 * A locked link with a check throws WrongPasscodeError for a wrong code before anything touches the network.
 */
export async function openLinkAccount(link: ClaimLink, passcode?: string): Promise<Priv> {
  return gloamLinkAccount(await openGloamLinkKeys(link, passcode));
}

/** A claim link's account: both vaults, spending what it received directly, through the relay. */
async function gloamLinkAccount(keys: Awaited<ReturnType<typeof gloamLinkKeys>>): Promise<GloamPrivate> {
  if (!GLOAM || !RELAYER_URL) throw new Hint("Payment links aren't available on this deployment yet.");
  const p = new GloamPrivate(
    {
      publicClient,
      chainId: chain.id,
      gloamVault: { pool: GLOAM.gloamVault, poolBlock: GLOAM.block },
      launchVault: { pool: GLOAM.launchVault, poolBlock: GLOAM.launchVaultBlock ?? GLOAM.block },
      ecosystemVault: GLOAM.ecosystemVault ? { pool: GLOAM.ecosystemVault, poolBlock: GLOAM.ecosystemVaultBlock ?? GLOAM.block } : undefined,
      payMemo: GLOAM.memoBoard,
      provers: gloamProvers(),
      submit: gloamRelaySubmitter(RELAYER_URL),
      whype: GLOAM.whype,
      spendReceived: true,
      logChunk: 1_000_000n, // the public RPCs cap logs per call, not ranges: 1M blocks answer in under a second
    },
    keys,
  );
  await p.loadMarkets();
  ASSETS.forEach((a) => p.addAsset({ ...a, pool: a.hop }));
  return p;
}

/** A new link's account: where the sender pays and, if locked, the check a wrong passcode fails. */
export async function newLinkTarget(secret: Uint8Array, passcode?: string): Promise<{ address: string; check?: string }> {
  const k = await gloamLinkKeys(secret, passcode);
  return { address: gloamLinkAddress(k), check: passcode !== undefined ? gloamLinkCheck(k) : undefined };
}

/** The token address a private client uses for HYPE or USDC. */
export function tokenOf(p: Priv, t: LinkToken): Address {
  if (t === "HYPE") return p.hypeMarket.token;
  const a = ASSETS.find((x) => x.symbol.toUpperCase() === "USDC");
  if (!a) throw new Hint("USDC isn't available on this deployment.");
  return a.token;
}

/** What a link's account holds of one token: what's waiting, and how many notes came in and were spent. */
export interface LinkHolding {
  waiting: bigint;
  /** notes still waiting to be claimed */
  open: number;
  /** notes already claimed (or taken back) */
  spent: number;
  /** the account's notes in the link's token (shape depends on the backend) */
  notes: { amount: bigint; spent?: boolean; nullifier?: unknown }[];
}
export type LinkState = Record<LinkToken, LinkHolding>;

/**
 * A link account's state, per token. `only` limits it to the link's own token (half the reading). Network trouble
 * throws: an unreadable vault must never look like an empty link.
 */
export async function linkState(p: Priv, only?: LinkToken): Promise<LinkState> {
  const empty = (): LinkHolding => ({ waiting: 0n, open: 0, spent: 0, notes: [] });
  const out: LinkState = { HYPE: empty(), USDC: empty() };
  const tokens = only ? [only] : (["HYPE", "USDC"] as LinkToken[]);
  await Promise.all(
    tokens.map(async (t) => {
      let pool: Address;
      try {
        pool = p.market(tokenOf(p, t)).pool;
      } catch {
        return; // this deployment has no vault for it
      }
      const notes: LinkHolding["notes"] = await withRetry<LinkHolding["notes"]>(() => p.history(pool));
      const open = notes.filter((n) => !n.spent);
      out[t] = { waiting: open.reduce((a, n) => a + n.amount, 0n), open: open.length, spent: notes.length - open.length, notes };
    }),
  );
  return out;
}

/** Balances a link account holds, per token. Throws on network trouble rather than reading as zero. */
export async function linkBalances(p: Priv, only?: LinkToken): Promise<Record<LinkToken, bigint>> {
  const s = await linkState(p, only);
  return { HYPE: s.HYPE.waiting, USDC: s.USDC.waiting };
}

/** Phones drop requests; one retry after a short pause covers most of it. */
async function withRetry<T>(f: () => Promise<T>, tries = 3): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await f();
    } catch (e) {
      if (i >= tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
}

/** One claim of a link, as the chain shows it. */
export interface LinkClaim {
  token: LinkToken;
  /** the share's amount, before the relayer's fee */
  amount: string;
  /** "private" when it went into someone's private balance (nobody can see whose), else the wallet it went to */
  to: "private" | Address;
  at: number;
  tx: Hex;
}

/**
 * Who claimed a link, as far as the chain says: when, how much, and where it went. A claim into a private balance
 * shows only that it happened; a claim to a wallet shows the wallet, like any withdrawal.
 */
export async function linkClaims(p: Priv, state: LinkState): Promise<LinkClaim[]> {
  const out: LinkClaim[] = [];
  for (const t of ["HYPE", "USDC"] as LinkToken[]) {
    if (!state[t].notes.some((n) => n.spent)) continue;
    for (const c of await withRetry(() => p.claims(p.market(tokenOf(p, t)).pool))) {
      out.push({ token: t, amount: formatUnits(c.amount, TOKEN_DECIMALS[t]), to: c.to, at: c.at, tx: c.tx });
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

// ── your links: kept in this browser, encrypted with a key from your private account ──

export interface SentLink {
  id: string;
  kind: "claim";
  url: string;
  token: LinkToken;
  amount: string;
  message?: string;
  passcode?: string;
  hint?: string;
  created: number;
  /** Last status seen: funding (being sent), open (money waiting), partly (some shares claimed), claimed (all gone),
   *  back (you took it back), unfunded (no money ever reached it). */
  status?: "funding" | "open" | "partly" | "claimed" | "back" | "unfunded";
  /** Claims seen on chain, newest first. */
  claims?: LinkClaim[];
  /** Transactions that took money back to you, so they aren't shown as someone's claim. */
  backTx?: Hex[];
  /** When the link was last checked. */
  checked?: number;
}
export interface SentRequest {
  id: string;
  kind: "request";
  url: string;
  token: LinkToken;
  amount?: string;
  note?: string;
  to: string;
  created: number;
}
export type LinkRecord = SentLink | SentRequest;

/** What the link list's encrypted store needs from an account (GloamPrivate's device keys). */
type StoreKeys = Pick<GloamPrivate["keys"], "encPub" | "encPriv">;
const storeKey = (fp: string) => `cloak.links.v1.${fp}`;
async function aesKey(keys: StoreKeys) {
  const raw = toBytes(keccak256(concat([toBytes("cloak-links-store-v1"), keys.encPriv])));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
const fingerprint = (keys: StoreKeys) => keccak256(concat([toBytes("cloak-links-id-v1"), keys.encPub])).slice(2, 18);

const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64 = (u: Uint8Array) => { let s = ""; for (const x of u) s += String.fromCharCode(x); return btoa(s); };

async function decryptList(keys: StoreKeys, raw: string): Promise<LinkRecord[]> {
  const { iv, ct } = JSON.parse(raw) as { iv: string; ct: string };
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await aesKey(keys), unb64(ct));
  const list = JSON.parse(new TextDecoder().decode(pt));
  if (!Array.isArray(list)) throw new Error("bad link store");
  return list;
}

export async function loadLinks(keys: StoreKeys): Promise<LinkRecord[]> {
  try {
    const raw = localStorage.getItem(storeKey(fingerprint(keys)));
    return raw ? await decryptList(keys, raw) : [];
  } catch {
    return [];
  }
}

export async function saveLinks(keys: StoreKeys, list: LinkRecord[]) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(keys), new TextEncoder().encode(JSON.stringify(list))));
  try {
    localStorage.setItem(storeKey(fingerprint(keys)), JSON.stringify({ iv: b64(iv), ct: b64(ct) }));
  } catch {
    throw new Hint("This browser wouldn't save the link list (its storage is full, or blocked in private mode). Free some space or use a normal window, then try again.");
  }
}

// Every change to the list is read, changed and written as one step, one after another. Two changes at once (a new
// link being saved while an older one is being re-checked) used to be able to write over each other and lose a link.
let queue: Promise<unknown> = Promise.resolve();
function change(keys: StoreKeys, f: (list: LinkRecord[]) => LinkRecord[]): Promise<void> {
  const run = async () => {
    const k = storeKey(fingerprint(keys));
    let list: LinkRecord[] = [];
    const raw = (() => { try { return localStorage.getItem(k); } catch { return null; } })();
    if (raw) {
      try {
        list = await decryptList(keys, raw);
      } catch {
        // a list that can't be read is set aside, never written over
        try { localStorage.setItem(`${k}.unreadable.${Date.now()}`, raw); } catch {}
      }
    }
    await saveLinks(keys, f(list));
  };
  const next = queue.then(run, run);
  queue = next.catch(() => {});
  return next;
}

/** How many links are kept. Old finished ones drop off the end first; a link with money waiting is never dropped. */
const KEEP = 500;
const isLive = (x: LinkRecord) => x.kind === "claim" && !["claimed", "back", "unfunded"].includes(x.status ?? "");

export function addLink(keys: StoreKeys, rec: LinkRecord) {
  return change(keys, (list) => {
    const all = [rec, ...list.filter((x) => x.id !== rec.id)];
    if (all.length <= KEEP) return all;
    let drop = all.length - KEEP;
    return all.reverse().filter((x) => !(drop > 0 && !isLive(x) && drop--)).reverse();
  });
}

export function updateLink(keys: StoreKeys, id: string, patch: Partial<SentLink>) {
  return change(keys, (list) => list.map((x) => (x.id === id ? ({ ...x, ...patch } as LinkRecord) : x)));
}

export function removeLink(keys: StoreKeys, id: string) {
  return change(keys, (list) => list.filter((x) => x.id !== id));
}

/** The list as a backup file's text: still encrypted, readable only by this private account. */
export async function exportLinks(keys: StoreKeys): Promise<string> {
  const list = await loadLinks(keys);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(keys), new TextEncoder().encode(JSON.stringify(list))));
  return JSON.stringify({ cloakLinks: 1, iv: b64(iv), ct: b64(ct) });
}

/** Adds a backup's links to the list. Returns how many were new. */
export async function importLinks(keys: StoreKeys, text: string): Promise<number> {
  let got: LinkRecord[];
  try {
    got = await decryptList(keys, text);
  } catch {
    throw new Hint("That file isn't a backup of this account's links. A backup only opens with the wallet that made it.");
  }
  let added = 0;
  await change(keys, (list) => {
    const have = new Set(list.map((x) => x.id));
    const fresh = got.filter((x) => x && typeof x.id === "string" && typeof x.url === "string" && !have.has(x.id));
    added = fresh.length;
    return [...list, ...fresh].sort((a, b) => b.created - a.created);
  });
  return added;
}

export const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");

/** Share targets for a link. `text` goes before the link. */
export function shareTargets(url: string, text: string) {
  const t = encodeURIComponent(text);
  const u = encodeURIComponent(url);
  return [
    { name: "X", href: `https://x.com/intent/post?text=${t}&url=${u}` },
    { name: "Telegram", href: `https://t.me/share/url?url=${u}&text=${t}` },
    { name: "WhatsApp", href: `https://wa.me/?text=${t}%20${u}` },
    { name: "Email", href: `mailto:?subject=${t}&body=${u}` },
  ];
}
