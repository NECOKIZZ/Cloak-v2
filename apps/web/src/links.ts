import { CloakPrivate, linkKeys, relayerSubmitter, type CloakKeys, type LinkToken } from "@cloakely/sdk";
import { keccak256, concat, toBytes, type Address } from "viem";
import { ASSETS, BATCHER, MIGRATOR, RELAYER_URL, ROUTER, VAULTS_BLOCK } from "./config";
import { getProver } from "./state";
import { publicClient } from "./wallet";

export const TOKEN_DECIMALS: Record<LinkToken, number> = { HYPE: 18, USDC: 6 };

/** The private client of the account a claim link opens. No wallet: the relayer submits, so claiming needs no gas. */
export async function openLinkAccount(secret: Uint8Array, passcode?: string): Promise<CloakPrivate> {
  if (!ROUTER || !RELAYER_URL) throw new Error("Payment links aren't available on this deployment yet.");
  const keys = await linkKeys(secret, passcode);
  return clientFor(keys);
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

/** Balances a link account holds, per token (only those it can hold). */
export async function linkBalances(p: CloakPrivate): Promise<Record<LinkToken, bigint>> {
  const out: Record<LinkToken, bigint> = { HYPE: 0n, USDC: 0n };
  await Promise.all(
    (["HYPE", "USDC"] as LinkToken[]).map(async (t) => {
      try {
        out[t] = await p.balance(p.market(tokenOf(p, t)).pool);
      } catch {
        out[t] = 0n;
      }
    }),
  );
  return out;
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
  /** Last status seen: open (money waiting), claimed (someone took it), back (you took it back). */
  status?: "open" | "claimed" | "back";
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
