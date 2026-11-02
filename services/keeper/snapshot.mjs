// A snapshot of Cloak's public data, rebuilt every 30 s, so the site can show launches, markets, launch images and
// Volume in one request instead of hundreds of RPC calls per visitor. Everything here is public chain data; nothing
// private ever passes through it. The site still reads the chain for anything that moves money.
//   GET /snapshot → { at, block, markets, launches, meta, stats } (bigints as {"$n":"…"})
import { gzipSync } from "node:zlib";
import { zeroAddress } from "viem";
import { Cloak, cloakFactoryAbi, cloakPairAbi, cloakTokenAbi, privateBatcherAbi, privateRouterAbi, shieldedPoolAbi, whypeAbi } from "@cloakely/sdk";

const WAD = 10n ** 18n;
const LAUNCH_CREATED_V1 = [{ type: "event", name: "LaunchCreated", inputs: [
  { name: "index", type: "uint256", indexed: true }, { name: "auction", type: "address", indexed: true }, { name: "token", type: "address", indexed: true },
  { name: "creator", type: "address", indexed: false }, { name: "launchpad", type: "address", indexed: false }, { name: "name", type: "string", indexed: false },
  { name: "symbol", type: "string", indexed: false }, { name: "creatorAlloc", type: "uint256", indexed: false }, { name: "metadataURI", type: "string", indexed: false },
] }];

export const toJson = (x) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? { $n: v.toString() } : v));

/**
 * @param pub   a multicall-batched public client
 * @param d     { router, routerBlock, batcher, factory, earlierFactories?, previous: [{ router, routerBlock, batcher, factory }] }
 */
export function startSnapshots(pub, d, { everyMs = 30_000, log = console.error } = {}) {
  const prev = (d.previous ?? []).filter((p) => p.router);
  const older = [...(d.earlierFactories ?? []), ...prev.map((p) => p.factory)].filter(Boolean);
  const reader = new Cloak(pub, undefined, d.factory, older);
  const factories = [d.factory, ...older];
  let body = null; // the last snapshot, serialized once
  let zipped = null;

  // events are fetched once from their start block, then only the new blocks each round
  const logs = new Map();
  async function since(key, fromBlock, head, q) {
    const c = logs.get(key) ?? { to: fromBlock - 1n, list: [] };
    if (c.to < head) {
      const fresh = await pub.getContractEvents({ ...q, fromBlock: c.to + 1n, toBlock: head, strict: true });
      c.list.push(...fresh);
      c.to = head;
      logs.set(key, c);
    }
    return c.list;
  }

  async function markets() {
    const c = { address: d.router, abi: privateRouterAbi };
    const [n, whype] = await Promise.all([pub.readContract({ ...c, functionName: "tokensCount" }), pub.readContract({ ...c, functionName: "whype" })]);
    const tokens = await Promise.all(Array.from({ length: Number(n) }, (_, i) => pub.readContract({ ...c, functionName: "tokens", args: [BigInt(i)] })));
    const rows = await Promise.all(
      tokens.map(async (token) => {
        if (token.toLowerCase() === whype.toLowerCase()) return null;
        const pair = await pub.readContract({ ...c, functionName: "pairOf", args: [token] });
        if (pair === zeroAddress) return null; // an asset (USDC), not a market
        const [pool, symbol, name, reserveHype, reserveToken, price, batchable] = await Promise.all([
          pub.readContract({ ...c, functionName: "poolOf", args: [token] }),
          pub.readContract({ address: token, abi: cloakTokenAbi, functionName: "symbol" }),
          pub.readContract({ address: token, abi: cloakTokenAbi, functionName: "name" }),
          pub.readContract({ address: pair, abi: cloakPairAbi, functionName: "reserveHype" }),
          pub.readContract({ address: pair, abi: cloakPairAbi, functionName: "reserveToken" }),
          pub.readContract({ address: pair, abi: cloakPairAbi, functionName: "price" }),
          pub.readContract({ address: pair, abi: cloakPairAbi, functionName: "lastUpdate" }).then(() => true, () => false),
        ]);
        return { token, pool, pair, symbol, name, price, reserveHype, reserveToken, batchable };
      }),
    );
    return rows.filter(Boolean).reverse(); // newest first, as the site lists them
  }

  async function meta(head) {
    const q = { address: factories, eventName: "LaunchCreated" };
    const [now, v1] = await Promise.all([since("meta", 0n, head, { ...q, abi: cloakFactoryAbi }), since("meta1", 0n, head, { ...q, abi: LAUNCH_CREATED_V1 })]);
    return [...now, ...v1].map((l) => ({ auction: l.args.auction, token: l.args.token, metadataURI: l.args.metadataURI ?? "" }));
  }

  /** The Volume page's totals, from the current deployment and every earlier one (same rules as the site). */
  async function stats(head, mkts, auctions) {
    const prices = new Map(mkts.map((m) => [m.token.toLowerCase(), m.price]));
    const sources = await Promise.all(
      [{ router: d.router, batcher: d.batcher, from: d.routerBlock }, ...prev.map((p) => ({ router: p.router, batcher: p.batcher, from: p.routerBlock ?? 0n }))].map(async (s) => {
        const c = { address: s.router, abi: privateRouterAbi };
        const [hypePool, whype, n] = await Promise.all([pub.readContract({ ...c, functionName: "hypePool" }), pub.readContract({ ...c, functionName: "whype" }), pub.readContract({ ...c, functionName: "tokensCount" })]);
        const tokens = await Promise.all(Array.from({ length: Number(n) - 1 }, (_, i) => pub.readContract({ ...c, functionName: "tokens", args: [BigInt(i + 1)] })));
        const pools = await Promise.all(tokens.map((t) => pub.readContract({ ...c, functionName: "poolOf", args: [t] })));
        const ev = (addr, abi, eventName) => since(`${addr}:${eventName}`, s.from, head, { address: addr, abi, eventName });
        const [shields, unshields, swaps, settles, orders, nullifiers, vaultHype, tokenVaults] = await Promise.all([
          ev(s.router, privateRouterAbi, "Shielded"),
          ev(s.router, privateRouterAbi, "Unshielded"),
          ev(s.router, privateRouterAbi, "PrivateSwap"),
          s.batcher ? ev(s.batcher, privateBatcherAbi, "BatchSettled") : [],
          s.batcher ? ev(s.batcher, privateBatcherAbi, "OrderPlaced") : [],
          since(`${s.router}:nullifiers:${pools.length}`, s.from, head, { address: [hypePool, ...pools], abi: shieldedPoolAbi, eventName: "NewNullifier" }),
          pub.readContract({ address: whype, abi: whypeAbi, functionName: "balanceOf", args: [hypePool] }),
          Promise.all(tokens.map((t, i) => pub.readContract({ address: t, abi: cloakTokenAbi, functionName: "balanceOf", args: [pools[i]] }).then((b) => (b * (prices.get(t.toLowerCase()) ?? 0n)) / WAD))),
        ]);
        return { hypePool, shields, unshields, swaps, settles, orders, nullifiers, vaultHype, tokenVault: tokenVaults.reduce((a, b) => a + b, 0n) };
      }),
    );
    const all = (k) => sources.flatMap((x) => x[k]);
    const [shields, unshields, swaps, settles, orders, nullifiers] = ["shields", "unshields", "swaps", "settles", "orders", "nullifiers"].map(all);
    const hypePools = new Set(sources.map((x) => x.hypePool.toLowerCase()));
    const sum = (xs) => xs.reduce((a, b) => a + b, 0n);
    const swapHype = swaps.map((e) => (hypePools.has(e.args.poolIn.toLowerCase()) ? e.args.amountIn : e.args.amountOut));
    const batchHype = settles.map((e) => e.args.buyHype + e.args.hypeForSellers);
    const shielded = sum(shields.map((e) => e.args.amount));
    const swapVolume = sum(swapHype);
    const batchVolume = sum(batchHype);
    const bidDeposits = sum(auctions.map((a) => a.totalDeposits));
    const vaultHype = sum(sources.map((x) => x.vaultHype));
    const recent = [
      ...shields.map((e) => ({ kind: "Shielded", amount: e.args.amount, block: e.blockNumber, tx: e.transactionHash })),
      ...swaps.map((e, i) => ({ kind: hypePools.has(e.args.poolIn.toLowerCase()) ? "Private buy" : "Private sell", amount: swapHype[i], block: e.blockNumber, tx: e.transactionHash })),
      ...settles.map((e, i) => ({ kind: "Batch round", amount: batchHype[i], block: e.blockNumber, tx: e.transactionHash })),
      ...unshields.map((e) => ({ kind: "Withdrawn", amount: e.args.amount, block: e.blockNumber, tx: e.transactionHash })),
    ].sort((a, b) => Number(b.block - a.block)).slice(0, 12);
    return {
      total: shielded + swapVolume + batchVolume + bidDeposits,
      vault: vaultHype + sum(sources.map((x) => x.tokenVault)),
      vaultHype,
      shielded,
      withdrawn: sum(unshields.map((e) => e.args.amount)),
      swapVolume,
      swaps: swaps.length,
      batchVolume,
      batchRounds: settles.length,
      batchOrders: orders.length,
      bidDeposits,
      bids: auctions.reduce((a, s) => a + s.commits, 0),
      raised: sum(auctions.filter((a) => a.settled && !a.failed).map((a) => a.raised)),
      launches: auctions.length,
      privateTxs: Math.floor(nullifiers.length / 2),
      recent,
    };
  }

  async function build() {
    const head = await pub.getBlockNumber();
    const [mkts, list, m] = await Promise.all([markets(), reader.listLaunches(), meta(head)]);
    const launches = await Promise.all(list.map((l) => reader.getAuction(l.auction)));
    const st = await stats(head, mkts, launches);
    body = toJson({ at: Date.now(), block: head, markets: mkts, launches: launches.reverse(), meta: m, stats: st });
    zipped = gzipSync(body);
  }

  (async function loop() {
    for (;;) {
      const t = Date.now();
      await build().then(() => log(`[snapshot] block ${JSON.parse(body).block.$n} in ${Date.now() - t} ms, ${body.length} bytes`), (e) => log(`[snapshot] failed: ${e.shortMessage ?? e.message}`));
      await new Promise((r) => setTimeout(r, everyMs));
    }
  })();

  return { get: () => body, gz: () => zipped };
}
