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
import { splitAmount, type ScheduledPiece, type Status } from "../private/client.js";
import { GloamCore, gloamKeysFromSignature, type GloamAccountKeys, type GloamCoreConfig, type OwnedGloamNote } from "./gloam.js";
import { announce, finishPending, launchRoute, launchRouteV4, launchSwap, type LaunchRecord } from "./launchVault.js";
import { notesFor, type HolderProver } from "./gloamProofs.js";
import { gloamFundsContext, type FundsProof } from "../private/funds.js";

export interface GloamPrivateConfig {
  publicClient: PublicClient;
  chainId: number;
  /** Gloam's vault (or omit it until Gloam's vault is live on this chain). */
  gloamVault?: { pool: Address; poolBlock: bigint };
  /** Cloak's launch vault. */
  launchVault?: { pool: Address; poolBlock: bigint };
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
  /** CloakGloamBatcher on the launch vault (rounds through Uniswap V2 pairs). */
  batcher?: Address;
  /** CloakGloamBatcherV4 on the launch vault: rounds through launches' own v4 pools (their CloakV4Market). */
  batcherV4?: Address;
  /** CloakGloamReceive: receive addresses anyone can pay, moved into the private balance by the app. */
  receive?: Address;
  /** CloakGloamBids on the launch vault: sealed bids paid from the private balance. */
  bids?: Address;
  /** A claim link's account: spend received payments directly, never sweep them (see GloamCoreConfig). */
  spendReceived?: boolean;
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
}

const ERC20 = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);
const VAULT = parseAbi(["function withdrawFeeBps() view returns (uint16)", "function launchTokensCount() view returns (uint256)", "function launchTokens(uint256) view returns (address)"]);
const V2 = parseAbi(["function factory() view returns (address)", "function getPair(address, address) view returns (address)", "function token0() view returns (address)", "function getReserves() view returns (uint112, uint112, uint32)"]);
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
export function standardSizesFor(amount: bigint, notes: bigint[], max: number): { sizes: bigint[]; rest: bigint } {
  const caps = notes.filter((n) => n > 0n).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  const sizes: bigint[] = [];
  let rest = amount;
  while (sizes.length < max && rest > 0n && caps.length) {
    const target = rest < caps[0] ? rest : caps[0];
    const sz = standardSizes(target, 1).sizes[0];
    if (!sz) break;
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
    const base = { publicClient: cfg.publicClient, chainId: cfg.chainId, payMemo: cfg.payMemo, provers: cfg.provers, submit: cfg.submit, logChunk: cfg.logChunk, spendReceived: cfg.spendReceived };
    this.cores = [cfg.gloamVault, cfg.launchVault].filter((v): v is { pool: Address; poolBlock: bigint } => !!v).map((v) => new GloamCore({ ...base, pool: v.pool, poolBlock: v.poolBlock }, keys));
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

  /** An asset with no launch market (USDC): its pool id is its token. */
  addAsset(a: { symbol: string; token: Address; decimals: number }): GloamMarket {
    const m: GloamMarket = { token: a.token, pool: a.token, pair: null, symbol: a.symbol, decimals: a.decimals };
    if (!this.markets.some((x) => lc(x.token) === lc(a.token))) this.markets.push(m);
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
  async syncAll(onStatus: Status = () => {}): Promise<void> {
    for (const c of this.cores) await c.sync(onStatus);
  }

  async balance(pool: Address): Promise<bigint> {
    const asset = this.assetOf(pool);
    let sum = 0n;
    for (const c of this.cores) {
      await c.sync();
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
      await c.sync();
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

  // ── in and out ─────────────────────────────────────────────────────────

  async shieldHype(wallet: WalletClient, amount: bigint): Promise<Hex> {
    const c = await this.depositCore(zeroAddress, amount);
    const hs = await c.shield(wallet, zeroAddress, amount);
    return hs[0];
  }

  async shieldToken(wallet: WalletClient, token: Address, amount: bigint, onStatus: Status = () => {}): Promise<Hex> {
    const c = await this.depositCore(token, amount);
    const hs = await c.shield(wallet, token, amount, onStatus);
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

  private async v2Quote(token: Address, side: "buy" | "sell", amountIn: bigint): Promise<bigint> {
    const m = this.market(token);
    const pair = m.pair;
    if (!pair) throw new Error("This token has no pool to trade privately against yet.");
    const pub = this.cfg.publicClient;
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

  async quote(token: Address, side: "buy" | "sell", amountIn: bigint): Promise<bigint> {
    return this.v2Quote(token, side, amountIn);
  }

  buy(token: Address, hypeIn: bigint, opts: { slippageBps?: number; onStatus?: Status } = {}) {
    return this.swap(token, "buy", hypeIn, opts);
  }

  sell(token: Address, tokensIn: bigint, opts: { slippageBps?: number; onStatus?: Status } = {}) {
    return this.swap(token, "sell", tokensIn, opts);
  }

  /**
   * Exact input from the private balance, exact output as a new note: the output is the quote on what the vault
   * releases, less the slippage allowance, and whatever the swap didn't need comes back as a note (finishPending).
   */
  private async swap(token: Address, side: "buy" | "sell", amountIn: bigint, opts: { slippageBps?: number; onStatus?: Status }) {
    const core = this.launchCore;
    const m = this.market(token);
    const router = m.v4 ? this.cfg.launchSwapV4 : this.cfg.launchSwap;
    if (!core || !router) throw new Error("Private trading isn't set up on this deployment yet.");
    const onStatus = opts.onStatus ?? (() => {});
    const assetIn = side === "buy" ? zeroAddress : token;
    await core.sync(onStatus);
    if (core.ownNotes(assetIn).reduce((a, n) => a + n.amount, 0n) < amountIn) throw new Error("insufficient private balance in the trading vault (deposits made for trading land there)");
    const assetOut = side === "buy" ? token : zeroAddress;
    const released = await this.afterFee(assetIn, amountIn);
    const expected = await this.v2Quote(token, side, released);
    const amountOut = (expected * BigInt(10_000 - (opts.slippageBps ?? 100))) / 10_000n;
    if (amountOut === 0n) throw new Error("amount too small to trade");
    // V2: the path through WHYPE. v4: the launch's own pool key (native HYPE, behind Cloak's hook)
    const route = m.v4
      ? launchRouteV4([await this.cfg.publicClient.readContract({ address: m.pair!, abi: V4MARKET, functionName: "key" })])
      : launchRoute(side === "buy" ? [this.cfg.whype, token] : [token, this.cfg.whype]);
    // the chain's clock, not this device's: the contract checks the deadline against block time
    const deadline = (await this.cfg.publicClient.getBlock()).timestamp + 600n;
    const rec = await launchSwap(core, { router, route, assetIn, amountIn, assetOut, amountOut, deadline }, onStatus);
    this.remember(rec);
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
    const res = await finishPending(core, this.cfg.records.load(), {}, onStatus);
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
    const core = this.launchCore;
    if (!core) throw new Error("no batcher configured");
    const batcher = await this.batcherFor(token);
    const onStatus = opts.onStatus ?? (() => {});
    const asset = side === "buy" ? zeroAddress : token;
    await core.sync(onStatus);
    const { sizes, rest } = standardSizesFor(amount, core.ownNotes(asset).map((n) => n.amount), opts.maxOrders ?? 6);
    if (!sizes.length) throw new Error("amount too small for a standard-size order");
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
      this.updateRecord(id, { txHash });
      orders.push({ id: BigInt(id), size: sizes[i], round, txHash });
    }
    return { orders, rest };
  }

  private addRecord(r: LaunchRecord) {
    if (!this.cfg.records) return;
    this.cfg.records.save([...this.cfg.records.load(), r]);
  }

  private updateRecord(id: Hex, patch: { txHash: Hex }) {
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
  async bidPrivately(auction: Address, opts: { maxPrice: bigint; quantity: bigint; deposit?: bigint }, onStatus: Status = () => {}) {
    const core = this.launchCore;
    if (!core || !this.cfg.bids) throw new Error(NOT_YET);
    const { Cloak } = await import("../cloak.js");
    const reader = new Cloak(this.cfg.publicClient as never);
    const s = await reader.getAuction(auction);
    if (s.phase !== "commit") throw new Error("commit phase is over");
    const q = reader.quoteBid(s, opts.maxPrice, opts.quantity);
    const deposit = opts.deposit ?? q.deposit;
    if (deposit < q.cost) throw new Error("deposit is below the bid's cost");
    // what arrives at the bid account is the note less the vault's fee: send enough that the deposit lands in full
    const bps = await this.feeBpsOf(core);
    const amount = (deposit * 10_000n + (10_000n - bps) - 1n) / (10_000n - bps);
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
  async finishPrivateBids(auction: Address, onStatus: Status = () => {}, _shared?: unknown): Promise<{ claimed: number; movedHype: bigint; movedTokens: bigint }> {
    const core = this.launchCore;
    if (!core || !this.cfg.records) return { claimed: 0, movedHype: 0n, movedTokens: 0n };
    const all = this.cfg.records.load();
    const mine = all.filter((r) => r.kind === "bid" && lc(r.key.auction) === lc(auction));
    const res = await finishPending(core, mine, {}, onStatus);
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

  // ── what Cloak's own vaults had and Gloam's don't ──────────────────────

  exportSync(): string {
    return "";
  }

  async importSync(): Promise<boolean> {
    return false;
  }

  async seedLeaves(): Promise<boolean> {
    return false;
  }

  async migrateFrom(): Promise<never[]> {
    return [];
  }
}
