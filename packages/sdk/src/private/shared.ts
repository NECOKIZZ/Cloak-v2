import { encodeAbiParameters, formatEther, keccak256, zeroAddress, type Address, type Hex } from "viem";
import { cloakAuctionAbi, cloakPairAbi, sharedRouterAbi, sharedVaultAbi } from "../abis.js";
import { Cloak, type Wallet } from "../cloak.js";
import { MAIN_KEY, encryptFullMemo, encryptRouterMemo, noteCommitment, nullifierOf, parseCloakAddress, randomField, randomKeyIndex, readMemo } from "./crypto.js";
import { MerkleTree } from "./tree.js";
import type { ProofArgs, Prover } from "./prover.js";
import { buildTransaction, selectNotes, type ExtData, type OwnedNote } from "./tx.js";
import type { CloakPrivate, RelayQuote, Status } from "./client.js";

/**
 * The shared launch-token vault (testnet experiment): one private vault for every Cloak launch token that opens on
 * Uniswap from now on, next to the single-token vaults of HYPE and USDC.
 *
 *   shield    wallet tokens → private note (one-time key)
 *   buy       private HYPE → private token, through the launch's Uniswap pool
 *   sell      private token → private HYPE
 *   send      private token → any cloak: address, and nobody can tell WHICH token moved: the vault sees a send with no
 *             fee, and the relayer is paid from the sender's private HYPE in the same transaction
 *   unshield  private token → any address
 *
 * Each note holds one token (Poseidon(amount, pubKey, blinding, token)), and every proof spends and creates notes of a
 * single token only. Uses the account's keys, HYPE vault and relayer from `CloakPrivate`.
 */

export const SHARED_SWAP_DATA_ABI = [
  {
    type: "tuple",
    components: [
      { name: "token", type: "address" },
      { name: "minOut", type: "uint256" },
      { name: "outPubKey", type: "uint256" },
      { name: "outBlinding", type: "uint256" },
      { name: "outMemo", type: "bytes" },
      { name: "deadline", type: "uint64" },
    ],
  },
] as const;

export type SharedRelayKind = "sharedTransact" | "sharedBuy" | "sharedSell" | "sharedSend";
export interface SharedRelayCall {
  kind: SharedRelayKind;
  /** The shared-vault proof (or, for sharedBuy, the HYPE vault proof). */
  proof: ProofArgs;
  extData: ExtData;
  /** sharedSend only: the HYPE vault proof that pays the relayer. */
  feeProof?: ProofArgs;
  feeExtData?: ExtData;
}
export type SharedSubmitter = ((call: SharedRelayCall) => Promise<Hex>) & {
  /** The relayer's fee: in HYPE for sharedBuy and sharedSend, in the token for sharedTransact and sharedSell. */
  quote?: (kind: SharedRelayKind, token: Address) => Promise<RelayQuote>;
};

const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

/** POST shared-vault calls to a Cloak relayer (`services/keeper` serves `/relay-shared` and `/quote-shared`). */
export function sharedRelayerSubmitter(url: string): SharedSubmitter {
  const base = url.replace(/\/$/, "");
  const submit: SharedSubmitter = async (call) => {
    const res = await fetch(`${base}/relay-shared`, { method: "POST", headers: { "content-type": "application/json" }, body: json(call) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error ?? `relay failed (${res.status})`);
    return out.txHash as Hex;
  };
  submit.quote = async (kind, token) => {
    const res = await fetch(`${base}/quote-shared?kind=${kind}&token=${token}`);
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error ?? `relayer quote failed (${res.status})`);
    return { relayer: out.relayer as Address, fee: BigInt(out.fee) };
  };
  return submit;
}

/** Submit shared-vault calls from a wallet (that wallet pays gas and appears as the sender). For tests and relayers. */
export function sharedWalletSubmitter(priv: CloakPrivate, wallet: Wallet, vault: Address, router: Address): SharedSubmitter {
  return async (call) => {
    const req =
      call.kind === "sharedTransact"
        ? { address: vault, abi: sharedVaultAbi, functionName: "transact", args: [call.proof, call.extData] }
        : call.kind === "sharedBuy"
          ? { address: router, abi: sharedRouterAbi, functionName: "buy", args: [call.proof, call.extData] }
          : call.kind === "sharedSell"
            ? { address: router, abi: sharedRouterAbi, functionName: "sell", args: [call.proof, call.extData] }
            : { address: router, abi: sharedRouterAbi, functionName: "send", args: [call.proof, call.extData, call.feeProof, call.feeExtData] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const est = await priv.publicClient.estimateContractGas({ ...req, account: wallet.account!.address } as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hash = await wallet.writeContract({ ...req, gas: (est * 13n) / 10n + 100_000n } as any);
    const r = await priv.publicClient.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`shared-vault call reverted: ${hash}`);
    return hash;
  };
}

export interface SharedToken {
  token: Address;
  market: Address;
  symbol: string;
}

const ERC20 = [
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

const EPOCH = 2 ** 20;
const asNum = (t: Address) => BigInt(t);

export class SharedVaultClient {
  tokens: SharedToken[] = [];
  private leaves: { index: number; commitment: bigint; memo: Hex }[] = [];
  private scannedUpTo = 0;
  private notes: OwnedNote[] = [];
  private nextBlock: bigint;

  constructor(
    readonly priv: CloakPrivate,
    readonly vault: Address,
    readonly router: Address,
    readonly prover: () => Promise<Prover>,
    readonly submit: SharedSubmitter,
    readonly fromBlock = 0n,
  ) {
    this.nextBlock = fromBlock;
  }

  private get pub() {
    return this.priv.publicClient;
  }

  /** Every token admitted to the vault, with its Uniswap market. */
  async loadTokens(): Promise<SharedToken[]> {
    const c = { address: this.vault, abi: sharedVaultAbi } as const;
    const n = Number(await this.pub.readContract({ ...c, functionName: "tokensCount" }));
    for (let i = this.tokens.length; i < n; i++) {
      const token = await this.pub.readContract({ ...c, functionName: "tokens", args: [BigInt(i)] });
      const [market, symbol] = await Promise.all([
        this.pub.readContract({ ...c, functionName: "marketOf", args: [token] }),
        this.pub.readContract({ address: token, abi: ERC20, functionName: "symbol" }).catch(() => "?"),
      ]);
      this.tokens.push({ token, market, symbol });
    }
    return this.tokens;
  }

  /** Whether `token` is in the shared vault (reads the vault's list if it isn't known yet). */
  async isAdmitted(token: Address): Promise<boolean> {
    const has = () => this.tokens.some((t) => t.token.toLowerCase() === token.toLowerCase());
    if (!has()) await this.loadTokens();
    return has();
  }

  private info(token: Address): SharedToken {
    const t = this.tokens.find((x) => x.token.toLowerCase() === token.toLowerCase());
    if (!t) throw new Error("this token isn't in the shared vault");
    return t;
  }

  /** Let a settled Uniswap launch's token into the vault (anyone can; costs gas). */
  async admit(wallet: Wallet, factory: Address, launchIndex: bigint): Promise<Hex> {
    const h = await wallet.writeContract({ address: this.vault, abi: sharedVaultAbi, functionName: "admit", args: [factory, launchIndex], account: wallet.account!, chain: wallet.chain });
    const r = await this.pub.waitForTransactionReceipt({ hash: h });
    if (r.status !== "success") throw new Error("admit reverted");
    await this.loadTokens();
    return h;
  }

  /** Pull new notes, find which are ours and which token each holds, refresh spent flags. */
  async sync(): Promise<OwnedNote[]> {
    if (!this.tokens.length) await this.loadTokens();
    const latest = await this.pub.getBlockNumber({ cacheTime: 0 });
    if (latest >= this.nextBlock) {
      const logs = await this.pub.getContractEvents({ address: this.vault, abi: sharedVaultAbi, eventName: "NewCommitment", fromBlock: this.nextBlock, toBlock: latest, strict: true });
      const known = new Set(this.leaves.map((l) => l.index));
      for (const l of logs) {
        const index = Number(l.args.index);
        if (!known.has(index)) this.leaves.push({ index, commitment: l.args.commitment, memo: l.args.encryptedOutput });
      }
      this.leaves.sort((a, b) => a.index - b.index);
      this.nextBlock = latest + 1n;
    }
    let n = 0;
    while (n < this.leaves.length && this.leaves[n].index === n) n++;
    let reloaded = false;
    for (const l of this.leaves.slice(this.scannedUpTo, n)) {
      const m = readMemo(this.priv.keys.encPriv, l.memo);
      if (!m || m.amount === 0n) continue;
      const k = await this.priv.keys.key(m.keyIndex);
      const base = { amount: m.amount, pubKey: k.pubKey, blinding: m.blinding };
      // the memo doesn't say which token: the commitment does, so try each admitted token
      let asset: bigint | undefined;
      for (let pass = 0; pass < 2 && asset === undefined; pass++) {
        for (const t of this.tokens) if ((await noteCommitment({ ...base, asset: asNum(t.token) })) === l.commitment) { asset = asNum(t.token); break; }
        if (asset === undefined && !reloaded) { await this.loadTokens(); reloaded = true; } else break;
      }
      if (asset === undefined) continue; // not ours, or a forged memo
      const note = { ...base, asset };
      const pos = l.index % EPOCH;
      this.notes.push({ ...note, leafIndex: pos, epoch: Math.floor(l.index / EPOCH), keyIndex: m.keyIndex, privKey: k.privKey, commitment: l.commitment, nullifier: await nullifierOf(note, pos, k.privKey), spent: false });
    }
    this.scannedUpTo = n;
    const flags = await Promise.all(this.notes.map((x) => (x.spent ? true : this.pub.readContract({ address: this.vault, abi: sharedVaultAbi, functionName: "isSpent", args: [x.nullifier] }))));
    this.notes.forEach((x, i) => (x.spent = Boolean(flags[i])));
    return this.notes.filter((x) => !x.spent);
  }

  /** Private balance of `token` in the shared vault. */
  async balance(token: Address): Promise<bigint> {
    const t = asNum(token);
    return (await this.sync()).filter((x) => x.asset === t).reduce((a, x) => a + x.amount, 0n);
  }

  /** Every token this account holds privately in the shared vault. */
  async balances(): Promise<{ token: Address; symbol: string; amount: bigint }[]> {
    const live = await this.sync();
    return this.tokens.map((t) => ({ token: t.token, symbol: t.symbol, amount: live.filter((x) => x.asset === asNum(t.token)).reduce((a, x) => a + x.amount, 0n) })).filter((x) => x.amount > 0n);
  }

  /** The most one withdrawal (or sell) of `token` can take: the balance minus the relayer's fee (with a 25% cushion). */
  async maxWithdraw(token: Address, kind: "sharedTransact" | "sharedSell" = "sharedTransact"): Promise<bigint> {
    const [bal, q] = await Promise.all([this.balance(token), this.quote(kind, token)]);
    const max = bal - (q.fee * 5n) / 4n;
    return max > 0n ? max : 0n;
  }

  private async tree(epoch: number): Promise<MerkleTree> {
    const t = new MerkleTree();
    for (const l of this.leaves.slice(0, this.scannedUpTo)) if (Math.floor(l.index / EPOCH) === epoch) await t.insert(l.commitment);
    return t;
  }

  private async quote(kind: SharedRelayKind, token: Address): Promise<RelayQuote> {
    return this.submit.quote ? this.submit.quote(kind, token) : { relayer: zeroAddress, fee: 0n };
  }

  /** 1–2 notes of `token` covering `target`, combining notes first (a relayed send to yourself) when needed. */
  private async inputsFor(token: Address, target: bigint, onStatus: Status): Promise<OwnedNote[]> {
    const asset = asNum(token);
    for (let round = 0; round < 6; round++) {
      const live = (await this.sync()).filter((x) => x.asset === asset);
      const epoch = live.length ? Math.max(...live.map((x) => x.epoch ?? 0)) : 0;
      const mine = live.filter((x) => (x.epoch ?? 0) === epoch);
      const sum = mine.reduce((a, x) => a + x.amount, 0n);
      if (sum < target) throw new Error("insufficient private balance");
      const pick = selectNotes(mine, target);
      if ("inputs" in pick) return pick.inputs;
      onStatus("Combining private notes first…");
      const q = await this.quote("sharedTransact", token);
      const total = pick.merge.reduce((a, x) => a + x.amount, 0n) - q.fee;
      const { proof, extData } = await buildTransaction({
        tree: await this.tree(epoch),
        inputs: pick.merge,
        outputs: [await this.priv.changeOutput(total)],
        fee: q.fee,
        relayer: q.relayer,
        asset,
        publicAsset: asset,
        ...(await this.priv.dummy()),
        prover: await this.prover(),
      });
      await this.pub.waitForTransactionReceipt({ hash: await this.submit({ kind: "sharedTransact", proof, extData }) });
    }
    throw new Error("too many notes to combine");
  }

  /** Expected output of a swap through `token`'s Uniswap market (0.3% fee), before slippage. */
  async quoteSwap(token: Address, side: "buy" | "sell", amountIn: bigint): Promise<bigint> {
    const m = this.info(token).market;
    const [rH, rT] = await Promise.all([
      this.pub.readContract({ address: m, abi: cloakPairAbi, functionName: "reserveHype" }),
      this.pub.readContract({ address: m, abi: cloakPairAbi, functionName: "reserveToken" }),
    ]);
    const [rIn, rOut] = side === "buy" ? [rH, rT] : [rT, rH];
    const a = amountIn * 997n;
    return (a * rOut) / (rIn * 1000n + a);
  }

  // ───────────── public → private ─────────────

  /** Wallet tokens → a private note on a one-time key. This step is public (the wallet deposits). */
  async shield(wallet: Wallet, token: Address, amount: bigint, onStatus: Status = () => {}): Promise<Hex> {
    if (amount <= 0n) throw new Error("amount must be positive");
    if (!this.tokens.length) await this.loadTokens();
    this.info(token);
    const owner = wallet.account!.address;
    const held = await this.pub.readContract({ address: token, abi: ERC20, functionName: "balanceOf", args: [owner] });
    if (held < amount) throw new Error(`insufficient token balance in wallet: has ${held}, needs ${amount}`);
    const allowance = await this.pub.readContract({ address: token, abi: ERC20, functionName: "allowance", args: [owner, this.vault] });
    if (allowance < amount) {
      onStatus("Approve the deposit in your wallet…");
      const a = await wallet.writeContract({ address: token, abi: ERC20, functionName: "approve", args: [this.vault, amount], account: wallet.account!, chain: wallet.chain });
      if ((await this.pub.waitForTransactionReceipt({ hash: a })).status !== "success") throw new Error("approve reverted");
    }
    const keyIndex = randomKeyIndex();
    const k = await this.priv.keys.key(keyIndex);
    const blinding = randomField();
    onStatus("Confirm the deposit in your wallet…");
    const hash = await wallet.writeContract({
      address: this.vault,
      abi: sharedVaultAbi,
      functionName: "depositTo",
      args: [token, k.pubKey, amount, blinding, encryptFullMemo(this.priv.keys.encPub, amount, blinding, keyIndex)],
      account: wallet.account!,
      chain: wallet.chain,
    });
    if ((await this.pub.waitForTransactionReceipt({ hash })).status !== "success") throw new Error("shield reverted");
    return hash;
  }

  /** Claim won bids of a shared-vault launch and move the tokens in. Two public steps from the bidder's wallet. */
  async claimInto(wallet: Wallet, auction: Address, bidIds: bigint[], onStatus: Status = () => {}): Promise<{ tokens: bigint }> {
    const c = new Cloak(this.pub, wallet);
    const s = await c.getAuction(auction);
    let tokens = 0n;
    for (const id of bidIds) tokens += (await this.pub.readContract({ address: auction, abi: cloakAuctionAbi, functionName: "allocationOf", args: [id] }))[0];
    onStatus("Claiming…");
    await c.claim(auction, bidIds);
    if (tokens > 0n) await this.shield(wallet, s.token, tokens, onStatus);
    return { tokens };
  }

  // ───────────── private trades ─────────────

  /** Private HYPE → private `token`. The HYPE side, the swap and the output note are proven here, relayed elsewhere. */
  async buy(token: Address, hypeIn: bigint, opts: { slippageBps?: number; onStatus?: Status } = {}): Promise<Hex> {
    const onStatus = opts.onStatus ?? (() => {});
    if (!this.tokens.length) await this.loadTokens();
    this.info(token);
    const hypePool = this.priv.hypeMarket.pool;
    const q = await this.quote("sharedBuy", token);
    const inputs = await this.priv.inputsFor(hypePool, hypeIn + q.fee, onStatus);
    const arrives = await this.priv.afterFee(hypePool, hypeIn);
    const minOut = ((await this.quoteSwap(token, "buy", arrives)) * BigInt(10_000 - (opts.slippageBps ?? 200))) / 10_000n;
    const keyIndex = randomKeyIndex();
    const k = await this.priv.keys.key(keyIndex);
    const outBlinding = randomField();
    const data = encodeAbiParameters(SHARED_SWAP_DATA_ABI, [
      { token, minOut, outPubKey: k.pubKey, outBlinding, outMemo: encryptRouterMemo(this.priv.keys.encPub, outBlinding, keyIndex), deadline: BigInt(Math.floor(Date.now() / 1000) + 600) },
    ]);
    const change = inputs.reduce((a, x) => a + x.amount, 0n) - hypeIn - q.fee;
    onStatus("Proving on this device…");
    const { proof, extData } = await buildTransaction({
      tree: await this.priv.treeFor(hypePool, inputs),
      inputs,
      outputs: change > 0n ? [await this.priv.changeOutput(change)] : [],
      extAmount: -hypeIn,
      fee: q.fee,
      relayer: q.relayer,
      recipient: this.router,
      data,
      ...(await this.priv.dummy()),
      prover: await this.priv.prover(),
    });
    onStatus("Relaying…");
    return this.submit({ kind: "sharedBuy", proof, extData });
  }

  /** Private `token` → private HYPE. */
  async sell(token: Address, amount: bigint, opts: { slippageBps?: number; onStatus?: Status } = {}): Promise<Hex> {
    const onStatus = opts.onStatus ?? (() => {});
    if (!this.tokens.length) await this.loadTokens();
    this.info(token);
    const asset = asNum(token);
    const q = await this.quote("sharedSell", token);
    const inputs = await this.inputsFor(token, amount + q.fee, onStatus);
    const arrives = await this.pub.readContract({ address: this.vault, abi: sharedVaultAbi, functionName: "afterFee", args: [amount] });
    const minOut = ((await this.quoteSwap(token, "sell", arrives)) * BigInt(10_000 - (opts.slippageBps ?? 200))) / 10_000n;
    const keyIndex = randomKeyIndex();
    const k = await this.priv.keys.key(keyIndex);
    const outBlinding = randomField();
    const data = encodeAbiParameters(SHARED_SWAP_DATA_ABI, [
      { token, minOut, outPubKey: k.pubKey, outBlinding, outMemo: encryptRouterMemo(this.priv.keys.encPub, outBlinding, keyIndex), deadline: BigInt(Math.floor(Date.now() / 1000) + 600) },
    ]);
    const change = inputs.reduce((a, x) => a + x.amount, 0n) - amount - q.fee;
    onStatus("Proving on this device…");
    const { proof, extData } = await buildTransaction({
      tree: await this.tree(inputs[0].epoch ?? 0),
      inputs,
      outputs: change > 0n ? [await this.priv.changeOutput(change)] : [],
      extAmount: -amount,
      fee: q.fee,
      relayer: q.relayer,
      recipient: this.router,
      data,
      asset,
      publicAsset: asset,
      ...(await this.priv.dummy()),
      prover: await this.prover(),
    });
    onStatus("Relaying…");
    return this.submit({ kind: "sharedSell", proof, extData });
  }

  /**
   * Send `amount` of `token` to a cloak: address without revealing which token: the shared-vault proof names no token
   * and pays no fee, and a second proof pays the relayer from this account's private HYPE. Needs some private HYPE.
   */
  async send(token: Address, amount: bigint, to: string, onStatus: Status = () => {}): Promise<Hex> {
    if (amount <= 0n) throw new Error("amount must be positive");
    if (!this.tokens.length) await this.loadTokens();
    this.info(token);
    const asset = asNum(token);
    const dest = parseCloakAddress(to);
    const hypePool = this.priv.hypeMarket.pool;
    const q = await this.quote("sharedSend", zeroAddress); // the relayer is never told which token a hidden send moves
    const hypeHeld = await this.priv.balance(hypePool);
    if (hypeHeld < q.fee) {
      throw new Error(`a hidden send pays its relayer from your private HYPE, so you need about ${formatEther(q.fee)} HYPE in your private balance (you have ${formatEther(hypeHeld)})`);
    }
    const inputs = await this.inputsFor(token, amount, onStatus);
    const feeInputs = await this.priv.inputsFor(hypePool, q.fee, onStatus);
    const change = inputs.reduce((a, x) => a + x.amount, 0n) - amount;
    onStatus("Proving the send on this device…");
    const send = await buildTransaction({
      tree: await this.tree(inputs[0].epoch ?? 0),
      inputs,
      outputs: [
        { amount, pubKey: dest.pubKey, memo: (b: bigint) => encryptFullMemo(dest.encPub, amount, b, MAIN_KEY) },
        ...(change > 0n ? [await this.priv.changeOutput(change)] : []),
      ],
      asset,
      publicAsset: 0n,
      ...(await this.priv.dummy()),
      prover: await this.prover(),
    });
    const fingerprint = keccak256(
      encodeAbiParameters([{ type: "uint256[2]" }, { type: "uint256[2]" }], [send.proof.inputNullifiers, send.proof.outputCommitments]),
    );
    const feeChange = feeInputs.reduce((a, x) => a + x.amount, 0n) - q.fee;
    onStatus("Proving the relayer's fee…");
    const fee = await buildTransaction({
      tree: await this.priv.treeFor(hypePool, feeInputs),
      inputs: feeInputs,
      outputs: feeChange > 0n ? [await this.priv.changeOutput(feeChange)] : [],
      extAmount: -q.fee,
      recipient: this.router,
      data: encodeAbiParameters([{ type: "bytes32" }], [fingerprint]),
      ...(await this.priv.dummy()),
      prover: await this.priv.prover(),
    });
    onStatus("Relaying…");
    return this.submit({ kind: "sharedSend", proof: send.proof, extData: send.extData, feeProof: fee.proof, feeExtData: fee.extData });
  }

  /** Private `token` → `to` (any address). Names the token, as any withdrawal must. */
  async unshield(token: Address, amount: bigint, to: Address, onStatus: Status = () => {}): Promise<Hex> {
    if (amount <= 0n) throw new Error("amount must be positive");
    if (!this.tokens.length) await this.loadTokens();
    this.info(token);
    const asset = asNum(token);
    const q = await this.quote("sharedTransact", token);
    const inputs = await this.inputsFor(token, amount + q.fee, onStatus);
    const change = inputs.reduce((a, x) => a + x.amount, 0n) - amount - q.fee;
    onStatus("Proving on this device…");
    const { proof, extData } = await buildTransaction({
      tree: await this.tree(inputs[0].epoch ?? 0),
      inputs,
      outputs: change > 0n ? [await this.priv.changeOutput(change)] : [],
      extAmount: -amount,
      fee: q.fee,
      relayer: q.relayer,
      recipient: to,
      asset,
      publicAsset: asset,
      ...(await this.priv.dummy()),
      prover: await this.prover(),
    });
    onStatus("Relaying…");
    return this.submit({ kind: "sharedTransact", proof, extData });
  }
}
