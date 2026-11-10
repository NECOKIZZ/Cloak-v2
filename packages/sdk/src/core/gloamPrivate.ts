/**
 * GloamPrivate: Cloak's private account on Gloam, with the same methods and return shapes the site's pages already call
 * on CloakPrivate, so the site keeps its pages and only its backend changes (one setting, `core: "gloam"`).
 *
 * Underneath are two GloamCores made from the same one wallet signature, so one private address (gloamr1.) receives in
 * both vaults:
 *   - Gloam's vault, the big shared crowd (HYPE and USDC once Gloam lists them, graduated tokens);
 *   - Cloak's launch vault (CloakLaunchVault, Gloam's code and keys), where launch tokens trade from the moment their
 *     launch settles.
 * Balances add up across both. A deposit goes to the launch vault when it takes the asset (so it can trade), else to
 * Gloam's. A send or a cash out draws from Gloam's vault first, then the launch vault.
 *
 * Pages pass a market's `pool` to the money methods. Here a market's pool is its asset (address 0 for HYPE): there is
 * no pool per token, so the pool id just names what to spend.
 *
 * What Gloam's design changes for the pages (shown by the same UI, with different numbers):
 *   - relayFee() is 0: Cloak's relay pays gas (from the launch vault's fee and its own budget);
 *   - afterFee() takes the vault's cash-out fee (0.5% on Elysium);
 *   - a payment received is "pending" until the next sync sweeps it into this account's own note.
 */
import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, toBytes, toHex, zeroAddress, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import * as gloam from "@gloamtrade/sdk";
import { privateKeyToAccount } from "viem/accounts";
import { ACCOUNT_TYPED_DATA } from "../private/crypto.js";
import { splitAmount, type ScheduledPiece, type Status } from "../private/common.js";
import { GloamCore, gloamKeysFromSignature, type GloamAccountKeys, type GloamCoreConfig, type OwnedGloamNote } from "./gloam.js";
import { announce, finishPending, hypeCoreOf, launchRoute, launchRouteV4, launchSwap, type LaunchRecord } from "./launchVault.js";
import { notesFor, type HolderProver } from "./gloamProofs.js";
import { gloamFundsContext, type FundsProof } from "../private/funds.js";

export interface GloamPrivateConfig {
  publicClient: PublicClient;
  chainId: number;
  /** Gloam's vault (or omit it until Gloam's vault is live on this chain). */
  gloamVault?: { pool: Address; poolBlock: bigint };
  /** Cloak's launch vault. */
  launchVault?: { pool: Address; poolBlock: bigint };
  /** Cloak's ecosystem vault (CloakEcosystemVault): admitted outside tokens such as KNTQ, traded through `router`. */
  ecosystemVault?: { pool: Address; poolBlock: bigint };
  payMemo: Address;
  provers: GloamCoreConfig["provers"];
  submit: GloamCoreConfig["submit"];
  /** WHYPE: the token the pages use for HYPE (hypeMarket.token). */
  whype: Address;
  /** CloakLaunchSwap and the Uniswap V2 factory it trades through. */
  launchSwap?: Address;
  /**
   * CloakLaunchSwapV4: private swaps through Cloak launches' own Uniswap v4 pools (their CloakV4Market). When set, a
   * launch token's market is its auction's market, quoted and routed through it; launchSwap (V2) is the fallback.
   */
  launchSwapV4?: Address;
  /**
   * CloakRouterV4: when set, HYPE lives in Gloam's vault and launch tokens in the launch vault. A buy spends HYPE from
   * Gloam's vault and lands the token in the launch vault; a sell does the reverse.
   */
  router?: Address;
  /**
   * Uniswap v4's PoolManager: plain pools' prices are read from it (USDC's HYPE pool, outside tokens' pools). Without
   * it they're read through the ecosystem vault's poolState().
   */
  poolManager?: Address;
  /** CloakGloamBatcher on the launch vault (rounds through Uniswap V2 pairs). */
  batcher?: Address;
  /** CloakGloamBatcherV4 on the launch vault: rounds through launches' own v4 pools (their CloakV4Market). */
  batcherV4?: Address;
  /** CloakGloamReceive: receive addresses anyone can pay, moved into the private balance by the app. */
  receive?: Address;
  /** CloakGloamBids on the launch vault: sealed bids paid from the private balance. */
  bids?: Address;
  /** Sweep received payments on every sync (default true). Tools that read without sending turn it off and sweep with syncAll({ sweep: true }). */
  autoSweep?: boolean;
  /** A claim link's account: spend received payments directly, never sweep them (see GloamCoreConfig). */
  spendReceived?: boolean;
  /**
   * Where this device keeps, per vault, notes made but not yet seen in the vault and memos not yet posted (no secrets,
   * see GloamCoreConfig.pendingStore). Without it they're kept for this session only.
   */
  pendingStore?: (vault: Address) => { load(): string | null; save(s: string): void };
  /** Where the app keeps per-action records for finishPending (a swap's leftover, a graduation). */
  records?: { load(): LaunchRecord[]; save(r: LaunchRecord[]): void };
  logChunk?: bigint;
}

/** The market shape the pages read (CloakPrivate's PrivateMarket). */
export interface GloamMarket {
  token: Address;
  pool: Address;
  pair: Address | null;
  symbol?: string;
  decimals?: number;
  /** traded through its launch's Uniswap v4 pool (pair is the CloakV4Market) */
  v4?: boolean;
  /** an outside token in the ecosystem vault, traded through this plain native-HYPE v4 pool (via the router) */
  ecoKey?: PoolKeyV4;
  /** an asset in Gloam's vault (USDC) with a plain native-HYPE v4 pool, traded through the router */
  hypeKey?: PoolKeyV4;
}

/** A Uniswap v4 pool key. */
export type PoolKeyV4 = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };

const EXTSLOAD = parseAbi(["function extsload(bytes32 slot) view returns (bytes32)"]);
const POOL_KEY_TYPE = [{ type: "tuple", components: [{ name: "currency0", type: "address" }, { name: "currency1", type: "address" }, { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" }] }] as const;

const ECO = parseAbi([
  "function ecosystemTokensCount() view returns (uint256)",
  "function ecosystemTokens(uint256) view returns (address)",
  "function poolKeyOf(address) view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks))",
  "function poolState((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key) view returns (uint160 sqrtPriceX96, uint128 liquidity)",
]);

const ERC20 = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);
const VAULT = parseAbi(["function withdrawFeeBps() view returns (uint16)", "function launchTokensCount() view returns (uint256)", "function launchTokens(uint256) view returns (address)"]);
const V2 = parseAbi(["function factory() view returns (address)", "function getPair(address, address) view returns (address)", "function token0() view returns (address)", "function getReserves() view returns (uint112, uint112, uint32)"]);
/** CloakRouterV4's trade fee: what it adds on top of a note of `amountOut` (0 for buys and earlier routers). */
const TRADE_FEE = [{ type: "function", name: "tradeFee", stateMutability: "view", inputs: [{ name: "assetIn", type: "address" }, { name: "assetOut", type: "address" }, { name: "amountOut", type: "uint256" }], outputs: [{ name: "fee", type: "uint256" }, { name: "to", type: "address" }] }] as const;

const V4MARKET = parseAbi([
  "function reserveHype() view returns (uint256)",
  "function reserveToken() view returns (uint256)",
  "function getAmountOut(uint256 amountIn, uint256 rIn, uint256 rOut) view returns (uint256)",
  "function key() view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks))",
]);
const RECEIVE = parseAbi([
  "function boxOf(address ownerKey, uint256 n) view returns (address)",
  "function shieldDigest(address box, address vault, address asset, uint256 amount, bytes32 commitment) view returns (bytes32)",
  "function shield(address ownerKey, uint256 n, address vault, address asset, uint256 amount, bytes32 commitment, bytes proof, bytes signature)",
]);
const BATCH = parseAbi([
  "function place((bytes proof, bytes32 root, bytes32 nullifier, address asset, uint256 amount) s, (bytes32 nullifier, address token, bool buy, uint128 size, address ownerKey, address fallbackTo) k) returns (bytes32)",
  "function escrowFor((bytes32 nullifier, address token, bool buy, uint128 size, address ownerKey, address fallbackTo) k) view returns (address)",
  "function currentRound() view returns (uint64)",
  "function roundSecs() view returns (uint256)",
  "function marketOf(address) view returns (address)",
  "function orders(bytes32) view returns (address token, uint64 round, bool buy, bool paid, uint128 net)",
  "function batches(address, uint64) view returns (uint128 buyHype, uint128 sellTokens, uint128 tokensForBuyers, uint128 hypeForSellers, uint256 spotStart, uint64 settledAt, bool settled, bool cancelled, uint256 cumStart, uint64 tStart)",
]);

const UNSHIELD = parseAbi(["function unshield(bytes proof, bytes32 root, bytes32 nullifier, address asset, address to, uint256 amount)"]);

const lc = (a: string) => a.toLowerCase();
const NOT_YET = "This part of Cloak isn't on the new private layer yet. It's coming soon.";

/** 1, 2 or 5 times a power of ten, largest first, at most `max` of them, adding up to at most `amount`. */
function standardSizes(amount: bigint, max: number): { sizes: bigint[]; rest: bigint } {
  const sizes: bigint[] = [];
  let rest = amount;
  while (sizes.length < max && rest > 0n) {
    let p = 1n;
    while (p * 10n <= rest) p *= 10n;
    const s = rest >= 5n * p ? 5n * p : rest >= 2n * p ? 2n * p : p;
    sizes.push(s);
    rest -= s;
  }
  return { sizes, rest };
}

/**
 * Standard sizes that the notes actually held can pay, one note per order (Gloam spends one note in). Each order is
 * the largest standard size that fits both what's left to place and the largest note, and the notes are then used the
 * way GloamCore.exactNote uses them (an exact note if there is one, else split from the largest). So an amount spread
 * over many notes still goes in, as more, smaller orders.
 */
/** The smallest batch order the batcher takes (its MIN_SIZE): smaller standard sizes stay in the balance. */
export const BATCH_MIN_SIZE = 10n ** 12n;

export function standardSizesFor(amount: bigint, notes: bigint[], max: number, min: bigint = BATCH_MIN_SIZE): { sizes: bigint[]; rest: bigint } {
  const caps = notes.filter((n) => n > 0n).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  const sizes: bigint[] = [];
  let rest = amount;
  while (sizes.length < max && rest > 0n && caps.length) {
    const target = rest < caps[0] ? rest : caps[0];
    const sz = standardSizes(target, 1).sizes[0];
    if (!sz || sz < min) break;
    const exact = caps.indexOf(sz);
    if (exact >= 0) caps.splice(exact, 1);
    else {
      caps[0] -= sz; // split from the largest; the change stays a note
      caps.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    }
    sizes.push(sz);
    rest -= sz;
  }
  return { sizes, rest };
}

export class GloamPrivate {
  readonly kind = "gloam" as const;
  /** Gloam's vault core, then the launch vault core (whichever are configured). */
  readonly cores: GloamCore[];
  markets: GloamMarket[] = [];
  private feeBps = new Map<string, bigint>();

  /**
   * Device-cache keys, in CloakKeys' shape (encPub names the account, encPriv keys its encrypted cache on this device),
   * derived from the account seed. Not a vault key: nothing on chain uses them.
   */
  readonly keys: { encPub: Uint8Array; encPriv: Uint8Array };

  /** From the wallet's account signature, or from keys (a claim link's account: `gloamLinkKeys`). */
  constructor(readonly cfg: GloamPrivateConfig, sigOrKeys: Hex | GloamAccountKeys) {
    const keys = typeof sigOrKeys === "string" ? gloamKeysFromSignature(sigOrKeys) : sigOrKeys;
    const encPriv = toBytes(keccak256(encodeAbiParameters([{ type: "string" }, { type: "uint256" }], ["cloak-gloam-device-v1", keys.noteSeed])));
    this.keys = { encPriv, encPub: toBytes(keccak256(encPriv)) };
    const base = { publicClient: cfg.publicClient, chainId: cfg.chainId, payMemo: cfg.payMemo, provers: cfg.provers, submit: cfg.submit, logChunk: cfg.logChunk, spendReceived: cfg.spendReceived, autoSweep: cfg.autoSweep };
    this.cores = [cfg.gloamVault, cfg.launchVault, cfg.ecosystemVault].filter((v): v is { pool: Address; poolBlock: bigint } => !!v).map((v) => new GloamCore({ ...base, pool: v.pool, poolBlock: v.poolBlock, pendingStore: cfg.pendingStore?.(v.pool) }, keys));
    if (!this.cores.length) throw new Error("No vault configured.");
  }

  /** One signature (the same request Cloak's own account uses), for both vaults. */
  static async unlock(wallet: WalletClient, cfg: GloamPrivateConfig): Promise<GloamPrivate> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sig = (await wallet.signTypedData({ account: wallet.account!, ...ACCOUNT_TYPED_DATA(cfg.chainId) } as any)) as Hex;
    return new GloamPrivate(cfg, sig);
  }

  private get launchCore(): GloamCore | undefined {
    return this.cfg.launchVault ? this.cores.find((c) => lc(c.config.pool) === lc(this.cfg.launchVault!.pool)) : undefined;
  }

  /** The asset a token or pool id names (HYPE's WHYPE and address 0 both mean native HYPE). */
  assetOf(tokenOrPool: Address): Address {
    return lc(tokenOrPool) === lc(this.cfg.whype) ? zeroAddress : tokenOrPool;
  }

  // ── markets ────────────────────────────────────────────────────────────

  async loadMarkets(): Promise<GloamMarket[]> {
    const pub = this.cfg.publicClient;
    const out: GloamMarket[] = [{ token: this.cfg.whype, pool: zeroAddress, pair: null, symbol: "HYPE", decimals: 18 }];
    const lv = this.cfg.launchVault?.pool;
    if (lv) {
      const n = await pub.readContract({ address: lv, abi: VAULT, functionName: "launchTokensCount" }).catch(() => 0n);
      let factory: Address | null = null;
      if (this.cfg.launchSwap) factory = await pub.readContract({ address: this.cfg.launchSwap, abi: V2, functionName: "factory" }).catch(() => null);
      // v4: each launch token's market is its auction's CloakV4Market
      const v4Markets = this.cfg.launchSwapV4 ? await this.launchMarkets(lv) : new Map<string, Address>();
      for (let i = 0n; i < n; i++) {
        const token = await pub.readContract({ address: lv, abi: VAULT, functionName: "launchTokens", args: [i] });
        const [symbol, decimals] = await Promise.all([pub.readContract({ address: token, abi: ERC20, functionName: "symbol" }).catch(() => "token"), pub.readContract({ address: token, abi: ERC20, functionName: "decimals" }).catch(() => 18)]);
        const v4 = v4Markets.get(lc(token));
        const pair = v4 ?? (factory ? await pub.readContract({ address: factory, abi: V2, functionName: "getPair", args: [this.cfg.whype, token] }).catch(() => null) : null);
        out.push({ token, pool: token, pair: pair && pair !== zeroAddress ? pair : null, symbol, decimals: Number(decimals), v4: !!v4 });
      }
    }
    // outside tokens admitted to the ecosystem vault, each with its plain HYPE pool
    const ev = this.cfg.ecosystemVault?.pool;
    if (ev && this.cfg.router) {
      const n = await pub.readContract({ address: ev, abi: ECO, functionName: "ecosystemTokensCount" }).catch(() => 0n);
      for (let i = 0n; i < n; i++) {
        const token = await pub.readContract({ address: ev, abi: ECO, functionName: "ecosystemTokens", args: [i] });
        const [symbol, decimals, ecoKey] = await Promise.all([
          pub.readContract({ address: token, abi: ERC20, functionName: "symbol" }).catch(() => "token"),
          pub.readContract({ address: token, abi: ERC20, functionName: "decimals" }).catch(() => 18),
          pub.readContract({ address: ev, abi: ECO, functionName: "poolKeyOf", args: [token] }),
        ]);
        out.push({ token, pool: token, pair: null, symbol, decimals: Number(decimals), v4: true, ecoKey });
      }
    }
    for (const m of this.markets) if (!out.some((x) => lc(x.token) === lc(m.token))) out.push(m);
    this.markets = out;
    return out;
  }

  /** Token -> its launch's market (auction.pair()), for every launch of the launch vault's factory. */
  private async launchMarkets(lv: Address): Promise<Map<string, Address>> {
    const pub = this.cfg.publicClient;
    const LAUNCH = parseAbi([
      "function factory() view returns (address)",
      "function launchesCount() view returns (uint256)",
      "function launches(uint256) view returns (address auction, address token, address creator, address launchpad, uint256 creatorAlloc, address vesting)",
      "function pair() view returns (address)",
    ]);
    const out = new Map<string, Address>();
    const factory = await pub.readContract({ address: lv, abi: LAUNCH, functionName: "factory" }).catch(() => null);
    if (!factory) return out;
    const n = await pub.readContract({ address: factory, abi: LAUNCH, functionName: "launchesCount" }).catch(() => 0n);
    for (let i = 0n; i < n; i++) {
      const [auction, token] = await pub.readContract({ address: factory, abi: LAUNCH, functionName: "launches", args: [i] });
      const market = await pub.readContract({ address: auction, abi: LAUNCH, functionName: "pair" }).catch(() => zeroAddress);
      if (market !== zeroAddress) out.set(lc(token), market);
    }
    return out;
  }

  get hypeMarket(): GloamMarket {
    return this.markets[0] ?? { token: this.cfg.whype, pool: zeroAddress, pair: null, symbol: "HYPE", decimals: 18 };
  }

  market(token: Address): GloamMarket {
    const m = this.markets.find((x) => lc(x.token) === lc(token) || lc(x.pool) === lc(token));
    if (!m) throw new Error("This token has no private balance on Cloak yet.");
    return m;
  }

  /**
   * An asset with no launch market (USDC): its pool id is its token. With `pool` (its plain native-HYPE v4 pool, no
   * hook) and the router set, it trades privately against HYPE and, through HYPE, against every other market.
   */
  addAsset(a: { symbol: string; token: Address; decimals: number; pool?: { fee: number; tickSpacing: number } }): GloamMarket {
    const hypeKey = a.pool && this.cfg.router ? { currency0: zeroAddress, currency1: a.token, fee: a.pool.fee, tickSpacing: a.pool.tickSpacing, hooks: zeroAddress } : undefined;
    const m: GloamMarket = { token: a.token, pool: a.token, pair: null, symbol: a.symbol, decimals: a.decimals, v4: !!hypeKey, hypeKey };
    const i = this.markets.findIndex((x) => lc(x.token) === lc(a.token));
    if (i < 0) this.markets.push(m);
    else if (hypeKey) this.markets[i] = { ...this.markets[i], ...m };
    return m;
  }

  // ── balances ───────────────────────────────────────────────────────────

  /**
   * This account's private address in the site's format: `cloak:` then Gloam's receive tag (`gloamr1.…`). Any Gloam app
   * pays the part after `cloak:`; Cloak takes either form.
   */
  async address(): Promise<string> {
    return `cloak:${await this.cores[0].address()}`;
  }

  /** A recipient as GloamCore takes it: the gloamr1. tag, with or without Cloak's `cloak:` in front. */
  static tagOf(to: string): string {
    return to.startsWith("cloak:gloamr1.") ? to.slice("cloak:".length) : to;
  }

  /** Reads both vaults; received payments are swept into own notes (GloamCore's autoSweep). */
  async syncAll(onStatus: Status = () => {}, opts: { sweep?: boolean } = {}): Promise<void> {
    for (const c of this.cores) await c.sync(onStatus, opts);
  }

  async balance(pool: Address): Promise<bigint> {
    const asset = this.assetOf(pool);
    let sum = 0n;
    // one sync serves every balance asked for at once (the site asks for each asset together)
    for (const c of this.cores) {
      await c.syncFresh();
      sum += c.ownNotes(asset).reduce((a, n) => a + n.amount, 0n);
    }
    return sum;
  }

  /** Received but not yet swept, per asset, across both vaults. */
  async pending(): Promise<Map<Address, bigint>> {
    const out = new Map<Address, bigint>();
    for (const c of this.cores) for (const [a, v] of await c.pending()) out.set(a, (out.get(a) ?? 0n) + v);
    return out;
  }

  /**
   * This account's notes in `pool`, both vaults: unspent ones, then the spent ones this session saw (Gloam keeps no
   * history on chain for an account, so a fresh session sees a note as spent only if it saw it before or it was spent
   * after the account's first sync, which is how a claim link's account reads its claims).
   */
  async history(pool: Address): Promise<(OwnedGloamNote & { spent: boolean; vault: Address })[]> {
    const asset = this.assetOf(pool);
    const out: (OwnedGloamNote & { spent: boolean; vault: Address })[] = [];
    for (const c of this.cores) {
      await c.syncFresh();
      for (const n of c.ownNotes(asset)) out.push({ ...n, spent: false, vault: c.config.pool });
      for (const n of c.spentNoteList(asset)) out.push({ ...n, spent: true, vault: c.config.pool });
    }
    return out;
  }

  /**
   * Where this account's spent notes in `pool` went, from the vault's own events: a cash out names its wallet, a private
   * transfer shows only that it happened.
   */
  async claims(pool: Address): Promise<{ amount: bigint; to: "private" | Address; at: number; tx: Hex }[]> {
    const pub = this.cfg.publicClient;
    const EV = parseAbi(["event Transferred(bytes32 indexed nullifier, bytes32[2] newCommitments)", "event Unshielded(bytes32 indexed nullifier, address indexed asset, address indexed to, uint256 amount)"]);
    const out: { amount: bigint; to: "private" | Address; at: number; tx: Hex }[] = [];
    for (const n of (await this.history(pool)).filter((x) => x.spent)) {
      const nullifier = toHex(n.nullifier, { size: 32 });
      const from = this.cores.find((c) => c.config.pool === n.vault)!.config.poolBlock;
      const [tr, un] = await Promise.all([
        pub.getContractEvents({ address: n.vault, abi: EV, eventName: "Transferred", args: { nullifier }, fromBlock: from }),
        pub.getContractEvents({ address: n.vault, abi: EV, eventName: "Unshielded", args: { nullifier }, fromBlock: from }),
      ]);
      const l = un[0] ?? tr[0];
      if (!l) continue;
      const block = await pub.getBlock({ blockNumber: l.blockNumber! });
      out.push({ amount: n.amount, to: un[0] ? (un[0].args.to as Address) : "private", at: Number(block.timestamp) * 1000, tx: l.transactionHash! });
    }
    return out.sort((a, b) => b.at - a.at);
  }

  /** No relayer fee comes out of the balance: the most one call moves is the whole balance. */
  async maxSpendable(pool: Address): Promise<bigint> {
    return this.balance(pool);
  }

  async relayFee(): Promise<{ relayer: Address; fee: bigint }> {
    return { relayer: zeroAddress, fee: 0n };
  }

  /** What a cash out of `amount` delivers after the vault's fee (the vault it would come from). */
  async afterFee(pool: Address, amount: bigint): Promise<bigint> {
    const c = await this.coreFor(this.assetOf(pool), amount).catch(() => this.cores[0]);
    const k = lc(c.config.pool);
    if (!this.feeBps.has(k)) this.feeBps.set(k, BigInt(await this.cfg.publicClient.readContract({ address: c.config.pool, abi: VAULT, functionName: "withdrawFeeBps" })));
    const bps = this.feeBps.get(k)!;
    return amount - ((amount / 10_000n) * bps + ((amount % 10_000n) * bps) / 10_000n);
  }

  /** The vault to spend `amount` of `asset` from: Gloam's first, then the launch vault. */
  private async coreFor(asset: Address, amount: bigint): Promise<GloamCore> {
    for (const c of this.cores) {
      await c.sync();
      if (c.ownNotes(asset).reduce((a, n) => a + n.amount, 0n) >= amount) return c;
    }
    throw new Error("Not enough private balance in one vault for this. Move some first, or send a smaller amount.");
  }

  /**
   * The vault a deposit of `asset` goes into: the launch vault when it takes the asset (HYPE and launch tokens, so they
   * can trade, since a swap spends from the launch vault and nothing moves privately between vaults), else Gloam's.
   */
  private async depositCore(asset: Address, amount: bigint): Promise<GloamCore> {
    const LIMIT = parseAbi(["function depositLimit(address) view returns (uint128 perDeposit, uint128 total)", "function deposited(address) view returns (uint256)"]);
    for (const c of [...this.cores].reverse()) {
      const [per, total] = await this.cfg.publicClient.readContract({ address: c.config.pool, abi: LIMIT, functionName: "depositLimit", args: [asset] });
      const dep = await this.cfg.publicClient.readContract({ address: c.config.pool, abi: LIMIT, functionName: "deposited", args: [asset] });
      if (amount <= per && dep + amount <= total) return c;
    }
    throw new Error("No private vault takes this deposit right now (the asset isn't listed, or its cap is full).");
  }

  /**
   * The most one deposit of `token` (or hypeMarket.token for HYPE) can be right now, in whichever vault takes it: its
   * per-deposit cap, and what's left under its total cap. 0 when no vault takes it.
   */
  /**
   * A vault's caps on `token` as they stand: the most one deposit can be, and what's left under its total, in the vault
   * with the most room. Shields bigger than one deposit go in several (shieldHype / shieldToken split them).
   */
  async depositCaps(token: Address): Promise<{ perDeposit: bigint; left: bigint }> {
    const asset = this.assetOf(token);
    const LIMIT = parseAbi(["function depositLimit(address) view returns (uint128 perDeposit, uint128 total)", "function deposited(address) view returns (uint256)"]);
    let best = { perDeposit: 0n, left: 0n };
    for (const c of this.cores) {
      const [per, total] = await this.cfg.publicClient.readContract({ address: c.config.pool, abi: LIMIT, functionName: "depositLimit", args: [asset] }).catch(() => [0n, 0n] as const);
      const dep = await this.cfg.publicClient.readContract({ address: c.config.pool, abi: LIMIT, functionName: "deposited", args: [asset] }).catch(() => 0n);
      const left = total > dep ? total - dep : 0n;
      if (per > 0n && left > best.left) best = { perDeposit: per, left };
    }
    return best;
  }

  async depositRoom(token: Address): Promise<bigint> {
    const asset = this.assetOf(token);
    const LIMIT = parseAbi(["function depositLimit(address) view returns (uint128 perDeposit, uint128 total)", "function deposited(address) view returns (uint256)"]);
    let best = 0n;
    for (const c of this.cores) {
      const [per, total] = await this.cfg.publicClient.readContract({ address: c.config.pool, abi: LIMIT, functionName: "depositLimit", args: [asset] }).catch(() => [0n, 0n] as const);
      const dep = await this.cfg.publicClient.readContract({ address: c.config.pool, abi: LIMIT, functionName: "deposited", args: [asset] }).catch(() => 0n);
      const left = total > dep ? total - dep : 0n;
      const room = per < left ? per : left;
      if (room > best) best = room;
    }
    return best;
  }

  // ── in and out ─────────────────────────────────────────────────────────

  /** A vault's per-deposit cap on `asset` (0 when it doesn't take it). */
  private async perDeposit(pool: Address, asset: Address): Promise<bigint> {
    const LIMIT = parseAbi(["function depositLimit(address) view returns (uint128 perDeposit, uint128 total)"]);
    const [per] = await this.cfg.publicClient.readContract({ address: pool, abi: LIMIT, functionName: "depositLimit", args: [asset] }).catch(() => [0n, 0n] as const);
    return per;
  }

  /**
   * `amount` as deposits a vault takes: one when it fits its per-deposit cap, else as many as needed (a vault's cap of
   * 12 HYPE per deposit makes a 30 HYPE deposit three: 12, 12, 6). Each is its own transaction from the wallet.
   */
  private async splitShield(wallet: WalletClient, asset: Address, amount: bigint, onStatus: Status): Promise<Hex[]> {
    const fits = await this.depositCore(asset, amount).catch(() => null);
    if (fits) return fits.shield(wallet, asset, amount, onStatus);
    const per = (await Promise.all(this.cores.map((c) => this.perDeposit(c.config.pool, asset)))).reduce((a, b) => (b > a ? b : a), 0n);
    if (per === 0n) throw new Error("No private vault takes this deposit right now (the asset isn't listed, or its cap is full).");
    const out: Hex[] = [];
    for (let left = amount, i = 1, n = (amount + per - 1n) / per; left > 0n; i++) {
      const part = left < per ? left : per;
      onStatus(`Deposit ${i} of ${n} (the vault takes at most ${part === per ? "this much" : "the rest"} at a time)`);
      const c = await this.depositCore(asset, part);
      out.push(...(await c.shield(wallet, asset, part, onStatus)));
      left -= part;
    }
    return out;
  }

  async shieldHype(wallet: WalletClient, amount: bigint, onStatus: Status = () => {}): Promise<Hex> {
    const hs = await this.splitShield(wallet, zeroAddress, amount, onStatus);
    return hs[0];
  }

  async shieldToken(wallet: WalletClient, token: Address, amount: bigint, onStatus: Status = () => {}): Promise<Hex> {
    const hs = await this.splitShield(wallet, token, amount, onStatus);
    return hs[token === zeroAddress ? 0 : 1] ?? hs[0];
  }

  /** Private send to a gloamr1. address. Returns the first transaction. */
  async send(token: Address, to: string, amount: bigint, onStatus: Status = () => {}): Promise<Hex> {
    const asset = this.assetOf(token);
    const c = await this.coreFor(asset, amount);
    const r = await c.send(asset, GloamPrivate.tagOf(to), amount, onStatus);
    return r.txHashes[0];
  }

  async unshieldHype(to: Address, amount: bigint, onStatus: Status = () => {}): Promise<Hex> {
    const c = await this.coreFor(zeroAddress, amount);
    const hs = await c.withdraw(zeroAddress, to, amount, onStatus);
    return hs[hs.length - 1];
  }

  async unshieldToken(token: Address, to: Address, amount: bigint, onStatus: Status = () => {}): Promise<Hex> {
    const asset = this.assetOf(token);
    const c = await this.coreFor(asset, amount);
    const hs = await c.withdraw(asset, to, amount, onStatus);
    return hs[hs.length - 1];
  }

  /** Empty this account's balance of `token` to a gloamr1. address (privately) or a 0x address (a cash out). */
  async sweep(token: Address, to: string, onStatus: Status = () => {}, opts: { one?: boolean } = {}): Promise<{ txHash: Hex; amount: bigint; left: bigint }> {
    const asset = this.assetOf(token);
    let txHash: Hex | null = null;
    let amount = 0n;
    for (const c of this.cores) {
      if (opts.one && txHash) break;
      await c.sync(onStatus);
      const notes = c.ownNotes(asset);
      // one share of a split link: the smallest note, so the bigger ones stay for the next people
      const have = opts.one ? (notes.length ? notes[notes.length - 1].amount : 0n) : notes.reduce((a, n) => a + n.amount, 0n);
      if (have === 0n) continue;
      const hs = to.startsWith("0x") ? await c.withdraw(asset, to as Address, opts.one ? have : "max", onStatus) : (await c.send(asset, GloamPrivate.tagOf(to), have, onStatus)).txHashes;
      txHash ??= hs[hs.length - 1];
      amount += have;
    }
    if (!txHash) throw new Error("Nothing to move.");
    return { txHash, amount, left: await this.balance(asset) };
  }

  // ── trading (CloakLaunchSwap on the launch vault) ──────────────────────

  /** The market's HYPE and token depth (the launch's CloakV4Market, or its V2 pair with WHYPE). */
  private async depth(token: Address): Promise<{ rH: bigint; rT: bigint }> {
    const pub = this.cfg.publicClient;
    // the v4 batcher's own record of the launch's market first, then the markets loaded for swaps
    const v4 = this.cfg.batcherV4 ? await pub.readContract({ address: this.cfg.batcherV4, abi: BATCH, functionName: "marketOf", args: [token] }) : zeroAddress;
    const m = v4 !== zeroAddress ? { pair: v4 as Address, v4: true } : this.market(token);
    const pair = m.pair;
    if (!pair) throw new Error("This token has no pool to trade privately against yet.");
    if (m.v4) {
      const [rH, rT] = await Promise.all([pub.readContract({ address: pair, abi: V4MARKET, functionName: "reserveHype" }), pub.readContract({ address: pair, abi: V4MARKET, functionName: "reserveToken" })]);
      return { rH, rT };
    }
    const [r0, r1] = await pub.readContract({ address: pair, abi: V2, functionName: "getReserves" });
    const hypeIs0 = lc(await pub.readContract({ address: pair, abi: V2, functionName: "token0" })) === lc(this.cfg.whype);
    return hypeIs0 ? { rH: BigInt(r0), rT: BigInt(r1) } : { rH: BigInt(r1), rT: BigInt(r0) };
  }

  /**
   * How much more one side of the current round takes: each side holds at most 4% of the market's depth (the
   * batcher's MAX_SIDE_BPS, so the round always settles). Counted on what's already in, and on the order's full size
   * (what lands is less the vault's fee), so an order sized to it fits.
   */
  async batchRoom(token: Address, side: "buy" | "sell"): Promise<bigint> {
    const batcher = await this.batcherFor(token);
    const pub = this.cfg.publicClient;
    const [round, { rH, rT }] = await Promise.all([pub.readContract({ address: batcher, abi: BATCH, functionName: "currentRound" }), this.depth(token)]);
    const b = await pub.readContract({ address: batcher, abi: BATCH, functionName: "batches", args: [token, round] });
    const cap = ((side === "buy" ? rH : rT) * 400n) / 10_000n;
    const used = side === "buy" ? b[0] : b[1];
    return cap > used ? cap - used : 0n;
  }

  private async v2Quote(token: Address, side: "buy" | "sell", amountIn: bigint): Promise<bigint> {
    const m = this.market(token);
    const pub = this.cfg.publicClient;
    const plain = m.ecoKey ?? m.hypeKey;
    if (plain) {
      // a plain v4 pool: its in-range reserves (L / sqrtP HYPE, L * sqrtP token) and its fee; exact for a trade that
      // stays in the current range, and the swap's slippage allowance covers the rest (a short output reverts whole)
      const [sqrtP, liq] = await this.poolState(plain);
      if (sqrtP === 0n || liq === 0n) throw new Error("This token's pool has no liquidity right now.");
      const rH = (liq << 96n) / sqrtP;
      const rT = (liq * sqrtP) >> 96n;
      const x = (amountIn * BigInt(1_000_000 - plain.fee)) / 1_000_000n;
      const [rIn, rOut] = side === "buy" ? [rH, rT] : [rT, rH];
      return (x * rOut) / (rIn + x);
    }
    const pair = m.pair;
    if (!pair) throw new Error("This token has no pool to trade privately against yet.");
    if (m.v4) {
      // the launch's CloakV4Market quotes its pool at its current fee
      const [rH, rT] = await Promise.all([pub.readContract({ address: pair, abi: V4MARKET, functionName: "reserveHype" }), pub.readContract({ address: pair, abi: V4MARKET, functionName: "reserveToken" })]);
      return pub.readContract({ address: pair, abi: V4MARKET, functionName: "getAmountOut", args: side === "buy" ? [amountIn, rH, rT] : [amountIn, rT, rH] });
    }
    const [r0, r1] = await pub.readContract({ address: pair, abi: V2, functionName: "getReserves" });
    const t0 = await pub.readContract({ address: pair, abi: V2, functionName: "token0" });
    const hypeIs0 = lc(t0) === lc(this.cfg.whype);
    const [rIn, rOut] = side === "buy" ? (hypeIs0 ? [r0, r1] : [r1, r0]) : hypeIs0 ? [r1, r0] : [r0, r1];
    const x = amountIn * 997n;
    return (x * BigInt(rOut)) / (BigInt(rIn) * 1000n + x);
  }

  /** A plain v4 pool's price and in-range liquidity, read from the PoolManager (or the ecosystem vault). */
  private async poolState(key: PoolKeyV4): Promise<[bigint, bigint]> {
    const pub = this.cfg.publicClient;
    if (this.cfg.poolManager) {
      // v4-core StateLibrary: pools is mapping slot 6; slot0 (sqrtPriceX96 in its low 160 bits) first, liquidity fourth
      const id = keccak256(encodeAbiParameters(POOL_KEY_TYPE, [key]));
      const slot = BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [id, 6n])));
      const [s0, l] = await Promise.all([0n, 3n].map((o) => pub.readContract({ address: this.cfg.poolManager!, abi: EXTSLOAD, functionName: "extsload", args: [toHex(slot + o, { size: 32 })] })));
      return [BigInt(s0) & ((1n << 160n) - 1n), BigInt(l) & ((1n << 128n) - 1n)];
    }
    if (!this.cfg.ecosystemVault) throw new Error("No pool reader configured (poolManager).");
    const [sqrtP, liq] = await pub.readContract({ address: this.cfg.ecosystemVault.pool, abi: ECO, functionName: "poolState", args: [key] });
    return [sqrtP, liq];
  }

  async quote(token: Address, side: "buy" | "sell", amountIn: bigint): Promise<bigint> {
    return this.v2Quote(token, side, amountIn);
  }

  /**
   * What the trader gets for `amountIn` of `tokenIn` in `tokenOut` (before the vault's fee on the input), through HYPE
   * when neither side is HYPE: USDC to a launch token is USDC to HYPE, then HYPE to the token. A sale out of Cloak's
   * vaults into Gloam's (a launch or outside token into HYPE or USDC) is net of Cloak's trade fee, which the router takes
   * from what the sale brings.
   */
  async quoteTrade(tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<bigint> {
    const [a, b] = [this.assetOf(tokenIn), this.assetOf(tokenOut)];
    if (a === b) throw new Error("Pick two different tokens.");
    const hype = a === zeroAddress ? amountIn : await this.v2Quote(a, "sell", amountIn);
    const gross = b === zeroAddress ? hype : await this.v2Quote(b, "buy", hype);
    return gross - (await this.tradeFeeOn(a, b, gross));
  }

  /** Cloak's trade fee on a sale whose output is `gross` in all: the router's own reading, 0 when none applies. */
  async tradeFeeOn(assetIn: Address, assetOut: Address, gross: bigint): Promise<bigint> {
    if (!this.cfg.router || !this.cfg.gloamVault || gross === 0n) return 0n;
    const pub = this.cfg.publicClient;
    // the fee the router adds to a note of `gross`: a note of gross - fee then needs gross - fee + (a fee no larger),
    // which fits in `gross`
    const [fee] = await pub.readContract({ address: this.cfg.router, abi: TRADE_FEE, functionName: "tradeFee", args: [assetIn, assetOut, gross] }).catch(() => [0n, zeroAddress] as const);
    return fee;
  }

  buy(token: Address, hypeIn: bigint, opts: { slippageBps?: number; onStatus?: Status } = {}) {
    return this.trade(zeroAddress, token, hypeIn, opts);
  }

  sell(token: Address, tokensIn: bigint, opts: { slippageBps?: number; onStatus?: Status } = {}) {
    return this.trade(token, zeroAddress, tokensIn, opts);
  }

  /** The vault that holds `asset` for trading: with the router, HYPE and USDC in Gloam's, outside tokens in the ecosystem vault, launch tokens in the launch vault. */
  private tradeCore(asset: Address): GloamCore | undefined {
    const find = (v?: { pool: Address }) => (v ? this.cores.find((c) => lc(c.config.pool) === lc(v.pool)) : undefined);
    if (!this.cfg.router) return this.launchCore;
    if (asset === zeroAddress || this.market(asset).hypeKey) return find(this.cfg.gloamVault);
    if (this.market(asset).ecoKey) return find(this.cfg.ecosystemVault);
    return this.launchCore;
  }

  /** The pool between `asset` and HYPE, as a route hop. */
  private async hopOf(asset: Address): Promise<PoolKeyV4> {
    const m = this.market(asset);
    const k = m.ecoKey ?? m.hypeKey;
    if (k) return k;
    if (m.v4 && m.pair) return this.cfg.publicClient.readContract({ address: m.pair, abi: V4MARKET, functionName: "key" });
    throw new Error(`${m.symbol ?? "This token"} has no pool the router can trade yet.`);
  }

  /**
   * How a trade of `amountIn` goes in: one piece, or several one after another. Two limits split it:
   * - the input: one trade spends one note, and a vault's notes are never bigger than its per-deposit cap (notes can't
   *   be merged), so 30 HYPE held as 12 + 12 + 6 trades as three;
   * - the output: it lands as one deposit in its vault, so it must fit that vault's per-deposit cap (Gloam's vault
   *   takes 12 HYPE at a time for now).
   * The app shows the count before a trade ("3 trades"); trade() follows the same plan.
   */
  async tradePlan(tokenIn: Address, tokenOut: Address, amountIn: bigint, onStatus?: Status): Promise<bigint[]> {
    const [assetIn, assetOut] = [this.assetOf(tokenIn), this.assetOf(tokenOut)];
    const src = this.tradeCore(assetIn);
    const dest = this.tradeCore(assetOut);
    if (!src || !dest || amountIn <= 0n) return [amountIn];
    await src.sync(onStatus ?? (() => {}));
    const notes = src.ownNotes(assetIn).map((n) => n.amount).sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
    const per = await this.perDeposit(dest.config.pool, assetOut);
    const out = per > 0n ? await this.quoteTrade(assetIn, assetOut, amountIn).catch(() => 0n) : 0n;
    // the most one piece may spend so its output stays under about 95% of the cap
    const capIn = per > 0n && out > 0n ? (amountIn * per * 95n) / (out * 100n) : amountIn;
    if (!notes.length || (amountIn <= notes[0] && amountIn <= capIn)) return [amountIn];
    if (notes.reduce((a, b) => a + b, 0n) < amountIn) throw new Error("insufficient private balance in the trading vault (deposits made for trading land there)");
    const parts: bigint[] = [];
    let left = amountIn;
    for (const note of notes) {
      for (let room = note; room > 0n && left > 0n; ) {
        const p = [room, capIn, left].reduce((a, b) => (b < a ? b : a));
        if (p === 0n) break;
        parts.push(p);
        room -= p;
        left -= p;
      }
      if (left === 0n) break;
    }
    if (parts.length > 50) throw new Error(`This trade would take ${parts.length} pieces under the vault's caps. Trade a smaller amount.`);
    return parts;
  }

  /** How many sealed bids a private bid paying `deposit` becomes: one per note it needs (notes are never merged). */
  async bidPieces(deposit: bigint): Promise<number> {
    const launch = this.launchCore;
    if (!launch || !this.cfg.bids) return 1;
    const core = await hypeCoreOf(this.cfg.bids, launch, this.cores);
    await core.sync(() => {});
    const notes = core.ownNotes(zeroAddress).map((n) => (n.amount * 995n) / 1000n).sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
    let n = 0;
    for (let left = deposit, i = 0; left > 0n && i < notes.length; i++, n++) left -= notes[i] < left ? notes[i] : left;
    return Math.max(1, n);
  }

  /**
   * Trade `amountIn` of `tokenIn` from the private balance for `tokenOut`, landing as a new note in `tokenOut`'s vault.
   * HYPE to a token, a token to HYPE, or (through the router) any two markets through HYPE in one swap, such as USDC
   * to a launch token. Exact input, exact output: the output is the quote on what the vault releases, less the slippage
   * allowance, and whatever the swap didn't need comes back as a note (finishPending).
   */
  async trade(tokenIn: Address, tokenOut: Address, amountIn: bigint, opts: { slippageBps?: number; onStatus?: Status; whole?: boolean } = {}): Promise<{ txHash: Hex; amountOut: bigint; expectedOut: bigint; minOut: bigint; relayerFee: bigint; pieces?: number }> {
    const [assetIn, assetOut] = [this.assetOf(tokenIn), this.assetOf(tokenOut)];
    if (assetIn === assetOut) throw new Error("Pick two different tokens.");
    if (!opts.whole) {
      const parts = await this.tradePlan(tokenIn, tokenOut, amountIn, opts.onStatus);
      if (parts.length > 1) {
        let total = 0n;
        let last: { txHash: Hex; amountOut: bigint; expectedOut: bigint; minOut: bigint; relayerFee: bigint } | undefined;
        for (let i = 0; i < parts.length; i++) {
          (opts.onStatus ?? (() => {}))(`Trade ${i + 1} of ${parts.length}`);
          last = await this.trade(tokenIn, tokenOut, parts[i], { ...opts, whole: true });
          total += last.amountOut;
        }
        return { ...last!, amountOut: total, expectedOut: total, minOut: total, pieces: parts.length };
      }
    }
    const viaRouter = !!(this.cfg.router && this.cfg.gloamVault);
    let router: Address | undefined;
    let route: Hex;
    if (viaRouter) {
      router = this.cfg.router;
      const hops: PoolKeyV4[] = [];
      if (assetIn !== zeroAddress) hops.push(await this.hopOf(assetIn));
      if (assetOut !== zeroAddress) hops.push(await this.hopOf(assetOut));
      route = launchRouteV4(hops);
    } else {
      // before the router: HYPE and launch tokens both in the launch vault, one pool between them
      const token = assetIn === zeroAddress ? assetOut : assetIn;
      if (assetIn !== zeroAddress && assetOut !== zeroAddress) throw new Error("Trading between two tokens needs the router, which isn't set up here.");
      const m = this.market(token);
      if (m.ecoKey || m.hypeKey) throw new Error("This token trades through the router, which isn't set up here.");
      router = m.v4 ? this.cfg.launchSwapV4 : this.cfg.launchSwap;
      // V2: the path through WHYPE. v4: the launch's own pool key (native HYPE, behind Cloak's hook)
      route = m.v4 ? launchRouteV4([await this.hopOf(token)]) : launchRoute(assetIn === zeroAddress ? [this.cfg.whype, token] : [token, this.cfg.whype]);
    }
    const from = this.tradeCore(assetIn);
    const to = this.tradeCore(assetOut);
    if (!from || !to || !router) throw new Error("Private trading isn't set up on this deployment yet.");
    const onStatus = opts.onStatus ?? (() => {});
    await from.sync(onStatus);
    if (from.ownNotes(assetIn).reduce((a, n) => a + n.amount, 0n) < amountIn) throw new Error("insufficient private balance in the trading vault (deposits made for trading land there)");
    const bps = await this.feeBpsOf(from);
    const released = amountIn - ((amountIn / 10_000n) * bps + ((amountIn % 10_000n) * bps) / 10_000n);
    const expected = await this.quoteTrade(assetIn, assetOut, released);
    // two pools: the allowance covers both
    const slip = BigInt(opts.slippageBps ?? (assetIn !== zeroAddress && assetOut !== zeroAddress ? 150 : 100));
    const amountOut = (expected * (10_000n - slip)) / 10_000n;
    if (amountOut === 0n) throw new Error("amount too small to trade");
    // the chain's clock, not this device's: the contract checks the deadline against block time
    const deadline = (await this.cfg.publicClient.getBlock()).timestamp + 600n;
    // the record is saved before the swap is sent, so its buffer is taken back even if the answer is lost
    const rec = await launchSwap(from, { router, route, assetIn, amountIn, assetOut, amountOut, deadline, to: viaRouter ? to : undefined }, onStatus, (r) => this.remember(r));
    if ("id" in rec) this.updateRecord(rec.id, { txHash: rec.txHash });
    // take the buffer back at once when it can be; otherwise the next open does
    await this.finishPending(onStatus).catch(() => {});
    return { txHash: rec.txHash, amountOut, expectedOut: amountOut, minOut: amountOut, relayerFee: 0n };
  }

  // ── follow-ups (finishPending) ─────────────────────────────────────────

  private remember(r: LaunchRecord) {
    if (!this.cfg.records) return;
    this.cfg.records.save([...this.cfg.records.load(), r]);
  }

  /** Run on every app open: swap leftovers back as notes, graduations moved once their round ends. */
  async finishPending(onStatus: Status = () => {}) {
    const core = this.launchCore;
    if (!core || !this.cfg.records) return { waiting: [], done: [], errors: [] };
    const res = await finishPending(core, this.cfg.records.load(), { cores: this.cores }, onStatus);
    this.cfg.records.save(res.waiting);
    return res;
  }

  // ── batch rounds (CloakGloamBatcher on the launch vault) ───────────────

  /**
   * The batcher that runs rounds for a token: the v4 one once the token's launch market is registered there (the keeper
   * registers every settled launch), else the V2 one. Without a token: the v4 one if set.
   */
  async batcherFor(token?: Address): Promise<Address> {
    const { batcher, batcherV4 } = this.cfg;
    if (batcherV4) {
      if (!token) return batcherV4;
      const m = await this.cfg.publicClient.readContract({ address: batcherV4, abi: BATCH, functionName: "marketOf", args: [token] });
      if (m !== zeroAddress || !batcher) return batcherV4;
    }
    if (!batcher) throw new Error("no batcher configured");
    return batcher;
  }

  async roundInfo(token?: Address): Promise<{ round: bigint; endsAt: number; roundSecs: number }> {
    const b = await this.batcherFor(token);
    const pub = this.cfg.publicClient;
    const [round, roundSecs] = await Promise.all([pub.readContract({ address: b, abi: BATCH, functionName: "currentRound" }), pub.readContract({ address: b, abi: BATCH, functionName: "roundSecs" })]);
    return { round, roundSecs: Number(roundSecs), endsAt: Number((round + 1n) * roundSecs) };
  }

  /**
   * Batched private buy or sell: standard-size orders (1, 2, 5 x 10^n), each a whole note spent into the batcher.
   * The remainder that isn't a standard size stays in the balance. Each order is recorded, and its payout comes back
   * as a note on a later open (finishPending), once the round settles.
   */
  async batch(token: Address, side: "buy" | "sell", amount: bigint, opts: { maxOrders?: number; onStatus?: Status } = {}) {
    const launch = this.launchCore;
    if (!launch) throw new Error("no batcher configured");
    const batcher = await this.batcherFor(token);
    // a buy spends HYPE from the batcher's HYPE vault (Gloam's, on a batcher built for it); a sell, tokens from the launch vault
    const core = side === "buy" ? await hypeCoreOf(batcher, launch, this.cores) : launch;
    const onStatus = opts.onStatus ?? (() => {});
    const asset = side === "buy" ? zeroAddress : token;
    await core.sync(onStatus);
    // a round's side holds at most 4% of the pool: what doesn't fit stays in the balance for a later round
    const room = await this.batchRoom(token, side);
    const fits = amount < room ? amount : room;
    const sized = standardSizesFor(fits, core.ownNotes(asset).map((n) => n.amount), opts.maxOrders ?? 6);
    const sizes = sized.sizes;
    const rest = sized.rest + (amount - fits);
    if (!sizes.length) throw new Error(room === 0n ? "This batch round is full. Try the next round, or swap instantly." : "amount too small for a standard-size order");
    const orders: { id: bigint; size: bigint; round: bigint; txHash: Hex }[] = [];
    const pub = this.cfg.publicClient;
    for (let i = 0; i < sizes.length; i++) {
      onStatus(`Order ${i + 1}/${sizes.length}: preparing…`);
      const note = await core.exactNote(asset, sizes[i], onStatus);
      const nullifier = toHex(note.nullifier, { size: 32 });
      const owner = privateKeyToAccount(core.exitKeyFor(nullifier)).address;
      const k = { nullifier, token, buy: side === "buy", size: sizes[i], ownerKey: owner, fallbackTo: owner };
      const escrow = await pub.readContract({ address: batcher, abi: BATCH, functionName: "escrowFor", args: [k] });
      const s = await core.spendProof(note, escrow, onStatus);
      onStatus(`Order ${i + 1}/${sizes.length}: relaying…`);
      const round = await pub.readContract({ address: batcher, abi: BATCH, functionName: "currentRound" });
      const id = keccak256(encodeAbiParameters([{ type: "tuple", components: [{ name: "nullifier", type: "bytes32" }, { name: "token", type: "address" }, { name: "buy", type: "bool" }, { name: "size", type: "uint128" }, { name: "ownerKey", type: "address" }, { name: "fallbackTo", type: "address" }] }], [k]));
      // recorded before it's sent, so a payout is never forgotten if the page closes mid-send
      this.addRecord({ kind: "batchOrder", batcher, id, key: k, round, txHash: "0x" });
      const txHash = await this.cfg.submit({ kind: "escrow", to: batcher, data: encodeFunctionData({ abi: BATCH, functionName: "place", args: [s, k] }) });
      // the round it actually landed in (the clock may have turned over while it was proved and sent)
      const landed = (await pub.readContract({ address: batcher, abi: BATCH, functionName: "orders", args: [id] }))[1];
      this.updateRecord(id, { txHash, round: landed || round });
      orders.push({ id: BigInt(id), size: sizes[i], round: landed || round, txHash });
    }
    return { orders, rest };
  }

  private addRecord(r: LaunchRecord) {
    if (!this.cfg.records) return;
    this.cfg.records.save([...this.cfg.records.load(), r]);
  }

  private updateRecord(id: Hex, patch: { txHash: Hex; round?: bigint }) {
    if (!this.cfg.records) return;
    this.cfg.records.save(this.cfg.records.load().map((r) => ("id" in r && r.id === id ? { ...r, ...patch } : r)));
  }

  // ── proof of funds (off chain, for a named reader) ─────────────────────

  /**
   * A proof of funds for a named reader, in the site's shareable format (FundsProof version 2: Gloam's funds circuit on
   * its final keys, up to 4 notes). verifyFundsProof checks it.
   */
  async proveFunds(token: Address, threshold: bigint, o: { label: string; expiresAt: number; prover: HolderProver; symbol?: string; decimals?: number; onStatus?: Status }): Promise<FundsProof> {
    const asset = this.assetOf(token);
    const core = await this.coreFor(asset, threshold).catch(() => this.cores[0]);
    const notes = notesFor(core, asset, threshold);
    const context = gloamFundsContext(this.cfg.chainId, core.config.pool, o.label, o.expiresAt);
    const inputs = [];
    for (const n of notes) inputs.push({ secretHex: toHex(n.secret, { size: 32 }), amount: n.amount, path: await core.pathOf(n.commitment) });
    const block = await this.cfg.publicClient.getBlockNumber();
    const w = await gloam.buildFundsWitness({ asset, threshold, context, notes: inputs });
    if (w.blocker) throw new Error(w.blocker);
    o.onStatus?.("Proving your balance (it stays private)");
    const { proof } = await o.prover(w.circomInput);
    return {
      v: 2,
      chainId: this.cfg.chainId,
      pool: core.config.pool,
      token,
      symbol: o.symbol ?? "HYPE",
      decimals: o.decimals ?? 18,
      threshold: threshold.toString(),
      label: o.label,
      expiresAt: o.expiresAt,
      block: block.toString(),
      root: w.publicInputs.root.toString(),
      context: context.toString(),
      nullifiers: w.publicInputs.nullifiers.map(String),
      asset: BigInt(asset).toString(),
      proof: proof as unknown as FundsProof["proof"],
    };
  }

  // ── on Cloak's own vaults, not built on Gloam yet (they throw a friendly message) ──

  // ── sealed bids from the private balance (CloakGloamBids on the launch vault) ──

  /** No bid wallet holds gas here: the relay sends the bid, so nothing is set aside. */
  async bidGasReserve(): Promise<bigint> {
    return 0n;
  }

  /** The bid accounts this device placed in `auction` (as the launch page lists one-time bid wallets). */
  async bidWallets(auction: Address): Promise<{ n: number; address: Address; wallet: WalletClient }[]> {
    const recs = (this.cfg.records?.load() ?? []).filter((r): r is Extract<LaunchRecord, { kind: "bid" }> => r.kind === "bid" && lc(r.key.auction) === lc(auction));
    return recs.map((r, n) => ({ n, address: r.account, wallet: undefined as unknown as WalletClient }));
  }

  /**
   * A sealed bid paid from the private HYPE balance: one note of the deposit (plus the vault's fee) leaves the launch
   * vault to a one-time bid account the auction sees as the bidder, sent by the relay. After settlement the won tokens
   * and the refund come back into the vault as notes (finishPending, or finishPrivateBids). If nobody finishes it, its
   * timeout exit goes to this account's receive address, which moves back in on the next open.
   */
  async bidPrivately(auction: Address, opts: { maxPrice: bigint; quantity: bigint; deposit?: bigint; single?: boolean }, onStatus: Status = () => {}): Promise<{ secret: { auction: Address; bidder: Address; tick: number; quantity: bigint; salt: Hex; id: bigint; deposit: bigint; commitment: Hex; txHash: Hex }; bidWallet: Address; n: number; fundTx: Hex; bids?: number; secrets?: { auction: Address; bidder: Address; tick: number; quantity: bigint; salt: Hex; id: bigint; deposit: bigint; commitment: Hex; txHash: Hex }[] }> {
    const launch = this.launchCore;
    if (!launch || !this.cfg.bids) throw new Error(NOT_YET);
    // the bid's HYPE comes from the bids contract's HYPE vault (Gloam's, on one built for it)
    const core = await hypeCoreOf(this.cfg.bids, launch, this.cores);
    const { Cloak } = await import("../cloak.js");
    const reader = new Cloak(this.cfg.publicClient as never);
    const s = await reader.getAuction(auction);
    if (s.phase !== "commit") throw new Error("commit phase is over");
    const q = reader.quoteBid(s, opts.maxPrice, opts.quantity);
    const deposit = opts.deposit ?? q.deposit;
    if (deposit < q.cost) throw new Error("deposit is below the bid's cost");
    // what arrives at the bid account is the note less the vault's fee: send enough that the deposit lands in full
    const bps = await this.feeBpsOf(core);
    const gross = (d: bigint) => (d * 10_000n + (10_000n - bps) - 1n) / (10_000n - bps);
    const amount = gross(deposit);
    // A bid is paid from one note, and a vault's notes are never bigger than its per-deposit cap (Gloam's vault takes
    // 12 HYPE at a time for now). A bid bigger than the biggest note goes in as several sealed bids at the same price,
    // one note each: with one clearing price, that's the same as one bid for the total.
    if (!opts.single) {
      await core.sync(onStatus);
      const notes = core.ownNotes(zeroAddress).map((n) => n.amount).sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
      if (notes.length && amount > notes[0]) {
        // each part leaves a little of its note for the fee and rounding: ask for 1% of room overall
        if (notes.reduce((a, b) => a + b, 0n) * 100n < amount * 101n) throw new Error("Not enough private HYPE for this bid (a bid paid from several notes needs about 1% of room).");
        let qLeft = opts.quantity;
        let first: Awaited<ReturnType<GloamPrivate["bidPrivately"]>> | undefined;
        let count = 0;
        const secrets: NonNullable<Awaited<ReturnType<GloamPrivate["bidPrivately"]>>["secrets"]> = [];
        for (const note of notes) {
          if (qLeft === 0n) break;
          // the most of the bid this note pays for, a little under the note so its fee and rounding fit
          let qi = (opts.quantity * ((note * 995n) / 1000n)) / amount;
          if (qi > qLeft) qi = qLeft;
          if (qi === 0n) continue;
          onStatus(`Bid ${count + 1}: one private note pays for each part`);
          const r = await this.bidPrivately(auction, { maxPrice: opts.maxPrice, quantity: qi, deposit: opts.deposit === undefined ? undefined : (opts.deposit * qi) / opts.quantity, single: true }, onStatus);
          first ??= r;
          secrets.push(r.secret);
          count++;
          qLeft -= qi;
        }
        if (!first || qLeft > 0n) throw new Error("Not enough private HYPE in your notes for this bid.");
        return { ...first, bids: count, secrets };
      }
    }
    const fallbackTo = this.cfg.receive ? await this.receiveAddress(0) : this.receiveKey(0).address;
    const { gloamBid } = await import("./gloamBids.js");
    const rec = await gloamBid(core, { bids: this.cfg.bids, auction, tick: q.tick, quantity: opts.quantity, tlockRound: s.tlockRound, amount, fallbackTo, exitAfter: BigInt(s.revealEnd) + 30n * 86_400n }, onStatus);
    this.remember({ kind: "bid", ...rec });
    const secret = { auction, bidder: rec.account, tick: rec.tick, quantity: rec.quantity, salt: rec.salt, id: 0n, deposit, commitment: "0x" as Hex, txHash: rec.txHash };
    return { secret, bidWallet: rec.account, n: 0, fundTx: rec.txHash };
  }

  private async feeBpsOf(c: GloamCore): Promise<bigint> {
    const k = lc(c.config.pool);
    if (!this.feeBps.has(k)) this.feeBps.set(k, BigInt(await this.cfg.publicClient.readContract({ address: c.config.pool, abi: VAULT, functionName: "withdrawFeeBps" })));
    return this.feeBps.get(k)!;
  }

  /** After settlement: every private bid in `auction` back into the vault (tokens and refund as notes). */
  async finishPrivateBids(auction: Address, onStatus: Status = () => {}): Promise<{ claimed: number; movedHype: bigint; movedTokens: bigint }> {
    const core = this.launchCore;
    if (!core || !this.cfg.records) return { claimed: 0, movedHype: 0n, movedTokens: 0n };
    const all = this.cfg.records.load();
    const mine = all.filter((r) => r.kind === "bid" && lc(r.key.auction) === lc(auction));
    const res = await finishPending(core, mine, { cores: this.cores }, onStatus);
    this.cfg.records.save([...all.filter((r) => !mine.includes(r)), ...res.waiting]);
    return { claimed: res.done.length, movedHype: 0n, movedTokens: 0n };
  }

  /** A bid placed from a wallet, its tokens claimed and moved into the private balance (the deposit is public). */
  async claimPrivately(wallet: WalletClient, auction: Address, bidId: bigint): Promise<{ txHash: Hex; tokens: bigint }> {
    const A = parseAbi(["function claim(uint256 bidId)", "function allocationOf(uint256) view returns (uint256 tokens, uint256 refund)", "function token() view returns (address)"]);
    const pub = this.cfg.publicClient;
    const [tokens] = await pub.readContract({ address: auction, abi: A, functionName: "allocationOf", args: [bidId] });
    if (tokens === 0n) throw new Error("this bid won no tokens");
    const token = await pub.readContract({ address: auction, abi: A, functionName: "token" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const h = await wallet.writeContract({ account: wallet.account!, chain: wallet.chain, address: auction, abi: A, functionName: "claim", args: [bidId] } as any);
    await pub.waitForTransactionReceipt({ hash: h });
    const txHash = await this.shieldToken(wallet, token, tokens);
    return { txHash, tokens };
  }

  /**
   * A withdrawal sent later in 2 to 4 pieces of different sizes, so the amount coming out doesn't match anything that
   * went in. Done now, on this device:
   *   1. private self-sends split the balance into one exact note per piece (one relayed send per piece that needs it),
   *   2. each piece's cash out is proved, its recipient and amount fixed by the proof.
   * Hand the pieces to the relayer with `scheduleRelay`: it can only send each one (after `notBefore`) or refuse it,
   * never change where it goes. Gloam's vault keeps every root valid, so a proof made now still works later. Spending
   * a piece's note before it goes out cancels that piece.
   * `token` is a launch token or asset, or hypeMarket.token for HYPE.
   */
  async planSplitWithdraw(token: Address, to: Address, amount: bigint, o: { pieces?: number; windowSecs?: number; onStatus?: Status } = {}): Promise<ScheduledPiece[]> {
    const onStatus = o.onStatus ?? (() => {});
    const k = Math.min(4, Math.max(2, o.pieces ?? 3));
    const windowSecs = Math.max(600, o.windowSecs ?? 3600);
    const asset = this.assetOf(token);
    const core = await this.coreFor(asset, amount);
    const amounts = splitAmount(amount, k);
    const notes: OwnedGloamNote[] = [];
    for (let i = 0; i < amounts.length; i++) {
      onStatus(`Splitting your balance privately (${i + 1} of ${amounts.length})…`);
      // a note already set aside for an earlier piece is never used again
      notes.push(await core.exactNote(asset, amounts[i], onStatus, new Set(notes.map((n) => n.commitment))));
    }
    // times are spread over the window by the chain's clock, not the device's
    const now = Number((await this.cfg.publicClient.getBlock()).timestamp);
    const times = Array.from({ length: notes.length }, () => now + 60 + Math.floor(Math.random() * (windowSecs - 60))).sort((a, b) => a - b);
    const out: ScheduledPiece[] = [];
    for (let i = 0; i < notes.length; i++) {
      onStatus(`Proving withdrawal ${i + 1} of ${notes.length}…`);
      const s = await core.spendProof(notes[i], to, onStatus);
      const data = encodeFunctionData({ abi: UNSHIELD, functionName: "unshield", args: [s.proof, s.root, s.nullifier, s.asset, to, s.amount] });
      out.push({ call: { kind: "gloamUnshield", to: core.config.pool, data, nullifier: s.nullifier }, notBefore: times[i], amount: s.amount, to });
    }
    return out;
  }

  // ── receive addresses (CloakGloamReceive) ─────────────────────────────

  /** The owner key of receive address `n`: made from the account's seed, so it says nothing about the account. */
  private receiveKey(n: number) {
    const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const k = BigInt(keccak256(encodeAbiParameters([{ type: "string" }, { type: "uint256" }, { type: "uint256" }], ["cloak-gloam-receive-v1", this.cores[0].keys.noteSeed, BigInt(n)])));
    return privateKeyToAccount(toHex((k % (N - 1n)) + 1n, { size: 32 }));
  }

  /**
   * Receive address `n` (0, 1, 2, … give unlinkable addresses): a public address anyone can pay HYPE or a listed
   * token, whose money collectReceived() moves into this account's private balance.
   */
  async receiveAddress(n = 0): Promise<Address> {
    if (!this.cfg.receive) throw new Error("Receive addresses aren't set up on this deployment yet.");
    return this.cfg.publicClient.readContract({ address: this.cfg.receive, abi: RECEIVE, functionName: "boxOf", args: [this.receiveKey(n).address, BigInt(n)] });
  }

  /**
   * Move what waits at receive address `n` into the private balance: one deposit per vault cap's worth, each a note of
   * exactly that amount, proved here, signed by the address's owner key, and sent by the relay. Run it on every open.
   * What a vault can't take now (not listed, cap full) stays at the address for next time.
   */
  async collectReceived(n = 0, onStatus: Status = () => {}): Promise<{ asset: Address; amount: bigint; txHash: Hex }[]> {
    const rx = this.cfg.receive;
    if (!rx) return [];
    const pub = this.cfg.publicClient;
    const key = this.receiveKey(n);
    const box = await this.receiveAddress(n);
    const ERC = parseAbi(["function balanceOf(address) view returns (uint256)"]);
    const LIMIT = parseAbi(["function depositLimit(address) view returns (uint128 perDeposit, uint128 total)", "function deposited(address) view returns (uint256)"]);
    const assets = [zeroAddress as Address, ...this.markets.filter((m) => lc(m.pool) !== lc(zeroAddress)).map((m) => m.pool)];
    const done: { asset: Address; amount: bigint; txHash: Hex }[] = [];
    for (const asset of assets) {
      let left = asset === zeroAddress ? await pub.getBalance({ address: box }) : await pub.readContract({ address: asset, abi: ERC, functionName: "balanceOf", args: [box] }).catch(() => 0n);
      for (const c of [...this.cores].reverse()) {
        while (left > 0n) {
          const [per, total] = await pub.readContract({ address: c.config.pool, abi: LIMIT, functionName: "depositLimit", args: [asset] });
          const dep = await pub.readContract({ address: c.config.pool, abi: LIMIT, functionName: "deposited", args: [asset] });
          const room = total > dep ? total - dep : 0n;
          let amount = left < per ? left : per;
          if (amount > room) amount = room;
          if (amount === 0n) break; // this vault can't take it now: try the next one, or leave it for later
          onStatus("Moving a payment into your private balance");
          const m = await c.depositFor(asset, amount);
          const digest = await pub.readContract({ address: rx, abi: RECEIVE, functionName: "shieldDigest", args: [box, c.config.pool, asset, amount, m.deposit.commitment] });
          const signature = await key.sign({ hash: digest });
          const txHash = await this.cfg.submit({ kind: "escrow", to: rx, data: encodeFunctionData({ abi: RECEIVE, functionName: "shield", args: [key.address, BigInt(n), c.config.pool, asset, amount, m.deposit.commitment, m.deposit.proof, signature] }) });
          c.track({ commitment: m.note.commitment, asset, amount, secret: m.note.secret });
          await announce(c, m.deposit.commitment, m.ticket, onStatus);
          done.push({ asset, amount, txHash });
          left -= amount;
        }
      }
    }
    return done;
  }

  // ── sync state kept on the device ──────────────────────────────────────

  /** Both vaults' sync state, for `importSync` after a reload (store it encrypted: it lists notes and their secrets). */
  exportSync(): string {
    return JSON.stringify({ v: 1, cores: this.cores.map((c) => c.exportState()) });
  }

  /** Loads `exportSync` output before the first sync, so only new blocks are read. */
  async importSync(data: string): Promise<boolean> {
    try {
      const o = JSON.parse(data) as { v?: number; cores?: Record<string, unknown>[] };
      if (o.v !== 1 || !Array.isArray(o.cores)) return false;
      const ok = await Promise.all(this.cores.map((c) => {
        const st = o.cores!.find((x) => x?.pool === c.config.pool.toLowerCase());
        return st ? c.importState(st) : Promise.resolve(false);
      }));
      return ok.some(Boolean);
    } catch {
      return false;
    }
  }

  /** Starts a vault's tree from the keeper's public leaf list (checked against a root the vault knows). */
  async seedLeaves(pool: Address, src: { block: bigint; leaves: { index: number; commitment: bigint }[] }): Promise<boolean> {
    const c = this.cores.find((x) => lc(x.config.pool) === lc(pool));
    return c ? c.seedLeaves(src) : false;
  }

  /** The vaults this account reads (for the keeper's leaf list). */
  vaults(): Address[] {
    return this.cores.map((c) => c.config.pool);
  }
}
