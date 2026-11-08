/**
 * GloamCore: Cloak's private balance on Gloam's shared vault (ShieldPoolPayments), through @gloamtrade/sdk.
 *
 * Gloam's notes are bearer notes, commitment = Poseidon(secret, amount, asset), with sends of one note in and two out.
 * Cloak's account model is mapped on top like this:
 *
 * - One signature (Cloak's own EIP-712 account request) derives two things with HKDF: a note seed and a P-256 receive
 *   key, so the same wallet gets the same Gloam account on every device.
 * - Notes this account makes for itself (deposits, change, swept payments) take secret = Poseidon(noteSeed, nonce)
 *   with a random nonce. Only this account knows noteSeed, so a note whose secret checks out is provably its own and
 *   nobody else can spend it.
 * - Each such note is announced on Gloam's payment-memo board as a ticket sealed to this account's own receive tag
 *   (nonce, amount, asset). Restoring on another device is a scan of the board with the receive key.
 * - A payment someone else sent is not safe yet (its payer made the secret). sync() moves each one into a fresh note
 *   of this account (a sweep, one 1-in 2-out transfer) before it counts as balance; until then it shows in pending().
 *
 * Every transaction goes through the injected submitter: a relayer by default, so the user's address never appears
 * next to a private action.
 */
import { p256 } from "@noble/curves/p256";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { randomBytes } from "@noble/hashes/utils";
import { poseidon2 as poseidonHash2 } from "poseidon-lite/poseidon2";
import { encodeAbiParameters, encodeFunctionData, hexToBytes, keccak256, parseAbi, toHex, zeroAddress, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import * as gloam from "@gloamtrade/sdk";
import { ACCOUNT_TYPED_DATA } from "../private/crypto.js";
import type { CoreSubmitter, PrivateCore, SendResult } from "./types.js";
import type { Status } from "../private/client.js";

export const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const HKDF_INFO = "cloak-gloam-account-v1";
const SELF_PREFIX = "cloakself1.";
const P256_SPKI_HEADER = "3059301306072a8648ce3d020106082a8648ce3d03010703420004";

export const GLOAM_POOL_ABI = parseAbi([
  "function shieldBound(address asset, uint256 amount, bytes32 commitment, bytes proof) payable",
  "function transfer(bytes proof, bytes32 root, bytes32 nullifier, bytes32[2] newCommitments)",
  "function unshield(bytes proof, bytes32 root, bytes32 nullifier, address asset, address to, uint256 amount)",
  "function isSpent(bytes32) view returns (bool)",
  "function withdrawFeeBps() view returns (uint16)",
]);
export const GLOAM_MEMO_ABI = parseAbi([
  "function postMemo(bytes32 paymentCommitment, bytes memo)",
  "event PaymentMemo(bytes32 indexed paymentCommitment, bytes memo)",
]);
const ERC20_APPROVE = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);

/** A Groth16 prover for one circuit: circuit input in, packed proof bytes out (Gloam's Prover shape). */
export type GloamProver = (input: Record<string, string | string[]>) => Promise<{ proofBytes: Hex }>;

export interface GloamCoreConfig {
  publicClient: PublicClient;
  chainId: number;
  pool: Address;
  poolBlock: bigint;
  payMemo: Address;
  /** Provers on the keys the vault's verifiers hold (the ceremony's final keys on Elysium). */
  provers: { shield: GloamProver; transfer: GloamProver; unshield: GloamProver };
  submit: CoreSubmitter;
  /** Move received payments into this account's own notes during sync (default true). */
  autoSweep?: boolean;
  /** getLogs range per call (Elysium's public RPCs cap results, not ranges). */
  logChunk?: bigint;
}

/** What this account derives from its one signature. */
export interface GloamAccountKeys {
  noteSeed: bigint;
  receiveTag: string;
  receiveJwk: { kty: "EC"; crv: "P-256"; x: string; y: string; d: string; ext: true; key_ops: ["deriveBits"] };
}

export interface OwnedGloamNote {
  asset: Address;
  amount: bigint;
  secret: bigint;
  commitment: bigint;
  nullifier: bigint;
  /** true: secret from this account's seed (safe). false: a received payment not yet swept. */
  own: boolean;
}

const b64url = (b: Uint8Array) => {
  let bin = "";
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const field = (b: Uint8Array) => BigInt(toHex(b)) % FIELD;
const h32 = (x: bigint) => toHex(x, { size: 32 });
const assetField = (a: Address) => BigInt(a);

/** Keys from the 65-byte account signature. Deterministic: the same signature gives the same account. */
export function gloamKeysFromSignature(sig: Hex): GloamAccountKeys {
  const okm = hkdf(sha256, hexToBytes(sig), new Uint8Array(0), HKDF_INFO, 64);
  const noteSeed = field(okm.slice(0, 32));
  const n = p256.CURVE.n;
  const d = (BigInt(toHex(okm.slice(32, 64))) % (n - 1n)) + 1n;
  const dBytes = hexToBytes(toHex(d, { size: 32 }));
  const pub = p256.getPublicKey(dBytes, false); // 04 || x || y
  const x = pub.slice(1, 33);
  const y = pub.slice(33, 65);
  const spki = new Uint8Array([...hexToBytes(`0x${P256_SPKI_HEADER}`), ...x, ...y]);
  return {
    noteSeed,
    receiveTag: gloam.RECEIVE_TAG_PREFIX + b64url(spki),
    receiveJwk: { kty: "EC", crv: "P-256", x: b64url(x), y: b64url(y), d: b64url(dBytes), ext: true, key_ops: ["deriveBits"] },
  };
}

export class GloamCore implements PrivateCore {
  readonly kind = "gloam" as const;
  private notes = new Map<string, OwnedGloamNote>();
  private memoFrom: bigint;
  private seenMemo = new Set<string>();
  private candidates: { commitment: bigint; asset: Address; amount: bigint; secret: bigint; own: boolean }[] = [];

  constructor(readonly cfg: GloamCoreConfig, readonly keys: GloamAccountKeys) {
    this.memoFrom = cfg.poolBlock;
  }

  /** Unlock from one wallet signature (the same request Cloak's own account uses). */
  static async unlock(wallet: WalletClient, cfg: GloamCoreConfig): Promise<GloamCore> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sig = await wallet.signTypedData({ account: wallet.account!, ...ACCOUNT_TYPED_DATA(cfg.chainId) } as any);
    return new GloamCore(cfg, gloamKeysFromSignature(sig));
  }

  async address(): Promise<string> {
    return this.keys.receiveTag;
  }

  // ── notes ──────────────────────────────────────────────────────────────

  /** @internal */ ownSecret(nonce: bigint): bigint {
    return poseidonHash2([this.keys.noteSeed, nonce]);
  }

  /** @internal */ async freshOwn(asset: Address, amount: bigint) {
    const nonce = field(randomBytes(31));
    const secret = this.ownSecret(nonce);
    const commitment = await gloam.noteCommitmentPoseidon(secret, amount, asset);
    return { nonce, secret, commitment, asset, amount };
  }

  /** @internal */ async selfTicket(n: { nonce: bigint; asset: Address; amount: bigint }): Promise<string> {
    const body = SELF_PREFIX + JSON.stringify({ v: 1, n: n.nonce.toString(), a: n.asset, w: n.amount.toString(), ch: this.cfg.chainId });
    return gloam.sealToReceiveTag(body, this.keys.receiveTag);
  }

  /** @internal */ async post(commitment: bigint, tickets: string[], onStatus: Status): Promise<Hex | null> {
    if (!tickets.length) return null;
    onStatus("Posting the sealed note");
    const memo = toHex(new TextEncoder().encode(tickets.join("\n")));
    return this.cfg.submit({ kind: "memo", to: this.cfg.payMemo, data: encodeFunctionData({ abi: GLOAM_MEMO_ABI, functionName: "postMemo", args: [h32(commitment), memo] }) });
  }

  // ── sync ───────────────────────────────────────────────────────────────

  private tree?: Awaited<ReturnType<typeof gloam.syncTree>>;

  async sync(onStatus: Status = () => {}): Promise<void> {
    const pub = this.cfg.publicClient;
    onStatus("Reading the vault");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.tree = await gloam.syncTree(pub as any, { pool: this.cfg.pool, fromBlock: this.cfg.poolBlock, chunkSize: this.cfg.logChunk });
    const head = await pub.getBlockNumber();
    onStatus("Reading sealed notes");
    const logs = await this.memoLogs(this.memoFrom, head);
    for (const log of logs) {
      const key = `${log.transactionHash}:${log.logIndex}`;
      if (this.seenMemo.has(key)) continue;
      this.seenMemo.add(key);
      const text = new TextDecoder().decode(hexToBytes(log.args.memo as Hex));
      for (const t of text.split("\n")) await this.tryTicket(t);
    }
    this.memoFrom = head + 1n;
    // Keep what is in the tree and unspent.
    const stillWaiting: typeof this.candidates = [];
    for (const c of this.candidates) {
      if (!this.tree.indexByCommitment.has(h32(c.commitment).toLowerCase())) {
        stillWaiting.push(c);
        continue;
      }
      const nullifier = await gloam.noteNullifierPoseidon(c.secret, c.commitment);
      this.notes.set(h32(c.commitment), { ...c, nullifier });
    }
    this.candidates = stillWaiting;
    for (const [k, n] of this.notes) {
      const spent = await pub.readContract({ address: this.cfg.pool, abi: GLOAM_POOL_ABI, functionName: "isSpent", args: [h32(n.nullifier)] });
      if (spent) this.notes.delete(k);
    }
    if (this.cfg.autoSweep !== false) {
      const received = [...this.notes.values()].filter((x) => !x.own);
      for (const n of received) {
        if (!this.notes.has(h32(n.commitment))) continue;
        onStatus("Securing a received payment");
        await this.transferOne(n, n.amount, undefined, onStatus);
      }
      if (received.length) await this.sync(onStatus); // picks up the swept notes, which are this account's own
    }
  }

  private async memoLogs(from: bigint, to: bigint) {
    const step = this.cfg.logChunk ?? 1_000_000n;
    const out = [];
    for (let a = from; a <= to; a += step) {
      const b = a + step - 1n < to ? a + step - 1n : to;
      out.push(...(await this.cfg.publicClient.getContractEvents({ address: this.cfg.payMemo, abi: GLOAM_MEMO_ABI, eventName: "PaymentMemo", fromBlock: a, toBlock: b })));
    }
    return out;
  }

  /** Opens one sealed ticket if it is for this account. Anyone can post to a tag, so every claim is checked. */
  private async tryTicket(t: string) {
    if (!gloam.isSealedTicket(t)) return;
    let plain: string;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      plain = await gloam.openSealedTicket(t, this.keys.receiveJwk as any);
    } catch {
      return; // not ours
    }
    try {
      if (plain.startsWith(SELF_PREFIX)) {
        const j = JSON.parse(plain.slice(SELF_PREFIX.length));
        if (j.ch !== this.cfg.chainId) return;
        const asset = j.a as Address;
        const amount = BigInt(j.w);
        const secret = this.ownSecret(BigInt(j.n));
        const commitment = await gloam.noteCommitmentPoseidon(secret, amount, asset);
        this.candidates.push({ commitment, asset, amount, secret, own: true });
      } else {
        const pack = gloam.decodeNotePackage(plain);
        if (pack.pool.toLowerCase() !== this.cfg.pool.toLowerCase()) return;
        if (pack.chainId !== undefined && pack.chainId !== this.cfg.chainId) return;
        const secret = BigInt(pack.secret);
        const amount = BigInt(pack.amountWei);
        const commitment = await gloam.noteCommitmentPoseidon(secret, amount, pack.asset);
        if (commitment !== BigInt(pack.commitment)) return; // lies about its own note
        this.candidates.push({ commitment, asset: pack.asset, amount, secret, own: false });
      }
    } catch {
      /* malformed */
    }
  }

  async balances(): Promise<Map<Address, bigint>> {
    return this.sum((n) => n.own);
  }

  async pending(): Promise<Map<Address, bigint>> {
    return this.sum((n) => !n.own);
  }

  /** Every spendable note, largest first. */
  ownNotes(asset?: Address): OwnedGloamNote[] {
    return [...this.notes.values()].filter((n) => n.own && (!asset || n.asset.toLowerCase() === asset.toLowerCase())).sort((a, b) => (a.amount < b.amount ? 1 : a.amount > b.amount ? -1 : 0));
  }

  private sum(pick: (n: OwnedGloamNote) => boolean) {
    const m = new Map<Address, bigint>();
    for (const n of this.notes.values()) if (pick(n) && n.amount > 0n) m.set(n.asset, (m.get(n.asset) ?? 0n) + n.amount);
    return m;
  }

  // ── actions ────────────────────────────────────────────────────────────

  async shield(wallet: WalletClient, asset: Address, amount: bigint, onStatus: Status = () => {}): Promise<Hex[]> {
    const pub = this.cfg.publicClient;
    const n = await this.freshOwn(asset, amount);
    onStatus("Proving the deposit");
    const { proofBytes } = await this.cfg.provers.shield({ commitment: n.commitment.toString(), amount: amount.toString(), asset: assetField(asset).toString(), secret: n.secret.toString() });
    const hashes: Hex[] = [];
    const send = async (to: Address, data: Hex, value = 0n) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const h = await wallet.sendTransaction({ account: wallet.account!, chain: wallet.chain, to, data, value } as any);
      const r = await pub.waitForTransactionReceipt({ hash: h });
      if (r.status !== "success") throw new Error(`deposit step reverted (${h})`);
      hashes.push(h);
    };
    if (asset !== zeroAddress) {
      onStatus("Approving the vault");
      await send(asset, encodeFunctionData({ abi: ERC20_APPROVE, functionName: "approve", args: [this.cfg.pool, amount] }));
    }
    onStatus("Depositing");
    // The deposit itself is public (it comes from the wallet); the memo goes through the relayer like everything else.
    await send(this.cfg.pool, encodeFunctionData({ abi: GLOAM_POOL_ABI, functionName: "shieldBound", args: [asset, amount, h32(n.commitment), proofBytes] }), asset === zeroAddress ? amount : 0n);
    const memo = await this.post(n.commitment, [await this.selfTicket(n)], onStatus);
    if (memo) hashes.push(memo);
    this.candidates.push({ commitment: n.commitment, asset, amount, secret: n.secret, own: true });
    return hashes;
  }

  /** One 1-in 2-out transfer. `pay` goes to `payTo` (a receive tag) or to this account (undefined). */
  private async transferOne(n: OwnedGloamNote, pay: bigint, payTo: string | undefined, onStatus: Status): Promise<Hex[]> {
    const path = await this.pathOf(n.commitment);
    const change = await this.freshOwn(n.asset, n.amount - pay);
    let paySecret: bigint;
    let payCommitment: bigint;
    let payTicket: string;
    let mine: Awaited<ReturnType<GloamCore["freshOwn"]>> | null = null;
    if (payTo) {
      paySecret = await gloam.randomSecretField();
      payCommitment = await gloam.noteCommitmentPoseidon(paySecret, pay, n.asset);
      const pack = gloam.encodeNotePackage({ pool: this.cfg.pool, asset: n.asset, amountWei: pay.toString(), secret: h32(paySecret), commitment: h32(payCommitment), chainId: this.cfg.chainId });
      payTicket = await gloam.sealToReceiveTag(pack, payTo);
    } else {
      mine = await this.freshOwn(n.asset, pay);
      paySecret = mine.secret;
      payCommitment = mine.commitment;
      payTicket = await this.selfTicket(mine);
    }
    onStatus("Proving the private send");
    const { proofBytes } = await this.cfg.provers.transfer({
      root: path.root.toString(),
      nullifier: n.nullifier.toString(),
      newCommitment0: payCommitment.toString(),
      newCommitment1: change.commitment.toString(),
      secretIn: n.secret.toString(),
      amountIn: n.amount.toString(),
      asset: assetField(n.asset).toString(),
      pathElements: path.pathElements.map((x: bigint) => x.toString()),
      pathIndices: path.pathIndices.map(String),
      secretPay: paySecret.toString(),
      amountPay: pay.toString(),
      secretChange: change.secret.toString(),
      amountChange: (n.amount - pay).toString(),
    });
    onStatus("Sending");
    const tx = await this.cfg.submit({
      kind: "transfer",
      to: this.cfg.pool,
      data: encodeFunctionData({ abi: GLOAM_POOL_ABI, functionName: "transfer", args: [proofBytes, h32(path.root), h32(n.nullifier), [h32(payCommitment), h32(change.commitment)]] }),
    });
    this.notes.delete(h32(n.commitment));
    const tickets = [payTicket];
    if (change.amount > 0n) tickets.push(await this.selfTicket(change));
    const memo = await this.post(payCommitment, tickets, onStatus);
    if (mine) this.candidates.push({ commitment: mine.commitment, asset: n.asset, amount: pay, secret: mine.secret, own: true });
    if (change.amount > 0n) this.candidates.push({ commitment: change.commitment, asset: n.asset, amount: change.amount, secret: change.secret, own: true });
    return memo ? [tx, memo] : [tx];
  }

  /** @internal */ async pathOf(commitment: bigint) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.tree = await gloam.syncTree(this.cfg.publicClient as any, { pool: this.cfg.pool, fromBlock: this.cfg.poolBlock, chunkSize: this.cfg.logChunk });
    const p = await this.tree.pathForCommitment(h32(commitment));
    if (!p) throw new Error("That note is not in the vault yet. Sync and try again.");
    return p;
  }

  /** Picks notes for `amount`: one note if one is big enough, else the largest ones (one piece each). */
  plan(asset: Address, amount: bigint): { note: OwnedGloamNote; take: bigint }[] {
    const notes = this.ownNotes(asset);
    const one = [...notes].reverse().find((n) => n.amount >= amount);
    if (one) return [{ note: one, take: amount }];
    const out: { note: OwnedGloamNote; take: bigint }[] = [];
    let left = amount;
    for (const n of notes) {
      if (left === 0n) break;
      const take = n.amount < left ? n.amount : left;
      out.push({ note: n, take });
      left -= take;
    }
    if (left > 0n) throw new Error("Not enough private balance.");
    return out;
  }

  // ── escrow building blocks (swaps, bids, batch orders, drop bids) ─────

  /** Remembers a note this account made, until sync finds it in the tree. */
  track(c: { commitment: bigint; asset: Address; amount: bigint; secret: bigint }) {
    this.candidates.push({ ...c, own: true });
  }

  /** One own note of exactly `amount`, splitting a larger one first when none matches (one extra transfer). */
  async exactNote(asset: Address, amount: bigint, onStatus: Status = () => {}): Promise<OwnedGloamNote> {
    await this.sync(onStatus);
    const hit = this.ownNotes(asset).find((n) => n.amount === amount);
    if (hit) return hit;
    const big = [...this.ownNotes(asset)].reverse().find((n) => n.amount > amount);
    if (!big) throw new Error("Not enough private balance in one note for this.");
    await this.transferOne(big, amount, undefined, onStatus);
    await this.sync(onStatus);
    const n = this.ownNotes(asset).find((x) => x.amount === amount);
    if (!n) throw new Error("split did not land");
    return n;
  }

  /** The unshield proof that spends `note` (whole) to `to`, without sending it. An escrow call carries it. */
  async spendProof(note: OwnedGloamNote, to: Address, onStatus: Status = () => {}) {
    const path = await this.pathOf(note.commitment);
    onStatus("Proving the spend");
    const { proofBytes } = await this.cfg.provers.unshield({
      root: path.root.toString(),
      nullifier: note.nullifier.toString(),
      asset: assetField(note.asset).toString(),
      amount: note.amount.toString(),
      recipient: BigInt(to).toString(),
      secret: note.secret.toString(),
      pathElements: path.pathElements.map((x: bigint) => x.toString()),
      pathIndices: path.pathIndices.map(String),
    });
    return { proof: proofBytes, root: h32(path.root), nullifier: h32(note.nullifier), asset: note.asset, amount: note.amount };
  }

  /** A note of exactly `amount` of `asset` for this account, with its shield proof, for an escrow to deposit. */
  async depositFor(asset: Address, amount: bigint) {
    const n = await this.freshOwn(asset, amount);
    const { proofBytes } = await this.cfg.provers.shield({ commitment: n.commitment.toString(), amount: amount.toString(), asset: assetField(asset).toString(), secret: n.secret.toString() });
    return { deposit: { proof: proofBytes, commitment: h32(n.commitment), asset, amount }, note: n, ticket: await this.selfTicket(n) };
  }

  /**
   * A one-time key for one escrow action, made from this account's seed and the note it spends, so it says nothing
   * about the account and any device that holds the signature can make it again.
   */
  exitKeyFor(nullifier: Hex): Hex {
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const k = BigInt(keccak256(encodeAbiParameters([{ type: "string" }, { type: "uint256" }, { type: "bytes32" }], ["cloak-gloam-exit-v1", this.keys.noteSeed, nullifier])));
    return toHex((k % (n - 1n)) + 1n, { size: 32 });
  }

  get config() {
    return this.cfg;
  }

  async send(asset: Address, to: string, amount: bigint, onStatus: Status = () => {}): Promise<SendResult> {
    gloam.assertReceiveTag(to, "recipient");
    if (amount <= 0n) throw new Error("Amount must be positive.");
    await this.sync(onStatus);
    const plan = this.plan(asset, amount);
    const txHashes: Hex[] = [];
    for (const p of plan) txHashes.push(...(await this.transferOne(p.note, p.take, to, onStatus)));
    await this.sync(onStatus);
    return { txHashes, pieces: plan.length };
  }

  /** Cashes out `amount` to `to` (an exact amount needs a split first when no note matches it). */
  async withdraw(asset: Address, to: Address, amount: bigint | "max", onStatus: Status = () => {}): Promise<Hex[]> {
    return this.exit(asset, to, amount, onStatus);
  }

  async spendTo(asset: Address, escrow: Address, amount: bigint, onStatus: Status = () => {}): Promise<Hex[]> {
    return this.exit(asset, escrow, amount, onStatus);
  }

  private async exit(asset: Address, to: Address, amount: bigint | "max", onStatus: Status): Promise<Hex[]> {
    await this.sync(onStatus);
    const want = amount === "max" ? this.ownNotes(asset).reduce((s, n) => s + n.amount, 0n) : amount;
    if (want <= 0n) throw new Error("Nothing to withdraw.");
    const out: Hex[] = [];
    for (const p of this.plan(asset, want)) {
      let note = p.note;
      if (p.take < note.amount) {
        // split: the exact amount into a fresh note of this account, the rest stays as change
        out.push(...(await this.transferOne(note, p.take, undefined, onStatus)));
        await this.sync(onStatus);
        note = this.ownNotes(asset).find((n) => n.amount === p.take)!;
      }
      const path = await this.pathOf(note.commitment);
      onStatus("Proving the withdrawal");
      const { proofBytes } = await this.cfg.provers.unshield({
        root: path.root.toString(),
        nullifier: note.nullifier.toString(),
        asset: assetField(asset).toString(),
        amount: note.amount.toString(),
        recipient: BigInt(to).toString(),
        secret: note.secret.toString(),
        pathElements: path.pathElements.map((x: bigint) => x.toString()),
        pathIndices: path.pathIndices.map(String),
      });
      onStatus("Withdrawing");
      out.push(await this.cfg.submit({ kind: "unshield", to: this.cfg.pool, data: encodeFunctionData({ abi: GLOAM_POOL_ABI, functionName: "unshield", args: [proofBytes, h32(path.root), h32(note.nullifier), asset, to, note.amount] }) }));
      this.notes.delete(h32(note.commitment));
    }
    return out;
  }
}
