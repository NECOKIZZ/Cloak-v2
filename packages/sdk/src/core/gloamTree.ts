/**
 * A Gloam vault's Merkle tree, kept up to date incrementally.
 *
 * Gloam's `syncTree` reads the vault's whole history and hashes every leaf again on each call. An app that syncs every
 * few seconds then pays for the vault's entire age on every refresh: about 860,000 Elysium blocks a day, three event
 * types, per vault. This keeps the tree between syncs and reads only blocks it hasn't seen.
 *
 * A batch of new leaves is accepted only if it brings the tree to the vault's own leaf count (`nextIndex`) at the
 * block read up to, so an RPC node that answers getLogs from behind can't leave a gap: the batch is dropped and read
 * again next time. After a few failed checks in a row, the tree is read again from the start.
 *
 * The state can be exported (commitments only, all public) and imported, so a reload reads only new blocks, and
 * seeded from the keeper's public list (`GET /leaves`), checked against a root the vault knows.
 */
import { readToHead } from "../head.js";
import * as gloam from "@gloamtrade/sdk";
import type { Address, Hex, PublicClient } from "viem";

const POOL_ABI = [
  { type: "function", name: "nextIndex", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "isKnownRoot", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }] },
] as const;

const SHIELDED = { type: "event", name: "Shielded", inputs: [{ name: "commitment", type: "bytes32", indexed: true }, { name: "asset", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false }, { name: "leafIndex", type: "uint256", indexed: false }, { name: "from", type: "address", indexed: true }] } as const;
const TRANSFERRED = { type: "event", name: "Transferred", inputs: [{ name: "nullifier", type: "bytes32", indexed: true }, { name: "newCommitments", type: "bytes32[2]", indexed: false }] } as const;
const SEALED_SWAPPED = { type: "event", name: "SealedSwapped", inputs: [{ name: "nullifier", type: "bytes32", indexed: true }, { name: "assetIn", type: "address", indexed: true }, { name: "assetOut", type: "address", indexed: true }, { name: "newCommitmentOut", type: "bytes32", indexed: false }, { name: "newCommitmentChange", type: "bytes32", indexed: false }] } as const;

/** Checks that failed in a row before the tree is read again from the vault's first block. */
const MAX_MISMATCHES = 3;
/** Above this many leaves the tree isn't exported (browser storage is about 5 MB); a reload then reads the chain. */
export const MAX_EXPORTED_LEAVES = 40_000;

type Insert = { commitment: Hex; block: bigint; logIndex: number; sub: number };
type Log = { args?: Record<string, unknown>; blockNumber?: bigint | null; logIndex?: number | null };

export interface GloamTreeView {
  root: Hex;
  leafCount: number;
  /** commitment (lowercase hex) -> leaf index */
  indexByCommitment: Map<string, number>;
  pathForCommitment(commitment: Hex): Promise<gloam.PoseidonMerklePath | null>;
}

export class GloamTree implements GloamTreeView {
  private tree = new gloam.IncrementalMerkleTreePoseidon();
  private commitments: Hex[] = [];
  /** first block not read yet */
  private next: bigint;
  private mismatches = 0;
  private updating: Promise<void> | null = null;
  readonly indexByCommitment = new Map<string, number>();
  /** bumped whenever leaves are added or the tree is reset, so a caller knows when to save */
  version = 0;

  constructor(
    readonly pool: Address,
    readonly fromBlock: bigint,
    readonly chunk: bigint = 1_000_000n,
  ) {
    this.next = fromBlock;
  }

  get root(): Hex {
    return gloam.fieldToHex(this.tree.currentRoot) as Hex;
  }
  get leafCount(): number {
    return this.commitments.length;
  }
  /** The leaves in order (public commitments), e.g. for the keeper's GET /leaves. */
  list(): Hex[] {
    return [...this.commitments];
  }

  /** first block not read yet */
  get scannedTo(): bigint {
    return this.next;
  }

  async pathForCommitment(commitment: Hex) {
    const i = this.indexByCommitment.get(commitment.toLowerCase());
    if (i === undefined) return null;
    try {
      return await this.tree.path(i);
    } catch {
      return null;
    }
  }

  private async reset(from = this.fromBlock) {
    this.tree = new gloam.IncrementalMerkleTreePoseidon();
    await this.tree.init();
    this.commitments = [];
    this.indexByCommitment.clear();
    this.next = from;
    this.mismatches = 0;
    this.version++;
  }

  private async add(list: Hex[]) {
    await this.tree.init();
    for (const c of list) {
      const i = this.commitments.length;
      await this.tree.insert(gloam.hexToField(c));
      this.commitments.push(c);
      this.indexByCommitment.set(c.toLowerCase(), i);
    }
    if (list.length) this.version++;
  }

  /** Reads new blocks. Concurrent calls share one read. */
  update(client: PublicClient): Promise<void> {
    this.updating ??= this.read(client).finally(() => (this.updating = null));
    return this.updating;
  }

  private async read(client: PublicClient) {
    // up to a fresh head (a cached one can miss a note made seconds before it's spent), a few blocks back if a lagging
    // node of the RPC refuses the range (head.ts)
    await readToHead(client, (latest) => this.readTo(client, latest));
  }

  private async readTo(client: PublicClient, latest: bigint) {
    // no new block: nothing to read, but the leaf count is still checked (a seeded list missing a leaf shows here)
    const ins: Insert[] = [];
    for (let a = this.next; a <= latest; a += this.chunk) {
      const b = a + this.chunk - 1n < latest ? a + this.chunk - 1n : latest;
      const [sh, tr, ss] = await Promise.all([
        client.getLogs({ address: this.pool, event: SHIELDED, fromBlock: a, toBlock: b }) as Promise<Log[]>,
        client.getLogs({ address: this.pool, event: TRANSFERRED, fromBlock: a, toBlock: b }) as Promise<Log[]>,
        (client.getLogs({ address: this.pool, event: SEALED_SWAPPED, fromBlock: a, toBlock: b }) as Promise<Log[]>).catch(() => [] as Log[]),
      ]);
      const at = (l: Log) => ({ block: l.blockNumber ?? 0n, logIndex: l.logIndex ?? 0 });
      for (const l of sh) if (l.args?.commitment) ins.push({ commitment: l.args.commitment as Hex, ...at(l), sub: 0 });
      for (const l of tr) {
        const p = l.args?.newCommitments as readonly [Hex, Hex] | undefined;
        if (p) ins.push({ commitment: p[0], ...at(l), sub: 0 }, { commitment: p[1], ...at(l), sub: 1 });
      }
      for (const l of ss) {
        const o = l.args?.newCommitmentOut as Hex | undefined;
        const c = l.args?.newCommitmentChange as Hex | undefined;
        if (o && c) ins.push({ commitment: o, ...at(l), sub: 0 }, { commitment: c, ...at(l), sub: 1 });
      }
    }
    ins.sort((x, y) => (x.block !== y.block ? (x.block < y.block ? -1 : 1) : x.logIndex !== y.logIndex ? x.logIndex - y.logIndex : x.sub - y.sub));
    // the vault's own count at the block read up to: a batch that doesn't reach it has a gap (a node answering from behind)
    const count = await client
      .readContract({ address: this.pool, abi: POOL_ABI, functionName: "nextIndex", blockNumber: latest })
      .catch(() => client.readContract({ address: this.pool, abi: POOL_ABI, functionName: "nextIndex" }))
      .catch(() => null);
    if (count === null || Number(count) !== this.commitments.length + ins.length) {
      if (++this.mismatches >= MAX_MISMATCHES) await this.reset(); // read from the start next time
      return;
    }
    this.mismatches = 0;
    await this.add(ins.map((x) => x.commitment));
    if (latest + 1n > this.next) this.next = latest + 1n;
  }

  /** The state to keep on this device (public data only), or null when it's too big to keep. */
  export(): { pool: Address; next: string; c: string } | null {
    if (this.commitments.length > MAX_EXPORTED_LEAVES) return null;
    return { pool: this.pool, next: this.next.toString(), c: this.commitments.map((x) => x.slice(2).padStart(64, "0")).join("") };
  }

  /**
   * Loads an exported state, or the keeper's public list, if the vault knows its root (a list that isn't a true prefix
   * of the vault's leaves can't hash to one). Only into an empty tree.
   */
  async load(commitments: Hex[], next: bigint, client: PublicClient): Promise<boolean> {
    if (this.updating || this.commitments.length || this.next !== this.fromBlock || !commitments.length || next < this.fromBlock) return false;
    // a block past the chain's head would stop reads until the chain got there: refused
    if (next > (await client.getBlockNumber({ cacheTime: 0 })) + 1n) return false;
    const t = new gloam.IncrementalMerkleTreePoseidon();
    await t.init();
    for (const c of commitments) await t.insert(gloam.hexToField(c));
    const root = gloam.fieldToHex(t.currentRoot) as Hex;
    const known = await client.readContract({ address: this.pool, abi: POOL_ABI, functionName: "isKnownRoot", args: [root] }).catch(() => false);
    if (!known || this.commitments.length) return false;
    this.tree = t;
    this.commitments = [...commitments];
    this.indexByCommitment.clear();
    commitments.forEach((c, i) => this.indexByCommitment.set(c.toLowerCase(), i));
    this.next = next;
    this.version++;
    return true;
  }

  /** Splits an export's packed commitments. */
  static unpack(c: string): Hex[] {
    const out: Hex[] = [];
    for (let i = 0; i + 64 <= c.length; i += 64) out.push(`0x${c.slice(i, i + 64)}` as Hex);
    return out;
  }
}
