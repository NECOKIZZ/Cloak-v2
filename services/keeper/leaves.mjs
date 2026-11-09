// The public leaf list of each vault (Gloam's and Cloak's launch vault: every commitment, in order), so an app's first
// sync on a new device is one download instead of a scan of every vault's history. Everything here is public on chain.
// The request names only the vault, the same for everyone, so the keeper never learns whose notes are whose. Apps
// rebuild the Merkle tree from it and use it only if the vault knows its root; otherwise they scan the chain.
//   GET /leaves            every vault
//   GET /leaves?pool=0x…   one vault
// Each list comes from the vault's Shielded, Transferred and SealedSwapped events, read incrementally and checked against
// the vault's own leaf count (GloamTree), so it never has a gap. It's read only when someone asks, at most every 10 s.
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { GloamTree } from "@cloakely/sdk";

const MIN_REFRESH_MS = 10_000;

/** @param vaults [{ address, block }] */
export function startLeaves(pub, { vaults = [] }) {
  const trees = vaults.map((g) => new GloamTree(g.address, BigInt(g.block)));
  let refreshedAt = 0;
  let refreshing = null;
  let cache = null; // every vault: { json, gz, etag }

  async function fresh() {
    if (Date.now() - refreshedAt < MIN_REFRESH_MS && refreshedAt) return;
    refreshing ??= Promise.all(trees.map((t) => t.update(pub)))
      .then(() => {
        refreshedAt = Date.now();
        cache = null;
      })
      .finally(() => (refreshing = null));
    await refreshing;
  }

  const pack = (json) => ({ json, gz: gzipSync(json), etag: `W/"${createHash("sha256").update(json).digest("base64url").slice(0, 22)}"` });
  const view = (t) => ({ pool: t.pool, block: (t.scannedTo - 1n).toString(), leaves: t.list().map((c, i) => [i, c, "0x"]) });

  return {
    /** JSON (and its gzip) for one vault or all of them; null for an unknown vault. */
    async get(pool) {
      await fresh();
      if (pool) {
        const t = trees.find((x) => x.pool.toLowerCase() === pool.toLowerCase());
        return t ? pack(JSON.stringify(view(t))) : null;
      }
      cache ??= pack(JSON.stringify({ vaults: trees.filter((t) => t.scannedTo > t.fromBlock).map(view) }));
      return cache;
    },
  };
}
