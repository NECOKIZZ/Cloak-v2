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
import { GloamTree } from "./gloamTree.js";
import type { CoreSubmitter, PrivateCore, SendResult } from "./types.js";
import type { Status } from "../private/client.js";

export const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const HKDF_INFO = "cloak-gloam-account-v1";
const SELF_PREFIX = "cloakself1.";
const LINK_PREFIX = "cloaklink1.";
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
  /**
   * Spend received payments directly, as if they were own notes, and never sweep them (a claim link's account: whoever
   * holds the link holds the account, so a sweep into it first would only cost a transaction).
   */
  spendReceived?: boolean;
  /** getLogs range per call (Elysium's public RPCs cap results, not ranges). */
  logChunk?: bigint;
  /**
   * Where this device keeps notes made but not yet seen in the vault, and memos not yet posted, so a dropped relay
   * answer, a refused memo or a closed page never loses a note. Holds no secrets: an own note is kept as its nonce,
   * which is worthless without the account's seed, and a memo is already sealed. One store per account and vault.
   */
  pendingStore?: { load(): string | null; save(s: string): void };
}

/** At most this many received payments are swept per sync; candidates kept waiting for the tree at most. */
const MAX_SWEEPS_PER_SYNC = 5;
const MAX_CANDIDATES = 1000;
/** How long a note made but never seen in the vault is kept trying, and an unposted memo retried. */
const PENDING_TTL_MS = 3 * 24 * 3600 * 1000;

/** What this account derives from its one signature. */
export interface GloamAccountKeys {
  noteSeed: bigint;
  receiveTag: string;
  receiveJwk: { kty: "EC"; crv: "P-256"; x: string; y: string; d: string; ext: true; key_ops: ["deriveBits"] };
}

/** A payment this account sent: what a receipt for it needs. */
export interface SentPayment {
  commitment: bigint;
  secret: bigint;
  asset: Address;
  amount: bigint;
  txHash: Hex;
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
  return gloamKeysFromBytes(hexToBytes(sig));
}

/** Keys from any secret bytes (a signature, or a claim link's seed). Deterministic. */
export function gloamKeysFromBytes(ikm: Uint8Array): GloamAccountKeys {
  const okm = hkdf(sha256, ikm, new Uint8Array(0), HKDF_INFO, 64);
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

const noteOut = (n: OwnedGloamNote) => ({ asset: n.asset, amount: n.amount.toString(), secret: n.secret.toString(), commitment: n.commitment.toString(), nullifier: n.nullifier.toString(), own: n.own });
const noteIn = (x: Record<string, unknown>): OwnedGloamNote => ({ asset: x.asset as Address, amount: BigInt(x.amount as string), secret: BigInt(x.secret as string), commitment: BigInt(x.commitment as string), nullifier: BigInt(x.nullifier as string), own: !!x.own });

export class GloamCore implements PrivateCore {
  readonly kind = "gloam" as const;
  private notes = new Map<string, OwnedGloamNote>();
  private memoFrom: bigint;
  private seenMemo = new Set<string>();
  /** Claim links this account made (gloam1. packages), by commitment: claimed or not, see links(). */
  private linkPacks = new Map<string, string>();
  private candidates: { commitment: bigint; asset: Address; amount: bigint; secret: bigint; own: boolean }[] = [];
  /** Own notes made and not yet seen in the vault (by commitment), and memos not yet posted: persisted (pendingStore). */
  private pendingOwn = new Map<string, { nonce: string; asset: Address; amount: string; at: number }>();
  private unposted: { commitment: string; tickets: string[]; at: number }[] = [];
  private pendingLoaded = false;
  private sweeping = false;

  constructor(readonly cfg: GloamCoreConfig, readonly keys: GloamAccountKeys) {
    this.memoFrom = cfg.poolBlock;
    this.tree = new GloamTree(cfg.pool, cfg.poolBlock, cfg.logChunk ?? 1_000_000n);
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

  /**
   * @internal Registers a new own note the moment it is made, before anything is sent: whatever happens to the call
   * that creates it (an error after it landed, a refused memo, a closed page), the next sync finds it in the tree.
   */
  remember(n: { nonce: bigint; secret: bigint; commitment: bigint; asset: Address; amount: bigint }) {
    if (n.amount === 0n) return;
    const k = h32(n.commitment);
    if (!this.candidates.some((c) => c.commitment === n.commitment)) this.candidates.push({ commitment: n.commitment, asset: n.asset, amount: n.amount, secret: n.secret, own: true });
    if (!this.pendingOwn.has(k)) {
      this.pendingOwn.set(k, { nonce: n.nonce.toString(), asset: n.asset, amount: n.amount.toString(), at: Date.now() });
      this.savePending();
    }
  }

  private savePending() {
    this.cfg.pendingStore?.save(JSON.stringify({ v: 1, own: [...this.pendingOwn.entries()], memos: this.unposted }));
  }

  private async loadPending() {
    if (this.pendingLoaded) return;
    this.pendingLoaded = true;
    const raw = this.cfg.pendingStore?.load();
    if (!raw) return;
    try {
      const j = JSON.parse(raw) as { own?: [string, { nonce: string; asset: Address; amount: string; at: number }][]; memos?: { commitment: string; tickets: string[]; at: number }[] };
      for (const [k, e] of j.own ?? []) {
        const secret = this.ownSecret(BigInt(e.nonce));
        const commitment = await gloam.noteCommitmentPoseidon(secret, BigInt(e.amount), e.asset);
        if (h32(commitment) !== k) continue; // not this account's (another seed), or corrupted
        this.pendingOwn.set(k, e);
        if (!this.candidates.some((c) => c.commitment === commitment)) this.candidates.push({ commitment, asset: e.asset, amount: BigInt(e.amount), secret, own: true });
      }
      for (const m of j.memos ?? []) if (typeof m?.commitment === "string" && Array.isArray(m.tickets)) this.unposted.push(m);
    } catch {
      /* a corrupted store is ignored: the vault and the memo board still have everything that landed */
    }
  }

  /**
   * Posts a payment's memo, best effort: a refused or failed memo is kept and retried on later syncs, and never fails
   * the action whose transaction already landed.
   */
  /** @internal */ async postSafe(commitment: bigint, tickets: string[], onStatus: Status): Promise<Hex | null> {
    const k = h32(commitment);
    try {
      const h = await this.post(commitment, tickets, onStatus);
      if (this.unposted.some((m) => m.commitment === k)) {
        this.unposted = this.unposted.filter((m) => m.commitment !== k);
        this.savePending();
      }
      return h;
    } catch (e) {
      if (/already relayed/i.test(String((e as Error)?.message))) return null; // it went out before
      onStatus("It went through. Its sealed memo will be posted on the next open");
      if (!this.unposted.some((m) => m.commitment === k)) this.unposted.push({ commitment: k, tickets, at: Date.now() });
      this.savePending();
      return null;
    }
  }

  /** @internal After a call that spends `nullifier` failed: whether it landed anyway (a lost answer, not a failure). */
  async landedAnyway(nullifier: bigint): Promise<boolean> {
    for (let i = 0; i < 4; i++) {
      const spent = await this.cfg.publicClient.readContract({ address: this.cfg.pool, abi: GLOAM_POOL_ABI, functionName: "isSpent", args: [h32(nullifier)] }).catch(() => false);
      if (spent) return true;
      await new Promise((r) => setTimeout(r, 1500));
    }
    return false;
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

  /** The vault's tree, read incrementally: each sync reads only new blocks (see gloamTree.ts). */
  private tree: GloamTree;
  private syncing: Promise<void> | null = null;
  private syncedAt = 0;

  /** @param opts.sweep sweep received payments now (default: the config's autoSweep) */
  async sync(onStatus: Status = () => {}, opts: { sweep?: boolean } = {}): Promise<void> {
    const run = this.syncNow(onStatus, opts);
    if (!this.syncing) this.syncing = run.finally(() => (this.syncing = null)).catch(() => {});
    await run;
    this.syncedAt = Date.now();
  }

  /**
   * A sync, sharing one that is already running: for reads (balances) that many callers make at once, so one sync
   * serves them all instead of one each. A read that starts after a sync finished runs a new one, so it always sees
   * the result of an action that came before it.
   */
  async syncFresh(): Promise<void> {
    if (this.syncing) return this.syncing;
    return this.sync();
  }

  /**
   * What sync has learned, to keep on this device and hand to `importState` next time, so a reload reads only new
   * blocks. It lists this account's notes with their secrets: store it encrypted (the site seals it with the account's
   * key). The tree part is public and left out once it's too big for browser storage.
   */
  exportState(): Record<string, unknown> {
    return {
      v: 1,
      pool: this.cfg.pool.toLowerCase(),
      who: this.who(),
      tree: this.tree.export(),
      memoFrom: this.memoFrom.toString(),
      notes: [...this.notes.values()].map(noteOut),
      spent: [...this.spentNotes.values()].map(noteOut),
      candidates: this.candidates.map((c) => ({ ...c, commitment: c.commitment.toString(), amount: c.amount.toString(), secret: c.secret.toString() })),
      links: [...this.linkPacks.entries()],
    };
  }

  /** Which account a saved state belongs to (a hash of its public receive tag). */
  private who(): string {
    return keccak256(toHex(this.keys.receiveTag)).slice(0, 18);
  }

  /** Loads `exportState` output into a core that hasn't synced yet. Notes whose commitment doesn't match are dropped. */
  async importState(o: Record<string, unknown>): Promise<boolean> {
    if (this.syncedAt || this.notes.size || o?.v !== 1 || o.pool !== this.cfg.pool.toLowerCase() || o.who !== this.who()) return false;
    try {
      const t = o.tree as { next: string; c: string } | null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (t) await this.tree.load(GloamTree.unpack(t.c), BigInt(t.next), this.cfg.publicClient as any).catch(() => false);
      const check = async (n: OwnedGloamNote) => h32(await gloam.noteCommitmentPoseidon(n.secret, n.amount, n.asset)) === h32(n.commitment);
      for (const x of (o.notes as Record<string, string>[]) ?? []) {
        const n = noteIn(x);
        if (await check(n)) this.notes.set(h32(n.commitment), n);
      }
      for (const x of (o.spent as Record<string, string>[]) ?? []) {
        const n = noteIn(x);
        if (await check(n)) this.spentNotes.set(h32(n.commitment), n);
      }
      for (const c of (o.candidates as Record<string, string>[]) ?? []) {
        const n = { commitment: BigInt(c.commitment), asset: c.asset as Address, amount: BigInt(c.amount), secret: BigInt(c.secret), own: !!c.own };
        if (!this.candidates.some((x) => x.commitment === n.commitment)) this.candidates.push(n);
      }
      for (const [k, v] of (o.links as [string, string][]) ?? []) this.linkPacks.set(k, v);
      const m = BigInt(o.memoFrom as string);
      if (m > this.memoFrom) this.memoFrom = m;
      return true;
    } catch {
      return false;
    }
  }

  /** Starts the tree from the keeper's public leaf list (GET /leaves), used only if the vault knows its root. */
  async seedLeaves(src: { block: bigint; leaves: { index: number; commitment: bigint }[] }): Promise<boolean> {
    const list = [...src.leaves].sort((a, b) => a.index - b.index);
    if (list.some((l, i) => l.index !== i)) return false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.tree.load(list.map((l) => h32(l.commitment)), src.block + 1n, this.cfg.publicClient as any).catch(() => false);
  }

  private async syncNow(onStatus: Status, opts: { sweep?: boolean }): Promise<void> {
    const pub = this.cfg.publicClient;
    await this.loadPending();
    onStatus("Reading the vault");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await this.tree.update(pub as any);
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
    // pending own notes: done once in the tree; given up on after PENDING_TTL_MS (the call that would make them failed)
    let changed = false;
    for (const [k, e] of this.pendingOwn) {
      if (this.tree.indexByCommitment.has(k.toLowerCase()) || Date.now() - e.at > PENDING_TTL_MS) {
        this.pendingOwn.delete(k);
        changed = true;
        if (!this.tree.indexByCommitment.has(k.toLowerCase())) this.candidates = this.candidates.filter((c) => h32(c.commitment) !== k);
      }
    }
    // memos that didn't go out: once their note is in the vault, try again (best effort, kept until they go or expire)
    if (this.unposted.length) {
      const keep: typeof this.unposted = [];
      for (const m of this.unposted) {
        if (Date.now() - m.at > PENDING_TTL_MS) continue;
        if (!this.tree.indexByCommitment.has(m.commitment.toLowerCase())) {
          keep.push(m);
          continue;
        }
        try {
          await this.post(BigInt(m.commitment), m.tickets, onStatus);
        } catch (e) {
          if (!/already relayed/i.test(String((e as Error)?.message))) keep.push(m);
        }
      }
      if (keep.length !== this.unposted.length) changed = true;
      this.unposted = keep;
    }
    if (changed) this.savePending();
    // every note's spent flag at once (one round trip, not one per note: review O-14)
    const entries = [...this.notes.entries()];
    const flags = await Promise.all(entries.map(([, n]) => pub.readContract({ address: this.cfg.pool, abi: GLOAM_POOL_ABI, functionName: "isSpent", args: [h32(n.nullifier)] })));
    entries.forEach(([k, n], i) => {
      if (flags[i]) {
        this.spentNotes.set(k, n);
        this.notes.delete(k);
      }
    });
    if ((opts.sweep ?? this.cfg.autoSweep !== false) && !this.cfg.spendReceived && !this.sweeping) {
      // received payments become own notes. Never more than a few per sync, never a zero payment, and a sweep that
      // fails (the relay busy, a payer spending it back first) leaves it pending for later instead of failing the sync,
      // so a stranger's flood of tiny payments can't stop this account from seeing or spending its balance (O-08)
      const received = [...this.notes.values()].filter((x) => !x.own && x.amount > 0n).sort((a, b) => (a.amount < b.amount ? 1 : -1)).slice(0, MAX_SWEEPS_PER_SYNC);
      let swept = 0;
      this.sweeping = true;
      try {
        for (const n of received) {
          if (!this.notes.has(h32(n.commitment))) continue;
          onStatus("Securing a received payment");
          try {
            await this.transferOne(n, n.amount, undefined, onStatus);
            swept++;
          } catch {
            /* left pending: tried again on a later sync */
          }
        }
      } finally {
        this.sweeping = false;
      }
      if (swept) await this.sync(onStatus, opts); // picks up the swept notes, which are this account's own
    }
    // tickets for notes that never show up (anyone can post to a public tag) don't pile up (O-13)
    if (this.candidates.length > MAX_CANDIDATES) this.candidates = this.candidates.slice(-MAX_CANDIDATES);
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
      if (plain.startsWith(LINK_PREFIX)) {
        const pack = gloam.decodeNotePackage(plain.slice(LINK_PREFIX.length));
        if (pack.pool.toLowerCase() === this.cfg.pool.toLowerCase()) this.linkPacks.set(pack.commitment.toLowerCase(), plain.slice(LINK_PREFIX.length));
      } else if (plain.startsWith(SELF_PREFIX)) {
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
    return this.sum((n) => n.own || !!this.cfg.spendReceived);
  }

  async pending(): Promise<Map<Address, bigint>> {
    return this.sum((n) => !n.own);
  }

  /** Every spendable note, largest first. */
  ownNotes(asset?: Address): OwnedGloamNote[] {
    return [...this.notes.values()].filter((n) => (n.own || this.cfg.spendReceived) && (!asset || n.asset.toLowerCase() === asset.toLowerCase())).sort((a, b) => (a.amount < b.amount ? 1 : a.amount > b.amount ? -1 : 0));
  }

  /** Notes this account held that have since been spent (seen in this session's syncs). */
  private spentNotes = new Map<string, OwnedGloamNote>();

  /** Spent notes this session saw: a claim link's account uses them to show who claimed and where it went. */
  spentNoteList(asset?: Address): OwnedGloamNote[] {
    return [...this.spentNotes.values()].filter((n) => !asset || n.asset.toLowerCase() === asset.toLowerCase());
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
    this.remember(n); // before the deposit: found on the next sync whatever happens after it lands
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
    const tickets = [await this.selfTicket(n)];
    let memo: Hex | null = null;
    try {
      memo = await this.post(n.commitment, tickets, onStatus);
    } catch {
      // the relay refused (its memo budget is shared by everyone): the wallet that paid the deposit posts it instead
      try {
        onStatus("Posting the sealed note from your wallet");
        await send(this.cfg.payMemo, encodeFunctionData({ abi: GLOAM_MEMO_ABI, functionName: "postMemo", args: [h32(n.commitment), toHex(new TextEncoder().encode(tickets.join("\n")))] }));
      } catch {
        memo = await this.postSafe(n.commitment, tickets, onStatus); // queued for a later sync
      }
    }
    if (memo) hashes.push(memo);
    return hashes;
  }

  /**
   * One 1-in 2-out transfer. `pay` goes to `payTo`: a receive tag, this account (undefined), or a claim link's note
   * ({ secret }: the link carries the secret; a copy sealed to this account lets any of its devices take it back).
   */
  private async transferOne(n: OwnedGloamNote, pay: bigint, payTo: string | { secret: bigint } | undefined, onStatus: Status): Promise<Hex[]> {
    const path = await this.pathOf(n.commitment);
    const change = await this.freshOwn(n.asset, n.amount - pay);
    let paySecret: bigint;
    let payCommitment: bigint;
    let payTicket: string;
    let mine: Awaited<ReturnType<GloamCore["freshOwn"]>> | null = null;
    if (payTo && typeof payTo === "object") {
      paySecret = payTo.secret;
      payCommitment = await gloam.noteCommitmentPoseidon(paySecret, pay, n.asset);
      const pack = gloam.encodeNotePackage({ pool: this.cfg.pool, asset: n.asset, amountWei: pay.toString(), secret: h32(paySecret), commitment: h32(payCommitment), chainId: this.cfg.chainId });
      payTicket = await gloam.sealToReceiveTag(LINK_PREFIX + pack, this.keys.receiveTag);
    } else if (payTo) {
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
    // the new own notes are known before anything is sent, so they're found even if the answer never comes back
    if (mine) this.remember(mine);
    this.remember(change);
    onStatus("Sending");
    let tx: Hex | null = null;
    try {
      tx = await this.cfg.submit({
        kind: "transfer",
        to: this.cfg.pool,
        data: encodeFunctionData({ abi: GLOAM_POOL_ABI, functionName: "transfer", args: [proofBytes, h32(path.root), h32(n.nullifier), [h32(payCommitment), h32(change.commitment)]] }),
      });
    } catch (e) {
      if (!(await this.landedAnyway(n.nullifier))) throw e;
      onStatus("It went through, though the relay's answer was lost");
    }
    this.notes.delete(h32(n.commitment));
    const tickets = [payTicket];
    if (change.amount > 0n) tickets.push(await this.selfTicket(change));
    const memo = await this.postSafe(payCommitment, tickets, onStatus);
    // the payer knows the payment note's secret: kept so it can prove the payment later (a receipt), never sent anywhere
    if (!mine) this.sent.push({ commitment: payCommitment, secret: paySecret, asset: n.asset, amount: pay, txHash: tx ?? "0x" });
    return [tx, memo].filter((x): x is Hex => !!x);
  }

  private sent: SentPayment[] = [];

  /**
   * Payments this account sent in this session, with each payment note's secret, so the app can store them and prove a
   * payment later (proveReceipt). Whoever holds a secret can spend that payment until the payee sweeps it, so store
   * them as carefully as the account itself.
   */
  sentPayments(): SentPayment[] {
    return [...this.sent];
  }

  /** @internal */ async pathOf(commitment: bigint) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await this.tree.update(this.cfg.publicClient as any);
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
    if (!this.candidates.some((x) => x.commitment === c.commitment)) this.candidates.push({ ...c, own: true });
  }

  /** One own note of exactly `amount`, splitting a larger one first when none matches (one extra transfer). */
  /** @param exclude commitments of notes not to use (already set aside for something else) */
  async exactNote(asset: Address, amount: bigint, onStatus: Status = () => {}, exclude: Set<bigint> = new Set()): Promise<OwnedGloamNote> {
    await this.sync(onStatus);
    const free = () => this.ownNotes(asset).filter((n) => !exclude.has(n.commitment));
    const hit = free().find((n) => n.amount === amount);
    if (hit) return hit;
    const big = [...free()].reverse().find((n) => n.amount > amount);
    if (!big) throw new Error("Not enough private balance in one note for this.");
    await this.transferOne(big, amount, undefined, onStatus);
    await this.sync(onStatus);
    const n = free().find((x) => x.amount === amount);
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
    this.remember(n); // an escrow may deposit it whenever its call lands: found on the next sync whatever the answer was
    const { proofBytes } = await this.cfg.provers.shield({ commitment: n.commitment.toString(), amount: amount.toString(), asset: assetField(asset).toString(), secret: n.secret.toString() });
    const ticket = await this.selfTicket(n);
    // its memo waits until the note is in the vault (announce posts it then; otherwise a later sync does)
    this.unposted.push({ commitment: h32(n.commitment), tickets: [ticket], at: Date.now() });
    this.savePending();
    return { deposit: { proof: proofBytes, commitment: h32(n.commitment), asset, amount }, note: n, ticket };
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

  // ── claim links ────────────────────────────────────────────────────────

  /**
   * A claim link: `amount` moves into a note whose secret the link carries (Gloam's gloam1. note package, which
   * Gloam's own app opens too). Whoever opens the link first takes it; until then this account can take it back.
   */
  async createClaimLink(asset: Address, amount: bigint, onStatus: Status = () => {}): Promise<{ link: string; commitment: Hex; txHashes: Hex[] }> {
    await this.sync(onStatus);
    const [p] = this.plan(asset, amount);
    if (p.take !== amount) throw new Error("A claim link is paid from one note: not enough in a single note.");
    const secret = await gloam.randomSecretField();
    const commitment = await gloam.noteCommitmentPoseidon(secret, amount, asset);
    const txHashes = await this.transferOne(p.note, amount, { secret }, onStatus);
    const link = gloam.encodeNotePackage({ pool: this.cfg.pool, asset, amountWei: amount.toString(), secret: h32(secret), commitment: h32(commitment), chainId: this.cfg.chainId });
    this.linkPacks.set(h32(commitment).toLowerCase(), link);
    return { link, commitment: h32(commitment), txHashes };
  }

  /** Take a claim link into this account (a sweep). The same call takes back an unclaimed link of one's own. */
  async claimLink(link: string, onStatus: Status = () => {}): Promise<{ amount: bigint; asset: Address; txHashes: Hex[] }> {
    const pack = gloam.decodeNotePackage(link.slice(link.indexOf(gloam.NOTE_PACKAGE_PREFIX)));
    if (pack.pool.toLowerCase() !== this.cfg.pool.toLowerCase()) throw new Error("That link is for another vault.");
    const secret = BigInt(pack.secret);
    const amount = BigInt(pack.amountWei);
    const commitment = await gloam.noteCommitmentPoseidon(secret, amount, pack.asset);
    if (commitment !== BigInt(pack.commitment)) throw new Error("That link is damaged.");
    const nullifier = await gloam.noteNullifierPoseidon(secret, commitment);
    const spent = await this.cfg.publicClient.readContract({ address: this.cfg.pool, abi: GLOAM_POOL_ABI, functionName: "isSpent", args: [h32(nullifier)] });
    if (spent) throw new Error("That link has already been claimed.");
    onStatus("Claiming");
    const txHashes = await this.transferOne({ asset: pack.asset, amount, secret, commitment, nullifier, own: false }, amount, undefined, onStatus);
    await this.sync(onStatus);
    return { amount, asset: pack.asset, txHashes };
  }

  /** Claim links this account made, with whether each is still open. */
  async links(): Promise<{ link: string; commitment: Hex; amount: bigint; asset: Address; open: boolean }[]> {
    const out = [];
    for (const [c, link] of this.linkPacks) {
      const pack = gloam.decodeNotePackage(link);
      const nullifier = await gloam.noteNullifierPoseidon(BigInt(pack.secret), BigInt(pack.commitment));
      const spent = await this.cfg.publicClient.readContract({ address: this.cfg.pool, abi: GLOAM_POOL_ABI, functionName: "isSpent", args: [h32(nullifier)] });
      out.push({ link, commitment: c as Hex, amount: BigInt(pack.amountWei), asset: pack.asset, open: !spent });
    }
    return out;
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
      try {
        out.push(await this.cfg.submit({ kind: "unshield", to: this.cfg.pool, data: encodeFunctionData({ abi: GLOAM_POOL_ABI, functionName: "unshield", args: [proofBytes, h32(path.root), h32(note.nullifier), asset, to, note.amount] }) }));
      } catch (e) {
        if (!(await this.landedAnyway(note.nullifier))) throw e;
        onStatus("It went through, though the relay's answer was lost");
      }
      this.notes.delete(h32(note.commitment));
    }
    return out;
  }
}
