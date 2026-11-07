import { encodeAbiParameters, getContractAddress, keccak256, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { CloakKeys } from "./crypto.js";

/**
 * Private receive addresses (CloakReceive). Each is an ordinary-looking address, derived offline from the account seed
 * and a number n, that anyone can pay with a plain transfer: an exchange withdrawal, a bridge, any wallet. A relayer
 * then delivers what arrived into the vault as this account's note (CloakReceive.deliver), keeping at most `maxFeeBps`.
 * The address has no private key: only the vault (or the owner's rescue signature) can ever move what's there.
 * Use each address once: payments to the same address are visibly linked to each other.
 */

export interface ReceiveParams {
  pubKey: bigint;
  blinding: bigint;
  memo: Hex;
  maxFeeBps: number;
  rescuer: Address;
}

export interface ReceiveAddress {
  n: number;
  address: Address;
  params: ReceiveParams;
}

/** The most a relayer may keep for delivering, unless the app asks for less (1%). */
export const RECEIVE_MAX_FEE_BPS = 100;

export function receiveSalt(p: ReceiveParams): Hex {
  return keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "bytes32" }, { type: "uint16" }, { type: "address" }], [p.pubKey, p.blinding, keccak256(p.memo), p.maxFeeBps, p.rescuer]));
}

/** The address CloakReceive at `factory` gives these parameters (`boxCodeHash` = CloakReceive.boxCodeHash()). */
export function receiveAddressOf(factory: Address, boxCodeHash: Hex, p: ReceiveParams): Address {
  return getContractAddress({ opcode: "CREATE2", from: factory, salt: receiveSalt(p), bytecodeHash: boxCodeHash });
}

/** Receive address `n` of this account (offline: nothing goes on chain until someone pays it). */
export async function receiveAddress(keys: CloakKeys, factory: Address, boxCodeHash: Hex, n: number, maxFeeBps = RECEIVE_MAX_FEE_BPS): Promise<ReceiveAddress> {
  const r = await keys.receive(n);
  const params: ReceiveParams = { pubKey: r.pubKey, blinding: r.blinding, memo: r.memo, maxFeeBps, rescuer: privateKeyToAccount(r.rescueKey).address };
  return { n, address: receiveAddressOf(factory, boxCodeHash, params), params };
}

/**
 * The owner's signature for getting something out of receive address `n` that the vaults can't take (an NFT, a token
 * without a vault): CloakReceive.rescue(params, target, value, data, signature). `nonce` = CloakReceive.nonces(address).
 */
export async function signReceiveRescue(keys: CloakKeys, n: number, o: { factory: Address; chainId: number; box: Address; target: Address; value?: bigint; data: Hex; nonce: bigint }): Promise<Hex> {
  const { rescueKey } = await keys.receive(n);
  return privateKeyToAccount(rescueKey).signTypedData({
    domain: { name: "CloakReceive", chainId: o.chainId, verifyingContract: o.factory },
    types: { Rescue: [{ name: "box", type: "address" }, { name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes32" }, { name: "nonce", type: "uint256" }] },
    primaryType: "Rescue",
    message: { box: o.box, target: o.target, value: o.value ?? 0n, data: keccak256(o.data), nonce: o.nonce },
  });
}

const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

/** Ask a Cloak relayer to watch receive addresses and deliver what arrives (`POST /receive`). */
export async function watchReceive(url: string, list: ReceiveAddress[]): Promise<void> {
  const res = await fetch(`${url.replace(/\/$/, "")}/receive`, { method: "POST", headers: { "content-type": "application/json" }, body: json({ addresses: list.map((x) => ({ address: x.address, params: x.params })) }), signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `watch failed (${res.status})`);
}

export interface ReceiveDelivery {
  token: Address;
  amount: string;
  fee: string;
  txHash: Hex;
  at: number;
}

/** What a relayer delivered from these receive addresses (`GET /receive?addresses=`). */
export async function receiveDeliveries(url: string, addresses: Address[]): Promise<Record<string, ReceiveDelivery[]>> {
  const res = await fetch(`${url.replace(/\/$/, "")}/receive?addresses=${addresses.join(",")}`, { signal: AbortSignal.timeout(30_000) });
  const out = (await res.json().catch(() => ({}))) as { deliveries?: Record<string, ReceiveDelivery[]>; error?: string };
  if (!res.ok) throw new Error(out.error ?? `status failed (${res.status})`);
  return out.deliveries ?? {};
}
