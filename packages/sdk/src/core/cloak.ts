/**
 * CloakCore: Cloak's own private layer (`private/`, CloakPrivate) behind the PrivateCore seam. Address 0 means native
 * HYPE, which Cloak keeps in its WHYPE pool.
 */
import { zeroAddress, type Address, type Hex, type WalletClient } from "viem";
import type { CloakPrivate } from "../private/client.js";
import type { PrivateCore, SendResult } from "./types.js";
import type { Status } from "../private/client.js";

export class CloakCore implements PrivateCore {
  readonly kind = "cloak" as const;
  constructor(readonly priv: CloakPrivate) {}

  private token(asset: Address): Address {
    return asset === zeroAddress ? this.priv.hypeMarket.token : asset;
  }
  private markets() {
    return [...this.priv.markets, ...this.priv.assets];
  }

  address(): Promise<string> {
    return this.priv.address();
  }

  async sync(): Promise<void> {
    if (!this.priv.markets.length) await this.priv.loadMarkets();
    for (const m of this.markets()) await this.priv.sync(m.pool);
  }

  async balances(): Promise<Map<Address, bigint>> {
    const out = new Map<Address, bigint>();
    for (const m of this.markets()) {
      const b = await this.priv.balance(m.pool);
      if (b > 0n) out.set(m.pool === this.priv.hypeMarket.pool ? zeroAddress : m.token, b);
    }
    return out;
  }

  /** Cloak's notes belong to a key from the start, so nothing waits to be secured. */
  async pending(): Promise<Map<Address, bigint>> {
    return new Map();
  }

  async shield(wallet: WalletClient, asset: Address, amount: bigint, onStatus: Status = () => {}): Promise<Hex[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = wallet as any;
    return [asset === zeroAddress ? await this.priv.shieldHype(w, amount) : await this.priv.shieldToken(w, asset, amount, onStatus)];
  }

  async send(asset: Address, to: string, amount: bigint, onStatus: Status = () => {}): Promise<SendResult> {
    return { txHashes: [await this.priv.send(this.token(asset), to, amount, onStatus)], pieces: 1 };
  }

  async withdraw(asset: Address, to: Address, amount: bigint | "max", onStatus: Status = () => {}): Promise<Hex[]> {
    if (amount === "max") return [(await this.priv.sweep(this.token(asset), to, onStatus)).txHash];
    return [asset === zeroAddress ? await this.priv.unshieldHype(to, amount, onStatus) : await this.priv.unshieldToken(asset, to, amount, onStatus)];
  }

  /** Cloak spends into its routers and batchers in the same proof, not through an escrow address. */
  async spendTo(): Promise<Hex[]> {
    throw new Error("CloakCore spends through its routers (buy, sell, batch, bidPrivately), not spendTo");
  }
}
