import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatEther, formatUnits } from "viem";
import type { Limits } from "./config.js";

export type Budget = "hype" | "usdc" | "launches";

interface Day {
  day: string;
  hype: bigint;
  usdc: bigint;
  launches: bigint;
}

/**
 * Spending limits for one wallet: a cap per transaction and per UTC day for HYPE value and for USDC, and a number of
 * launches per day. The day's totals live in a file under the state directory, so restarting the server doesn't reset
 * them. Only actions that succeed are counted.
 */
export class Spending {
  private file: string;
  session = { hype: 0n, usdc: 0n, launches: 0n };

  constructor(
    readonly limits: Limits,
    stateDir: string,
    account: string,
    private now: () => Date = () => new Date(),
  ) {
    mkdirSync(stateDir, { recursive: true });
    this.file = join(stateDir, `spend-${account.toLowerCase()}.json`);
  }

  private today(): Day {
    const day = this.now().toISOString().slice(0, 10);
    try {
      const j = JSON.parse(readFileSync(this.file, "utf8"));
      if (j.day === day) return { day, hype: BigInt(j.hype), usdc: BigInt(j.usdc), launches: BigInt(j.launches ?? 0) };
    } catch {
      // no file yet, or unreadable: start the day at zero
    }
    return { day, hype: 0n, usdc: 0n, launches: 0n };
  }

  private caps(b: Budget): { perTx: bigint; perDay: bigint } {
    if (b === "hype") return { perTx: this.limits.hypePerTx, perDay: this.limits.hypePerDay };
    if (b === "usdc") return { perTx: this.limits.usdcPerTx, perDay: this.limits.usdcPerDay };
    return { perTx: 1n, perDay: BigInt(this.limits.launchesPerDay) };
  }

  /** Throws a plain sentence if `amount` would break a limit. */
  check(b: Budget, amount: bigint) {
    const { perTx, perDay } = this.caps(b);
    const used = this.today()[b];
    const f = (x: bigint) => show(b, x);
    if (amount > perTx) throw new Error(`Spending limit: ${f(amount)} is over the ${f(perTx)} allowed per transaction. Raise CLOAK_MAX_${b === "hype" ? "HYPE" : "USDC"}_PER_TX to allow it.`);
    if (used + amount > perDay) throw new Error(`Spending limit: ${f(amount)} would bring today's total to ${f(used + amount)}, over the ${f(perDay)} daily limit (${f(perDay > used ? perDay - used : 0n)} left today).`);
  }

  record(b: Budget, amount: bigint) {
    const d = this.today();
    d[b] += amount;
    this.session[b] += amount;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ day: d.day, hype: d.hype.toString(), usdc: d.usdc.toString(), launches: d.launches.toString() }));
    renameSync(tmp, this.file);
  }

  summary() {
    const d = this.today();
    const row = (b: Budget) => {
      const { perTx, perDay } = this.caps(b);
      return { perTransaction: show(b, perTx), perDay: show(b, perDay), usedToday: show(b, d[b]), leftToday: show(b, perDay > d[b] ? perDay - d[b] : 0n), usedThisSession: show(b, this.session[b]) };
    };
    return { day: d.day, hype: row("hype"), usdc: row("usdc"), launches: row("launches") };
  }
}

export function show(b: Budget, x: bigint): string {
  if (b === "hype") return `${formatEther(x)} HYPE`;
  if (b === "usdc") return `${formatUnits(x, 6)} USDC`;
  return `${x} launch${x === 1n ? "" : "es"}`;
}
