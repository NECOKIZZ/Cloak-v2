/**
 * Claim links on Cloak v2 on Gloam, in the same shape as Cloak's own: a link's secret (and passcode, if locked) opens a
 * small Gloam account, the sender pays its receive tag (one payment per share), and whoever opens the link sweeps it
 * to a wallet or into their own private balance. The link format (`buildClaimLink`) is unchanged, so locks, riddles,
 * shares and the sender taking a link back all work as before.
 *
 * Gloam's notes are bearer notes, which is what a link wants: the link carries what is needed to spend. The account
 * spends what it received directly (`spendReceived`), without first sweeping it into its own note.
 */
import { scryptAsync } from "@noble/hashes/scrypt";
import { concat, keccak256, toBytes } from "viem";
import { normalizePasscode, passcodeVariants, WrongPasscodeError, type ClaimLink } from "../private/links.js";
import { gloamKeysFromBytes, type GloamAccountKeys } from "./gloam.js";

/** The Gloam account a link opens. Without a passcode, from the secret alone; with one, scrypt(passcode, secret). */
export async function gloamLinkKeys(secret: Uint8Array, passcode?: string): Promise<GloamAccountKeys> {
  if (secret.length !== 32) throw new Error("bad link secret");
  if (passcode === undefined) return gloamKeysFromBytes(toBytes(keccak256(concat([toBytes("cloak-gloam-link-v1"), secret]))));
  const code = normalizePasscode(passcode);
  if (!code) throw new Error("enter the passcode");
  return gloamKeysFromBytes(await scryptAsync(toBytes(code), concat([toBytes("cloak-gloam-link-lock-v1"), secret]), { N: 2 ** 15, r: 8, p: 1, dkLen: 32 }));
}

/** Where a link's money is sent: the account's receive tag, in Cloak's `cloak:` form. */
export function gloamLinkAddress(keys: GloamAccountKeys): string {
  return `cloak:${keys.receiveTag}`;
}

/** The 8-hex-digit check a locked link carries, so a wrong passcode is caught before any network call. */
export function gloamLinkCheck(keys: GloamAccountKeys): string {
  return keccak256(concat([toBytes("cloak-gloam-link-check-v1"), toBytes(gloamLinkAddress(keys))])).slice(2, 10);
}

/** Open a link's account, trying the passcode's usual spellings against the link's check. */
export async function openGloamLinkKeys(l: ClaimLink, passcode?: string): Promise<GloamAccountKeys> {
  if (!l.locked) return gloamLinkKeys(l.secret);
  if (!passcode || !normalizePasscode(passcode)) throw new Error(l.hint ? "Type the answer." : "Enter the passcode.");
  if (!l.check) return gloamLinkKeys(l.secret, passcode);
  for (const v of passcodeVariants(passcode)) {
    const k = await gloamLinkKeys(l.secret, v);
    if (gloamLinkCheck(k) === l.check) return k;
  }
  throw new WrongPasscodeError(!!l.hint);
}
