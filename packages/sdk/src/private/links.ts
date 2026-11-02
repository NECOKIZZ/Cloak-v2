/**
 * Payment links: money and requests that travel as a URL.
 *
 *   claim link    https://cloak.boblabs.tech/claim#k=<secret>&b=<block>&t=HYPE&m=Happy+birthday
 *                 The link holds a whole throwaway private account. The sender funds it with a private send, and
 *                 whoever opens the link moves that money into their own private balance, or out to any wallet. The
 *                 relayer submits the claim and takes its fee from the link, so the claimer needs no gas and no
 *                 Cloak account. Until someone claims it, the sender can take it back the same way.
 *                 With a passcode (`p=1`), the account's seed also needs the code, sent another way or posed as a
 *                 riddle (`q=`): a link posted in public that only the right person can open.
 *
 *   request link  https://cloak.boblabs.tech/pay#to=cloak:…&amount=25&token=USDC&note=Invoice+42&name=Robin
 *                 Asks someone to pay you. `to` is a cloak: address (a private payment) or a 0x address (paid from
 *                 the payer's private balance, so the payer's wallet never shows). Leave out the amount for a tip
 *                 jar. Nothing about a request is on chain.
 *
 * Everything sits in the URL fragment (after #), which browsers never send to a server or put in a referrer, so a
 * link stays between the people who share it.
 */
import { scryptAsync } from "@noble/hashes/scrypt";
import { randomBytes } from "@noble/hashes/utils";
import { concat, isAddress, keccak256, toBytes, type Hex } from "viem";
import { CloakKeys, formatCloakAddress, parseCloakAddress } from "./crypto.js";

export const LINK_ORIGIN = "https://cloak.boblabs.tech";
export const LINK_MESSAGE_MAX = 140;
export const LINK_NAME_MAX = 40;
export const LINK_HINT_MAX = 120;
/** Tokens a link can carry today. */
export const LINK_TOKENS = ["HYPE", "USDC"] as const;
export type LinkToken = (typeof LINK_TOKENS)[number];

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(t + "=".repeat((4 - (t.length % 4)) % 4)), (c) => c.charCodeAt(0));
};

/** Unicode-safe trim to `max` characters, with control characters removed. */
export function cleanLinkText(s: string | null | undefined, max: number): string {
  // eslint-disable-next-line no-control-regex
  return Array.from((s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()).slice(0, max).join("");
}

/** A passcode as both sides type it: case, outer spaces and repeated spaces don't matter. */
export const normalizePasscode = (code: string) => code.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");

/** A fresh link secret (32 random bytes). */
export const newLinkSecret = (): Uint8Array => randomBytes(32);

/**
 * The private account a claim link opens. Without a passcode it comes from the secret alone. With one, the seed is
 * scrypt(passcode, secret), so a copy of the link is useless without the code, and guessing codes is slow.
 */
export async function linkKeys(secret: Uint8Array, passcode?: string): Promise<CloakKeys> {
  if (secret.length !== 32) throw new Error("bad link secret");
  if (passcode === undefined) return CloakKeys.fromSeed(toBytes(keccak256(concat([toBytes("cloak-link-v1"), secret]))));
  const code = normalizePasscode(passcode);
  if (!code) throw new Error("enter the passcode");
  const seed = await scryptAsync(toBytes(code), concat([toBytes("cloak-link-lock-v1"), secret]), { N: 2 ** 15, r: 8, p: 1, dkLen: 32 });
  return CloakKeys.fromSeed(seed);
}

/** The cloak: address a link's money is sent to. */
export async function linkAddress(keys: CloakKeys): Promise<string> {
  return formatCloakAddress((await keys.main()).pubKey, keys.encPub);
}

export interface ClaimLink {
  secret: Uint8Array;
  /** Block the link was funded in. Shown to the claimer; scanning still starts at the vaults' first block, because
   *  a note's Merkle proof needs every leaf before it. */
  block: bigint;
  /** What the sender put in (a display hint; the claim page reads the real balance). */
  token?: LinkToken;
  amount?: string;
  /** A message from the sender. */
  message?: string;
  /** The sender's name, as they chose to give it. */
  from?: string;
  /** Needs a passcode. */
  locked?: boolean;
  /** A hint or riddle whose answer is the passcode. */
  hint?: string;
}

export function buildClaimLink(l: ClaimLink, origin = LINK_ORIGIN): string {
  const p = new URLSearchParams();
  p.set("k", b64url(l.secret));
  p.set("b", l.block.toString());
  if (l.token) p.set("t", l.token);
  if (l.amount) p.set("a", l.amount);
  const m = cleanLinkText(l.message, LINK_MESSAGE_MAX);
  if (m) p.set("m", m);
  const f = cleanLinkText(l.from, LINK_NAME_MAX);
  if (f) p.set("f", f);
  if (l.locked) p.set("p", "1");
  const q = cleanLinkText(l.hint, LINK_HINT_MAX);
  if (l.locked && q) p.set("q", q);
  return `${origin.replace(/\/+$/, "")}/claim#${p.toString()}`;
}

/** Reads a claim link (the whole URL or just its fragment). Throws on anything that isn't one. */
export function parseClaimLink(link: string): ClaimLink {
  const frag = link.includes("#") ? link.slice(link.indexOf("#") + 1) : link;
  const p = new URLSearchParams(frag);
  const k = p.get("k");
  if (!k) throw new Error("This isn't a Cloak claim link.");
  let secret: Uint8Array;
  try {
    secret = unb64url(k);
  } catch {
    throw new Error("This claim link is damaged. Ask the sender to copy it again.");
  }
  if (secret.length !== 32) throw new Error("This claim link is cut short. Ask the sender to copy it again.");
  const b = p.get("b") ?? "0";
  const t = p.get("t");
  const a = p.get("a");
  return {
    secret,
    block: /^\d{1,12}$/.test(b) ? BigInt(b) : 0n,
    token: (LINK_TOKENS as readonly string[]).includes(t ?? "") ? (t as LinkToken) : undefined,
    amount: a && /^\d{1,15}(\.\d{1,18})?$/.test(a) ? a : undefined,
    message: cleanLinkText(p.get("m"), LINK_MESSAGE_MAX) || undefined,
    from: cleanLinkText(p.get("f"), LINK_NAME_MAX) || undefined,
    locked: p.get("p") === "1",
    hint: cleanLinkText(p.get("q"), LINK_HINT_MAX) || undefined,
  };
}

export interface PaymentRequest {
  /** A cloak: address (paid privately) or a 0x address (paid from the payer's private balance). */
  to: string;
  token: LinkToken;
  /** Whole units as a decimal ("25", "0.5"); leave out to let the payer choose. */
  amount?: string;
  /** What it's for: an invoice number, an order. Only the payer sees it. */
  note?: string;
  /** Who is asking. */
  name?: string;
}

/** Checks an amount and returns it as a plain decimal, or throws a plain-language error. Empty means "payer chooses". */
export function normalizeLinkAmount(input: string, decimals: number): string {
  const s = input.trim().replace(/,/g, "");
  if (!s) return "";
  if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) throw new Error("Use numbers and one dot for the amount, like 25 or 0.5.");
  const [i = "", f = ""] = s.split(".");
  if (f.length > decimals) throw new Error(`Use at most ${decimals} decimal places.`);
  const int = i.replace(/^0+(?=\d)/, "") || "0";
  const frac = f.replace(/0+$/, "");
  if (int.length > 15) throw new Error("That amount is too large.");
  if (/^0*$/.test(int) && !frac) throw new Error("Use an amount above zero, or leave it empty.");
  return frac ? `${int}.${frac}` : int;
}

/** Throws unless `to` is a cloak: address or a 0x address. */
export function checkPayee(to: string): "cloak" | "wallet" {
  const t = to.trim();
  if (t.startsWith("cloak:")) {
    parseCloakAddress(t);
    return "cloak";
  }
  if (isAddress(t)) return "wallet";
  throw new Error("Pay to a cloak: address or a 0x wallet address.");
}

export function buildRequestLink(r: PaymentRequest, origin = LINK_ORIGIN): string {
  checkPayee(r.to);
  if (!(LINK_TOKENS as readonly string[]).includes(r.token)) throw new Error(`Requests take ${LINK_TOKENS.join(" or ")}.`);
  const p = new URLSearchParams();
  p.set("to", r.to.trim());
  if (r.amount) p.set("amount", normalizeLinkAmount(r.amount, r.token === "USDC" ? 6 : 18));
  p.set("token", r.token);
  const note = cleanLinkText(r.note, LINK_MESSAGE_MAX);
  if (note) p.set("note", note);
  const name = cleanLinkText(r.name, LINK_NAME_MAX);
  if (name) p.set("name", name);
  return `${origin.replace(/\/+$/, "")}/pay#${p.toString()}`;
}

/** Reads a request link (fragment first, then the query string, so hand-made `?to=…` links work too). */
export function parseRequestLink(link: string): PaymentRequest {
  const url = new URL(link, LINK_ORIGIN);
  const p = new URLSearchParams(url.search);
  const frag = url.hash.replace(/^#/, "");
  for (const [k, v] of new URLSearchParams(frag)) p.set(k, v);
  const to = (p.get("to") ?? "").trim();
  checkPayee(to);
  const token = ((p.get("token") ?? "HYPE").toUpperCase() === "USDC" ? "USDC" : "HYPE") as LinkToken;
  const raw = p.get("amount") ?? "";
  let amount: string | undefined;
  try {
    amount = normalizeLinkAmount(raw, token === "USDC" ? 6 : 18) || undefined;
  } catch {
    amount = undefined;
  }
  return { to, token, amount, note: cleanLinkText(p.get("note"), LINK_MESSAGE_MAX) || undefined, name: cleanLinkText(p.get("name"), LINK_NAME_MAX) || undefined };
}

export type { Hex };
