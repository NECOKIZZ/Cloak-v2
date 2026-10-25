import { encodeAbiParameters, parseEventLogs, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { cloakMigratorAbi, cloakPairAbi, privateBatcherAbi, privateRouterAbi, shieldedPoolAbi } from "../abis.js";
import type { Wallet } from "../cloak.js";
import {
  ACCOUNT_MESSAGE,
  ACCOUNT_TYPED_DATA,
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
  pair: Address | null; // null for the WHYPE pool
  symbol?: string;
}

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
    if (call.kind === "migrate" && !migrator) throw new Error("no migrator configured");
    const req =
      call.kind === "migrate"
        ? { address: migrator!, abi: cloakMigratorAbi, functionName: "migrate", args: [call.pool, call.proof, call.extData] }
        : call.kind === "placeOrder"
        ? { address: batcher!, abi: privateBatcherAbi, functionName: "placeOrder", args: [call.pool, call.proof, call.extData] }
        : call.kind === "privateSwap"
          ? { address: router, abi: privateRouterAbi, functionName: "privateSwap", args: [call.pool, call.proof, call.extData] }
          : call.kind === "unshieldHype"
            ? { address: router, abi: privateRouterAbi, functionName: "unshieldHype", args: [call.proof, call.extData] }
            : { address: call.pool, abi: shieldedPoolAbi, functionName: "transact", args: [call.proof, call.extData] };
    if (call.kind === "placeOrder" && !batcher) throw new Error("no batcher configured");
    // Pad the estimate: state can change between estimation and inclusion (e.g. an order landing in a new batch round
    // writes fresh storage, ~60k more gas). Unused gas is refunded.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const est = await publicClient.estimateContractGas({ ...req, account: wallet.account } as any);
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
   * Derive the private keys from one EIP-712 signature bound to this chain and router, so a signature asked for by any
   * other site or contract can't reproduce them. With `verify`, the wallet signs twice and the keys are refused if the
   * two signatures differ (some smart and MPC wallets sign differently each time, which would hide earlier notes).
   */
  static async keysFromWallet(wallet: Wallet, opts: { chainId: number; router: Address; verify?: boolean }): Promise<CloakKeys> {
    const req = { account: wallet.account!, ...ACCOUNT_TYPED_DATA(opts.chainId, opts.router) };
    const sig = await wallet.signTypedData(req);
    if (opts.verify) {
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

  async loadMarkets(): Promise<PrivateMarket[]> {
    const c = { address: this.router, abi: privateRouterAbi } as const;
    const n = await this.publicClient.readContract({ ...c, functionName: "tokensCount" });
    const out: PrivateMarket[] = [];
    for (let i = 0n; i < n; i++) {
      const token = await this.publicClient.readContract({ ...c, functionName: "tokens", args: [i] });
      const [pool, pair] = await Promise.all([
        this.publicClient.readContract({ ...c, functionName: "poolOf", args: [token] }),
        this.publicClient.readContract({ ...c, functionName: "pairOf", args: [token] }),
      ]);
      out.push({ token, pool, pair: i === 0n ? null : pair });
    }
    this.markets = out;
    return out;
  }

  get hypeMarket(): PrivateMarket {
    const m = this.markets[0];
    if (!m) throw new Error("call loadMarkets() first");
    return m;
  }

  market(token: Address): PrivateMarket {
    const m = this.markets.find((x) => x.token.toLowerCase() === token.toLowerCase());
    if (!m) throw new Error("no private market for this token (createPool after settlement)");
    return m;
  }

  private state(pool: Address): PoolState {
    let s = this.pools.get(pool.toLowerCase());
    if (!s) {
      s = { leaves: [], scannedUpTo: 0, fromBlock: this.fromBlock, notes: [] };
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
    const { sizes, rest } = splitStandard(amount, opts.maxOrders ?? 6);
    if (sizes.length === 0) throw new Error("amount too small for a standard-size order");
    const placed: { id: bigint; size: bigint; round: bigint; txHash: Hex }[] = [];
    for (let i = 0; i < sizes.length; i++) {
      const size = sizes[i];
      onStatus(`Order ${i + 1}/${sizes.length}: syncing…`);
      const q = await this.relayFee("placeOrder", poolIn);
      const inputs = await this.inputsFor(poolIn, size + q.fee, onStatus);
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
   * `token` = a launch token, or the WHYPE address / hypeMarket.token for HYPE.
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

  /** Private launch tokens → any address. */
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
   * the migrator, which deposits the same amount here as a new note for one of this account's one-time keys.
   */
  async migrateFrom(legacy: CloakPrivate, onStatus: Status = () => {}): Promise<{ token: Address; amount: bigint; txHash: Hex }[]> {
    const moved: { token: Address; amount: bigint; txHash: Hex }[] = [];
    const markets = await legacy.loadMarkets();
    await this.loadMarkets();
    for (const m of markets) {
      if (!this.markets.some((x) => x.token.toLowerCase() === m.token.toLowerCase())) continue; // no pool here yet
      for (;;) {
        const live = (await legacy.sync(m.pool)).sort((a, b) => (a.amount > b.amount ? -1 : 1));
        if (!live.length) break;
        const inputs = live.slice(0, 2);
        const total = inputs.reduce((a, x) => a + x.amount, 0n);
        const q = await legacy.relayFee("migrate", m.pool);
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
          recipient: this.migratorAddress(),
          data,
          ...(await legacy.dummy()),
          prover: await this.prover(),
        });
        onStatus(`Moving ${m.symbol ?? "balance"}: relaying…`);
        const txHash = await this.submit({ kind: "migrate", pool: m.pool, proof, extData });
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
