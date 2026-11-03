/**
 * WL spot sales: a partner collection gives out whitelist spots and they're sold as a Cloak drop.
 *
 * The drop's supply is the number of spots and its sealed auction picks the winners (the floor, ties and refunds work
 * as in any drop). CloakSpotBook marks the drop as a spot sale. Once it settles, each winning bid names the wallets to
 * whitelist, one per spot it won, and can change them until the deadline. The book holds the list the partner uses.
 * Each winner also gets the drop's NFT as a receipt.
 */
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { cloakSpotBookAbi } from "./abis.js";
import { CloakDrops, type CreateDropOptions, type DropBid } from "./drops.js";

/** How long winners have to name their wallets, by default, once bids are opened. */
export const SPOT_DEFAULT_WALLET_DAYS = 3;
export const SPOT_MAX_WALLET_DAYS = 90;

export interface SpotSale {
  drop: Address;
  partner: string;
  /** Unix seconds: winners name or change wallets until then. */
  deadline: number;
}

/** One winning bid and the wallets it named (none yet: `wallets` is empty). */
export interface SpotWinner {
  bidId: bigint;
  bidder: Address;
  spots: number;
  wallets: Address[];
}

export type CreateSpotSaleOptions = Omit<CreateDropOptions, "gtd" | "baseURI" | "spots"> & {
  /** The partner collection giving the spots. */
  partner: string;
  /** Days after the reveal window that winners have to name wallets (default 3). */
  walletDays?: number;
  baseURI?: string;
};

export class CloakSpots {
  constructor(
    readonly drops: CloakDrops,
    readonly book: Address,
  ) {}

  private get pc() {
    return this.drops.publicClient;
  }

  private async send(hash: Hex) {
    const r = await this.pc.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`transaction reverted: ${hash}`);
    return r;
  }

  /**
   * Create a drop that sells `supply` WL spots for `partner`, then mark it as a spot sale. Two transactions; if the
   * second fails, `open(drop, …)` finishes the job.
   */
  async create(o: CreateSpotSaleOptions): Promise<{ drop: Address; txHash: Hex; openTx: Hex; deadline: number }> {
    const partner = o.partner.trim();
    if (!partner || partner.length > 200) throw new Error("Name the partner collection (up to 200 characters).");
    const days = o.walletDays ?? SPOT_DEFAULT_WALLET_DAYS;
    if (!(days > 0 && days <= SPOT_MAX_WALLET_DAYS)) throw new Error(`Winners get 1 to ${SPOT_MAX_WALLET_DAYS} days to name wallets.`);
    const { drop, txHash } = await this.drops.create({ ...o, baseURI: o.baseURI ?? "", maxPerBid: o.maxPerBid ?? 1, spots: { partner } });
    const s = await this.drops.get(drop);
    const deadline = s.revealEnd + Math.round(days * 86400);
    const openTx = await this.open(drop, partner, deadline);
    return { drop, txHash, openTx, deadline };
  }

  /** Mark an existing drop (the caller's, not settled yet) as a WL spot sale. */
  async open(drop: Address, partner: string, deadline: number): Promise<Hex> {
    const w = this.drops.walletClient;
    if (!w) throw new Error("CloakSpots: a walletClient is required for this call");
    const all = await this.drops.list();
    const index = all.findIndex((a) => a.toLowerCase() === drop.toLowerCase());
    if (index < 0) throw new Error("That isn't a Cloak drop.");
    const { request } = await this.pc.simulateContract({ address: this.book, abi: cloakSpotBookAbi, functionName: "open", args: [BigInt(index), partner.trim(), BigInt(deadline)], account: w.account });
    const h = await w.writeContract(request);
    await this.send(h);
    return h;
  }

  /** The sale on a drop, or null if the drop isn't a WL spot sale. */
  async sale(drop: Address): Promise<SpotSale | null> {
    const s = await this.pc.readContract({ address: this.book, abi: cloakSpotBookAbi, functionName: "sale", args: [drop] });
    return s.open ? { drop, partner: s.partner, deadline: Number(s.deadline) } : null;
  }

  /** Every drop marked as a spot sale, oldest first. */
  async sales(): Promise<Address[]> {
    const n = Number(await this.pc.readContract({ address: this.book, abi: cloakSpotBookAbi, functionName: "salesCount" }));
    const out: Address[] = [];
    for (let i = 0; i < n; i++) out.push(await this.pc.readContract({ address: this.book, abi: cloakSpotBookAbi, functionName: "sales", args: [BigInt(i)] }));
    return out;
  }

  /** Every winning bid (once the drop is settled) with the wallets it has named so far. */
  async winners(drop: Address, bids?: DropBid[]): Promise<SpotWinner[]> {
    const all = bids ?? (await this.drops.bids(drop));
    const won = all.filter((b) => b.nfts > 0);
    const [ids, wallets] = await this.pc.readContract({ address: this.book, abi: cloakSpotBookAbi, functionName: "list", args: [drop] });
    return won.map((b) => ({ bidId: b.id, bidder: b.bidder, spots: b.nfts, wallets: wallets.filter((_, i) => ids[i] === b.id) }));
  }

  /** Name the wallets to whitelist for a winning bid of the connected wallet: one per spot. Replaces earlier ones. */
  async setWallets(drop: Address, bidId: bigint, wallets: string[]): Promise<Hex> {
    const w = this.drops.walletClient;
    if (!w) throw new Error("CloakSpots: a walletClient is required for this call");
    const list = wallets.map((a) => a.trim());
    const bad = list.find((a) => !isAddress(a));
    if (bad !== undefined) throw new Error(`${bad || "An empty line"} isn't a wallet address.`);
    const clean = list.map((a) => getAddress(a));
    if (new Set(clean.map((a) => a.toLowerCase())).size !== clean.length) throw new Error("Each spot needs a different wallet.");
    const { request } = await this.pc.simulateContract({ address: this.book, abi: cloakSpotBookAbi, functionName: "setWallets", args: [drop, bidId, clean], account: w.account });
    const h = await w.writeContract(request);
    await this.send(h);
    return h;
  }

  /**
   * The whitelist as CSV, one row per spot: the wallet to whitelist (or blank if the winner hasn't named one), the
   * bid and the bidder. A partner whitelists the `wallet` column.
   */
  static csv(winners: SpotWinner[]): string {
    const rows = ["wallet,bid,bidder,status"];
    for (const w of winners)
      for (let i = 0; i < w.spots; i++) rows.push(`${w.wallets[i] ?? ""},${w.bidId},${w.bidder},${w.wallets[i] ? "named" : "not named yet"}`);
    return rows.join("\n") + "\n";
  }
}
