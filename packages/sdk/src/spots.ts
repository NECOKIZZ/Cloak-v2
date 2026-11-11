/**
 * WL spot sales: a partner collection gives out whitelist (or GTD) spots and they're sold as a Cloak drop.
 *
 * The drop's supply is the number of spots and its sealed auction picks the winners (the floor, ties and refunds work
 * as in any drop). CloakSpotBook marks the drop as a spot sale. Once it settles, the wallet behind each winning bid is
 * on the list by default; a winner can name other wallets instead, one per spot, until the deadline. The book holds the list the partner uses.
 * Each winner also gets the drop's NFT as a receipt.
 */
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { cloakSpotBookAbi } from "./abis.js";
import { CloakDrops, type CreateDropOptions, type DropBid, type DropField, type SpotKind } from "./drops.js";

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
  /** The winner's answers to the sale's bid fields (an X username, say), from its sealed bid. */
  fields?: Record<string, string>;
}

/** One spot on the partner's list: its wallet, and whether the winner named it or it's the wallet that bid. */
export interface SpotRow {
  wallet: Address | null;
  bidId: bigint;
  bidder: Address;
  source: "named" | "bidder" | "none";
  /** The winner's answers to the sale's bid fields, on every row of its bid. */
  fields: Record<string, string>;
}

export type CreateSpotSaleOptions = Omit<CreateDropOptions, "gtd" | "baseURI" | "spots"> & {
  /** The partner collection giving the spots. */
  partner: string;
  /** WL (default) or GTD: what the partner's spots give. Shown on the sale page and the receipts. */
  kind?: SpotKind;
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
    if (!(days >= 1 && days <= SPOT_MAX_WALLET_DAYS)) throw new Error(`Winners get 1 to ${SPOT_MAX_WALLET_DAYS} days to name wallets.`);
    const { drop, txHash } = await this.drops.create({ ...o, baseURI: o.baseURI ?? "", maxPerBid: o.maxPerBid ?? 1, spots: { partner, kind: o.kind } });
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
    // the sale's bid fields, read from the opened sealed bids
    const answers = won.length && (await this.drops.details(drop)).fields?.length ? await this.drops.bidFields(drop) : new Map<bigint, Record<string, string>>();
    return won.map((b) => ({ bidId: b.id, bidder: b.bidder, spots: b.nfts, wallets: wallets.filter((_, i) => ids[i] === b.id), ...(answers.get(b.id) ? { fields: answers.get(b.id) } : {}) }));
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
   * The list the partner gets, one row per spot. A winner doesn't have to do anything: the wallet that placed a winning
   * bid fills its first spot. Naming wallets (setWallets) replaces that. A spot is left empty only when its bid won
   * more than one spot, or the bidding wallet is already on the list through another bid.
   */
  static rows(winners: SpotWinner[]): SpotRow[] {
    const named = new Set(winners.flatMap((w) => w.wallets.map((a) => a.toLowerCase())));
    const used = new Set<string>();
    const out: SpotRow[] = [];
    for (const w of winners) {
      for (let i = 0; i < w.spots; i++) {
        const own = w.wallets[i];
        if (own) out.push({ wallet: own, bidId: w.bidId, bidder: w.bidder, source: "named", fields: w.fields ?? {} });
        else if (i === 0 && !w.wallets.length && !named.has(w.bidder.toLowerCase()) && !used.has(w.bidder.toLowerCase())) {
          used.add(w.bidder.toLowerCase());
          out.push({ wallet: w.bidder, bidId: w.bidId, bidder: w.bidder, source: "bidder", fields: w.fields ?? {} });
        } else out.push({ wallet: null, bidId: w.bidId, bidder: w.bidder, source: "none", fields: w.fields ?? {} });
      }
    }
    return out;
  }

  /**
   * The winners sheet as CSV, one row per spot: id (1, 2, …), one column per bid field (the sale's `fields`, or every
   * field any winner answered), the wallet to list (blank only if a spot has none), the bid, the bidder, and where the
   * wallet came from. A partner lists the `wallet` column.
   */
  static csv(winners: SpotWinner[], fields?: DropField[]): string {
    const status = { named: "named by winner", bidder: "bidding wallet", none: "no wallet yet" } as const;
    const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const labels = fields?.length ? fields.map((f) => f.label) : [...new Set(winners.flatMap((w) => Object.keys(w.fields ?? {})))];
    const rows = [["id", ...labels, "wallet", "bid", "bidder", "status"].map(cell).join(",")];
    CloakSpots.rows(winners).forEach((r, i) => rows.push([String(i + 1), ...labels.map((l) => cell(r.fields[l] ?? "")), r.wallet ?? "", String(r.bidId), r.bidder, status[r.source]].join(",")));
    return rows.join("\n") + "\n";
  }
}
