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
import { ACCOUNT_TYPED_DATA } from "../private/crypto.js";
import type { Status } from "../private/client.js";
import { GloamCore, gloamKeysFromSignature, type GloamCoreConfig, type OwnedGloamNote } from "./gloam.js";
import { finishPending, launchRoute, launchSwap, type LaunchRecord } from "./launchVault.js";
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
  /** CloakGloamBatcher on the launch vault. */
  batcher?: Address;
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
}

const ERC20 = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);
const VAULT = parseAbi(["function withdrawFeeBps() view returns (uint16)", "function launchTokensCount() view returns (uint256)", "function launchTokens(uint256) view returns (address)"]);
const V2 = parseAbi(["function factory() view returns (address)", "function getPair(address, address) view returns (address)", "function token0() view returns (address)", "function getReserves() view returns (uint112, uint112, uint32)"]);
const BATCH = parseAbi([
  "function place((bytes proof, bytes32 root, bytes32 nullifier, address asset, uint256 amount) s, (bytes32 nullifier, address token, bool buy, uint128 size, address ownerKey, address fallbackTo) k) returns (bytes32)",
  "function escrowFor((bytes32 nullifier, address token, bool buy, uint128 size, address ownerKey, address fallbackTo) k) view returns (address)",
  "function currentRound() view returns (uint64)",
  "function roundSecs() view returns (uint256)",
]);

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

  constructor(readonly cfg: GloamPrivateConfig, sig: Hex) {
    const keys = gloamKeysFromSignature(sig);
    const encPriv = toBytes(keccak256(encodeAbiParameters([{ type: "string" }, { type: "uint256" }], ["cloak-gloam-device-v1", keys.noteSeed])));
    this.keys = { encPriv, encPub: toBytes(keccak256(encPriv)) };
    const base = { publicClient: cfg.publicClient, chainId: cfg.chainId, payMemo: cfg.payMemo, provers: cfg.provers, submit: cfg.submit, logChunk: cfg.logChunk };
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
      for (let i = 0n; i < n; i++) {
        const token = await pub.readContract({ address: lv, abi: VAULT, functionName: "launchTokens", args: [i] });
        const [symbol, decimals] = await Promise.all([pub.readContract({ address: token, abi: ERC20, functionName: "symbol" }).catch(() => "token"), pub.readContract({ address: token, abi: ERC20, functionName: "decimals" }).catch(() => 18)]);
        const pair = factory ? await pub.readContract({ address: factory, abi: V2, functionName: "getPair", args: [this.cfg.whype, token] }).catch(() => null) : null;
        out.push({ token, pool: token, pair: pair && pair !== zeroAddress ? pair : null, symbol, decimals: Number(decimals) });
      }
    }
    for (const m of this.markets) if (!out.some((x) => lc(x.token) === lc(m.token))) out.push(m);
    this.markets = out;
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

  async address(): Promise<string> {
    return this.cores[0].address();
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

  /** This account's unspent notes in `pool`, both vaults (Gloam keeps no history of spent notes). */
  async history(pool: Address): Promise<(OwnedGloamNote & { spent: false })[]> {
    const asset = this.assetOf(pool);
    const out: (OwnedGloamNote & { spent: false })[] = [];
    for (const c of this.cores) {
      await c.sync();
      for (const n of c.ownNotes(asset)) out.push({ ...n, spent: false });
    }
    return out;
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
    const r = await c.send(asset, to, amount, onStatus);
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
  async sweep(token: Address, to: string, onStatus: Status = () => {}): Promise<{ txHash: Hex; amount: bigint; left: bigint }> {
    const asset = this.assetOf(token);
    let txHash: Hex | null = null;
    let amount = 0n;
    for (const c of this.cores) {
      await c.sync(onStatus);
      const have = c.ownNotes(asset).reduce((a, n) => a + n.amount, 0n);
      if (have === 0n) continue;
      const hs = to.startsWith("0x") ? await c.withdraw(asset, to as Address, "max", onStatus) : (await c.send(asset, to, have, onStatus)).txHashes;
      txHash ??= hs[hs.length - 1];
      amount += have;
    }
    if (!txHash) throw new Error("Nothing to move.");
    return { txHash, amount, left: await this.balance(asset) };
  }

  // ── trading (CloakLaunchSwap on the launch vault) ──────────────────────

  private async v2Quote(token: Address, side: "buy" | "sell", amountIn: bigint): Promise<bigint> {
    const pair = this.market(token).pair;
    if (!pair) throw new Error("This token has no pool to trade privately against yet.");
    const pub = this.cfg.publicClient;
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
    if (!core || !this.cfg.launchSwap) throw new Error("Private trading isn't set up on this deployment yet.");
    const onStatus = opts.onStatus ?? (() => {});
    const assetIn = side === "buy" ? zeroAddress : token;
    await core.sync(onStatus);
    if (core.ownNotes(assetIn).reduce((a, n) => a + n.amount, 0n) < amountIn) throw new Error("insufficient private balance in the trading vault (deposits made for trading land there)");
    const assetOut = side === "buy" ? token : zeroAddress;
    const released = await this.afterFee(assetIn, amountIn);
    const expected = await this.v2Quote(token, side, released);
    const amountOut = (expected * BigInt(10_000 - (opts.slippageBps ?? 100))) / 10_000n;
    if (amountOut === 0n) throw new Error("amount too small to trade");
    const path = side === "buy" ? [this.cfg.whype, token] : [token, this.cfg.whype];
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const rec = await launchSwap(core, { router: this.cfg.launchSwap, route: launchRoute(path), assetIn, amountIn, assetOut, amountOut, deadline }, onStatus);
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

  async roundInfo(): Promise<{ round: bigint; endsAt: number; roundSecs: number }> {
    if (!this.cfg.batcher) throw new Error("no batcher configured");
    const pub = this.cfg.publicClient;
    const [round, roundSecs] = await Promise.all([pub.readContract({ address: this.cfg.batcher, abi: BATCH, functionName: "currentRound" }), pub.readContract({ address: this.cfg.batcher, abi: BATCH, functionName: "roundSecs" })]);
    return { round, roundSecs: Number(roundSecs), endsAt: Number((round + 1n) * roundSecs) };
  }

  /**
   * Batched private buy or sell: standard-size orders (1, 2, 5 x 10^n), each a whole note spent into the batcher.
   * The remainder that isn't a standard size stays in the balance. Payouts come back on a later open.
   */
  async batch(token: Address, side: "buy" | "sell", amount: bigint, opts: { maxOrders?: number; onStatus?: Status } = {}) {
    const core = this.launchCore;
    if (!core || !this.cfg.batcher) throw new Error("no batcher configured");
    const onStatus = opts.onStatus ?? (() => {});
    const { sizes, rest } = standardSizes(amount, opts.maxOrders ?? 6);
    if (!sizes.length) throw new Error("amount too small for a standard-size order");
    const asset = side === "buy" ? zeroAddress : token;
    const orders: { id: bigint; size: bigint; round: bigint; txHash: Hex }[] = [];
    const pub = this.cfg.publicClient;
    for (let i = 0; i < sizes.length; i++) {
      onStatus(`Order ${i + 1}/${sizes.length}: preparing…`);
      const note = await core.exactNote(asset, sizes[i], onStatus);
      const nullifier = toHex(note.nullifier, { size: 32 });
      const { privateKeyToAccount } = await import("viem/accounts");
      const owner = privateKeyToAccount(core.exitKeyFor(nullifier)).address;
      const k = { nullifier, token, buy: side === "buy", size: sizes[i], ownerKey: owner, fallbackTo: owner };
      const escrow = await pub.readContract({ address: this.cfg.batcher, abi: BATCH, functionName: "escrowFor", args: [k] });
      const s = await core.spendProof(note, escrow, onStatus);
      onStatus(`Order ${i + 1}/${sizes.length}: relaying…`);
      const txHash = await this.cfg.submit({ kind: "escrow", to: this.cfg.batcher, data: encodeFunctionData({ abi: BATCH, functionName: "place", args: [s, k] }) });
      const round = await pub.readContract({ address: this.cfg.batcher, abi: BATCH, functionName: "currentRound" });
      orders.push({ id: BigInt(nullifier), size: sizes[i], round, txHash });
    }
    return { orders, rest };
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

  /** Bids from the private balance go through CloakGloamBids on Gloam, so no one-time bid wallets and no gas reserve. */
  async bidGasReserve(): Promise<bigint> {
    return 0n;
  }

  async bidWallets(_auction: Address): Promise<{ n: number; address: Address; wallet: WalletClient }[]> {
    return [];
  }

  async bidPrivately(_auction: Address, _opts: { maxPrice: bigint; quantity: bigint; deposit?: bigint }, _onStatus?: Status): Promise<never> {
    throw new Error(NOT_YET);
  }

  async claimPrivately(_wallet: WalletClient, _auction: Address, _bidId: bigint): Promise<{ txHash: Hex; tokens: bigint }> {
    throw new Error(NOT_YET);
  }

  async finishPrivateBids(_auction: Address, _onStatus?: Status, _shared?: unknown): Promise<{ claimed: number; movedHype: bigint; movedTokens: bigint }> {
    return { claimed: 0, movedHype: 0n, movedTokens: 0n };
  }

  async planSplitWithdraw(_token: Address, _to: Address, _amount: bigint, _o: { pieces: number; windowSecs: number; onStatus?: Status }): Promise<never[]> {
    throw new Error(NOT_YET);
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
