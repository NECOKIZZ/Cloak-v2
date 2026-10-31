import { encodeAbiParameters, parseEventLogs, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { cloakAuctionAbi, cloakMigratorAbi, cloakPairAbi, privateBatcherAbi, privateRouterAbi, shieldedPoolAbi } from "../abis.js";
import type { Wallet } from "../cloak.js";
import {
  ACCOUNT_MESSAGE,
  ACCOUNT_TYPED_DATA,
  ROUTER_ACCOUNT_TYPED_DATA,
  CloakKeys,
  MAIN_KEY,
  noteCommitment,
  encryptFullMemo,
  encryptRouterMemo,
  formatCloakAddress,
  nullifierOf,
  parseCloakAddress,
  randomField,
  randomKeyIndex,
  readMemo,
} from "./crypto.js";
import { MerkleTree } from "./tree.js";
import type { ProofArgs, Prover } from "./prover.js";
import { MOVE_DATA_ABI, ORDER_DATA_ABI, SWAP_DATA_ABI, buildTransaction, selectNotes, splitStandard, type ExtData, type OwnedNote } from "./tx.js";

/** A shielded call the relayer submits so the trader's wallet never appears on-chain. */
export type RelayKind = "privateSwap" | "unshieldHype" | "transact" | "placeOrder" | "migrate";
export interface RelayCall {
  kind: RelayKind;
  pool: Address;
  proof: ProofArgs;
  extData: ExtData;
  /** For `migrate`: the migrator from the pool's deployment into this one (the proof pays out to it). */
  migrator?: Address;
}
/** What a relayer charges for one call, paid out of the pool's own token inside the proof. */
export interface RelayQuote {
  relayer: Address;
  fee: bigint;
}
export type Submitter = ((call: RelayCall) => Promise<Hex>) & {
  /** The relayer's fee for a call of this kind on this pool. Without it, calls carry no fee. */
  quote?: (kind: RelayKind, pool: Address) => Promise<RelayQuote>;
};

/** Leaf positions per tree epoch (a pool starts a new tree after 2^20 leaves). */
const EPOCH_BITS = 20;
const epochOf = (globalIndex: number) => Math.floor(globalIndex / 2 ** EPOCH_BITS);
const positionOf = (globalIndex: number) => globalIndex % 2 ** EPOCH_BITS;

export interface PrivateMarket {
  token: Address;
  pool: Address;
  pair: Address | null; // null for the WHYPE pool and for assets without a launch market (USDC)
  symbol?: string;
  /** Token decimals (18 for HYPE and launch tokens; 6 for USDC). */
  decimals?: number;
}

/** A shielded pool for an existing token (such as USDC) that lives next to the router, not in its launch registry. */
export interface PrivateAsset {
  symbol: string;
  token: Address;
  pool: Address;
  decimals: number;
  /** Block the pool was deployed in: its events are scanned from here. */
  fromBlock: bigint;
}

const ERC20_ABI = [
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

interface PoolState {
  leaves: { index: number; commitment: bigint; memo: Hex }[];
  scannedUpTo: number;
  fromBlock: bigint;
  notes: OwnedNote[];
}

const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

/** POST shielded calls to a Cloak relayer (`services/keeper` serves `/relay` and `/quote`). */
export function relayerSubmitter(url: string): Submitter {
  const base = url.replace(/\/$/, "");
  const submit: Submitter = async (call) => {
    const res = await fetch(`${base}/relay`, { method: "POST", headers: { "content-type": "application/json" }, body: json(call) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error ?? `relay failed (${res.status})`);
    return out.txHash as Hex;
  };
  submit.quote = async (kind, pool) => {
    const res = await fetch(`${base}/quote?kind=${kind}&pool=${pool}`);
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error ?? `relayer quote failed (${res.status})`);
    return { relayer: out.relayer as Address, fee: BigInt(out.fee) };
  };
  return submit;
}

/** Submit from a wallet directly — works, but that wallet pays gas and appears as the sender. Use for tests/relayers. */
export function walletSubmitter(publicClient: PublicClient, wallet: Wallet, router: Address, batcher?: Address, migrator?: Address): Submitter {
  return async (call) => {
    // viem cannot infer the nested tuple types through the union; the shapes match the ABI exactly.
    const mig = call.migrator ?? migrator;
    if (call.kind === "migrate" && !mig) throw new Error("no migrator configured");
    const req =
      call.kind === "migrate"
        ? { address: mig!, abi: cloakMigratorAbi, functionName: "migrate", args: [call.pool, call.proof, call.extData] }
        : call.kind === "placeOrder"
        ? { address: batcher!, abi: privateBatcherAbi, functionName: "placeOrder", args: [call.pool, call.proof, call.extData] }
        : call.kind === "privateSwap"
          ? { address: router, abi: privateRouterAbi, functionName: "privateSwap", args: [call.pool, call.proof, call.extData] }
          : call.kind === "unshieldHype"
            ? { address: router, abi: privateRouterAbi, functionName: "unshieldHype", args: [call.proof, call.extData] }
            : { address: call.pool, abi: shieldedPoolAbi, functionName: "transact", args: [call.proof, call.extData] };
    if (call.kind === "placeOrder" && !batcher) throw new Error("no batcher configured");
    // Pad the estimate: state can change between estimation and inclusion (e.g. an order landing in a new batch round
    // writes fresh storage, ~60k more gas). Unused gas is refunded. Estimate from the address, not the local account:
    // with a local account viem estimates twice, the second time capped at the first result, so a round turning over
    // in between made that second estimate run out of gas.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const est = await publicClient.estimateContractGas({ ...req, account: wallet.account!.address } as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hash = await wallet.writeContract({ ...req, gas: (est * 13n) / 10n + 100_000n } as any);
    const r = await publicClient.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`shielded call reverted: ${hash}`);
    return hash;
  };
}

export type Status = (msg: string) => void;

/**
 * Private trading for Cloak launch tokens on Elysium.
 *
 *   shieldHype   public HYPE → private balance (one-time key, so deposits are unlinkable)
 *   buy / sell   private balance → launch token / back, via the PrivateRouter and the launch's CloakPair,
 *                proven on this device and submitted by a relayer
 *   unshield     private HYPE → any address
 */
export class CloakPrivate {
  private pools = new Map<string, PoolState>();
  markets: PrivateMarket[] = [];
  /** Shielded pools outside the launch registry (USDC). Send, unshieldToken and shieldToken work on these too. */
  assets: (PrivateMarket & { fromBlock: bigint })[] = [];

  constructor(
    readonly publicClient: PublicClient,
    readonly router: Address,
    readonly keys: CloakKeys,
    readonly prover: () => Promise<Prover>,
    readonly submit: Submitter,
    readonly fromBlock = 0n,
    readonly batcher?: Address,
    readonly migrator?: Address,
  ) {}

  /**
   * Derive the wallet's Cloak private account from one EIP-712 signature bound to this chain (never to a contract, so
   * the account survives every upgrade). With `verify`, the wallet signs twice and the keys are refused if the two
   * signatures differ (some smart and MPC wallets sign differently each time, which would hide earlier notes).
   */
  static async keysFromWallet(wallet: Wallet, opts: { chainId: number; verify?: boolean }): Promise<CloakKeys> {
    return CloakPrivate.signedKeys(wallet, ACCOUNT_TYPED_DATA(opts.chainId), opts.verify);
  }

  /** Keys of a v2 or v3 account, bound to that deployment's router. Only needed to move an old balance across. */
  static async routerKeysFromWallet(wallet: Wallet, opts: { chainId: number; router: Address }): Promise<CloakKeys> {
    return CloakPrivate.signedKeys(wallet, ROUTER_ACCOUNT_TYPED_DATA(opts.chainId, opts.router), false);
  }

  /** The keys an earlier deployment's notes were made for: v1 a plain message, v2 and v3 their router, v4 on the account. */
  static async keysForVersion(wallet: Wallet, opts: { chainId: number; version: number; router: Address }): Promise<CloakKeys> {
    if (opts.version <= 1) return CloakPrivate.legacyKeysFromWallet(wallet);
    if (opts.version <= 3) return CloakPrivate.routerKeysFromWallet(wallet, opts);
    return CloakPrivate.keysFromWallet(wallet, opts);
  }

  private static async signedKeys(
    wallet: Wallet,
    typed: ReturnType<typeof ACCOUNT_TYPED_DATA> | ReturnType<typeof ROUTER_ACCOUNT_TYPED_DATA>,
    verify?: boolean,
  ): Promise<CloakKeys> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req = { account: wallet.account!, ...typed } as any;
    const sig = await wallet.signTypedData(req);
    if (verify) {
      const again = await wallet.signTypedData(req);
      if (again.toLowerCase() !== sig.toLowerCase()) {
        throw new Error("This wallet gives a different signature each time, so it can't hold a Cloak private account. Use a standard wallet such as MetaMask or Rabby.");
      }
    }
    return CloakKeys.fromSignature(sig);
  }

  /** Keys of the first Cloak deployment (plain signed message). Only needed to move an old balance across. */
  static async legacyKeysFromWallet(wallet: Wallet): Promise<CloakKeys> {
    const sig = await wallet.signMessage({ account: wallet.account!, message: ACCOUNT_MESSAGE });
    return CloakKeys.fromSignature(sig);
  }

  /**
   * Read the router's vaults: HYPE first, then every launch market. A vault without a launch pair (USDC) is an asset,
   * not a market, and is added to `assets` instead.
   */
  async loadMarkets(): Promise<PrivateMarket[]> {
    const c = { address: this.router, abi: privateRouterAbi } as const;
    const [n, whype] = await Promise.all([
      this.publicClient.readContract({ ...c, functionName: "tokensCount" }),
      this.publicClient.readContract({ ...c, functionName: "whype" }),
    ]);
    const tokens = await Promise.all(Array.from({ length: Number(n) }, (_, i) => this.publicClient.readContract({ ...c, functionName: "tokens", args: [BigInt(i)] })));
    const rows = await Promise.all(
      tokens.map((token) =>
        Promise.all([
          this.publicClient.readContract({ ...c, functionName: "poolOf", args: [token] }),
          this.publicClient.readContract({ ...c, functionName: "pairOf", args: [token] }),
        ]),
      ),
    );
    const out: PrivateMarket[] = [];
    let hype: PrivateMarket | undefined;
    for (let i = 0; i < tokens.length; i++) {
      const [pool, pair] = rows[i];
      const token = tokens[i];
      if (token.toLowerCase() === whype.toLowerCase()) hype = { token, pool, pair: null };
      else if (pair !== zeroAddress) out.push({ token, pool, pair });
      else if (!this.assets.some((a) => a.pool.toLowerCase() === pool.toLowerCase())) {
        const [symbol, decimals] = await Promise.all([
          this.publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" }).catch(() => "?"),
          this.publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" }).catch(() => 18),
        ]);
        this.addAsset({ symbol, token, pool, decimals: Number(decimals), fromBlock: this.fromBlock });
      }
    }
    if (!hype) throw new Error("the router has no HYPE vault");
    this.markets = [hype, ...out];
    return this.markets;
  }

  get hypeMarket(): PrivateMarket {
    const m = this.markets[0];
    if (!m) throw new Error("call loadMarkets() first");
    return m;
  }

  market(token: Address): PrivateMarket {
    const t = token.toLowerCase();
    const m = this.markets.find((x) => x.token.toLowerCase() === t) ?? this.assets.find((x) => x.token.toLowerCase() === t);
    if (!m) throw new Error("no private market for this token (createPool after settlement)");
    return m;
  }

  /** Register a shielded pool that isn't a launch market, such as USDC (`deploymentFor(chainId).assets`). */
  addAsset(a: PrivateAsset): PrivateMarket {
    const existing = this.assets.find((x) => x.pool.toLowerCase() === a.pool.toLowerCase());
    if (existing) return existing;
    const m = { token: a.token, pool: a.pool, pair: null, symbol: a.symbol, decimals: a.decimals, fromBlock: a.fromBlock };
    this.assets.push(m);
    return m;
  }

  private state(pool: Address): PoolState {
    let s = this.pools.get(pool.toLowerCase());
    if (!s) {
      const asset = this.assets.find((x) => x.pool.toLowerCase() === pool.toLowerCase());
      s = { leaves: [], scannedUpTo: 0, fromBlock: asset?.fromBlock ?? this.fromBlock, notes: [] };
      this.pools.set(pool.toLowerCase(), s);
    }
    return s;
  }

  /** Pull new leaves from the pool's events, trial-decrypt them, and refresh spent flags. */
  async sync(pool: Address): Promise<OwnedNote[]> {
    const s = this.state(pool);
    const latest = await this.publicClient.getBlockNumber({ cacheTime: 0 });
    if (latest >= s.fromBlock) {
      const logs = await this.publicClient.getContractEvents({
        address: pool,
        abi: shieldedPoolAbi,
        eventName: "NewCommitment",
        fromBlock: s.fromBlock,
        toBlock: latest,
        strict: true,
      });
      const known = new Set(s.leaves.map((l) => l.index));
      for (const l of logs) {
        const index = Number(l.args.index);
        if (!known.has(index)) s.leaves.push({ index, commitment: l.args.commitment, memo: l.args.encryptedOutput });
      }
      s.leaves.sort((a, b) => a.index - b.index);
      s.fromBlock = latest + 1n;
    }
    // only the contiguous prefix forms a valid tree
    let n = 0;
    while (n < s.leaves.length && s.leaves[n].index === n) n++;
    for (const l of s.leaves.slice(s.scannedUpTo, n)) {
      const m = readMemo(this.keys.encPriv, l.memo);
      if (!m || m.amount === 0n) continue;
      const k = await this.keys.key(m.keyIndex);
      const note = { amount: m.amount, pubKey: k.pubKey, blinding: m.blinding };
      if ((await noteCommitment(note)) !== l.commitment) continue; // forged memo → ignored
      const pos = positionOf(l.index);
      s.notes.push({ ...note, leafIndex: pos, epoch: epochOf(l.index), keyIndex: m.keyIndex, privKey: k.privKey, commitment: l.commitment, nullifier: await nullifierOf(note, pos, k.privKey), spent: false });
    }
    s.scannedUpTo = n;
    const flags = await Promise.all(
      s.notes.map((x) => (x.spent ? true : this.publicClient.readContract({ address: pool, abi: shieldedPoolAbi, functionName: "isSpent", args: [x.nullifier] }))),
    );
    s.notes.forEach((x, i) => (x.spent = Boolean(flags[i])));
    return s.notes.filter((x) => !x.spent);
  }

  async balance(pool: Address): Promise<bigint> {
    return (await this.sync(pool)).reduce((a, x) => a + x.amount, 0n);
  }

  /** The most a single relayed call of this kind can move from `pool`: the balance minus the relayer's fee. */
  async maxSpendable(pool: Address, kind: RelayKind = "transact"): Promise<bigint> {
    const [notes, q, m] = await Promise.all([this.sync(pool), this.relayFee(kind, pool), this.relayFee("transact", pool)]);
    // a transaction takes at most two notes, so using the k largest notes costs k-2 combining steps first (dust notes
    // aren't worth one); the fee is re-quoted when sending, so keep a 25% cushion on every fee
    const sorted = notes.map((n) => n.amount).sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
    let best = 0n;
    let sum = 0n;
    for (let k = 1; k <= sorted.length; k++) {
      sum += sorted[k - 1];
      const spendable = sum - (q.fee * 5n) / 4n - (BigInt(Math.max(0, k - 2)) * m.fee * 5n) / 4n;
      if (spendable > best) best = spendable;
    }
    return best;
  }

  /** The Merkle tree of one epoch (default: the epoch the given notes live in, else the newest). */
  private async tree(pool: Address, epoch?: number): Promise<MerkleTree> {
    const s = this.state(pool);
    const leaves = s.leaves.slice(0, s.scannedUpTo);
    const e = epoch ?? (leaves.length ? epochOf(leaves[leaves.length - 1].index) : 0);
    const t = new MerkleTree();
    for (const l of leaves) if (epochOf(l.index) === e) await t.insert(l.commitment);
    return t;
  }

  treeFor(pool: Address, inputs: OwnedNote[]) {
    return this.tree(pool, inputs.length ? inputs[0].epoch : undefined);
  }

  /** The relayer's fee for this call (0 when submitting from a wallet). */
  async relayFee(kind: RelayKind, pool: Address): Promise<RelayQuote> {
    return this.submit.quote ? this.submit.quote(kind, pool) : { relayer: zeroAddress, fee: 0n };
  }

  /** What a withdrawal of `amount` from `pool` delivers after the protocol's withdrawal fee. */
  async afterFee(pool: Address, amount: bigint): Promise<bigint> {
    // pools of the first deployment have no withdrawal fee (and no afterFee)
    return this.publicClient.readContract({ address: pool, abi: shieldedPoolAbi, functionName: "afterFee", args: [amount] }).catch(() => amount);
  }

  private async changeOutput(amount: bigint) {
    const main = await this.keys.main();
    return { amount, pubKey: main.pubKey, memo: (b: bigint) => encryptFullMemo(this.keys.encPub, amount, b, MAIN_KEY) };
  }

  async dummy() {
    const main = await this.keys.main();
    return { dummyPubKey: main.pubKey, dummyMemo: (b: bigint) => encryptFullMemo(this.keys.encPub, 0n, b, MAIN_KEY) };
  }

  /**
   * Get 1–2 notes (from one tree epoch) covering `target`, merging notes privately first when the balance is spread
   * across many. Each merge is a relayed transaction and pays the relayer's fee from the merged notes.
   */
  private async inputsFor(pool: Address, target: bigint, onStatus: Status): Promise<OwnedNote[]> {
    for (let round = 0; round < 6; round++) {
      const live = await this.sync(pool);
      const byEpoch = new Map<number, OwnedNote[]>();
      for (const n of live) byEpoch.set(n.epoch ?? 0, [...(byEpoch.get(n.epoch ?? 0) ?? []), n]);
      const sum = (ns: OwnedNote[]) => ns.reduce((a, x) => a + x.amount, 0n);
      const groups = [...byEpoch.values()].sort((a, b) => (sum(b) > sum(a) ? 1 : -1));
      if (!groups.length || sum(groups[0]) < target) {
        throw new Error(sum(live) >= target ? "balance is split across tree epochs: send it in two parts" : "insufficient private balance");
      }
      const pick = selectNotes(groups[0], target);
      if ("inputs" in pick) return pick.inputs;
      onStatus("Combining private notes first…");
      const q = await this.relayFee("transact", pool);
      const total = sum(pick.merge) - q.fee;
      const { proof, extData } = await buildTransaction({
        tree: await this.treeFor(pool, pick.merge),
        inputs: pick.merge,
        outputs: [await this.changeOutput(total)],
        fee: q.fee,
        relayer: q.relayer,
        ...(await this.dummy()),
        prover: await this.prover(),
      });
      const h = await this.submit({ kind: "transact", pool, proof, extData });
      await this.publicClient.waitForTransactionReceipt({ hash: h });
    }
    throw new Error("too many notes to combine");
  }

  // ───────────── public → private ─────────────

  /** Public HYPE → private balance. This one step is public (your wallet deposits); everything after is not. */
  async shieldHype(wallet: Wallet, amount: bigint): Promise<Hex> {
    const keyIndex = randomKeyIndex();
    const k = await this.keys.key(keyIndex);
    const blinding = randomField();
    const hash = await wallet.writeContract({
      address: this.router,
      abi: privateRouterAbi,
      functionName: "shieldHype",
      args: [k.pubKey, blinding, encryptRouterMemo(this.keys.encPub, blinding, keyIndex)],
      value: amount,
    });
    const r = await this.publicClient.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error("shield reverted");
    return hash;
  }

  /**
   * Public tokens → private balance, for any pool this client knows (USDC, or a launch token). Like shieldHype, this
   * one step is public and lands on a one-time key. Asks the wallet to approve the pool first if needed.
   */
  async shieldToken(wallet: Wallet, token: Address, amount: bigint, onStatus: Status = () => {}): Promise<Hex> {
    if (amount <= 0n) throw new Error("amount must be positive");
    const pool = this.market(token).pool;
    const owner = wallet.account!.address;
    // check first, so a wallet without the tokens doesn't pay gas for an approval that leads nowhere
    const held = await this.publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [owner] });
    if (held < amount) throw new Error(`insufficient token balance in wallet: has ${held}, needs ${amount}`);
    const allowance = await this.publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "allowance", args: [owner, pool] });
    if (allowance < amount) {
      onStatus("Approve the deposit in your wallet…");
      const a = await wallet.writeContract({ address: token, abi: ERC20_ABI, functionName: "approve", args: [pool, amount] });
      const ar = await this.publicClient.waitForTransactionReceipt({ hash: a });
      if (ar.status !== "success") throw new Error("approve reverted");
    }
    const keyIndex = randomKeyIndex();
    const k = await this.keys.key(keyIndex);
    const blinding = randomField();
    onStatus("Confirm the deposit in your wallet…");
    const hash = await wallet.writeContract({
      address: pool,
      abi: shieldedPoolAbi,
      functionName: "depositTo",
      args: [k.pubKey, amount, blinding, encryptFullMemo(this.keys.encPub, amount, blinding, keyIndex)],
    });
    const r = await this.publicClient.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error("shield reverted");
    return hash;
  }

  /**
   * Claim a won sealed bid straight into the private vault (v4 launches): the tokens become a note for a one-time key,
   * so later trades can't be linked to the bid. Sent from the bidder's wallet (only the bidder can claim this way); the
   * HYPE refund, if any, still goes to the wallet. The token's vault must exist (the keeper opens it at settlement).
   */
  async claimPrivately(wallet: Wallet, auction: Address, bidId: bigint): Promise<{ txHash: Hex; tokens: bigint }> {
    const [tokens] = await this.publicClient.readContract({ address: auction, abi: cloakAuctionAbi, functionName: "allocationOf", args: [bidId] });
    if (tokens === 0n) throw new Error("this bid won no tokens");
    const keyIndex = randomKeyIndex();
    const k = await this.keys.key(keyIndex);
    const blinding = randomField();
    const hash = await wallet.writeContract({
      address: auction,
      abi: cloakAuctionAbi,
      functionName: "claimPrivate",
      args: [bidId, k.pubKey, blinding, encryptFullMemo(this.keys.encPub, tokens, blinding, keyIndex)],
    });
    const r = await this.publicClient.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error("private claim reverted");
    return { txHash: hash, tokens };
  }

  // ───────────── batch auctions (hide trade size) ─────────────

  async roundInfo(): Promise<{ round: bigint; endsAt: number; roundSecs: number }> {
    if (!this.batcher) throw new Error("no batcher configured");
    const c = { address: this.batcher, abi: privateBatcherAbi } as const;
    const [round, roundSecs] = await Promise.all([
      this.publicClient.readContract({ ...c, functionName: "currentRound" }),
      this.publicClient.readContract({ ...c, functionName: "roundSecs" }),
    ]);
    return { round, roundSecs: Number(roundSecs), endsAt: Number((round + 1n) * roundSecs) };
  }

  /**
   * Batched private buy/sell. The amount is split into standard-size orders (1, 2, 5 × 10ⁿ), each placed from the
   * private balance by the relayer into the current round. When the round ends, buys and sells cross at the pool's
   * mid-price and only the net trades through the pool; outputs arrive as private notes. Observers can't tell how
   * much any one trader moved. Any remainder that isn't a standard size stays in your private balance.
   */
  async batch(token: Address, side: "buy" | "sell", amount: bigint, opts: { maxOrders?: number; onStatus?: Status } = {}) {
    if (!this.batcher) throw new Error("no batcher configured");
    const onStatus = opts.onStatus ?? (() => {});
    const m = this.market(token);
    const poolIn = side === "buy" ? this.hypeMarket.pool : m.pool;
    const maxOrders = opts.maxOrders ?? 6;
    let { sizes, rest } = splitStandard(amount, maxOrders);
    // each order also pays the relayer's fee from the same balance: if the orders plus their fees don't fit (say, when
    // selling everything), shrink the orders so they do
    const fee = (await this.relayFee("placeOrder", poolIn)).fee;
    if (fee > 0n) {
      const have = await this.balance(poolIn);
      // headroom: the fee is re-quoted before every order (gas moves), and combining notes first costs one more fee
      const reserve = (n: number) => (fee * BigInt(n) * 5n) / 4n + fee;
      if (sizes.reduce((a, x) => a + x, 0n) + reserve(sizes.length) > have) {
        const budget = have - reserve(maxOrders);
        if (budget <= 0n) throw new Error("insufficient private balance");
        ({ sizes } = splitStandard(budget < amount ? budget : amount, maxOrders));
        rest = amount - sizes.reduce((a, x) => a + x, 0n);
      }
    }
    if (sizes.length === 0) throw new Error("amount too small for a standard-size order");
    const placed: { id: bigint; size: bigint; round: bigint; txHash: Hex }[] = [];
    for (let i = 0; i < sizes.length; i++) {
      const size = sizes[i];
      onStatus(`Order ${i + 1}/${sizes.length}: syncing…`);
      const q = await this.relayFee("placeOrder", poolIn);
      let inputs: OwnedNote[];
      try {
        inputs = await this.inputsFor(poolIn, size + q.fee, onStatus);
      } catch (e) {
        // if fees rose mid-way, keep the orders already placed and leave the rest in the balance
        if (!placed.length || !/insufficient private balance/.test(String((e as Error).message))) throw e;
        rest += sizes.slice(i).reduce((a, x) => a + x, 0n);
        break;
      }
      const keyIndex = randomKeyIndex();
      const outKey = await this.keys.key(keyIndex);
      const outBlinding = randomField();
      const data = encodeAbiParameters(ORDER_DATA_ABI, [
        { token, outPubKey: outKey.pubKey, outBlinding, outMemo: encryptRouterMemo(this.keys.encPub, outBlinding, keyIndex) },
      ]);
      const change = inputs.reduce((a, x) => a + x.amount, 0n) - size - q.fee;
      onStatus(`Order ${i + 1}/${sizes.length}: proving on this device…`);
      const { proof, extData } = await buildTransaction({
        tree: await this.treeFor(poolIn, inputs),
        inputs,
        outputs: change > 0n ? [await this.changeOutput(change)] : [],
        extAmount: -size,
        fee: q.fee,
        relayer: q.relayer,
        recipient: this.batcher,
        data,
        ...(await this.dummy()),
        prover: await this.prover(),
      });
      onStatus(`Order ${i + 1}/${sizes.length}: relaying…`);
      const txHash = await this.submit({ kind: "placeOrder", pool: poolIn, proof, extData });
      const rc = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
      const ev = parseEventLogs({ abi: privateBatcherAbi, logs: rc.logs, eventName: "OrderPlaced" })[0];
      placed.push({ id: ev.args.id, size, round: ev.args.round, txHash });
    }
    return { orders: placed, rest };
  }

  // ───────────── private trades ─────────────

  async quote(token: Address, side: "buy" | "sell", amountIn: bigint): Promise<bigint> {
    const pair = this.market(token).pair!;
    const [rH, rT] = await Promise.all([
      this.publicClient.readContract({ address: pair, abi: cloakPairAbi, functionName: "reserveHype" }),
      this.publicClient.readContract({ address: pair, abi: cloakPairAbi, functionName: "reserveToken" }),
    ]);
    return this.publicClient.readContract({ address: pair, abi: cloakPairAbi, functionName: "getAmountOut", args: side === "buy" ? [amountIn, rH, rT] : [amountIn, rT, rH] });
  }

  /** Private buy: spend private HYPE, receive private tokens. `slippageBps` defaults to 1%. */
  buy(token: Address, hypeIn: bigint, opts: { slippageBps?: number; onStatus?: Status } = {}) {
    return this.swap(token, "buy", hypeIn, opts);
  }

  /** Private sell: spend private tokens, receive private HYPE. */
  sell(token: Address, tokensIn: bigint, opts: { slippageBps?: number; onStatus?: Status } = {}) {
    return this.swap(token, "sell", tokensIn, opts);
  }

  private async swap(token: Address, side: "buy" | "sell", amountIn: bigint, opts: { slippageBps?: number; onStatus?: Status }) {
    const onStatus = opts.onStatus ?? (() => {});
    const m = this.market(token);
    const poolIn = side === "buy" ? this.hypeMarket.pool : m.pool;
    const poolOut = side === "buy" ? m.pool : this.hypeMarket.pool;
    onStatus("Syncing your private balance…");
    const q = await this.relayFee("privateSwap", poolIn);
    const inputs = await this.inputsFor(poolIn, amountIn + q.fee, onStatus);
    // the router trades what the pool releases after its withdrawal fee
    const expected = await this.quote(token, side, await this.afterFee(poolIn, amountIn));
    const minOut = (expected * BigInt(10_000 - (opts.slippageBps ?? 100))) / 10_000n;
    const keyIndex = randomKeyIndex();
    const outKey = await this.keys.key(keyIndex);
    const outBlinding = randomField();
    const data = encodeAbiParameters(SWAP_DATA_ABI, [
      {
        pair: m.pair!,
        poolOut,
        minOut,
        outPubKey: outKey.pubKey,
        outBlinding,
        outMemo: encryptRouterMemo(this.keys.encPub, outBlinding, keyIndex),
        deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
      },
    ]);
    const change = inputs.reduce((a, x) => a + x.amount, 0n) - amountIn - q.fee;
    onStatus("Generating zero-knowledge proof on this device…");
    const { proof, extData } = await buildTransaction({
      tree: await this.treeFor(poolIn, inputs),
      inputs,
      outputs: change > 0n ? [await this.changeOutput(change)] : [],
      extAmount: -amountIn,
      fee: q.fee,
      relayer: q.relayer,
      recipient: this.router,
      data,
      ...(await this.dummy()),
      prover: await this.prover(),
    });
    onStatus("Relaying private trade…");
    const txHash = await this.submit({ kind: "privateSwap", pool: poolIn, proof, extData });
    return { txHash, expectedOut: expected, minOut, relayerFee: q.fee };
  }

  /** Private HYPE → native HYPE at `to` (use a fresh address to stay unlinkable). */
  async unshieldHype(to: Address, amount: bigint, onStatus: Status = () => {}): Promise<Hex> {
    const pool = this.hypeMarket.pool;
    const q = await this.relayFee("unshieldHype", pool);
    const inputs = await this.inputsFor(pool, amount + q.fee, onStatus);
    const change = inputs.reduce((a, x) => a + x.amount, 0n) - amount - q.fee;
    onStatus("Generating zero-knowledge proof on this device…");
    const { proof, extData } = await buildTransaction({
      tree: await this.treeFor(pool, inputs),
      inputs,
      outputs: change > 0n ? [await this.changeOutput(change)] : [],
      extAmount: -amount,
      fee: q.fee,
      relayer: q.relayer,
      recipient: this.router,
      data: encodeAbiParameters([{ type: "address" }], [to]),
      ...(await this.dummy()),
      prover: await this.prover(),
    });
    onStatus("Relaying withdrawal…");
    return this.submit({ kind: "unshieldHype", pool, proof, extData });
  }

  /** Your receiving address for private transfers. */
  async address(): Promise<string> {
    return formatCloakAddress((await this.keys.main()).pubKey, this.keys.encPub);
  }

  /**
   * Private transfer inside a pool: sender, recipient and amount all stay hidden.
   * `token` = a launch token, an asset such as USDC, or the WHYPE address / hypeMarket.token for HYPE.
   */
  async send(token: Address, to: string, amount: bigint, onStatus: Status = () => {}): Promise<Hex> {
    const rcpt = parseCloakAddress(to);
    const pool = this.market(token).pool;
    const q = await this.relayFee("transact", pool);
    const inputs = await this.inputsFor(pool, amount + q.fee, onStatus);
    const change = inputs.reduce((a, x) => a + x.amount, 0n) - amount - q.fee;
    const outputs = [{ amount, pubKey: rcpt.pubKey, memo: (b: bigint) => encryptFullMemo(rcpt.encPub, amount, b, MAIN_KEY) }];
    if (change > 0n) outputs.push(await this.changeOutput(change));
    onStatus("Generating zero-knowledge proof on this device…");
    const { proof, extData } = await buildTransaction({
      tree: await this.treeFor(pool, inputs),
      inputs,
      outputs,
      fee: q.fee,
      relayer: q.relayer,
      ...(await this.dummy()),
      prover: await this.prover(),
    });
    onStatus("Relaying private transfer…");
    return this.submit({ kind: "transact", pool, proof, extData });
  }

  /** Private tokens (a launch token, or an asset such as USDC) → any address. */
  async unshieldToken(token: Address, to: Address, amount: bigint, onStatus: Status = () => {}): Promise<Hex> {
    const pool = this.market(token).pool;
    const q = await this.relayFee("transact", pool);
    const inputs = await this.inputsFor(pool, amount + q.fee, onStatus);
    const change = inputs.reduce((a, x) => a + x.amount, 0n) - amount - q.fee;
    onStatus("Generating zero-knowledge proof on this device…");
    const { proof, extData } = await buildTransaction({
      tree: await this.treeFor(pool, inputs),
      inputs,
      outputs: change > 0n ? [await this.changeOutput(change)] : [],
      extAmount: -amount,
      fee: q.fee,
      relayer: q.relayer,
      recipient: to,
      ...(await this.dummy()),
      prover: await this.prover(),
    });
    return this.submit({ kind: "transact", pool, proof, extData });
  }

  // ───────────── moving a balance from an earlier deployment ─────────────

  /**
   * Move every private balance `legacy` (a client on the earlier router, with the earlier keys) can see into this
   * deployment, note by note, through `CloakMigrator`. Each move is one relayed transaction: the old proof withdraws to
   * the migrator, which deposits the same amount here as a new note for one of this account's one-time keys. Each
   * earlier deployment has its own migrator into this one: pass it as `opts.migrator` (default: `this.migrator`).
   */
  async migrateFrom(legacy: CloakPrivate, onStatus: Status = () => {}, opts: { migrator?: Address } = {}): Promise<{ token: Address; amount: bigint; txHash: Hex }[]> {
    const migrator = opts.migrator ?? this.migratorAddress();
    const moved: { token: Address; amount: bigint; txHash: Hex }[] = [];
    const markets = [...(await legacy.loadMarkets()), ...legacy.assets];
    await this.loadMarkets();
    const here = [...this.markets, ...this.assets];
    for (const m of markets) {
      if (!here.some((x) => x.token.toLowerCase() === m.token.toLowerCase())) continue; // no vault here yet
      for (;;) {
        const live = (await legacy.sync(m.pool)).sort((a, b) => (a.amount > b.amount ? -1 : 1));
        if (!live.length) break;
        const inputs = live.slice(0, 2);
        const total = inputs.reduce((a, x) => a + x.amount, 0n);
        const q = await this.relayFee("migrate", m.pool); // quoted by the relayer that will submit it
        if (total <= q.fee) break; // dust that costs more to move than it's worth
        const amount = total - q.fee;
        const keyIndex = randomKeyIndex();
        const outKey = await this.keys.key(keyIndex);
        const outBlinding = randomField();
        const data = encodeAbiParameters(MOVE_DATA_ABI, [
          { outPubKey: outKey.pubKey, outBlinding, outMemo: encryptRouterMemo(this.keys.encPub, outBlinding, keyIndex) },
        ]);
        onStatus(`Moving ${m.symbol ?? "balance"}: proving on this device…`);
        const { proof, extData } = await buildTransaction({
          tree: await legacy.treeFor(m.pool, inputs),
          inputs,
          outputs: [],
          extAmount: -amount,
          fee: q.fee,
          relayer: q.relayer,
          recipient: migrator,
          data,
          ...(await legacy.dummy()),
          prover: await this.prover(),
        });
        onStatus(`Moving ${m.symbol ?? "balance"}: relaying…`);
        const txHash = await this.submit({ kind: "migrate", pool: m.pool, proof, extData, migrator });
        await this.publicClient.waitForTransactionReceipt({ hash: txHash });
        moved.push({ token: m.token, amount, txHash });
      }
    }
    return moved;
  }

  private migratorAddress(): Address {
    if (!this.migrator) throw new Error("no migrator configured");
    return this.migrator;
  }
}
