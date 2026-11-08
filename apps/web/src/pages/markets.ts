import { useEffect, useState } from "react";
import type { Address } from "viem";
import { parseAbi } from "viem";
import { cloakConfigAbi, cloakPairAbi, cloakTokenAbi, privateRouterAbi, sharedVaultAbi } from "@cloakely/sdk";
import { CORE, GLOAM, ROUTER, SHARED, SHARED_BATCHER } from "../config";
import { publicClient } from "../wallet";
import { friendly } from "../errors";
import { getSnapshot, save, saved } from "../snapshot";
import { every } from "../every";

const BATCHER_V4 = parseAbi(["function marketOf(address) view returns (address)"]);
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

export interface Market {
  token: Address;
  pool: Address;
  pair: Address;
  symbol: string;
  name: string;
  /** wei of HYPE per whole token */
  price: bigint;
  reserveHype: bigint;
  reserveToken: bigint;
  /** Batch rounds need the pair's time-weighted price, which first-deployment pairs don't have. */
  batchable: boolean;
  /** In the shared launch-token vault (pool is the shared vault): instant trades, sends that hide the token. */
  shared?: boolean;
}

/** Tokens in the shared launch-token vault, with their Uniswap market. Always read from the chain. */
async function sharedMarkets(): Promise<Market[]> {
  if (!SHARED) return [];
  const c = { address: SHARED, abi: sharedVaultAbi } as const;
  const n = Number(await publicClient.readContract({ ...c, functionName: "tokensCount" }));
  const tokens = await Promise.all(Array.from({ length: n }, (_, i) => publicClient.readContract({ ...c, functionName: "tokens", args: [BigInt(i)] })));
  const rows = await Promise.all(
    tokens.map(async (token): Promise<Market> => {
      const pair = await publicClient.readContract({ ...c, functionName: "marketOf", args: [token] });
      const [symbol, name, reserveHype, reserveToken, price] = await Promise.all([
        publicClient.readContract({ address: token, abi: cloakTokenAbi, functionName: "symbol" }),
        publicClient.readContract({ address: token, abi: cloakTokenAbi, functionName: "name" }),
        publicClient.readContract({ address: pair, abi: cloakPairAbi, functionName: "reserveHype" }),
        publicClient.readContract({ address: pair, abi: cloakPairAbi, functionName: "reserveToken" }),
        publicClient.readContract({ address: pair, abi: cloakPairAbi, functionName: "price" }),
      ]);
      return { token, pool: SHARED!, pair, symbol, name, price, reserveHype, reserveToken, batchable: !!SHARED_BATCHER, shared: true };
    }),
  );
  return rows.reverse();
}

let cache: { at: number; data: Market[] } | null = null;

// ───────────── Cloak v2 on Gloam: launch tokens in the launch vault, traded through their Uniswap V2 pools ─────────────

const GLOAM_READS = parseAbi([
  "function launchTokensCount() view returns (uint256)",
  "function launchTokens(uint256) view returns (address)",
  "function withdrawFeeBps() view returns (uint16)",
  "function factory() view returns (address)",
  "function getPair(address, address) view returns (address)",
  "function token0() view returns (address)",
  "function getReserves() view returns (uint112, uint112, uint32)",
]);

async function v2Reserves(pair: Address): Promise<[bigint, bigint]> {
  const [[r0, r1], t0] = await Promise.all([
    publicClient.readContract({ address: pair, abi: GLOAM_READS, functionName: "getReserves" }),
    publicClient.readContract({ address: pair, abi: GLOAM_READS, functionName: "token0" }),
  ]);
  return t0.toLowerCase() === GLOAM!.whype.toLowerCase() ? [r0, r1] : [r1, r0];
}

/**
 * Launch tokens admitted to the launch vault that Cloak v2 on Gloam can trade: through their launch's own Uniswap v4
 * market (CloakV4Market, quoted like Cloak's pairs) when the v4 venue is deployed, else through a V2 pool with WHYPE.
 * A market's pool id is its token.
 */
async function gloamMarkets(): Promise<Market[]> {
  const g = GLOAM;
  if (g?.launchSwapV4) return gloamV4Markets(g.launchVault);
  if (!g?.launchSwap) return [];
  const lv = g.launchVault;
  const n = await publicClient.readContract({ address: lv, abi: GLOAM_READS, functionName: "launchTokensCount" });
  const factory = await publicClient.readContract({ address: g.launchSwap, abi: GLOAM_READS, functionName: "factory" });
  const rows = await Promise.all(
    Array.from({ length: Number(n) }, async (_, i): Promise<Market | null> => {
      const token = await publicClient.readContract({ address: lv, abi: GLOAM_READS, functionName: "launchTokens", args: [BigInt(i)] });
      const pair = await publicClient.readContract({ address: factory, abi: GLOAM_READS, functionName: "getPair", args: [g.whype, token] });
      if (pair === "0x0000000000000000000000000000000000000000") return null;
      const [symbol, name, [reserveHype, reserveToken]] = await Promise.all([
        publicClient.readContract({ address: token, abi: cloakTokenAbi, functionName: "symbol" }),
        publicClient.readContract({ address: token, abi: cloakTokenAbi, functionName: "name" }),
        v2Reserves(pair),
      ]);
      const price = reserveToken === 0n ? 0n : (reserveHype * 10n ** 18n) / reserveToken;
      return { token, pool: token, pair, symbol, name, price, reserveHype, reserveToken, batchable: !!g.batcher };
    }),
  );
  return rows.filter((x): x is Market => x !== null).reverse();
}

/** Every launch token with a private market, read from the chain (all tokens at once). */
async function marketsFromChain(): Promise<Market[]> {
  const c = { address: ROUTER!, abi: privateRouterAbi } as const;
  const [n, whype] = await Promise.all([publicClient.readContract({ ...c, functionName: "tokensCount" }), publicClient.readContract({ ...c, functionName: "whype" })]);
  const tokens = await Promise.all(Array.from({ length: Number(n) }, (_, i) => publicClient.readContract({ ...c, functionName: "tokens", args: [BigInt(i)] })));
  const rows = await Promise.all(
    tokens.map(async (token): Promise<Market | null> => {
      if (token.toLowerCase() === whype.toLowerCase()) return null;
      const pair = await publicClient.readContract({ ...c, functionName: "pairOf", args: [token] });
      // a vault without a launch pair holds an existing token (USDC): an asset, not a market
      if (pair === "0x0000000000000000000000000000000000000000") return null;
      const [pool, symbol, name, reserveHype, reserveToken, price, batchable] = await Promise.all([
        publicClient.readContract({ ...c, functionName: "poolOf", args: [token] }),
        publicClient.readContract({ address: token, abi: cloakTokenAbi, functionName: "symbol" }),
        publicClient.readContract({ address: token, abi: cloakTokenAbi, functionName: "name" }),
        publicClient.readContract({ address: pair, abi: cloakPairAbi, functionName: "reserveHype" }),
        publicClient.readContract({ address: pair, abi: cloakPairAbi, functionName: "reserveToken" }),
        publicClient.readContract({ address: pair, abi: cloakPairAbi, functionName: "price" }),
        publicClient.readContract({ address: pair, abi: cloakPairAbi, functionName: "lastUpdate" }).then(() => true, () => false),
      ]);
      return { token, pool, pair, symbol, name, price, reserveHype, reserveToken, batchable };
    }),
  );
  return rows.filter((x): x is Market => x !== null).reverse(); // newest launches first, so the default market is a recent one
}

/** The snapshot's markets, if every vault and pair address matches the router on chain (trades use these addresses). */
async function checked(ms: Market[]): Promise<Market[] | null> {
  const c = { address: ROUTER!, abi: privateRouterAbi } as const;
  const ok = await Promise.all(
    ms.map(async (m) => {
      const [pool, pair] = await Promise.all([publicClient.readContract({ ...c, functionName: "poolOf", args: [m.token] }), publicClient.readContract({ ...c, functionName: "pairOf", args: [m.token] })]);
      return pool.toLowerCase() === m.pool.toLowerCase() && pair.toLowerCase() === m.pair.toLowerCase();
    }),
  ).catch(() => [false]);
  return ok.every(Boolean) ? ms : null;
}

/**
 * Every launch token with a private market, plus pool prices: from the keeper's snapshot when it's fresh and its
 * addresses check out on chain, else from the chain. `force` always reads the chain (fresh reserves after a trade).
 */
const LAUNCHES = parseAbi([
  "function factory() view returns (address)",
  "function launchesCount() view returns (uint256)",
  "function launches(uint256) view returns (address auction, address token, address creator, address launchpad, uint256 creatorAlloc, address vesting)",
  "function pair() view returns (address)",
  "function isLaunchToken(address) view returns (bool)",
]);

/** Admitted launch tokens with their launch's v4 market (auction.pair(), a CloakV4Market): reserves, price, quotes. */
async function gloamV4Markets(lv: Address): Promise<Market[]> {
  const factory = await publicClient.readContract({ address: lv, abi: LAUNCHES, functionName: "factory" });
  const n = await publicClient.readContract({ address: factory, abi: LAUNCHES, functionName: "launchesCount" });
  const rows = await Promise.all(
    Array.from({ length: Number(n) }, async (_, i): Promise<Market | null> => {
      const [auction, token] = await publicClient.readContract({ address: factory, abi: LAUNCHES, functionName: "launches", args: [BigInt(i)] });
      const [admitted, pair] = await Promise.all([
        publicClient.readContract({ address: lv, abi: LAUNCHES, functionName: "isLaunchToken", args: [token] }),
        publicClient.readContract({ address: auction, abi: LAUNCHES, functionName: "pair" }).catch(() => "0x0000000000000000000000000000000000000000" as Address),
      ]);
      if (!admitted || pair === "0x0000000000000000000000000000000000000000") return null;
      const [symbol, name, reserveHype, reserveToken, price] = await Promise.all([
        publicClient.readContract({ address: token, abi: cloakTokenAbi, functionName: "symbol" }),
        publicClient.readContract({ address: token, abi: cloakTokenAbi, functionName: "name" }),
        publicClient.readContract({ address: pair, abi: cloakPairAbi, functionName: "reserveHype" }),
        publicClient.readContract({ address: pair, abi: cloakPairAbi, functionName: "reserveToken" }),
        publicClient.readContract({ address: pair, abi: cloakPairAbi, functionName: "price" }),
      ]);
      // batch rounds through the launch's v4 market (CloakGloamBatcherV4), once the keeper has registered it there
      const batchable = GLOAM?.batcherV4
        ? (await publicClient.readContract({ address: GLOAM.batcherV4, abi: BATCHER_V4, functionName: "marketOf", args: [token] }).catch(() => ZERO)) !== ZERO
        : false;
      return { token, pool: token, pair, symbol, name, price, reserveHype, reserveToken, batchable };
    }),
  );
  return rows.filter((x): x is Market => x !== null).reverse();
}

export async function loadMarkets(force = false): Promise<Market[]> {
  if (CORE === "gloam") {
    if (!force && cache && Date.now() - cache.at < 15_000) return cache.data;
    const data = await gloamMarkets();
    cache = { at: Date.now(), data };
    return data;
  }
  if (!ROUTER) return [];
  if (!force && cache && Date.now() - cache.at < 15_000) return cache.data;
  const snap = force ? null : await getSnapshot();
  const [own, shared] = await Promise.all([(async () => (snap && (await checked(snap.markets as Market[]))) || (await marketsFromChain()))(), sharedMarkets().catch(() => [] as Market[])]);
  // a token is listed once: if it is in the shared vault, that is where its private balance lives
  const inShared = new Set(shared.map((m) => m.token.toLowerCase()));
  const data = [...shared, ...own.filter((m) => !inShared.has(m.token.toLowerCase()))];
  cache = { at: Date.now(), data };
  save("markets", data);
  return data;
}

export function useMarkets() {
  const [markets, setMarkets] = useState<Market[] | null>(cache?.data ?? saved<Market[]>("markets") ?? null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let alive = true;
    const go = () => loadMarkets().then((m) => alive && setMarkets(m)).catch((e) => alive && setErr(friendly(e)));
    go();
    // a minute is plenty for other people's trades: after your own the app reads the chain at once (loadMarkets(true))
    const stop = every(go, 60_000);
    return () => {
      alive = false;
      stop();
    };
  }, []);
  return { markets, err };
}

let feeBps: Promise<number> | null = null;
/** The protocol's withdrawal fee (a private swap is a withdrawal into the router), in bps. */
export function withdrawFeeBps(): Promise<number> {
  if (CORE === "gloam" && GLOAM) {
    feeBps ??= publicClient.readContract({ address: GLOAM.launchVault, abi: GLOAM_READS, functionName: "withdrawFeeBps" }).then(Number).catch(() => ((feeBps = null), 0));
    return feeBps;
  }
  if (!ROUTER) return Promise.resolve(0);
  feeBps ??= publicClient
    .readContract({ address: ROUTER, abi: privateRouterAbi, functionName: "config" })
    .then((config) => publicClient.readContract({ address: config, abi: cloakConfigAbi, functionName: "withdrawFeeBps" }))
    .then(Number)
    .catch(() => ((feeBps = null), 0));
  return feeBps;
}

/** "0.25%" (or "no") for display. */
export function useFeePct(): string {
  const [bps, setBps] = useState<number | null>(null);
  useEffect(() => {
    withdrawFeeBps().then(setBps);
  }, []);
  return bps === null ? "a" : bps === 0 ? "no" : `${bps / 100}%`;
}

export async function quote(m: Market, side: "buy" | "sell", amountIn: bigint): Promise<bigint> {
  if (amountIn <= 0n) return 0n;
  amountIn -= (amountIn * BigInt(await withdrawFeeBps())) / 10_000n; // what the router actually trades
  if (CORE === "gloam" && !GLOAM?.launchSwapV4) {
    // Uniswap V2 (0.3%), on live reserves
    const [rH, rT] = await v2Reserves(m.pair);
    const [rIn, rOut] = side === "buy" ? [rH, rT] : [rT, rH];
    const x = amountIn * 997n;
    return (x * rOut) / (rIn * 1000n + x);
  }
  // live reserves, so the quote reflects trades made since the markets were loaded
  const [rH, rT] = await Promise.all([
    publicClient.readContract({ address: m.pair, abi: cloakPairAbi, functionName: "reserveHype" }),
    publicClient.readContract({ address: m.pair, abi: cloakPairAbi, functionName: "reserveToken" }),
  ]);
  return publicClient.readContract({
    address: m.pair,
    abi: cloakPairAbi,
    functionName: "getAmountOut",
    args: side === "buy" ? [amountIn, rH, rT] : [amountIn, rT, rH],
  });
}
