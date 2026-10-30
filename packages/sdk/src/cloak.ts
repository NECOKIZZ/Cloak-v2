import {
  zeroAddress,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
  encodeAbiParameters,
  keccak256,
  parseEventLogs,
  toHex,
} from "viem";
import { cloakAuctionAbi, cloakFactoryAbi, cloakPairAbi, cloakTokenAbi } from "./abis.js";
import { type BidPreimage, drandRoundAt, sealBid, unsealBid } from "./seal.js";

const WAD = 10n ** 18n;

export type Wallet = WalletClient<Transport, Chain, Account>;

export interface LaunchParams {
  name: string;
  symbol: string;
  /** Tokens sold in the auction (18 decimals). */
  saleSupply: bigint;
  /** Tokens paired with HYPE at the clearing price. Defaults to `saleSupply`. */
  lpReserve?: bigint;
  /** Creator share, at most 20% of the supply. It vests linearly from the end of the auction. */
  creatorAlloc?: bigint;
  /** Vesting length for the creator share, in seconds (at least 30 days; default 90 days). */
  creatorVestSecs?: number;
  /** Wei of HYPE per whole token at the lowest tick. */
  minPrice: bigint;
  tickSize: bigint;
  numTicks?: number;
  /** Unix seconds. */
  commitEnd: number;
  revealEnd: number;
  /** Share of the raise that seeds the pool, in bps (default 5000). */
  lpBps?: number;
  /** Unix seconds until LP shares can be released to the creator; 0 / "burn" burns them (default). */
  lpLockUntil?: number | "burn";
  noRevealPenaltyBps?: number;
  creator?: Address;
  metadataURI?: string;
}

export interface AuctionState {
  address: Address;
  token: Address;
  creator: Address;
  saleSupply: bigint;
  lpReserve: bigint;
  minPrice: bigint;
  tickSize: bigint;
  numTicks: number;
  commitEnd: number;
  revealEnd: number;
  lpBps: number;
  noRevealPenaltyBps: number;
  lpLockUntil: number;
  tlockRound: number;
  phase: "commit" | "reveal" | "settle" | "settled";
  commits: number;
  reveals: number;
  totalDeposits: bigint;
  totalDemand: bigint;
  settled: boolean;
  failed: boolean;
  clearingTick: number;
  clearingPrice: bigint;
  sold: bigint;
  raised: bigint;
  pair: Address;
  tokenName: string;
  tokenSymbol: string;
  /** Launch fee on a successful raise, fixed when the auction was created. */
  launchFeeBps: number;
  /** HYPE caps fixed at creation (0 = none): per bid deposit, and in total. */
  bidCap: bigint;
  depositCap: bigint;
  /** Settled money waiting to be pulled: the creator's proceeds and the protocol's launch fee. */
  creatorOwed: bigint;
  feesOwed: bigint;
}

/** Everything a bidder must keep to reveal manually; auto-reveal makes losing it harmless. */
export interface BidSecret extends BidPreimage {
  id: bigint;
  deposit: bigint;
  commitment: Hex;
  txHash: Hex;
}

export interface BidQuote {
  tick: number;
  price: bigint;
  cost: bigint;
  deposit: bigint;
}

const PHASES = ["commit", "reveal", "settle", "settled"] as const;

/**
 * Budget buckets: deposits are rounded up to 1, 2 or 5 × 10ⁿ wei, so the deposit only reveals the bid's order of
 * magnitude (every bid within ~2.5× of another looks the same) at any price scale.
 */
export function budgetBuckets(atLeast: bigint, count = 8): bigint[] {
  const out: bigint[] = [];
  let b = bucketDeposit(atLeast > 0n ? atLeast : 1n);
  while (out.length < count) {
    out.push(b);
    b = nextBucket(b);
  }
  return out;
}

function nextBucket(b: bigint): bigint {
  const s = b.toString();
  const lead = s[0];
  const pow = 10n ** BigInt(s.length - 1);
  return lead === "1" ? 2n * pow : lead === "2" ? 5n * pow : 10n * pow;
}

export function commitmentOf(auction: Address, bidder: Address, tick: number, quantity: bigint, salt: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint16" }, { type: "uint128" }, { type: "bytes32" }],
      [auction, bidder, tick, quantity, salt],
    ),
  );
}

export function randomSalt(): Hex {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return toHex(b);
}

/** Round a required deposit up to the next 1/2/5 × 10ⁿ bucket. */
export function bucketDeposit(cost: bigint): bigint {
  if (cost <= 1n) return 1n;
  const pow = 10n ** BigInt(cost.toString().length - 1);
  for (const m of [1n, 2n, 5n, 10n]) if (m * pow >= cost) return m * pow;
  return 10n * pow;
}

/** `launches(i)` of the first CloakFactory (five fields, no vesting). */
const LEGACY_LAUNCHES_ABI = [
  {
    type: "function",
    name: "launches",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [
      { name: "auction", type: "address" },
      { name: "token", type: "address" },
      { name: "creator", type: "address" },
      { name: "launchpad", type: "address" },
      { name: "creatorAlloc", type: "uint256" },
    ],
  },
] as const;

export class Cloak {
  constructor(
    readonly publicClient: PublicClient,
    readonly walletClient?: Wallet,
    readonly factory?: Address,
    /** Earlier deployments' factories (newest first), so their launches still list and settle. */
    readonly legacyFactory?: Address | readonly Address[],
  ) {}

  private get legacyFactories(): readonly Address[] {
    return this.legacyFactory === undefined ? [] : typeof this.legacyFactory === "string" ? [this.legacyFactory] : this.legacyFactory;
  }

  private wallet(): Wallet {
    if (!this.walletClient) throw new Error("Cloak: a walletClient is required for this call");
    return this.walletClient;
  }

  private async send(hash: Hex) {
    const r = await this.publicClient.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`transaction reverted: ${hash}`);
    return r;
  }

  // ───────────── launchpad side ─────────────

  async createLaunch(p: LaunchParams): Promise<{ auction: Address; token: Address; txHash: Hex; block: bigint }> {
    if (!this.factory) throw new Error("Cloak: factory address required");
    const w = this.wallet();
    const lock = p.lpLockUntil === undefined || p.lpLockUntil === "burn" ? 0 : p.lpLockUntil;
    const params = {
      creator: p.creator ?? w.account.address,
      saleSupply: p.saleSupply,
      lpReserve: p.lpReserve ?? p.saleSupply,
      minPrice: p.minPrice,
      tickSize: p.tickSize,
      numTicks: p.numTicks ?? 100,
      commitEnd: BigInt(p.commitEnd),
      revealEnd: BigInt(p.revealEnd),
      lpBps: p.lpBps ?? 5000,
      noRevealPenaltyBps: p.noRevealPenaltyBps ?? 1000,
      lpLockUntil: BigInt(lock),
      tlockRound: BigInt(drandRoundAt(p.commitEnd)),
    };
    const txHash = await w.writeContract({
      address: this.factory,
      abi: cloakFactoryAbi,
      functionName: "createLaunch",
      args: [p.name, p.symbol, p.creatorAlloc ?? 0n, BigInt(p.creatorAlloc ? (p.creatorVestSecs ?? 90 * 86400) : 0), params, p.metadataURI ?? ""],
    });
    const r = await this.send(txHash);
    const [ev] = parseEventLogs({ abi: cloakFactoryAbi, logs: r.logs, eventName: "LaunchCreated" });
    return { auction: ev.args.auction, token: ev.args.token, txHash, block: r.blockNumber };
  }

  /**
   * Every launch, newest factory first. Launches from the `legacyFactory` list (earlier deployments) are included with
   * `legacy: true`; the first deployment's have no vesting contract.
   */
  async listLaunches(): Promise<{ auction: Address; token: Address; creator: Address; launchpad: Address; creatorAlloc: bigint; vesting: Address; factory: Address; legacy?: boolean }[]> {
    if (!this.factory) throw new Error("Cloak: factory address required");
    const legacy = [];
    for (const f of this.legacyFactories) legacy.push(...(await this.listLegacy(f)));
    return [...(await this.listCurrent()), ...legacy];
  }

  private async listLegacy(factory: Address) {
    const n = await this.publicClient.readContract({ address: factory, abi: cloakFactoryAbi, functionName: "launchesCount" });
    const out = [];
    for (let i = 0n; i < n; i++) {
      // a factory from v2 on returns a vesting contract too; the first one returns five fields
      const six = await this.publicClient.readContract({ address: factory, abi: cloakFactoryAbi, functionName: "launches", args: [i] }).catch(() => null);
      const [auction, token, creator, launchpad, creatorAlloc] =
        six ?? (await this.publicClient.readContract({ address: factory, abi: LEGACY_LAUNCHES_ABI, functionName: "launches", args: [i] }));
      out.push({ auction, token, creator, launchpad, creatorAlloc, vesting: (six?.[5] ?? zeroAddress) as Address, factory, legacy: true });
    }
    return out;
  }

  private async listCurrent() {
    if (!this.factory) throw new Error("Cloak: factory address required");
    const n = await this.publicClient.readContract({
      address: this.factory,
      abi: cloakFactoryAbi,
      functionName: "launchesCount",
    });
    const out = [];
    for (let i = 0n; i < n; i++) {
      const [auction, token, creator, launchpad, creatorAlloc, vesting] = await this.publicClient.readContract({
        address: this.factory,
        abi: cloakFactoryAbi,
        functionName: "launches",
        args: [i],
      });
      out.push({ auction, token, creator, launchpad, creatorAlloc, vesting, factory: this.factory });
    }
    return out;
  }

  // ───────────── reads ─────────────

  async getAuction(auction: Address): Promise<AuctionState> {
    const c = { address: auction, abi: cloakAuctionAbi } as const;
    const r = this.publicClient;
    const [params, token, phase, commits, reveals, totalDeposits, totalDemand, settled, failed, clearingTick, clearingPrice, sold, raised, pair, launchFeeBps, bidCap, depositCap, creatorOwed, feesOwed] =
      await Promise.all([
        r.readContract({ ...c, functionName: "params" }),
        r.readContract({ ...c, functionName: "token" }),
        r.readContract({ ...c, functionName: "phase" }),
        r.readContract({ ...c, functionName: "bidsCount" }),
        r.readContract({ ...c, functionName: "revealCount" }),
        r.readContract({ ...c, functionName: "totalDeposits" }),
        r.readContract({ ...c, functionName: "totalDemand" }),
        r.readContract({ ...c, functionName: "settled" }),
        r.readContract({ ...c, functionName: "failed" }),
        r.readContract({ ...c, functionName: "clearingTick" }),
        r.readContract({ ...c, functionName: "clearingPrice" }),
        r.readContract({ ...c, functionName: "sold" }),
        r.readContract({ ...c, functionName: "raised" }),
        r.readContract({ ...c, functionName: "pair" }),
        // not on first-deployment auctions
        r.readContract({ ...c, functionName: "launchFeeBps" }).catch(() => 0),
        r.readContract({ ...c, functionName: "bidCap" }).catch(() => 0n),
        r.readContract({ ...c, functionName: "depositCap" }).catch(() => 0n),
        r.readContract({ ...c, functionName: "creatorOwed" }).catch(() => 0n),
        r.readContract({ ...c, functionName: "feesOwed" }).catch(() => 0n),
      ]);
    const [creator, saleSupply, lpReserve, minPrice, tickSize, numTicks, commitEnd, revealEnd, lpBps, noRevealPenaltyBps, lpLockUntil, tlockRound] =
      params;
    const [tokenName, tokenSymbol] = await Promise.all([
      r.readContract({ address: token, abi: cloakTokenAbi, functionName: "name" }),
      r.readContract({ address: token, abi: cloakTokenAbi, functionName: "symbol" }),
    ]);
    return {
      address: auction,
      token,
      creator,
      saleSupply,
      lpReserve,
      minPrice,
      tickSize,
      numTicks,
      commitEnd: Number(commitEnd),
      revealEnd: Number(revealEnd),
      lpBps,
      noRevealPenaltyBps,
      lpLockUntil: Number(lpLockUntil),
      tlockRound: Number(tlockRound),
      phase: PHASES[phase],
      commits: Number(commits),
      reveals: Number(reveals),
      totalDeposits,
      totalDemand,
      settled,
      failed,
      clearingTick,
      clearingPrice,
      sold,
      raised,
      pair,
      tokenName,
      tokenSymbol,
      launchFeeBps,
      bidCap,
      depositCap,
      creatorOwed,
      feesOwed,
    };
  }

  /** Revealed demand per tick (empty until the reveal phase — that is the point). */
  async demandCurve(auction: Address): Promise<{ tick: number; price: bigint; demand: bigint }[]> {
    const s = await this.getAuction(auction);
    const curve = await this.publicClient.readContract({
      address: auction,
      abi: cloakAuctionAbi,
      functionName: "demandCurve",
    });
    return curve.map((d, t) => ({ tick: t, price: s.minPrice + BigInt(t) * s.tickSize, demand: d }));
  }

  async pairPrice(pair: Address): Promise<bigint> {
    return this.publicClient.readContract({ address: pair, abi: cloakPairAbi, functionName: "price" });
  }

  // ───────────── bidder side ─────────────

  /** Pick the tick for a max price (rounded down to a tick) and the bucketed deposit that hides the bid size. */
  quoteBid(s: Pick<AuctionState, "minPrice" | "tickSize" | "numTicks">, maxPrice: bigint, quantity: bigint): BidQuote {
    if (maxPrice < s.minPrice) throw new Error("max price is below the auction's minimum price");
    let tick = s.tickSize === 0n ? 0 : Number((maxPrice - s.minPrice) / s.tickSize);
    tick = Math.min(tick, s.numTicks - 1);
    const price = s.minPrice + BigInt(tick) * s.tickSize;
    const cost = (price * quantity + WAD - 1n) / WAD;
    return { tick, price, cost, deposit: bucketDeposit(cost) };
  }

  /**
   * Seal and commit a bid. Only a hash and a drand-timelocked ciphertext go on-chain, so neither the sequencer nor other
   * bidders learn the price or size. After commit closes, any keeper can decrypt and reveal it — no second visit needed.
   */
  async bid(
    auction: Address,
    opts: { maxPrice: bigint; quantity: bigint; deposit?: bigint },
  ): Promise<BidSecret> {
    const w = this.wallet();
    const s = await this.getAuction(auction);
    if (s.phase !== "commit") throw new Error("commit phase is over");
    const q = this.quoteBid(s, opts.maxPrice, opts.quantity);
    const deposit = opts.deposit ?? q.deposit;
    if (deposit < q.cost) throw new Error("deposit is below the bid's cost");
    const salt = randomSalt();
    const bidder = w.account.address;
    const commitment = commitmentOf(auction, bidder, q.tick, opts.quantity, salt);
    const sealed = await sealBid({ auction, bidder, tick: q.tick, quantity: opts.quantity, salt }, s.tlockRound);
    const txHash = await w.writeContract({
      address: auction,
      abi: cloakAuctionAbi,
      functionName: "commit",
      args: [commitment, sealed],
      value: deposit,
    });
    const r = await this.send(txHash);
    const [ev] = parseEventLogs({ abi: cloakAuctionAbi, logs: r.logs, eventName: "Committed" });
    return { id: ev.args.id, auction, bidder, tick: q.tick, quantity: opts.quantity, salt, deposit, commitment, txHash };
  }

  async reveal(secret: BidSecret): Promise<Hex> {
    const txHash = await this.wallet().writeContract({
      address: secret.auction,
      abi: cloakAuctionAbi,
      functionName: "reveal",
      args: [secret.id, secret.tick, secret.quantity, secret.salt],
    });
    await this.send(txHash);
    return txHash;
  }

  async settle(auction: Address): Promise<Hex> {
    const txHash = await this.wallet().writeContract({ address: auction, abi: cloakAuctionAbi, functionName: "settle" });
    await this.send(txHash);
    return txHash;
  }

  /** Pay out a settled launch's creator proceeds, and send its launch fee to the treasury (anyone can call either). */
  async payOut(auction: Address): Promise<Hex[]> {
    const s = await this.getAuction(auction);
    const out: Hex[] = [];
    for (const fn of [s.creatorOwed > 0n && "withdrawProceeds", s.feesOwed > 0n && "collectFees"] as const) {
      if (!fn) continue;
      const h = await this.wallet().writeContract({ address: auction, abi: cloakAuctionAbi, functionName: fn });
      await this.send(h);
      out.push(h);
    }
    return out;
  }

  async claim(auction: Address, ids: bigint[]): Promise<Hex> {
    const txHash = await this.wallet().writeContract({
      address: auction,
      abi: cloakAuctionAbi,
      functionName: "claimBatch",
      args: [ids],
    });
    await this.send(txHash);
    return txHash;
  }

  async bidsOf(auction: Address, bidder: Address, fromBlock = 0n) {
    const logs = await this.committedLogs(auction, fromBlock);
    const mine = logs.filter((l) => l.args.bidder.toLowerCase() === bidder.toLowerCase());
    return Promise.all(
      mine.map(async (l) => {
        const [bid, alloc] = await Promise.all([
          this.publicClient.readContract({ address: auction, abi: cloakAuctionAbi, functionName: "getBid", args: [l.args.id] }),
          this.publicClient.readContract({ address: auction, abi: cloakAuctionAbi, functionName: "allocationOf", args: [l.args.id] }),
        ]);
        return { id: l.args.id, ...bid, tokens: alloc[0], refund: alloc[1], penalty: alloc[2] };
      }),
    );
  }

  // ───────────── keeper side ─────────────

  async committedLogs(auction: Address, fromBlock = 0n) {
    const latest = await this.publicClient.getBlockNumber({ cacheTime: 0 });
    const get = (from: bigint, to: bigint) =>
      this.publicClient.getContractEvents({
        address: auction,
        abi: cloakAuctionAbi,
        eventName: "Committed",
        strict: true,
        fromBlock: from,
        toBlock: to,
      });
    try {
      return await get(fromBlock, latest);
    } catch {
      // RPCs that cap eth_getLogs ranges: walk in chunks
      const out: Awaited<ReturnType<typeof get>> = [];
      const step = 10_000n;
      for (let from = fromBlock; from <= latest; from += step) {
        const to = from + step - 1n > latest ? latest : from + step - 1n;
        out.push(...(await get(from, to)));
      }
      return out;
    }
  }

  /**
   * Decrypt every sealed bid whose drand round has passed and reveal them in batches. Anyone can run this — it needs no
   * key material, only the public beacon. Bids whose ciphertext is garbage are skipped (and get penalised at claim).
   */
  async revealAll(auction: Address, opts: { fromBlock?: bigint; batchSize?: number; log?: (m: string) => void } = {}) {
    const log = opts.log ?? (() => {});
    const logs = await this.committedLogs(auction, opts.fromBlock ?? 0n);
    const reveals: { id: bigint; tick: number; quantity: bigint; salt: Hex }[] = [];
    for (const l of logs) {
      const bid = await this.publicClient.readContract({
        address: auction,
        abi: cloakAuctionAbi,
        functionName: "getBid",
        args: [l.args.id],
      });
      if (bid.revealed) continue;
      try {
        const p = await unsealBid(l.args.sealedBid);
        if (p.auction.toLowerCase() !== auction.toLowerCase()) throw new Error("sealed for another auction");
        const expected = commitmentOf(auction, bid.bidder, p.tick, p.quantity, p.salt);
        if (expected !== bid.commitment) throw new Error("ciphertext does not match commitment");
        reveals.push({ id: l.args.id, tick: p.tick, quantity: p.quantity, salt: p.salt });
      } catch (e) {
        log(`bid #${l.args.id}: cannot unseal (${(e as Error).message})`);
      }
    }
    const size = opts.batchSize ?? 40;
    const txs: Hex[] = [];
    for (let i = 0; i < reveals.length; i += size) {
      const txHash = await this.wallet().writeContract({
        address: auction,
        abi: cloakAuctionAbi,
        functionName: "revealBatch",
        args: [reveals.slice(i, i + size)],
      });
      await this.send(txHash);
      txs.push(txHash);
      log(`revealed ${Math.min(i + size, reveals.length)}/${reveals.length}`);
    }
    return { revealed: reveals.length, txs };
  }

  /** Claim on behalf of every bidder (tokens and refunds always go to the bidder, never the caller). */
  async claimAll(auction: Address, opts: { fromBlock?: bigint; batchSize?: number } = {}) {
    const logs = await this.committedLogs(auction, opts.fromBlock ?? 0n);
    const ids: bigint[] = [];
    for (const l of logs) {
      const bid = await this.publicClient.readContract({
        address: auction,
        abi: cloakAuctionAbi,
        functionName: "getBid",
        args: [l.args.id],
      });
      if (!bid.claimed) ids.push(l.args.id);
    }
    const size = opts.batchSize ?? 40;
    const txs: Hex[] = [];
    for (let i = 0; i < ids.length; i += size) txs.push(await this.claim(auction, ids.slice(i, i + size)));
    return { claimed: ids.length, txs };
  }
}
