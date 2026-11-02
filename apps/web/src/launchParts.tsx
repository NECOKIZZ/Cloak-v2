import { useEffect, useState } from "react";
import type { Address } from "viem";
import { Cloak, type AuctionState, type Wallet } from "@cloakely/sdk";
import { DEPLOYMENT } from "./config";
import { duration, hype, short, tokens } from "./format";
import { friendly } from "./errors";
import { useApp } from "./state";
import { publicClient, readCloak } from "./wallet";

const FROM_BLOCK = DEPLOYMENT?.firstFactoryBlock ?? DEPLOYMENT?.factoryBlock ?? 0n;

// ───────────────────────────── demand meter ─────────────────────────────

const BANDS: [bigint, string][] = [
  [10n ** 16n, "under 0.01"],
  [10n ** 17n, "0.01 to 0.1"],
  [10n ** 18n, "0.1 to 1"],
  [10n ** 19n, "1 to 10"],
  [10n ** 20n, "10 to 100"],
  [2n ** 255n, "100 and up"],
];

/**
 * How much interest a launch has, without revealing a single bid: how many sealed bids, how much HYPE is locked behind
 * them, how deposits are spread across size bands (deposits round up to 1, 2 or 5 × 10ⁿ, so a band says nothing
 * exact), and how the locked HYPE compares to what the sale costs at its starting price.
 */
export function DemandMeter({ s, now }: { s: AuctionState; now: number }) {
  const [deposits, setDeposits] = useState<bigint[] | null>(null);
  const [lastAt, setLastAt] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      const logs = await readCloak.committedLogs(s.address, FROM_BLOCK);
      if (!alive) return;
      setDeposits(logs.map((l) => l.args.deposit));
      const last = logs.at(-1);
      if (last) {
        const b = await publicClient.getBlock({ blockNumber: last.blockNumber });
        if (alive) setLastAt(Number(b.timestamp));
      }
    })().catch(() => {});
    return () => {
      alive = false;
    };
  }, [s.address, s.commits]);

  const open = s.phase === "commit";
  const startCost = (s.minPrice * s.saleSupply) / 10n ** 18n;
  const cover = startCost > 0n ? Number((s.totalDeposits * 100n) / startCost) / 100 : 0;
  const counts = BANDS.map(([max], i) => (deposits ?? []).filter((d) => d < max && (i === 0 || d >= BANDS[i - 1][0])).length);
  const most = Math.max(1, ...counts);
  return (
    <div className="card">
      <div className="card-head">
        <h3>{open ? "Bidding closes in" : "Bidding closed"}</h3>
        <span className={`pill ${open ? "ok" : ""}`}>{open ? <><span className="dot live" />live</> : lastAt ? `last bid ${duration(now - lastAt)} ago` : "closed"}</span>
      </div>
      {open && <div className="countdown" style={{ marginBottom: 18 }}>{duration(s.commitEnd - now)}</div>}
      <div className="meter">
        <div><div className="k">Sealed bids</div><div className="v">{s.commits}</div></div>
        <div><div className="k">HYPE committed</div><div className="v">{hype(s.totalDeposits, 4)}</div></div>
        <div><div className="k">Starting price</div><div className="v">{hype(s.minPrice)}</div></div>
      </div>
      {s.commits > 0 && (
        <div className="buckets-chart" aria-label="Deposits by size">
          {BANDS.map(([, label], i) =>
            counts[i] || i < 4 ? (
              <div className="b" key={label}>
                <span className="mute">{label} HYPE</span>
                <span className="bar-h"><i style={{ width: `${(counts[i] / most) * 100}%` }} /></span>
                <span className="mono">{counts[i]}</span>
              </div>
            ) : null,
          )}
        </div>
      )}
      <p className="xs mute" style={{ margin: "14px 0 0" }}>
        {startCost > 0n && s.commits > 0 && cover >= 1 && (
          <>Enough HYPE is committed to buy the whole sale <b>{cover >= 10 ? Math.round(cover) : cover}×</b> over at the starting price. </>
        )}
        {s.commits > 0 ? "Sizes are shown in rough bands only. No price or amount is visible until bidding closes." : "No bids yet. Prices and amounts stay hidden until bidding closes."}
      </p>
    </div>
  );
}

// ───────────────────────────── creator fees ─────────────────────────────

type Fees = Awaited<ReturnType<typeof readCloak.creatorFees>>;

/** For launches whose liquidity is locked forever: the trading fees earned so far, and a button to send them to the creator. */
export function CreatorFeesCard({ s, wallet }: { s: AuctionState; wallet: Wallet | null }) {
  const { connect, toast } = useApp();
  const [f, setF] = useState<Fees>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const load = () => readCloak.creatorFees(s.address).then(setF).catch(() => {});
  useEffect(() => {
    if (!s.creatorFees) return;
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [s.address, s.creatorFees]);
  if (!s.creatorFees || !f) return null;
  const mine = wallet?.account.address.toLowerCase() === f.beneficiary.toLowerCase();
  const earned = f.claimableLp > 0n && (f.tokens > 0n || f.whype > 0n);
  // amounts too small to print in full read as "under 0.000001", never as a misleading 0
  const amt = (x: bigint, fmt: (v: bigint) => string) => (x === 0n ? "0" : fmt(x) === "0" ? "under 0.000001" : fmt(x));
  async function claim() {
    if (!wallet) return connect();
    setBusy(true);
    setErr("");
    try {
      await new Cloak(publicClient, wallet).claimCreatorFees(s.address);
      toast(mine ? "Fees collected to your wallet" : "Fees sent to the creator");
      await load();
    } catch (e) {
      setErr(friendly(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="card">
      <div className="card-head"><h3>Creator fees</h3><span className="pill ok">liquidity locked forever</span></div>
      <p className="small soft" style={{ marginTop: 0 }}>The pool can never be emptied. The creator earns its 0.3% trading fee instead.</p>
      <div className="summary">
        <div className="row"><span className="mute">Earned so far</span><span className="mono">{earned ? [f.whype > 0n && `${amt(f.whype, (v) => hype(v))} HYPE`, f.tokens > 0n && `${amt(f.tokens, tokens)} ${s.tokenSymbol}`].filter(Boolean).join(" + ") : "nothing yet"}</span></div>
        <div className="row"><span className="mute">Paid to</span><span className="mono">{mine ? "you" : short(f.beneficiary)}</span></div>
      </div>
      {earned && (
        <button className={`btn ${mine ? "btn-primary" : "btn-ghost"} btn-block`} disabled={busy} onClick={claim}>
          {busy ? "Collecting…" : !wallet ? "Connect a wallet" : mine ? "Collect fees" : "Send the fees to the creator"}
        </button>
      )}
      {err && <div className="err">{err}</div>}
    </div>
  );
}

// ───────────────────────────── bids paid from the private balance ─────────────────────────────

type BidRow = Awaited<ReturnType<typeof readCloak.bidsOf>>[number] & { wallet: Address };

/**
 * Bids this private account placed through one-time wallets (found again from the account alone), and the one button
 * that wraps them up after settlement: claim into the private balance and move every refund back in.
 */
export function PrivateBids({ s, onDone }: { s: AuctionState; onDone: () => void }) {
  const { priv, toast } = useApp();
  const [rows, setRows] = useState<BidRow[]>([]);
  const [leftover, setLeftover] = useState(0n);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const load = async () => {
    if (!priv) return;
    const ws = await priv.bidWallets(s.address);
    const all = await Promise.all(ws.map(async (w) => (await readCloak.bidsOf(s.address, w.address, FROM_BLOCK)).map((b) => ({ ...b, wallet: w.address }))));
    const bal = await Promise.all(ws.map((w) => publicClient.getBalance({ address: w.address })));
    setRows(all.flat());
    setLeftover(bal.reduce((a, b) => a + b, 0n));
  };
  useEffect(() => {
    load().catch(() => {});
  }, [priv, s.address, s.commits, s.settled, s.reveals]);
  if (!priv || (rows.length === 0 && leftover <= 10n ** 15n)) return null;
  const todo = (s.settled && rows.some((b) => !b.claimed)) || ((s.settled || rows.length === 0) && leftover > 10n ** 15n);
  async function finish() {
    setBusy("finish");
    setErr("");
    try {
      const r = await priv!.finishPrivateBids(s.address, (m) => setBusy(m));
      toast(r.claimed ? `${s.tokenSymbol} and refunds moved into your private balance` : "Refund moved into your private balance");
      await load();
      onDone();
    } catch (e) {
      setErr(friendly(e));
    } finally {
      setBusy("");
    }
  }
  return (
    <div className="card">
      <div className="card-head"><h3>Your private bids</h3><span className="pill ok">paid from your private balance</span></div>
      <p className="xs mute" style={{ marginTop: 0 }}>
        {rows.length ? "Each bid came from a one-time wallet funded privately, so nobody can tie it to your own wallet." : `A one-time wallet holds ${hype(leftover)} HYPE from a bid that didn't go through. Move it back into your private balance.`}
      </p>
      <div className="bids">
        {rows.map((b) => (
          <div className="bidrow" key={`${b.wallet}-${b.id}`}>
            <span className="bidno">#{b.id.toString()}</span>
            <div>
              {b.revealed ? <div className="mono">{tokens(b.quantity)} @ ≤ {hype(s.minPrice + BigInt(b.tick) * s.tickSize)}</div> : <div><span className="sealed" style={{ width: 120, height: 13 }} /></div>}
              <div className="xs mute">deposit {hype(b.deposit)} HYPE{s.settled && ` · gets ${tokens(b.tokens)} ${s.tokenSymbol} + ${hype(b.refund)} HYPE back`}</div>
            </div>
            <span className={`pill ${b.claimed ? "ok" : s.settled ? (b.tokens > 0n ? "ok" : "warn") : b.revealed ? "ok" : "sealed-p"}`}>
              {b.claimed ? "claimed" : s.settled ? (b.tokens > 0n ? "won" : "refund") : b.revealed ? "revealed" : "sealed"}
            </span>
          </div>
        ))}
      </div>
      {todo && (
        <button className="btn btn-primary btn-block" style={{ marginTop: 14 }} disabled={!!busy} onClick={finish}>
          {busy ? (busy === "finish" ? "Working…" : busy) : rows.length ? "Claim privately and move refunds in" : "Move it back"}
        </button>
      )}
      {err && <div className="err">{err}</div>}
    </div>
  );
}
