import { encodeAbiParameters, parseEventLogs, type Address, type Hex, type PublicClient } from "viem";
import { cloakPairAbi, privateBatcherAbi, privateRouterAbi, shieldedPoolAbi } from "../abis.js";
import type { Wallet } from "../cloak.js";
import {
  ACCOUNT_MESSAGE,
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
import { ORDER_DATA_ABI, SWAP_DATA_ABI, buildTransaction, selectNotes, splitStandard, type ExtData, type OwnedNote } from "./tx.js";

/** A shielded call the relayer submits so the trader's wallet never appears on-chain. */
export interface RelayCall {
  kind: "privateSwap" | "unshieldHype" | "transact" | "placeOrder";
  pool: Address;
  proof: ProofArgs;
  extData: ExtData;
}
export type Submitter = (call: RelayCall) => Promise<Hex>;

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

/** POST shielded calls to a Cloak relayer (`services/keeper` serves `/relay`). */
export function relayerSubmitter(url: string): Submitter {
  return async (call) => {
    const res = await fetch(`${url.replace(/\/$/, "")}/relay`, { method: "POST", headers: { "content-type": "application/json" }, body: json(call) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error ?? `relay failed (${res.status})`);
    return out.txHash as Hex;
  };
}

/** Submit from a wallet directly — works, but that wallet pays gas and appears as the sender. Use for tests/relayers. */
export function walletSubmitter(publicClient: PublicClient, wallet: Wallet, router: Address, batcher?: Address): Submitter {
  return async (call) => {
    // viem cannot infer the nested tuple types through the union; the shapes match the ABI exactly.
    const req =
      call.kind === "placeOrder"
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
 * Gloam-style private trading for Cloak launch tokens on Elysium.
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
  ) {}

  /** Ask the wallet to sign the account message and derive the private keys from it. */
  static async keysFromWallet(wallet: Wallet): Promise<CloakKeys> {
    const sig = await wallet.signMessage({ account: wallet.account, message: ACCOUNT_MESSAGE });
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
      s.notes.push({ ...note, leafIndex: l.index, keyIndex: m.keyIndex, privKey: k.privKey, commitment: l.commitment, nullifier: await nullifierOf(note, l.index, k.privKey), spent: false });
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

  private async tree(pool: Address): Promise<MerkleTree> {
    const s = this.state(pool);
    const t = new MerkleTree();
    for (const l of s.leaves.slice(0, s.scannedUpTo)) await t.insert(l.commitment);
    return t;
  }

  private async changeOutput(amount: bigint) {
    const main = await this.keys.main();
    return { amount, pubKey: main.pubKey, memo: (b: bigint) => encryptFullMemo(this.keys.encPub, amount, b, MAIN_KEY) };
  }

  private async dummy() {
    const main = await this.keys.main();
    return { dummyPubKey: main.pubKey, dummyMemo: (b: bigint) => encryptFullMemo(this.keys.encPub, 0n, b, MAIN_KEY) };
  }

  /** Get 1–2 notes covering `target`, merging notes privately first when the balance is spread across many. */
  private async inputsFor(pool: Address, target: bigint, onStatus: Status): Promise<OwnedNote[]> {
    for (let round = 0; round < 6; round++) {
      const live = await this.sync(pool);
      const pick = selectNotes(live, target);
      if ("inputs" in pick) return pick.inputs;
      onStatus("Combining private notes first…");
      const total = pick.merge.reduce((a, x) => a + x.amount, 0n);
      const { proof, extData } = await buildTransaction({
        tree: await this.tree(pool),
        inputs: pick.merge,
        outputs: [await this.changeOutput(total)],
        ...(await this.dummy()),
        prover: await this.prover(),
      });
      await this.submit({ kind: "transact", pool, proof, extData });
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
      const inputs = await this.inputsFor(poolIn, size, onStatus);
      const keyIndex = randomKeyIndex();
      const outKey = await this.keys.key(keyIndex);
      const outBlinding = randomField();
      const data = encodeAbiParameters(ORDER_DATA_ABI, [
        { token, outPubKey: outKey.pubKey, outBlinding, outMemo: encryptRouterMemo(this.keys.encPub, outBlinding, keyIndex) },
      ]);
      const change = inputs.reduce((a, x) => a + x.amount, 0n) - size;
      onStatus(`Order ${i + 1}/${sizes.length}: proving on this device…`);
      const { proof, extData } = await buildTransaction({
        tree: await this.tree(poolIn),
        inputs,
        outputs: change > 0n ? [await this.changeOutput(change)] : [],
        extAmount: -size,
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
    const inputs = await this.inputsFor(poolIn, amountIn, onStatus);
    const expected = await this.quote(token, side, amountIn);
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
    const change = inputs.reduce((a, x) => a + x.amount, 0n) - amountIn;
    onStatus("Generating zero-knowledge proof on this device…");
    const { proof, extData } = await buildTransaction({
      tree: await this.tree(poolIn),
      inputs,
      outputs: change > 0n ? [await this.changeOutput(change)] : [],
      extAmount: -amountIn,
      recipient: this.router,
      data,
      ...(await this.dummy()),
      prover: await this.prover(),
    });
    onStatus("Relaying private trade…");
    const txHash = await this.submit({ kind: "privateSwap", pool: poolIn, proof, extData });
    return { txHash, expectedOut: expected, minOut };
  }

  /** Private HYPE → native HYPE at `to` (use a fresh address to stay unlinkable). */
  async unshieldHype(to: Address, amount: bigint, onStatus: Status = () => {}): Promise<Hex> {
    const pool = this.hypeMarket.pool;
    const inputs = await this.inputsFor(pool, amount, onStatus);
    const change = inputs.reduce((a, x) => a + x.amount, 0n) - amount;
    onStatus("Generating zero-knowledge proof on this device…");
    const { proof, extData } = await buildTransaction({
      tree: await this.tree(pool),
      inputs,
      outputs: change > 0n ? [await this.changeOutput(change)] : [],
      extAmount: -amount,
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
   * Private transfer inside a pool: sender, recipient and amount all stay hidden (Gloam/Veil-style payment).
   * `token` = a launch token, or the WHYPE address / hypeMarket.token for HYPE.
   */
  async send(token: Address, to: string, amount: bigint, onStatus: Status = () => {}): Promise<Hex> {
    const rcpt = parseCloakAddress(to);
    const pool = this.market(token).pool;
    const inputs = await this.inputsFor(pool, amount, onStatus);
    const change = inputs.reduce((a, x) => a + x.amount, 0n) - amount;
    const outputs = [{ amount, pubKey: rcpt.pubKey, memo: (b: bigint) => encryptFullMemo(rcpt.encPub, amount, b, MAIN_KEY) }];
    if (change > 0n) outputs.push(await this.changeOutput(change));
    onStatus("Generating zero-knowledge proof on this device…");
    const { proof, extData } = await buildTransaction({
      tree: await this.tree(pool),
      inputs,
      outputs,
      ...(await this.dummy()),
      prover: await this.prover(),
    });
    onStatus("Relaying private transfer…");
    return this.submit({ kind: "transact", pool, proof, extData });
  }

  /** Private launch tokens → any address. */
  async unshieldToken(token: Address, to: Address, amount: bigint, onStatus: Status = () => {}): Promise<Hex> {
    const pool = this.market(token).pool;
    const inputs = await this.inputsFor(pool, amount, onStatus);
    const change = inputs.reduce((a, x) => a + x.amount, 0n) - amount;
    onStatus("Generating zero-knowledge proof on this device…");
    const { proof, extData } = await buildTransaction({
      tree: await this.tree(pool),
      inputs,
      outputs: change > 0n ? [await this.changeOutput(change)] : [],
      extAmount: -amount,
      recipient: to,
      ...(await this.dummy()),
      prover: await this.prover(),
    });
    return this.submit({ kind: "transact", pool, proof, extData });
  }
}
