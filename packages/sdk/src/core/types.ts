import type { Address, Hex, PublicClient, WalletClient } from "viem";
import type { Status } from "../private/client.js";

/**
 * The one seam between Cloak's features and the private layer underneath.
 *
 * Features (Portfolio, Send, Withdraw, Links, escrows, the MCP tools) talk to a PrivateCore and never to a vault
 * directly. Two cores implement it: CloakCore (Cloak's own vaults, `private/`) and GloamCore (Gloam's shared vault).
 * Switching is one setting (`coreFor`).
 */
export interface PrivateCore {
  readonly kind: "cloak" | "gloam";
  /** The shareable private address this account receives at (`cloak:` for Cloak, `gloamr1.` for Gloam). */
  address(): Promise<string>;
  /** Reads the chain and rebuilds what this account owns. Safe to call again; it picks up where it stopped. */
  sync(onStatus?: Status): Promise<void>;
  /** Spendable private balance per asset (address 0 is native HYPE). */
  balances(): Promise<Map<Address, bigint>>;
  /** Received but not yet secured (Gloam: a payment the payer could still spend back until it is swept). */
  pending(): Promise<Map<Address, bigint>>;
  /** Public balance into the private balance. The deposit (asset, amount, depositor) is public. */
  shield(wallet: WalletClient, asset: Address, amount: bigint, onStatus?: Status): Promise<Hex[]>;
  /** Private send to a private address. No public transfer, amount and asset hidden. */
  send(asset: Address, to: string, amount: bigint, onStatus?: Status): Promise<SendResult>;
  /** Private balance out to a public address. Amount, asset and recipient become public. */
  withdraw(asset: Address, to: Address, amount: bigint | "max", onStatus?: Status): Promise<Hex[]>;
  /**
   * Spends `amount` of `asset` out of the private balance into `escrow` and nothing else, the shape every Cloak
   * action (swap, bid, batch order, drop bid) uses on Gloam: the escrow then acts and shields the result back.
   */
  spendTo(asset: Address, escrow: Address, amount: bigint, onStatus?: Status): Promise<Hex[]>;
}

export interface SendResult {
  txHashes: Hex[];
  /** How many separate payments the recipient receives (Gloam's sends take one note in, so a balance spread over k notes pays in up to k pieces). */
  pieces: number;
}

/** A transaction to send: by a relayer (the private default) or by the user's own wallet. */
export interface CoreCall {
  to: Address;
  data: Hex;
  value?: bigint;
  /** What it is, for the relayer's allow list and the logs. */
  kind: "transfer" | "unshield" | "memo" | "escrow";
}

export type CoreSubmitter = (call: CoreCall) => Promise<Hex>;

/** Submits from a wallet (tests, or a user who accepts that their address is linked to the call). */
export function walletCoreSubmitter(publicClient: PublicClient, wallet: WalletClient): CoreSubmitter {
  return async (call) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hash = await wallet.sendTransaction({ account: wallet.account!, chain: wallet.chain, to: call.to, data: call.data, value: call.value ?? 0n } as any);
    const r = await publicClient.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${call.kind} reverted (${hash})`);
    return hash;
  };
}

/** Submits through a Cloak keeper's Gloam relay (POST /gloam/relay): the keeper pays gas and is the only sender seen. */
export function gloamRelaySubmitter(url: string): CoreSubmitter {
  return async (call) => {
    const r = await fetch(`${url.replace(/\/+$/, "")}/gloam/relay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: call.kind, to: call.to, data: call.data }) });
    const j = (await r.json().catch(() => ({}))) as { txHash?: Hex; error?: string };
    if (!r.ok || !j.txHash) throw new Error(j.error ?? `relay answered ${r.status}`);
    return j.txHash;
  };
}
