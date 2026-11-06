// The public note list of every Cloak vault (commitment and encrypted memo of each leaf, in order), so an app's first
// sync on a new device is one download instead of a scan of every vault's history. Everything here is public on chain.
// The request names only the vault, the same for everyone, so the keeper never learns whose notes are whose. Apps
// rebuild the Merkle tree from it and use it only if the root is one the vault knows; otherwise they scan the chain.
//   GET /leaves            every vault
//   GET /leaves?pool=0x…   one vault
import { gzipSync } from "node:zlib";
import { cloakVaultsAbi, sharedVaultAbi, shieldedPoolAbi } from "@cloakely/sdk";

const MIN_REFRESH_MS = 10_000;

export function startLeaves(pub, { vaults, vaultsBlock, shared, sharedBlock }) {
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

  async function fresh() {
    if (Date.now() - refreshedAt < MIN_REFRESH_MS && pools.size) return;
    refreshing ??= refresh().finally(() => (refreshing = null));
    await refreshing;
  }

  const view = (p) => ({ pool: p.address, block: (p.block ?? p.next - 1n).toString(), leaves: p.leaves });

  return {
    /** JSON (and its gzip) for one pool or all of them; null for an unknown pool. */
    async get(pool) {
      await fresh();
      if (pool) {
        const p = pools.get(pool.toLowerCase());
        if (!p) return null;
        const json = JSON.stringify(view(p));
        return { json, gz: gzipSync(json) };
      }
      if (!cache) {
        const json = JSON.stringify({ vaults: [...pools.values()].map(view) });
        cache = { json, gz: gzipSync(json) };
      }
      return cache;
    },
  };
}
