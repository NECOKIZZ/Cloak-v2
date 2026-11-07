// Private-account cryptography: Poseidon notes, x25519-encrypted memos, deterministic keys.
import { x25519 } from "@noble/curves/ed25519";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { randomBytes } from "@noble/hashes/utils";
import { concat, keccak256, toBytes, toHex, type Hex } from "viem";
import { poseidon1 } from "poseidon-lite/poseidon1";
import { poseidon2 } from "poseidon-lite/poseidon2";
import { poseidon3 } from "poseidon-lite/poseidon3";
import { poseidon4 } from "poseidon-lite/poseidon4";

export const FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const LEVELS = 20;
export const MAX_NOTE_AMOUNT = 2n ** 128n;
/** Key index of the main spending key; any other index is a one-time key used for a single public entry. */
export const MAIN_KEY = 0xffffffff;
/** One-time keys of private receive addresses: RECEIVE_KEY_BASE + n (random one-time keys stay below it in practice). */
export const RECEIVE_KEY_BASE = 0xc0000000;
export const RECEIVE_KEY_COUNT = 0x3fffffff;

const fieldMod = (x: bigint) => ((x % FIELD_SIZE) + FIELD_SIZE) % FIELD_SIZE;
export const randomField = () => BigInt(toHex(randomBytes(31)));
export const randomKeyIndex = () => Number(BigInt(toHex(randomBytes(4))) % 0xc0000000n); // below RECEIVE_KEY_BASE

// circomlib's Poseidon (the circuits' hash) with per-arity constants: tens of KB instead of circomlibjs's 1.3 MB.
// Identical outputs for arities 1 to 4 (checked against circomlibjs on 10,000+ inputs, field edges included, in
// test/poseidon.test.mjs), which are the only arities Cloak uses.
const POSEIDON = [poseidon1, poseidon2, poseidon3, poseidon4];
export async function poseidon(inputs: bigint[]): Promise<bigint> {
  const f = POSEIDON[inputs.length - 1];
  if (!f) throw new Error(`poseidon: ${inputs.length} inputs, only 1 to 4 are supported`);
  return f(inputs.map((x) => BigInt(x)));
}

/**
 * EIP-712 request whose signature derives a wallet's Cloak private account (v4 on). It is bound to the chain only, never
 * to a contract, so the account and its `cloak:` address stay the same through every upgrade.
 */
export const ACCOUNT_TYPED_DATA = (chainId: number) =>
  ({
    domain: { name: "Cloak", version: "4", chainId },
    types: { PrivateAccount: [{ name: "purpose", type: "string" }] },
    primaryType: "PrivateAccount",
    message: {
      purpose: "Derive my Cloak private account. This costs nothing and moves no funds. Only sign this on cloak.boblabs.tech.",
    },
  }) as const;

/** The plain message v1 accounts were derived from. Only used to move an old v1 balance. */
export const ACCOUNT_MESSAGE =
  "Cloak private account v1\n\nSigning this derives your private trading keys on Elysium. It costs nothing and does not move funds.";

/** The EIP-712 request v2 and v3 accounts were derived from, bound to that deployment's router. Only used to move an old balance. */
export const ROUTER_ACCOUNT_TYPED_DATA = (chainId: number, router: `0x${string}`) =>
  ({
    domain: { name: "Cloak", version: "2", chainId, verifyingContract: router },
    types: { PrivateAccount: [{ name: "purpose", type: "string" }] },
    primaryType: "PrivateAccount",
    message: {
      purpose: "Derive my Cloak private trading keys. This costs nothing and moves no funds. Only sign this on cloak.boblabs.tech.",
    },
  }) as const;

export interface SpendKey {
  index: number;
  privKey: bigint;
  pubKey: bigint;
}

/**
 * One seed → a main spending key, a view key (memo encryption) and 2³² one-time keys. One-time keys receive every note
 * that enters the pool publicly (shielding, swap outputs), so on-chain `depositTo` calls never repeat a pubKey and
 * cannot be linked to each other or to the main key.
 */
export class CloakKeys {
  private cache = new Map<number, SpendKey>();
  private constructor(
    private seed: Uint8Array,
    readonly encPriv: Uint8Array,
    readonly encPub: Uint8Array,
  ) {}

  static fromSeed(seed: Uint8Array): CloakKeys {
    const encPriv = toBytes(keccak256(concat([toBytes("cloak-view-v1"), seed])));
    return new CloakKeys(seed, encPriv, x25519.getPublicKey(encPriv));
  }

  /** Derive from a wallet signature over ACCOUNT_MESSAGE. */
  static fromSignature(sig: Hex): CloakKeys {
    return CloakKeys.fromSeed(toBytes(keccak256(sig)));
  }

  async key(index: number): Promise<SpendKey> {
    const hit = this.cache.get(index);
    if (hit) return hit;
    const tag = index === MAIN_KEY ? toBytes("cloak-spend-v1") : concat([toBytes("cloak-otk-v1"), toBytes(toHex(index, { size: 4 }))]);
    const privKey = fieldMod(BigInt(keccak256(concat([tag, this.seed]))));
    const k = { index, privKey, pubKey: await poseidon([privKey]) };
    this.cache.set(index, k);
    return k;
  }

  main() {
    return this.key(MAIN_KEY);
  }

  /**
   * The private key of one-time bid wallet `n` for `auction`: a fresh address that bids from the private balance, so the
   * bid can't be linked to the account's wallet. Derived from this account's seed, so the same signature always finds
   * it again (on any device).
   */
  /**
   * Everything private receive address `n` needs, derived from the seed alone, so any device that unlocks the account
   * finds the same address again: a one-time key (index RECEIVE_KEY_BASE + n), a blinding, the memo encrypted to this
   * account's view key (deterministic, so the address is too) and the key that may sign a rescue for it.
   */
  async receive(n: number): Promise<{ keyIndex: number; pubKey: bigint; blinding: bigint; memo: Hex; rescueKey: Hex }> {
    if (!Number.isInteger(n) || n < 0 || n >= RECEIVE_KEY_COUNT) throw new Error("receive address number out of range");
    const tag = (t: string) => toBytes(keccak256(concat([toBytes(t), this.seed, toBytes(toHex(n, { size: 4 }))])));
    const keyIndex = RECEIVE_KEY_BASE + n;
    const k = await this.key(keyIndex);
    const blinding = fieldMod(BigInt(toHex(tag("cloak-receive-blinding-v1"))));
    const memo = toHex(seal(this.encPub, concat([toBytes(toHex(blinding, { size: 32 })), u32(keyIndex)]), tag("cloak-receive-eph-v1"), tag("cloak-receive-nonce-v1").slice(0, 24)));
    return { keyIndex, pubKey: k.pubKey, blinding, memo, rescueKey: toHex(tag("cloak-receive-rescue-v1")) };
  }

  bidWalletKey(auction: Hex, n: number): Hex {
    return keccak256(concat([toBytes("cloak-bidwallet-v1"), this.seed, toBytes(auction.toLowerCase() as Hex), toBytes(toHex(n, { size: 4 }))]));
  }
}

export interface Note {
  amount: bigint;
  pubKey: bigint;
  blinding: bigint;
  /** Shared vault only: the token's address as a number. Notes of single-token vaults have none. */
  asset?: bigint;
}

export const noteCommitment = (n: Note) =>
  n.asset === undefined ? poseidon([n.amount, n.pubKey, n.blinding]) : poseidon([n.amount, n.pubKey, n.blinding, n.asset]);

export async function nullifierOf(n: Note, leafIndex: number, privKey: bigint) {
  const c = await noteCommitment(n);
  const sig = await poseidon([privKey, c, BigInt(leafIndex)]);
  return poseidon([c, BigInt(leafIndex), sig]);
}

// ── memos ──
// 0x03 | eph(32) | nonce(24) | enc(amount16 ‖ blinding32 ‖ keyIndex4) + tag(16)   — notes created by a proof
// 0x02 | amount(16) | eph(32) | nonce(24) | enc(blinding32 ‖ keyIndex4) + tag(16) — notes created by the router
//        (the router prepends the public amount; the client only encrypts blinding + key index)
const INFO = toBytes("cloak-note-v1");

function seal(encPub: Uint8Array, pt: Uint8Array, eph = randomBytes(32), nonce = randomBytes(24)): Uint8Array {
  const key = hkdf(sha256, x25519.getSharedSecret(eph, encPub), undefined, INFO, 32);
  return concat([x25519.getPublicKey(eph), nonce, xchacha20poly1305(key, nonce).encrypt(pt)]);
}

function open(encPriv: Uint8Array, b: Uint8Array): Uint8Array | null {
  try {
    const key = hkdf(sha256, x25519.getSharedSecret(encPriv, b.slice(0, 32)), undefined, INFO, 32);
    return xchacha20poly1305(key, b.slice(32, 56)).decrypt(b.slice(56));
  } catch {
    return null;
  }
}

const u32 = (n: number) => toBytes(toHex(n, { size: 4 }));

export function encryptFullMemo(encPub: Uint8Array, amount: bigint, blinding: bigint, keyIndex: number): Hex {
  return toHex(concat([new Uint8Array([3]), seal(encPub, concat([toBytes(toHex(amount, { size: 16 })), toBytes(toHex(blinding, { size: 32 })), u32(keyIndex)]))]));
}

/** For router-created notes: the router adds `0x02 ‖ amount` in front on-chain. */
export function encryptRouterMemo(encPub: Uint8Array, blinding: bigint, keyIndex: number): Hex {
  return toHex(seal(encPub, concat([toBytes(toHex(blinding, { size: 32 })), u32(keyIndex)])));
}

export function readMemo(encPriv: Uint8Array, memo: Hex): { amount: bigint; blinding: bigint; keyIndex: number } | null {
  const b = toBytes(memo);
  if (b.length === 1 + 32 + 24 + 52 + 16 && b[0] === 3) {
    const pt = open(encPriv, b.slice(1));
    if (!pt) return null;
    return { amount: BigInt(toHex(pt.slice(0, 16))), blinding: BigInt(toHex(pt.slice(16, 48))), keyIndex: Number(BigInt(toHex(pt.slice(48, 52)))) };
  }
  if (b.length === 1 + 16 + 32 + 24 + 36 + 16 && b[0] === 2) {
    const pt = open(encPriv, b.slice(17));
    if (!pt) return null;
    return { amount: BigInt(toHex(b.slice(1, 17))), blinding: BigInt(toHex(pt.slice(0, 32))), keyIndex: Number(BigInt(toHex(pt.slice(32, 36)))) };
  }
  return null;
}

// ── Cloak addresses: share one to receive private transfers ──
// cloak:<pubKey 32 bytes><view key 32 bytes>
export function formatCloakAddress(pubKey: bigint, encPub: Uint8Array): string {
  return `cloak:${toHex(pubKey, { size: 32 }).slice(2)}${toHex(encPub).slice(2)}`;
}

export function parseCloakAddress(addr: string): { pubKey: bigint; encPub: Uint8Array } {
  const a = addr.trim();
  if (!/^cloak:[0-9a-fA-F]{128}$/.test(a)) throw new Error("not a cloak: address");
  const pubKey = BigInt("0x" + a.slice(6, 70));
  if (pubKey >= FIELD_SIZE) throw new Error("bad cloak: address");
  return { pubKey, encPub: toBytes(`0x${a.slice(70)}`) };
}
