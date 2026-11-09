import { useEffect, useState } from "react";
import type { Address } from "viem";
import { parseAbi } from "viem";
import { cloakPairAbi, cloakTokenAbi } from "@cloakely/sdk";
import { GLOAM } from "../config";
import { publicClient } from "../wallet";
import { friendly } from "../errors";
import { save, saved } from "../snapshot";
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
  /** Registered for batch rounds (CloakGloamBatcherV4), which the keeper does once the launch settles. */
  batchable: boolean;
}

let cache: { at: number; data: Market[] } | null = null;

const GLOAM_READS = parseAbi(["function withdrawFeeBps() view returns (uint16)"]);

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

/**
 * Every launch token with a private market (admitted to the launch vault, with its v4 pool), and pool prices, read
 * from the chain. Kept 15 s; `force` reads again (fresh reserves after a trade). The last list is saved on this
 * device, so the next visit shows it at once while the fresh one loads.
 */
export async function loadMarkets(force = false): Promise<Market[]> {
  if (!GLOAM) return [];
  if (!force && cache && Date.now() - cache.at < 15_000) return cache.data;
  const data = await gloamV4Markets(GLOAM.launchVault);
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
/** The launch vault's withdrawal fee (a private swap is a withdrawal into the swap escrow), in bps. */
export function withdrawFeeBps(): Promise<number> {
  if (!GLOAM) return Promise.resolve(0);
  feeBps ??= publicClient.readContract({ address: GLOAM.launchVault, abi: GLOAM_READS, functionName: "withdrawFeeBps" }).then(Number).catch(() => ((feeBps = null), 0));
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
