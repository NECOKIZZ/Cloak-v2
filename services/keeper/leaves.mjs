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

  // The ETag names the leaves only (each vault's address, leaf count and last leaf: the list is append-only and checked
  // against the vault's count), not `block`, which moves on every refresh. So a browser asking again gets a bodiless 304
  // until a new leaf lands. Its cached copy then carries an older `block`, which is still right: no leaf came after it,
  // and the app reads the chain from there.
  const tag = (ts) => `W/"${createHash("sha256").update(ts.map((t) => `${t.pool.toLowerCase()}:${t.leafCount}:${t.list().at(-1) ?? ""}`).join(",")).digest("base64url").slice(0, 22)}"`;
  const pack = (json, ts) => ({ json, gz: gzipSync(json), etag: tag(ts) });
  const view = (t) => ({ pool: t.pool, block: (t.scannedTo - 1n).toString(), leaves: t.list().map((c, i) => [i, c, "0x"]) });

  return {
    /** JSON (and its gzip) for one vault or all of them; null for an unknown vault. */
    async get(pool) {
      await fresh();
      if (pool) {
        const t = trees.find((x) => x.pool.toLowerCase() === pool.toLowerCase());
        return t ? pack(JSON.stringify(view(t)), [t]) : null;
      }
      const ready = trees.filter((t) => t.scannedTo > t.fromBlock);
      cache ??= pack(JSON.stringify({ vaults: ready.map(view) }), ready);
      return cache;
    },
  };
}
