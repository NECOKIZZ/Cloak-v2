import { useEffect, useMemo, useRef, useState } from "react";
import { formatEther, type Address } from "viem";
import { cloakAuctionAbi, cloakPairAbi, cloakV4MarketAbi, poolManagerAbi, type AuctionState } from "@cloakely/sdk";
import { DEPLOYMENT } from "./config";
import { hype } from "./format";
import { publicClient } from "./wallet";
import { every } from "./every";

const ZERO = "0x0000000000000000000000000000000000000000";
const FROM_BLOCK = DEPLOYMENT?.firstFactoryBlock ?? DEPLOYMENT?.factoryBlock ?? 0n;
const WAD = 10n ** 18n;
const MAX_POINTS = 160; // newest price changes read with their block times; older ones are rarely needed on a launch page

const uniPairAbi = [
  { type: "function", name: "token0", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "event", name: "Sync", inputs: [{ name: "reserve0", type: "uint112", indexed: false }, { name: "reserve1", type: "uint112", indexed: false }], anonymous: false },
] as const;

export interface PricePoint {
  t: number; // unix seconds
  p: number; // HYPE per token
}

/** A launch's price since it opened: the clearing price, then every change of the pool (Uniswap's Sync, or a CloakPair trade). */
export async function priceHistory(s: AuctionState): Promise<PricePoint[]> {
  const settled = await publicClient.getContractEvents({ address: s.address, abi: cloakAuctionAbi, eventName: "Settled", fromBlock: FROM_BLOCK, strict: true });
  const start = settled[0]?.blockNumber;
  if (start === undefined) return [];
  const raw: { block: bigint; p: number }[] = [{ block: start, p: Number(formatEther(s.clearingPrice)) }];
  const uni = s.uniPair && BigInt(s.uniPair) !== 0n;
  if (s.pool === "v4" && uni) {
    // every trade on the v4 pool, through Cloak or not, is a PoolManager Swap carrying the price after it
    const m = { address: s.pair as Address, abi: cloakV4MarketAbi } as const;
    const [pm, id] = await Promise.all([publicClient.readContract({ ...m, functionName: "poolManager" }), publicClient.readContract({ ...m, functionName: "poolId" })]);
    const swaps = await publicClient.getContractEvents({ address: pm, abi: poolManagerAbi, eventName: "Swap", args: { id }, fromBlock: start, strict: true });
    for (const e of swaps) {
      const sp = e.args.sqrtPriceX96;
      if (sp > 0n) raw.push({ block: e.blockNumber, p: Number(formatEther(((1n << 192n) * WAD) / (sp * sp))) });
    }
  } else if (uni) {
    const [token0, syncs] = await Promise.all([
      publicClient.readContract({ address: s.uniPair, abi: uniPairAbi, functionName: "token0" }),
      publicClient.getContractEvents({ address: s.uniPair, abi: uniPairAbi, eventName: "Sync", fromBlock: start, strict: true }),
    ]);
    const tokenIs0 = token0.toLowerCase() === s.token.toLowerCase();
    for (const e of syncs) {
      const [rt, rh] = tokenIs0 ? [e.args.reserve0, e.args.reserve1] : [e.args.reserve1, e.args.reserve0];
      if (rt > 0n) raw.push({ block: e.blockNumber, p: Number(formatEther((rh * WAD) / rt)) });
    }
  } else if (s.pair && s.pair !== ZERO) {
    // a CloakPair's Swap carries no reserves: each trade's own price stands in for the pool's
    const swaps = await publicClient.getContractEvents({ address: s.pair as Address, abi: cloakPairAbi, eventName: "Swap", fromBlock: start, strict: true });
    for (const e of swaps) {
      const { hypeIn, amountIn, amountOut } = e.args;
      const [h, t] = hypeIn ? [amountIn, amountOut] : [amountOut, amountIn];
      if (t > 0n) raw.push({ block: e.blockNumber, p: Number(formatEther((h * WAD) / t)) });
    }
  }
  // one point per block (its last price), then the newest ones with their real times
  const byBlock = new Map<bigint, number>();
  for (const r of raw) byBlock.set(r.block, r.p);
  let rows = [...byBlock.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (rows.length > MAX_POINTS) rows = [rows[0], ...rows.slice(-(MAX_POINTS - 1))];
  const times = await Promise.all(rows.map(([b]) => publicClient.getBlock({ blockNumber: b }).then((x) => Number(x.timestamp))));
  const pts = rows.map(([, p], i) => ({ t: times[i], p }));
  // and the price right now, so the line reaches today
  const now = await publicClient.readContract({ address: s.pair as Address, abi: cloakPairAbi, functionName: "price" }).catch(() => undefined);
  if (now !== undefined) pts.push({ t: Math.floor(Date.now() / 1000), p: Number(formatEther(now)) });
  return pts;
}

const fmtP = (p: number) => (p === 0 ? "0" : p < 1e-6 ? p.toExponential(2) : p < 1 ? p.toPrecision(3) : p.toLocaleString(undefined, { maximumFractionDigits: 4 }));
const fmtT = (t: number, span: number) =>
  new Date(t * 1000).toLocaleString(undefined, span > 2 * 86400 ? { month: "short", day: "numeric" } : span > 6 * 3600 ? { weekday: "short", hour: "2-digit", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit" });

/** Price since the launch opened, as a line with a crosshair and the price at the hovered moment. */
export function PriceChart({ pts, clearing }: { pts: PricePoint[]; clearing: bigint }) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const W = 640, H = 220, PAD_T = 12, PAD_B = 22;
  const geo = useMemo(() => {
    if (pts.length < 2) return null;
    const t0 = pts[0].t, t1 = Math.max(pts.at(-1)!.t, t0 + 60);
    const ps = pts.map((x) => x.p);
    let lo = Math.min(...ps), hi = Math.max(...ps);
    if (hi === lo) (lo *= 0.9), (hi *= 1.1);
    const padY = (hi - lo) * 0.12;
    lo = Math.max(0, lo - padY);
    hi += padY;
    const x = (t: number) => ((t - t0) / (t1 - t0)) * W;
    const y = (p: number) => PAD_T + (1 - (p - lo) / (hi - lo)) * (H - PAD_T - PAD_B);
    // a step line: the price holds until the next trade changes it
    let d = `M${x(pts[0].t)},${y(pts[0].p)}`;
    for (let i = 1; i < pts.length; i++) d += ` H${x(pts[i].t)} V${y(pts[i].p)}`;
    const area = `${d} V${H - PAD_B} H${x(pts[0].t)} Z`;
    return { t0, t1, lo, hi, x, y, d, area };
  }, [pts]);
  if (!geo) return <div className="chart-empty small mute">The chart starts with the first trade after the launch.</div>;
  const clearP = Number(formatEther(clearing));
  const hp = hover !== null ? pts[hover] : null;
  function move(e: React.PointerEvent) {
    const r = ref.current!.getBoundingClientRect();
    const t = geo!.t0 + ((e.clientX - r.left) / r.width) * (geo!.t1 - geo!.t0);
    let i = 0;
    while (i + 1 < pts.length && pts[i + 1].t <= t) i++;
    setHover(i);
  }
  const span = geo.t1 - geo.t0;
  return (
    <div className="pchart">
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" onPointerMove={move} onPointerLeave={() => setHover(null)} role="img" aria-label="Price since launch">
        <defs>
          <linearGradient id="pfill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--signal)" stopOpacity="0.18" />
            <stop offset="1" stopColor="var(--signal)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {clearP >= geo.lo && clearP <= geo.hi && <line x1="0" x2={W} y1={geo.y(clearP)} y2={geo.y(clearP)} className="pchart-ref" vectorEffect="non-scaling-stroke" />}
        <path d={geo.area} fill="url(#pfill)" />
        <path d={geo.d} className="pchart-line" vectorEffect="non-scaling-stroke" />
        {hp && <line x1={geo.x(hp.t)} x2={geo.x(hp.t)} y1={PAD_T} y2={H - PAD_B} className="pchart-cross" vectorEffect="non-scaling-stroke" />}
      </svg>
      {hp && (
        <>
          <span className="pchart-dot" style={{ left: `${(geo.x(hp.t) / W) * 100}%`, top: `${(geo.y(hp.p) / H) * 100}%` }} />
          <div className="pchart-tip" style={{ left: `${Math.min(Math.max((geo.x(hp.t) / W) * 100, 12), 88)}%` }}>
            <b className="mono">{fmtP(hp.p)} HYPE</b>
            <span className="xs mute">{new Date(hp.t * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
          </div>
        </>
      )}
      <div className="pchart-y"><span>{fmtP(geo.hi)}</span><span>{fmtP(geo.lo)}</span></div>
      <div className="axis"><span>{fmtT(geo.t0, span)}</span>{clearP >= geo.lo && clearP <= geo.hi && <span className="pchart-legend"><i />launch price {hype(clearing)}</span>}<span>now</span></div>
    </div>
  );
}

/** Live price data for a trading launch: history for the chart, the price now and the pool's HYPE side. */
export function usePrice(s: AuctionState | null) {
  const [pts, setPts] = useState<PricePoint[] | null>(null);
  const live = !!s && s.settled && !s.failed && s.pair !== ZERO;
  useEffect(() => {
    if (!live) return;
    let alive = true;
    const load = () => priceHistory(s!).then((p) => alive && setPts(p)).catch(() => alive && setPts((x) => x ?? []));
    load();
    const stop = every(load, 20_000);
    return () => {
      alive = false;
      stop();
    };
  }, [live, s?.address]);
  return pts;
}
