// Private-account cryptography: Poseidon notes, x25519-encrypted memos, deterministic keys.
import { buildPoseidon } from "circomlibjs";
import { x25519 } from "@noble/curves/ed25519";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { randomBytes } from "@noble/hashes/utils";
import { concat, keccak256, toBytes, toHex, type Hex } from "viem";

export const FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const LEVELS = 20;
export const MAX_NOTE_AMOUNT = 2n ** 128n;
/** Key index of the main spending key; any other index is a one-time key used for a single public entry. */
export const MAIN_KEY = 0xffffffff;

const fieldMod = (x: bigint) => ((x % FIELD_SIZE) + FIELD_SIZE) % FIELD_SIZE;
export const randomField = () => BigInt(toHex(randomBytes(31)));
export const randomKeyIndex = () => Number(BigInt(toHex(randomBytes(4))) % 0xfffffffen);

let _poseidon: any;
export async function poseidon(inputs: bigint[]): Promise<bigint> {
  _poseidon ??= await buildPoseidon();
  return _poseidon.F.toObject(_poseidon(inputs.map((x) => BigInt(x))));
}

/** The message a wallet signs to derive its Cloak private account (deterministic for standard EOAs). */
export const ACCOUNT_MESSAGE =
  "Cloak private account v1\n\nSigning this derives your private trading keys on Elysium. It costs nothing and does not move funds.";

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
}

export interface Note {
  amount: bigint;
  pubKey: bigint;
  blinding: bigint;
}

export const noteCommitment = (n: Note) => poseidon([n.amount, n.pubKey, n.blinding]);

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

function seal(encPub: Uint8Array, pt: Uint8Array): Uint8Array {
  const eph = randomBytes(32);
  const key = hkdf(sha256, x25519.getSharedSecret(eph, encPub), undefined, INFO, 32);
  const nonce = randomBytes(24);
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
