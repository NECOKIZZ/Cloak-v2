import { useEffect, useState } from "react";
import type { Address } from "viem";
import { cloakPairAbi, cloakTokenAbi, privateRouterAbi } from "@cloak/sdk";
import { ROUTER } from "../config";
import { publicClient } from "../wallet";

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
}

let cache: { at: number; data: Market[] } | null = null;

/** Every launch token with a private market (from the PrivateRouter registry), plus live pool prices. */
export async function loadMarkets(force = false): Promise<Market[]> {
  if (!ROUTER) return [];
  if (!force && cache && Date.now() - cache.at < 15_000) return cache.data;
  const c = { address: ROUTER, abi: privateRouterAbi } as const;
  const n = await publicClient.readContract({ ...c, functionName: "tokensCount" });
  const out: Market[] = [];
  for (let i = 1n; i < n; i++) {
    const token = await publicClient.readContract({ ...c, functionName: "tokens", args: [i] });
    const [pool, pair, symbol, name] = await Promise.all([
      publicClient.readContract({ ...c, functionName: "poolOf", args: [token] }),
      publicClient.readContract({ ...c, functionName: "pairOf", args: [token] }),
      publicClient.readContract({ address: token, abi: cloakTokenAbi, functionName: "symbol" }),
      publicClient.readContract({ address: token, abi: cloakTokenAbi, functionName: "name" }),
    ]);
    const [reserveHype, reserveToken, price] = await Promise.all([
      publicClient.readContract({ address: pair, abi: cloakPairAbi, functionName: "reserveHype" }),
      publicClient.readContract({ address: pair, abi: cloakPairAbi, functionName: "reserveToken" }),
      publicClient.readContract({ address: pair, abi: cloakPairAbi, functionName: "price" }),
    ]);
    out.push({ token, pool, pair, symbol, name, price, reserveHype, reserveToken });
  }
  cache = { at: Date.now(), data: out };
  return out;
}

export function useMarkets() {
  const [markets, setMarkets] = useState<Market[] | null>(cache?.data ?? null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let alive = true;
    const go = () => loadMarkets().then((m) => alive && setMarkets(m)).catch((e) => alive && setErr(e.shortMessage ?? e.message));
    go();
    const t = setInterval(go, 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return { markets, err };
}

export async function quote(m: Market, side: "buy" | "sell", amountIn: bigint): Promise<bigint> {
  if (amountIn <= 0n) return 0n;
  return publicClient.readContract({
    address: m.pair,
    abi: cloakPairAbi,
    functionName: "getAmountOut",
    args: side === "buy" ? [amountIn, m.reserveHype, m.reserveToken] : [amountIn, m.reserveToken, m.reserveHype],
  });
}
