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
 *                 Split into shares (`n=`), it is a red envelope: several equal notes, and each person who opens the
 *                 link claims one, first come first served.
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
import { concat, isAddress, keccak256, toBytes, toHex, type Hex } from "viem";
import { CloakKeys, formatCloakAddress, parseCloakAddress } from "./crypto.js";

export const LINK_ORIGIN = "https://cloak.boblabs.tech";
export const LINK_MESSAGE_MAX = 140;
export const LINK_NAME_MAX = 40;
export const LINK_HINT_MAX = 120;
/** Most shares one link can be split into. Each share is its own private send, so more means a longer wait to make it. */
export const LINK_SHARES_MAX = 20;
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

/** The 8-hex-digit check a locked link carries: the first 4 bytes of a hash of the account the passcode opens. */
export async function linkCheck(keys: CloakKeys): Promise<string> {
  return keccak256(concat([toBytes("cloak-link-check-v1"), toBytes(await linkAddress(keys))])).slice(2, 10);
}

/** Thrown when a link's check says the passcode is wrong. */
export class WrongPasscodeError extends Error {
  constructor(riddle: boolean) {
    super(riddle ? "That's not the answer. Check the spelling and try again." : "That's not the passcode. Check it with the sender and try again.");
    this.name = "WrongPasscodeError";
  }
}

/** Ways a phone may have typed the same code: curly quotes and long dashes from autocorrect, a trailing full stop. */
function passcodeVariants(code: string): string[] {
  const base = normalizePasscode(code);
  const straight = base.replace(/[\u2018\u2019\u201b\u2032]/g, "'").replace(/[\u201c\u201d\u2033]/g, '"').replace(/[\u2013\u2014\u2212]/g, "-");
  return [...new Set([base, straight, straight.replace(/[.!?]+$/, "")])].filter(Boolean);
}

/**
 * Opens a link's account. A locked link with a check tries the code (and the ways a phone may have mangled it) and
 * throws WrongPasscodeError if none matches, without touching the network. A link without a check (made before
 * checks existed) opens with the code as typed; an empty account is then all a wrong code looks like.
 */
export async function openLinkKeys(l: ClaimLink, passcode?: string): Promise<CloakKeys> {
  if (!l.locked) return linkKeys(l.secret);
  if (!passcode || !normalizePasscode(passcode)) throw new Error(l.hint ? "Type the answer." : "Enter the passcode.");
  if (!l.check) return linkKeys(l.secret, passcode);
  for (const v of passcodeVariants(passcode)) {
    const k = await linkKeys(l.secret, v);
    if ((await linkCheck(k)) === l.check) return k;
  }
  throw new WrongPasscodeError(!!l.hint);
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
  /** Split into this many equal shares: each person who opens the link claims one (a red envelope). */
  shares?: number;
  /** A short check of the account a passcode opens, so a wrong passcode is caught on the device, before any
   *  network call. It tells a guesser nothing a copy of the link didn't already: each guess still costs a full scrypt. */
  check?: string;
}

/** The fields of a claim link as query parameters (the secret in hex). */
function claimParams(l: ClaimLink): URLSearchParams {
  const p = new URLSearchParams();
  p.set("k", toHex(l.secret).slice(2));
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
  if (l.shares && l.shares > 1) p.set("n", String(Math.min(Math.floor(l.shares), LINK_SHARES_MAX)));
  if (l.check && /^[0-9a-f]{8}$/.test(l.check)) p.set("c", l.check);
  return p;
}

/**
 * A claim link: https://cloak.boblabs.tech/claim#c<letters and digits>. Everything after the # is one run of letters
 * and digits (base 62), because chat apps end a link at characters like "-", "_", "." or "%" (WhatsApp and Telegram
 * both cut links that way) and a cut link loses the money's key.
 */
export function buildClaimLink(l: ClaimLink, origin = LINK_ORIGIN): string {
  return `${origin.replace(/\/+$/, "")}/claim#c${toBase62(new TextEncoder().encode(claimParams(l).toString()))}`;
}

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function toBase62(bytes: Uint8Array): string {
  // a leading 1 byte keeps leading zero bytes; the payload is a few hundred bytes, so plain bigint math is fine
  let n = BigInt(toHex(concat([new Uint8Array([1]), bytes])));
  let out = "";
  while (n > 0n) {
    out = B62[Number(n % 62n)] + out;
    n /= 62n;
  }
  return out;
}
function fromBase62(s: string): Uint8Array {
  let n = 0n;
  for (const ch of s) {
    const v = B62.indexOf(ch);
    if (v < 0) throw new Error("bad link");
    n = n * 62n + BigInt(v);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const b = toBytes(`0x${hex}`);
  if (b[0] !== 1) throw new Error("bad link");
  return b.slice(1);
}

/** Reads a claim link (the whole URL or just its fragment). Throws on anything that isn't one. */
export function parseClaimLink(link: string): ClaimLink {
  let frag = (link.includes("#") ? link.slice(link.indexOf("#") + 1) : link).trim();
  if (/^c[0-9A-Za-z]+$/.test(frag)) {
    try {
      frag = new TextDecoder("utf-8", { fatal: true }).decode(fromBase62(frag.slice(1)));
    } catch {
      throw new Error("This claim link is cut short or damaged. Ask the sender to copy the whole link again.");
    }
  }
  const p = new URLSearchParams(frag);
  const k = p.get("k");
  if (!k) throw new Error("This isn't a Cloak claim link.");
  let secret: Uint8Array;
  try {
    secret = /^[0-9a-fA-F]{64}$/.test(k) ? toBytes(`0x${k}`) : unb64url(k);
  } catch {
    throw new Error("This claim link is damaged. Ask the sender to copy it again.");
  }
  if (secret.length !== 32) throw new Error("This claim link is cut short. Ask the sender to copy the whole link again.");
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
    shares: /^\d{1,2}$/.test(p.get("n") ?? "") && Number(p.get("n")) > 1 ? Math.min(Number(p.get("n")), LINK_SHARES_MAX) : undefined,
    check: /^[0-9a-f]{8}$/.test(p.get("c") ?? "") ? (p.get("c") as string) : undefined,
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
