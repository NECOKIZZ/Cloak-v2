import { formatEther, formatUnits } from "viem";

/** Adaptive HYPE formatting: tiny launch prices stay readable. */
export function hype(wei: bigint, max = 6): string {
  const n = Number(formatEther(wei));
  if (n === 0) return "0";
  if (n < 1e-6) return n.toExponential(2);
  if (n < 1) return n.toPrecision(3).replace(/\.?0+$/, "");
  return n.toLocaleString(undefined, { maximumFractionDigits: Math.min(max, n < 100 ? 4 : 2) });
}

export function tokens(wei: bigint): string {
  const n = Number(formatEther(wei));
  if (n >= 1e6) return `${(n / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 })}M`;
  if (n >= 1e3) return `${(n / 1e3).toLocaleString(undefined, { maximumFractionDigits: 1 })}K`;
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** Dollar stablecoins (6 decimals): cents, or more digits for amounts under a cent. */
export function usd(units: bigint, decimals = 6): string {
  const n = Number(formatUnits(units, decimals));
  if (n === 0) return "0";
  if (n < 0.01) return n.toPrecision(2);
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function duration(s: number): string {
  if (s <= 0) return "00:00";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const p = (x: number) => String(x).padStart(2, "0");
  return d > 0 ? `${d}d ${p(h)}:${p(m)}:${p(sec)}` : h > 0 ? `${p(h)}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`;
}
