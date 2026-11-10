import { useEffect, useState } from "react";
import type { Address } from "viem";
import { encodeAbiParameters, keccak256, parseAbi, toHex } from "viem";
import { cloakPairAbi, cloakTokenAbi } from "@cloakely/sdk";
import { ASSETS, DEPLOYMENT, GLOAM } from "../config";
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
  decimals: number;
  /** "launch": a Cloak launch token (launch vault). "eco": an outside token (ecosystem vault). "asset": USDC (Gloam's vault). */
  kind: "launch" | "eco" | "asset";
  /** Outside tokens and USDC: the plain native-HYPE v4 pool (no hook) the router trades it through. */
  hop?: PoolKey;
}

export type PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };

/** The vault a market's balance trades from: with the router, HYPE and USDC in Gloam's, each token in its own vault. */
export function vaultOf(m: Market | null): Address | undefined {
  if (!GLOAM) return undefined;
  if (!GLOAM.router) return GLOAM.launchVault;
  if (!m || m.kind === "asset") return GLOAM.gloamVault;
  if (m.kind === "eco") return GLOAM.ecosystemVault;
  return GLOAM.launchVault;
}

const ECO = parseAbi([
  "function ecosystemTokensCount() view returns (uint256)",
  "function ecosystemTokens(uint256) view returns (address)",
  "function poolKeyOf(address) view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks))",
  "function poolState((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key) view returns (uint160 sqrtPriceX96, uint128 liquidity)",
]);

const EXTSLOAD = parseAbi(["function extsload(bytes32 slot) view returns (bytes32)"]);
const KEY_TYPE = [{ type: "tuple", components: [{ name: "currency0", type: "address" }, { name: "currency1", type: "address" }, { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" }] }] as const;

/** A plain v4 pool's in-range reserves (L / sqrtP HYPE, L * sqrtP of the token), read from the PoolManager. */
async function plainReserves(key: PoolKey): Promise<[bigint, bigint]> {
  let sqrtP: bigint, liq: bigint;
  if (DEPLOYMENT?.poolManager) {
    const id = keccak256(encodeAbiParameters(KEY_TYPE, [key]));
    const slot = BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [id, 6n])));
    const [s0, l] = await Promise.all([0n, 3n].map((o) => publicClient.readContract({ address: DEPLOYMENT.poolManager, abi: EXTSLOAD, functionName: "extsload", args: [toHex(slot + o, { size: 32 })] })));
    sqrtP = BigInt(s0) & ((1n << 160n) - 1n);
    liq = BigInt(l) & ((1n << 128n) - 1n);
  } else if (GLOAM?.ecosystemVault) {
    [sqrtP, liq] = await publicClient.readContract({ address: GLOAM.ecosystemVault, abi: ECO, functionName: "poolState", args: [key] });
  } else return [0n, 0n];
  if (sqrtP === 0n) return [0n, 0n];
  return [(liq << 96n) / sqrtP, (liq * sqrtP) >> 96n];
}

/** HYPE per whole token, in wei. */
const priceOf = (rH: bigint, rT: bigint, decimals: number) => (rT > 0n ? (rH * 10n ** BigInt(decimals)) / rT : 0n);

/** USDC and the deployment's other assets with a plain HYPE pool: tradeable through the router. */
async function assetMarkets(): Promise<Market[]> {
  if (!GLOAM?.router) return [];
  return Promise.all(
    ASSETS.filter((a) => a.hop).map(async (a): Promise<Market> => {
      const hop = { currency0: ZERO, currency1: a.token, fee: a.hop!.fee, tickSpacing: a.hop!.tickSpacing, hooks: ZERO };
      const [reserveHype, reserveToken] = await plainReserves(hop);
      return { token: a.token, pool: a.pool, pair: a.token, symbol: a.symbol, name: a.symbol === "USDC" ? "USD Coin" : a.symbol, price: priceOf(reserveHype, reserveToken, a.decimals), reserveHype, reserveToken, batchable: false, decimals: a.decimals, kind: "asset", hop };
    }),
  );
}

/** Outside tokens admitted to the ecosystem vault, traded through the router over their plain HYPE pool. */
async function ecoMarkets(ev: Address): Promise<Market[]> {
  const n = await publicClient.readContract({ address: ev, abi: ECO, functionName: "ecosystemTokensCount" });
  const rows = await Promise.all(
    Array.from({ length: Number(n) }, async (_, i): Promise<Market> => {
      const token = await publicClient.readContract({ address: ev, abi: ECO, functionName: "ecosystemTokens", args: [BigInt(i)] });
      const [symbol, name, decimals, hop] = await Promise.all([
        publicClient.readContract({ address: token, abi: cloakTokenAbi, functionName: "symbol" }),
        publicClient.readContract({ address: token, abi: cloakTokenAbi, functionName: "name" }),
        publicClient.readContract({ address: token, abi: cloakTokenAbi, functionName: "decimals" }).then(Number).catch(() => 18),
        publicClient.readContract({ address: ev, abi: ECO, functionName: "poolKeyOf", args: [token] }),
      ]);
      const [reserveHype, reserveToken] = await plainReserves(hop);
      return { token, pool: token, pair: ev, symbol, name, price: priceOf(reserveHype, reserveToken, decimals), reserveHype, reserveToken, batchable: false, decimals, kind: "eco", hop };
    }),
  );
  return rows;
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
      return { token, pool: token, pair, symbol, name, price, reserveHype, reserveToken, batchable, decimals: 18, kind: "launch" };
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
  const [launch, eco, assets] = await Promise.all([
    gloamV4Markets(GLOAM.launchVault),
    GLOAM.ecosystemVault && GLOAM.router ? ecoMarkets(GLOAM.ecosystemVault).catch(() => []) : Promise.resolve([]),
    assetMarkets().catch(() => []),
  ]);
  const data = [...launch, ...eco, ...assets];
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

const feeBps = new Map<string, Promise<number>>();
/** A vault's withdrawal fee in bps (a private swap is a withdrawal into the swap escrow): the launch vault by default. */
export function withdrawFeeBps(vault: Address | undefined = GLOAM?.launchVault): Promise<number> {
  if (!vault) return Promise.resolve(0);
  const k = vault.toLowerCase();
  if (!feeBps.has(k)) feeBps.set(k, publicClient.readContract({ address: vault, abi: GLOAM_READS, functionName: "withdrawFeeBps" }).then(Number).catch(() => (feeBps.delete(k), 0)));
  return feeBps.get(k)!;
}

/** "0.25%" (or "no") for display: the fee of the vault the trade spends from. */
export function useFeePct(vault?: Address): string {
  const [bps, setBps] = useState<number | null>(null);
  useEffect(() => {
    withdrawFeeBps(vault).then(setBps);
  }, [vault]);
  return bps === null ? "a" : bps === 0 ? "no" : `${bps / 100}%`;
}

/** One pool: HYPE into `m` (toToken) or `m` into HYPE, on what reaches the pool. */
async function legQuote(m: Market, toToken: boolean, amountIn: bigint): Promise<bigint> {
  if (amountIn <= 0n) return 0n;
  if (m.hop) {
    // the pool's fee, then a constant-product step on its in-range reserves (the swap's slippage allowance covers more)
    const [rH, rT] = await plainReserves(m.hop);
    const x = (amountIn * BigInt(1_000_000 - m.hop.fee)) / 1_000_000n;
    const [rIn, rOut] = toToken ? [rH, rT] : [rT, rH];
    return rIn + x === 0n ? 0n : (x * rOut) / (rIn + x);
  }
  // live reserves, so the quote reflects trades made since the markets were loaded
  const [rH, rT] = await Promise.all([
    publicClient.readContract({ address: m.pair, abi: cloakPairAbi, functionName: "reserveHype" }),
    publicClient.readContract({ address: m.pair, abi: cloakPairAbi, functionName: "reserveToken" }),
  ]);
  return publicClient.readContract({ address: m.pair, abi: cloakPairAbi, functionName: "getAmountOut", args: toToken ? [amountIn, rH, rT] : [amountIn, rT, rH] });
}

/**
 * What `amountIn` of `from` gets in `to` (null is HYPE), after the fee of the vault it's spent from: one pool when
 * either side is HYPE, else two through HYPE (USDC to HYPE, then HYPE to the token).
 */
export async function quoteRoute(from: Market | null, to: Market | null, amountIn: bigint): Promise<bigint> {
  if (amountIn <= 0n) return 0n;
  amountIn -= (amountIn * BigInt(await withdrawFeeBps(vaultOf(from)))) / 10_000n; // what the router actually trades
  const hype = from ? await legQuote(from, false, amountIn) : amountIn;
  return to ? legQuote(to, true, hype) : hype;
}

export function quote(m: Market, side: "buy" | "sell", amountIn: bigint): Promise<bigint> {
  return side === "buy" ? quoteRoute(null, m, amountIn) : quoteRoute(m, null, amountIn);
}
