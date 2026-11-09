// The public note list of every Cloak vault (commitment and encrypted memo of each leaf, in order), so an app's first
// sync on a new device is one download instead of a scan of every vault's history. Everything here is public on chain.
// The request names only the vault, the same for everyone, so the keeper never learns whose notes are whose. Apps
// rebuild the Merkle tree from it and use it only if the root is one the vault knows; otherwise they scan the chain.
//   GET /leaves            every vault
//   GET /leaves?pool=0x…   one vault
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { GloamTree, cloakVaultsAbi, sharedVaultAbi, shieldedPoolAbi } from "@cloakely/sdk";

const MIN_REFRESH_MS = 10_000;

// Cloak v2 (Gloam vaults, `gloam: [{ address, block }]`): the same list from each vault's Shielded, Transferred and
// SealedSwapped events (no memo: Gloam's memos are on the memo board), read incrementally and checked against the
// vault's own leaf count, so the list never has a gap. Apps check its root against the vault before using it.
export function startLeaves(pub, { vaults, vaultsBlock, shared, sharedBlock, gloam = [] }) {
  const gloamTrees = gloam.map((g) => new GloamTree(g.address, BigInt(g.block)));
  /** pool (lowercase) → { address, abi, next: next block to read, leaves: [index, commitment hex, memo][] } */
  const pools = new Map();
  let refreshedAt = 0;
  let refreshing = null;
  let cache = null; // { all: { json, gz } }

  const track = (address, abi, from) => {
    const k = address.toLowerCase();
    if (!pools.has(k)) pools.set(k, { address, abi, next: from, leaves: [] });
  };

  async function refresh() {
    if (vaults && vaultsBlock !== undefined) {
      const n = Number(await pub.readContract({ address: vaults, abi: cloakVaultsAbi, functionName: "tokensCount" }));
      const tokens = await Promise.all(Array.from({ length: n }, (_, i) => pub.readContract({ address: vaults, abi: cloakVaultsAbi, functionName: "tokens", args: [BigInt(i)] })));
      const ps = await Promise.all(tokens.map((t) => pub.readContract({ address: vaults, abi: cloakVaultsAbi, functionName: "poolOf", args: [t] })));
      for (const p of ps) track(p, shieldedPoolAbi, vaultsBlock);
    }
    if (shared && sharedBlock !== undefined) track(shared, sharedVaultAbi, sharedBlock);
    await Promise.all(gloamTrees.map((t) => t.update(pub)));
    const latest = await pub.getBlockNumber({ cacheTime: 0 });
    await Promise.all(
      [...pools.values()].map(async (p) => {
        if (latest < p.next) return;
        const logs = await pub.getContractEvents({ address: p.address, abi: p.abi, eventName: "NewCommitment", fromBlock: p.next, toBlock: latest, strict: true });
        const have = new Set(p.leaves.map((l) => l[0]));
        for (const l of logs) {
          const i = Number(l.args.index);
          if (!have.has(i)) p.leaves.push([i, `0x${l.args.commitment.toString(16)}`, l.args.encryptedOutput]);
        }
        p.leaves.sort((a, b) => a[0] - b[0]);
        p.block = latest;
        p.next = latest + 1n;
      }),
    );
    refreshedAt = Date.now();
    cache = null;
  }

  const gloamView = (t) => ({ pool: t.pool, block: (t.scannedTo - 1n).toString(), leaves: t.list().map((c, i) => [i, c, "0x"]) });
  const views = () => [...[...pools.values()].map(view), ...gloamTrees.filter((t) => t.scannedTo > t.fromBlock).map(gloamView)];

  async function fresh() {
    if (Date.now() - refreshedAt < MIN_REFRESH_MS && refreshedAt) return;
    refreshing ??= refresh().finally(() => (refreshing = null));
    await refreshing;
  }

  const pack = (json) => ({ json, gz: gzipSync(json), etag: `W/"${createHash("sha256").update(json).digest("base64url").slice(0, 22)}"` });
  const view = (p) => ({ pool: p.address, block: (p.block ?? p.next - 1n).toString(), leaves: p.leaves });

  return {
    /** JSON (and its gzip) for one pool or all of them; null for an unknown pool. */
    async get(pool) {
      await fresh();
      if (pool) {
        const p = pools.get(pool.toLowerCase());
        const g = gloamTrees.find((t) => t.pool.toLowerCase() === pool.toLowerCase());
        if (!p && !g) return null;
        return pack(JSON.stringify(p ? view(p) : gloamView(g)));
      }
      if (!cache) {
        cache = pack(JSON.stringify({ vaults: views() }));
      }
      return cache;
    },
  };
}
