/**
 * Sealed NFT drops: one collection and its sealed sale (CloakDrop), made by CloakDropFactory.
 *
 *   GTD      listed wallets mint their guaranteed spots at the creator's GTD price, until the GTD window closes.
 *   Auction  everyone else bids what they'd pay, sealed to a drand round. The creator's price is the floor. Bids rank
 *            by score: their price, or for WL bids their price × (1 + boost). Public winners pay the clearing score;
 *            WL winners pay it ÷ (1 + boost), never under the floor. Bids tied at the clearing score share what's left
 *            by a lottery whose random start comes from every bid's sealed salt.
 *
 * The GTD and WL lists live on chain only as Merkle roots. The lists themselves are published once, in the factory's
 * DropDetails event, so anyone can rebuild a proof; a list that doesn't match the root proves nothing.
 */
import { encodeAbiParameters, getAddress, isAddress, keccak256, toHex, type Address, type Hex, type PublicClient } from "viem";
import { cloakDropAbi, cloakDropFactoryAbi } from "./abis.js";
import { commitmentOf, type Wallet } from "./cloak.js";
import { drandRoundAt, drandRoundTime, sealBid, unsealBid } from "./seal.js";

export const DROP_BPS = 10_000n;
export const DROP_MAX_BOOST_BPS = 3_000;
export const DROP_MAX_PER_BID = 20;
export const DROP_MAX_SUPPLY = 10_000;
/** Most entries one GTD or WL list can hold (the lists travel in one transaction). */
export const DROP_LIST_MAX = 2_000;

// ───────────────────────────── Merkle lists ─────────────────────────────

const enc = (types: { type: string }[], values: unknown[]) => encodeAbiParameters(types, values as never);

/** A WL list entry, as the drop hashes it. */
export const wlLeaf = (wallet: Address): Hex => keccak256(keccak256(enc([{ type: "address" }], [wallet])));
/** A GTD list entry: a wallet and its number of spots. */
export const gtdLeaf = (wallet: Address, spots: number): Hex =>
  keccak256(keccak256(enc([{ type: "address" }, { type: "uint32" }], [wallet, spots])));

const hashPair = (a: Hex, b: Hex): Hex =>
  BigInt(a) < BigInt(b) ? keccak256(enc([{ type: "bytes32" }, { type: "bytes32" }], [a, b])) : keccak256(enc([{ type: "bytes32" }, { type: "bytes32" }], [b, a]));

/** A Merkle tree over `leaves` (sorted-pair hashing, the layout CloakDrop checks). */
export function merkleTree(leaves: Hex[]): { root: Hex; proof: (leaf: Hex) => Hex[] } {
  const base = [...new Set(leaves.map((l) => l.toLowerCase() as Hex))].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  if (!base.length) return { root: `0x${"0".repeat(64)}`, proof: () => [] };
  const layers: Hex[][] = [base];
  while (layers.at(-1)!.length > 1) {
    const prev = layers.at(-1)!;
    const next: Hex[] = [];
    for (let i = 0; i < prev.length; i += 2) next.push(i + 1 < prev.length ? hashPair(prev[i], prev[i + 1]) : prev[i]);
    layers.push(next);
  }
  return {
    root: layers.at(-1)![0],
    proof(leaf) {
      let i = layers[0].indexOf(leaf.toLowerCase() as Hex);
      if (i < 0) throw new Error("not on the list");
      const out: Hex[] = [];
      for (let k = 0; k < layers.length - 1; k++) {
        const sib = i ^ 1;
        if (sib < layers[k].length) out.push(layers[k][sib]);
        i = Math.floor(i / 2);
      }
      return out;
    },
  };
}

// ───────────────────────────── types ─────────────────────────────

export interface GtdEntry {
  wallet: Address;
  spots: number;
}

/** What a drop publishes about itself at creation (the DropDetails event). */
export interface DropDetails {
  image?: string;
  description?: string;
  gtd?: GtdEntry[];
  wl?: Address[];
  /** Set when the drop sells WL spots for a partner collection (see CloakSpots). */
  spots?: { partner: string };
}

export interface CreateDropOptions {
  name: string;
  symbol: string;
  /** Token metadata: tokenURI(n) = baseURI + n, e.g. "ipfs://<folder>/". */
  baseURI: string;
  supply: number;
  /** The creator's price, in wei per NFT: the auction's floor. */
  floor: bigint;
  /** Price step between bid levels (default 5% of the floor). */
  tickSize?: bigint;
  /** Number of bid levels (default 200, so bids reach 11× the floor at 5% steps). */
  numTicks?: number;
  maxPerBid?: number;
  royaltyBps?: number;
  gtd?: { list: GtdEntry[]; price: bigint; durationSecs: number };
  wl?: { list: Address[]; boostBps: number };
  biddingSecs: number;
  /** Time after bidding closes for the keeper to open the bids (default 3 minutes). */
  revealSecs?: number;
  image?: string;
  description?: string;
  /** A WL spot sale: published with the drop so its pages and metadata say so. */
  spots?: { partner: string };
}

export type DropPhase = "gtd" | "bidding" | "reveal" | "settle" | "numbering" | "settled";
const PHASES: DropPhase[] = ["gtd", "bidding", "reveal", "settle", "numbering", "settled"];

export interface DropState {
  address: Address;
  name: string;
  symbol: string;
  baseURI: string;
  creator: Address;
  supply: number;
  maxPerBid: number;
  numTicks: number;
  wlBoostBps: number;
  royaltyBps: number;
  gtdEnd: number;
  commitEnd: number;
  revealEnd: number;
  tlockRound: number;
  floor: bigint;
  tickSize: bigint;
  gtdPrice: bigint;
  hasGtd: boolean;
  hasWl: boolean;
  phase: DropPhase;
  bids: number;
  reveals: number;
  gtdMinted: number;
  auctionSupply: number;
  minted: number;
  settled: boolean;
  failed: boolean;
  sold: number;
  /** What a public / WL winner pays per NFT (once settled). */
  publicPrice: bigint;
  wlPrice: bigint;
  tieSupply: number;
  tieDemand: number;
}

export interface DropBid {
  id: bigint;
  bidder: Address;
  wl: boolean;
  revealed: boolean;
  claimed: boolean;
  tick: number;
  price: bigint;
  quantity: number;
  deposit: bigint;
  /** Once settled: NFTs won, what they cost and the rest of the deposit back. */
  nfts: number;
  paid: bigint;
  refund: bigint;
}

// ───────────────────────────── client ─────────────────────────────

export class CloakDrops {
  constructor(
    readonly publicClient: PublicClient,
    readonly walletClient: Wallet | undefined,
    readonly factory: Address,
    /** First block to read the factory's and drops' events from. */
    readonly fromBlock = 0n,
  ) {}

  /** Many reads in one multicall where the chain has multicall3, else one by one (a local chain). */
  private async reads(contracts: readonly { address: Address; abi: unknown; functionName: string; args?: readonly unknown[] }[]): Promise<unknown[]> {
    if (!contracts.length) return [];
    if (this.publicClient.chain?.contracts?.multicall3) return this.publicClient.multicall({ contracts: contracts as never, allowFailure: false }) as Promise<unknown[]>;
    return Promise.all(contracts.map((c) => this.publicClient.readContract(c as never)));
  }

  private wallet(): Wallet {
    if (!this.walletClient) throw new Error("CloakDrops: a walletClient is required for this call");
    return this.walletClient;
  }

  private async send(hash: Hex) {
    const r = await this.publicClient.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`transaction reverted: ${hash}`);
    return r;
  }

  /** Every drop the factory made, newest last. */
  async list(): Promise<Address[]> {
    const n = Number(await this.publicClient.readContract({ address: this.factory, abi: cloakDropFactoryAbi, functionName: "dropsCount" }));
    if (!n) return [];
    return (await this.reads(Array.from({ length: n }, (_, i) => ({ address: this.factory, abi: cloakDropFactoryAbi, functionName: "drops", args: [BigInt(i)] })))) as Address[];
  }

  /** Create a drop. The caller is its creator. Returns the drop's address. */
  async create(o: CreateDropOptions): Promise<{ drop: Address; txHash: Hex }> {
    const w = this.wallet();
    if (!o.name.trim() || o.name.length > 64 || !o.symbol.trim() || o.symbol.length > 16) throw new Error("Give the collection a name (up to 64 characters) and a symbol (up to 16).");
    if (!Number.isInteger(o.supply) || o.supply < 1 || o.supply > DROP_MAX_SUPPLY) throw new Error(`Supply is 1 to ${DROP_MAX_SUPPLY}.`);
    if (o.floor <= 0n) throw new Error("Set a price above zero.");
    const boost = o.wl?.boostBps ?? 0;
    if (boost < 0 || boost > DROP_MAX_BOOST_BPS) throw new Error("The WL boost is 0% to 30%.");
    if ((o.gtd?.list.length ?? 0) > DROP_LIST_MAX || (o.wl?.list.length ?? 0) > DROP_LIST_MAX) throw new Error(`A list holds up to ${DROP_LIST_MAX} wallets.`);
    const gtdList = (o.gtd?.list ?? []).map((e) => ({ wallet: getAddress(e.wallet), spots: e.spots }));
    const wlList = (o.wl?.list ?? []).map((a) => getAddress(a));
    for (const e of gtdList) if (!Number.isInteger(e.spots) || e.spots < 1) throw new Error(`Give ${e.wallet} at least one GTD spot.`);
    const gtdSpots = gtdList.reduce((a, e) => a + e.spots, 0);
    if (gtdSpots > o.supply) throw new Error("There are more GTD spots than NFTs.");

    const now = Number((await this.publicClient.getBlock()).timestamp);
    const gtdEnd = now + 90 + (gtdList.length ? o.gtd!.durationSecs : 0);
    const commitEnd = gtdEnd + o.biddingSecs;
    const tlockRound = drandRoundAt(commitEnd);
    const revealEnd = Math.max(commitEnd + (o.revealSecs ?? 180), drandRoundTime(tlockRound) + 60);
    const params = {
      creator: w.account.address,
      supply: o.supply,
      maxPerBid: o.maxPerBid ?? 2,
      numTicks: o.numTicks ?? 200,
      wlBoostBps: wlList.length ? boost : 0,
      royaltyBps: o.royaltyBps ?? 500,
      gtdEnd: BigInt(gtdEnd),
      commitEnd: BigInt(commitEnd),
      revealEnd: BigInt(revealEnd),
      tlockRound: BigInt(tlockRound),
      floor: o.floor,
      tickSize: o.tickSize ?? (o.floor / 20n || 1n),
      gtdPrice: o.gtd?.price ?? 0n,
      gtdRoot: merkleTree(gtdList.map((e) => gtdLeaf(e.wallet, e.spots))).root,
      wlRoot: merkleTree(wlList.map(wlLeaf)).root,
    };
    const details: DropDetails & { v: 1 } = { v: 1, ...(o.image ? { image: o.image } : {}), ...(o.description ? { description: o.description.slice(0, 1000) } : {}), ...(gtdList.length ? { gtd: gtdList } : {}), ...(wlList.length ? { wl: wlList } : {}), ...(o.spots ? { spots: { partner: o.spots.partner.slice(0, 200) } } : {}) };
    const { result, request } = await this.publicClient.simulateContract({
      address: this.factory,
      abi: cloakDropFactoryAbi,
      functionName: "createDrop",
      args: [params, o.name.trim(), o.symbol.trim(), o.baseURI.trim(), JSON.stringify(details)],
      account: w.account,
    });
    const txHash = await w.writeContract(request);
    await this.send(txHash);
    return { drop: result, txHash };
  }

  /** A drop's published details: its image, description and the lists behind its roots. */
  async details(drop: Address): Promise<DropDetails> {
    const logs = await this.publicClient.getContractEvents({ address: this.factory, abi: cloakDropFactoryAbi, eventName: "DropDetails", args: { drop }, fromBlock: this.fromBlock, strict: true });
    try {
      const d = JSON.parse(logs[0]?.args.details ?? "{}");
      return {
        image: typeof d.image === "string" ? d.image : undefined,
        description: typeof d.description === "string" ? d.description : undefined,
        gtd: Array.isArray(d.gtd) ? d.gtd.filter((e: GtdEntry) => isAddress(e?.wallet) && Number.isInteger(e?.spots)) : undefined,
        wl: Array.isArray(d.wl) ? d.wl.filter((a: string) => isAddress(a)) : undefined,
        spots: typeof d.spots?.partner === "string" ? { partner: d.spots.partner } : undefined,
      };
    } catch {
      return {};
    }
  }

  async get(drop: Address): Promise<DropState> {
    const c = { address: drop, abi: cloakDropAbi } as const;
    const fn = ["params", "name", "symbol", "baseURI", "phase", "bidsCount", "revealCount", "gtdMinted", "auctionSupply", "totalSupply", "settled", "failed", "sold", "clearingScore", "tieSupply", "tieDemand"] as const;
    const r = await this.reads(fn.map((f) => ({ ...c, functionName: f })));
    const p = r[0] as { creator: Address; supply: number; maxPerBid: number; numTicks: number; wlBoostBps: number; royaltyBps: number; gtdEnd: bigint; commitEnd: bigint; revealEnd: bigint; tlockRound: bigint; floor: bigint; tickSize: bigint; gtdPrice: bigint; gtdRoot: Hex; wlRoot: Hex };
    const settled = r[10] as boolean;
    const clearing = r[13] as bigint;
    const zero = `0x${"0".repeat(64)}`;
    const publicPrice = settled ? (clearing + DROP_BPS - 1n) / DROP_BPS : 0n;
    let wlPrice = settled ? (clearing + DROP_BPS + BigInt(p.wlBoostBps) - 1n) / (DROP_BPS + BigInt(p.wlBoostBps)) : 0n;
    if (settled && wlPrice < p.floor) wlPrice = p.floor;
    return {
      address: drop,
      name: r[1] as string,
      symbol: r[2] as string,
      baseURI: r[3] as string,
      creator: p.creator,
      supply: p.supply,
      maxPerBid: p.maxPerBid,
      numTicks: p.numTicks,
      wlBoostBps: p.wlBoostBps,
      royaltyBps: p.royaltyBps,
      gtdEnd: Number(p.gtdEnd),
      commitEnd: Number(p.commitEnd),
      revealEnd: Number(p.revealEnd),
      tlockRound: Number(p.tlockRound),
      floor: p.floor,
      tickSize: p.tickSize,
      gtdPrice: p.gtdPrice,
      hasGtd: p.gtdRoot !== zero,
      hasWl: p.wlRoot !== zero,
      phase: PHASES[Number(r[4])],
      bids: Number(r[5]),
      reveals: Number(r[6]),
      gtdMinted: Number(r[7]),
      auctionSupply: Number(r[8]),
      minted: Number(r[9]),
      settled,
      failed: r[11] as boolean,
      sold: Number(r[12]),
      publicPrice,
      wlPrice,
      tieSupply: Number(r[14]),
      tieDemand: Number(r[15]),
    };
  }

  /** The bid level for a price: the highest level at or below it (bids snap down, never up). */
  static tickFor(s: Pick<DropState, "floor" | "tickSize" | "numTicks">, price: bigint): number {
    if (price < s.floor) throw new Error("Bid at least the creator's price.");
    const t = s.tickSize > 0n ? Number((price - s.floor) / s.tickSize) : 0;
    return Math.min(t, s.numTicks - 1);
  }

  static priceAt(s: Pick<DropState, "floor" | "tickSize">, tick: number): bigint {
    return s.floor + BigInt(tick) * s.tickSize;
  }

  /** Whether a wallet is on a drop's WL or GTD list (and with how many GTD spots). */
  async listed(drop: Address, wallet: Address): Promise<{ wl: boolean; gtdSpots: number; gtdMinted: number }> {
    const d = await this.details(drop);
    const me = wallet.toLowerCase();
    const gtd = d.gtd?.find((e) => e.wallet.toLowerCase() === me);
    const gtdMinted = gtd ? Number(await this.publicClient.readContract({ address: drop, abi: cloakDropAbi, functionName: "gtdMintedBy", args: [wallet] })) : 0;
    return { wl: !!d.wl?.some((a) => a.toLowerCase() === me), gtdSpots: gtd?.spots ?? 0, gtdMinted };
  }

  /** Mint GTD spots from the listed wallet (the connected one). */
  async gtdMint(drop: Address, quantity: number): Promise<Hex> {
    const w = this.wallet();
    const [s, d] = await Promise.all([this.get(drop), this.details(drop)]);
    const me = w.account.address;
    const entry = d.gtd?.find((e) => e.wallet.toLowerCase() === me.toLowerCase());
    if (!entry) throw new Error("This wallet isn't on the GTD list.");
    const tree = merkleTree((d.gtd ?? []).map((e) => gtdLeaf(getAddress(e.wallet), e.spots)));
    const leaf = gtdLeaf(getAddress(entry.wallet), entry.spots);
    const hash = await w.writeContract({ address: drop, abi: cloakDropAbi, functionName: "gtdMint", args: [entry.spots, tree.proof(leaf), quantity], value: s.gtdPrice * BigInt(quantity) });
    await this.send(hash);
    return hash;
  }

  /**
   * Place a sealed bid: `quantity` NFTs at up to `price` wei each. The bid is encrypted to the drop's drand round, so
   * nobody can read it before bidding closes; the keeper opens it then. A WL bid must come from the listed wallet.
   * `deposit` may be more than the bid needs (the rest comes back), which hides the bid's size from the deposit.
   */
  async bid(drop: Address, o: { price: bigint; quantity: number; wl?: boolean; deposit?: bigint }): Promise<{ id: bigint; txHash: Hex; tick: number; salt: Hex }> {
    const w = this.wallet();
    const s = await this.get(drop);
    if (s.phase !== "bidding") throw new Error(s.phase === "gtd" ? "Bidding opens when the GTD window closes." : "Bidding has closed.");
    if (!Number.isInteger(o.quantity) || o.quantity < 1 || o.quantity > s.maxPerBid) throw new Error(`Bid for 1 to ${s.maxPerBid} NFTs.`);
    const tick = CloakDrops.tickFor(s, o.price);
    const cost = CloakDrops.priceAt(s, tick) * BigInt(o.quantity);
    const deposit = o.deposit ?? cost;
    if (deposit < cost) throw new Error("The deposit must cover the bid.");
    let proof: Hex[] = [];
    if (o.wl) {
      const d = await this.details(drop);
      const list = (d.wl ?? []).map((a) => getAddress(a));
      if (!list.some((a) => a.toLowerCase() === w.account.address.toLowerCase())) throw new Error("This wallet isn't on the WL.");
      proof = merkleTree(list.map(wlLeaf)).proof(wlLeaf(w.account.address));
    }
    const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const quantity = BigInt(o.quantity);
    const commitment = commitmentOf(drop, w.account.address, tick, quantity, salt);
    const sealed = await sealBid({ auction: drop, bidder: w.account.address, tick, quantity, salt }, s.tlockRound);
    const { result, request } = await this.publicClient.simulateContract({ address: drop, abi: cloakDropAbi, functionName: "commit", args: [commitment, sealed, !!o.wl, proof], value: deposit, account: w.account });
    const txHash = await w.writeContract(request);
    await this.send(txHash);
    return { id: result, txHash, tick, salt };
  }

  async committedLogs(drop: Address) {
    const latest = await this.publicClient.getBlockNumber({ cacheTime: 0 });
    const get = (from: bigint, to: bigint) => this.publicClient.getContractEvents({ address: drop, abi: cloakDropAbi, eventName: "Committed", strict: true, fromBlock: from, toBlock: to });
    try {
      return await get(this.fromBlock, latest);
    } catch {
      const out: Awaited<ReturnType<typeof get>> = [];
      for (let from = this.fromBlock; from <= latest; from += 10_000n) out.push(...(await get(from, from + 9_999n > latest ? latest : from + 9_999n)));
      return out;
    }
  }

  /** Every bid on a drop (or one bidder's), with what it won once settled. */
  async bids(drop: Address, bidder?: Address): Promise<DropBid[]> {
    const [s, n] = await Promise.all([this.get(drop), this.publicClient.readContract({ address: drop, abi: cloakDropAbi, functionName: "bidsCount" })]);
    if (!n) return [];
    const ids = Array.from({ length: Number(n) }, (_, i) => BigInt(i));
    const raw = (await this.reads(ids.map((id) => ({ address: drop, abi: cloakDropAbi, functionName: "getBid", args: [id] })))) as { bidder: Address; wl: boolean; revealed: boolean; claimed: boolean; tick: number; quantity: number; deposit: bigint }[];
    const ready = s.settled && (s.tieSupply === 0 || s.phase === "settled");
    const alloc = ready ? await this.reads(ids.map((id) => ({ address: drop, abi: cloakDropAbi, functionName: "allocationOf", args: [id] }))) : [];
    return raw
      .map((b, i) => {
        const a = alloc[i] as readonly [number, bigint, bigint, bigint] | undefined;
        return { id: ids[i], bidder: b.bidder, wl: b.wl, revealed: b.revealed, claimed: b.claimed, tick: b.tick, price: CloakDrops.priceAt(s, b.tick), quantity: b.quantity, deposit: b.deposit, nfts: a ? Number(a[0]) : 0, paid: a?.[1] ?? 0n, refund: a?.[2] ?? 0n };
      })
      .filter((b) => !bidder || b.bidder.toLowerCase() === bidder.toLowerCase());
  }

  // ── what the keeper (or anyone) runs ──

  /** Open every sealed bid whose drand round has passed. Garbage ciphertexts are skipped (and penalised at claim). */
  async revealAll(drop: Address, opts: { batchSize?: number; log?: (m: string) => void } = {}) {
    const log = opts.log ?? (() => {});
    const logs = await this.committedLogs(drop);
    const reveals: { id: bigint; tick: number; quantity: bigint; salt: Hex }[] = [];
    for (const l of logs) {
      const b = await this.publicClient.readContract({ address: drop, abi: cloakDropAbi, functionName: "getBid", args: [l.args.id] });
      if (b.revealed) continue;
      try {
        const p = await unsealBid(l.args.sealedBid);
        if (p.auction.toLowerCase() !== drop.toLowerCase()) throw new Error("sealed for another drop");
        if (commitmentOf(drop, b.bidder, p.tick, p.quantity, p.salt) !== b.commitment) throw new Error("ciphertext does not match commitment");
        reveals.push({ id: l.args.id, tick: p.tick, quantity: p.quantity, salt: p.salt });
      } catch (e) {
        log(`bid #${l.args.id}: cannot unseal (${(e as Error).message})`);
      }
    }
    const size = opts.batchSize ?? 40;
    for (let i = 0; i < reveals.length; i += size) {
      await this.send(await this.wallet().writeContract({ address: drop, abi: cloakDropAbi, functionName: "revealBatch", args: [reveals.slice(i, i + size)] }));
      log(`revealed ${Math.min(i + size, reveals.length)}/${reveals.length}`);
    }
    return { revealed: reveals.length };
  }

  /** Settle, then number the tied bids (if any) so claims can start. */
  async settle(drop: Address, opts: { tieBatch?: number } = {}): Promise<Hex[]> {
    const c = { address: drop, abi: cloakDropAbi } as const;
    const txs: Hex[] = [];
    if (!(await this.publicClient.readContract({ ...c, functionName: "settled" }))) {
      const h = await this.wallet().writeContract({ ...c, functionName: "settle" });
      await this.send(h);
      txs.push(h);
    }
    while ((await this.get(drop)).phase === "numbering") {
      const h = await this.wallet().writeContract({ ...c, functionName: "numberTies", args: [BigInt(opts.tieBatch ?? 400)] });
      await this.send(h);
      txs.push(h);
    }
    return txs;
  }

  /** Deliver every unclaimed bid (NFTs and refunds always go to the bidder, never the caller). */
  async claimAll(drop: Address, opts: { batchSize?: number } = {}) {
    const ids = (await this.bids(drop)).filter((b) => !b.claimed).map((b) => b.id);
    const size = opts.batchSize ?? 25;
    for (let i = 0; i < ids.length; i += size) await this.send(await this.wallet().writeContract({ address: drop, abi: cloakDropAbi, functionName: "claimBatch", args: [ids.slice(i, i + size)] }));
    return { claimed: ids.length };
  }

  /** The bidder takes its NFTs to another address (a fresh wallet, say); the refund still goes to the bidder. */
  async claimTo(drop: Address, id: bigint, to: Address): Promise<Hex> {
    const h = await this.wallet().writeContract({ address: drop, abi: cloakDropAbi, functionName: "claimTo", args: [id, to] });
    await this.send(h);
    return h;
  }

  /** Pay out the creator's proceeds and the protocol fee (anyone can call; the destinations are fixed). */
  async payOut(drop: Address): Promise<Hex[]> {
    const c = { address: drop, abi: cloakDropAbi } as const;
    const [owed, fees] = await Promise.all([this.publicClient.readContract({ ...c, functionName: "creatorOwed" }), this.publicClient.readContract({ ...c, functionName: "feesOwed" })]);
    const txs: Hex[] = [];
    if (owed > 0n) {
      const h = await this.wallet().writeContract({ ...c, functionName: "withdrawProceeds" });
      await this.send(h);
      txs.push(h);
    }
    if (fees > 0n) {
      try {
        await this.publicClient.simulateContract({ ...c, functionName: "collectFees", account: this.wallet().account });
        const h = await this.wallet().writeContract({ ...c, functionName: "collectFees" });
        await this.send(h);
        txs.push(h);
      } catch {}
    }
    return txs;
  }

  /** The creator mints what nobody bought (or all of it, if the drop failed). */
  async mintUnsold(drop: Address, to: Address, quantity: number): Promise<Hex> {
    const h = await this.wallet().writeContract({ address: drop, abi: cloakDropAbi, functionName: "mintUnsold", args: [to, quantity] });
    await this.send(h);
    return h;
  }
}
