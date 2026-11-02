import { CloakPrivate, openLinkKeys, privateRouterAbi, relayerSubmitter, shieldedPoolAbi, type ClaimLink, type CloakKeys, type LinkToken, type OwnedNote } from "@cloakely/sdk";
import { keccak256, concat, toBytes, decodeAbiParameters, decodeFunctionData, formatUnits, type Address, type Hex } from "viem";
import { ASSETS, BATCHER, MIGRATOR, RELAYER_URL, ROUTER, VAULTS_BLOCK } from "./config";
import { getProver } from "./state";
import { publicClient } from "./wallet";

export const TOKEN_DECIMALS: Record<LinkToken, number> = { HYPE: 18, USDC: 6 };

/**
 * The private client of the account a claim link opens. No wallet: the relayer submits, so claiming needs no gas.
 * A locked link with a check throws WrongPasscodeError for a wrong code before anything touches the network.
 */
export async function openLinkAccount(link: ClaimLink, passcode?: string): Promise<CloakPrivate> {
  if (!ROUTER || !RELAYER_URL) throw new Error("Payment links aren't available on this deployment yet.");
  return clientFor(await openLinkKeys(link, passcode));
}

/** A wallet-less private client for `keys`, submitting through the relayer. */
export async function clientFor(keys: CloakKeys): Promise<CloakPrivate> {
  if (!ROUTER || !RELAYER_URL) throw new Error("Payment links aren't available on this deployment yet.");
  const p = new CloakPrivate(publicClient, ROUTER, keys, getProver, relayerSubmitter(RELAYER_URL), VAULTS_BLOCK, BATCHER, MIGRATOR);
  await p.loadMarkets();
  ASSETS.forEach((a) => p.addAsset(a));
  return p;
}

/** The token address a private client uses for HYPE or USDC. */
export function tokenOf(p: CloakPrivate, t: LinkToken): Address {
  if (t === "HYPE") return p.hypeMarket.token;
  const a = ASSETS.find((x) => x.symbol.toUpperCase() === "USDC");
  if (!a) throw new Error("USDC isn't available on this deployment.");
  return a.token;
}

/** What a link's account holds of one token: what's waiting, and how many notes came in and were spent. */
export interface LinkHolding {
  waiting: bigint;
  /** notes still waiting to be claimed */
  open: number;
  /** notes already claimed (or taken back) */
  spent: number;
  notes: OwnedNote[];
}
export type LinkState = Record<LinkToken, LinkHolding>;

/**
 * A link account's state, per token. `only` limits it to the link's own token (half the reading). Network trouble
 * throws: an unreadable vault must never look like an empty link.
 */
export async function linkState(p: CloakPrivate, only?: LinkToken): Promise<LinkState> {
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
      const notes = await withRetry(() => p.history(pool));
      const open = notes.filter((n) => !n.spent);
      out[t] = { waiting: open.reduce((a, n) => a + n.amount, 0n), open: open.length, spent: notes.length - open.length, notes };
    }),
  );
  return out;
}

/** Balances a link account holds, per token. Throws on network trouble rather than reading as zero. */
export async function linkBalances(p: CloakPrivate, only?: LinkToken): Promise<Record<LinkToken, bigint>> {
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
export async function linkClaims(p: CloakPrivate, state: LinkState): Promise<LinkClaim[]> {
  const out: LinkClaim[] = [];
  for (const t of ["HYPE", "USDC"] as LinkToken[]) {
    const spent = state[t].notes.filter((n) => n.spent);
    if (!spent.length) continue;
    const pool = p.market(tokenOf(p, t)).pool;
    const logs = await withRetry(() => publicClient.getContractEvents({ address: pool, abi: shieldedPoolAbi, eventName: "NewNullifier", fromBlock: VAULTS_BLOCK, strict: true }));
    const want = new Map(spent.map((n) => [BigInt(n.nullifier), n]));
    const seen = new Set<string>();
    for (const l of logs) {
      const note = want.get(BigInt(l.args.nullifier));
      if (!note || seen.has(String(note.nullifier))) continue;
      seen.add(String(note.nullifier));
      const [tx, block] = await Promise.all([withRetry(() => publicClient.getTransaction({ hash: l.transactionHash })), withRetry(() => publicClient.getBlock({ blockNumber: l.blockNumber }))]);
      out.push({ token: t, amount: formatUnits(note.amount, TOKEN_DECIMALS[t]), to: claimDestination(tx.input), at: Number(block.timestamp) * 1000, tx: l.transactionHash });
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

/** Where a claim's money went, read from the claim transaction's own data. */
function claimDestination(input: Hex): "private" | Address {
  for (const abi of [privateRouterAbi, shieldedPoolAbi] as const) {
    try {
      const d = decodeFunctionData({ abi, data: input }) as { functionName: string; args: readonly unknown[] };
      const ext = d.args.find((a) => a && typeof a === "object" && "extAmount" in (a as object)) as { recipient: Address; extAmount: bigint; data: Hex } | undefined;
      if (!ext) continue;
      if (ext.extAmount >= 0n) return "private";
      if (d.functionName === "unshieldHype" && ext.data && ext.data !== "0x") return decodeAbiParameters([{ type: "address" }], ext.data)[0];
      return ext.recipient;
    } catch {}
  }
  return "private";
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

const storeKey = (fp: string) => `cloak.links.v1.${fp}`;
async function aesKey(keys: CloakKeys) {
  const raw = toBytes(keccak256(concat([toBytes("cloak-links-store-v1"), keys.encPriv])));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
const fingerprint = (keys: CloakKeys) => keccak256(concat([toBytes("cloak-links-id-v1"), keys.encPub])).slice(2, 18);

export async function loadLinks(keys: CloakKeys): Promise<LinkRecord[]> {
  try {
    const raw = localStorage.getItem(storeKey(fingerprint(keys)));
    if (!raw) return [];
    const { iv, ct } = JSON.parse(raw) as { iv: string; ct: string };
    const b = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b(iv) }, await aesKey(keys), b(ct));
    return JSON.parse(new TextDecoder().decode(pt));
  } catch {
    return [];
  }
}

export async function saveLinks(keys: CloakKeys, list: LinkRecord[]) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(keys), new TextEncoder().encode(JSON.stringify(list))));
  const s = (u: Uint8Array) => btoa(String.fromCharCode(...u));
  try {
    localStorage.setItem(storeKey(fingerprint(keys)), JSON.stringify({ iv: s(iv), ct: s(ct) }));
  } catch {}
}

export async function addLink(keys: CloakKeys, rec: LinkRecord) {
  const list = await loadLinks(keys);
  await saveLinks(keys, [rec, ...list.filter((x) => x.id !== rec.id)].slice(0, 200));
}

export async function updateLink(keys: CloakKeys, id: string, patch: Partial<SentLink>) {
  const list = await loadLinks(keys);
  await saveLinks(keys, list.map((x) => (x.id === id ? ({ ...x, ...patch } as LinkRecord) : x)));
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
