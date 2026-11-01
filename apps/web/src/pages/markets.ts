import { useEffect, useState } from "react";
import type { Address } from "viem";
import { cloakConfigAbi, cloakPairAbi, cloakTokenAbi, privateRouterAbi } from "@cloakely/sdk";
import { ROUTER } from "../config";
import { publicClient } from "../wallet";
import { friendly } from "../errors";
import { getSnapshot, save, saved } from "../snapshot";

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
}

let cache: { at: number; data: Market[] } | null = null;

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
export async function loadMarkets(force = false): Promise<Market[]> {
  if (!ROUTER) return [];
  if (!force && cache && Date.now() - cache.at < 15_000) return cache.data;
  const snap = force ? null : await getSnapshot();
  const data = (snap && (await checked(snap.markets as Market[]))) || (await marketsFromChain());
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
    const t = setInterval(go, 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return { markets, err };
}

let feeBps: Promise<number> | null = null;
/** The protocol's withdrawal fee (a private swap is a withdrawal into the router), in bps. */
export function withdrawFeeBps(): Promise<number> {
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
