import { useEffect, useMemo, useRef, useState } from "react";
import { formatEther, parseEther, type Address, type Hex } from "viem";
import { splitStandard } from "@cloakely/sdk";
import { BATCHER, txLink } from "../config";
import { hype, tokens } from "../format";
import { Link, useRoute } from "../router";
import { getProver, useApp } from "../state";
import { friendly } from "../errors";
import { Icon, TokenIcon } from "../ui";
import { quote, useFeePct, useMarkets, type Market } from "./markets";

function TokenSel({ label, token, onPick, markets }: { label: string; token?: string; onPick?: (m: Market) => void; markets?: Market[]; hypeSide?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      <button className="token-sel" onClick={() => onPick && setOpen(!open)} style={!onPick ? { cursor: "default" } : undefined}>
        <TokenIcon symbol={label} token={token} />
        {label}
        {onPick && <Icon.chev size={14} />}
      </button>
      {open && markets && (
        <div className="menu">
          {markets.map((m) => (
            <button key={m.token} onClick={() => { onPick?.(m); setOpen(false); }}>
              <TokenIcon symbol={m.symbol} token={m.token} />
              <span style={{ textAlign: "left" }}>{m.symbol}<div className="xs mute">{m.name}</div></span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Trade() {
  const { query } = useRoute();
  const { wallet, connect, priv, unlock, unlocking } = useApp();
  const { markets, err } = useMarkets();
  const [market, setMarket] = useState<Market | null>(null);
  const feePct = useFeePct();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amt, setAmt] = useState("0.001");
  const [modePick, setMode] = useState<"instant" | "batch">(BATCHER ? "batch" : "instant");
  const mode = market && !market.batchable ? "instant" : modePick;
  const [q, setQ] = useState(0n);
  const [bal, setBal] = useState<{ hype: bigint; tok: bigint } | null>(null);
  const [round, setRound] = useState<{ endsAt: number } | null>(null);
  const [now, setNow] = useState(Date.now() / 1000);
  const [busy, setBusy] = useState("");
  const [res, setRes] = useState<{ ok?: string; tx?: Hex; err?: string }>({});
  const syncing = useRef(false);

  useEffect(() => {
    if (!markets?.length || market) return;
    const want = query.get("token")?.toLowerCase();
    setMarket(markets.find((m) => m.token.toLowerCase() === want) ?? markets[0]);
  }, [markets]);

  const amountIn = useMemo(() => {
    try {
      return parseEther(amt || "0");
    } catch {
      return 0n;
    }
  }, [amt]);

  useEffect(() => {
    if (!market) return;
    let alive = true;
    quote(market, side, amountIn).then((x) => alive && setQ(x)).catch(() => alive && setQ(0n));
    return () => {
      alive = false;
    };
  }, [market, side, amountIn]);

  async function refreshBal() {
    if (!priv || !market || syncing.current) return;
    syncing.current = true;
    try {
      const [h, t] = await Promise.all([priv.balance(priv.hypeMarket.pool), priv.balance(market.pool)]);
      setBal({ hype: h, tok: t });
    } catch {
    } finally {
      syncing.current = false;
    }
  }
  useEffect(() => {
    refreshBal();
    const t = setInterval(refreshBal, 8000);
    return () => clearInterval(t);
  }, [priv, market]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!priv || !BATCHER) return;
    if (!round || now > round.endsAt) priv.roundInfo().then(setRound).catch(() => {});
  }, [priv, now > (round?.endsAt ?? 0)]);

  const split = splitStandard(amountIn, 6);
  const fromSym = side === "buy" ? "HYPE" : market?.symbol ?? "…";
  const toSym = side === "buy" ? market?.symbol ?? "…" : "HYPE";
  const fromBal = bal ? (side === "buy" ? bal.hype : bal.tok) : undefined;
  const fmtIn = (x: bigint) => (side === "buy" ? hype(x) : tokens(x));
  const fmtOut = (x: bigint) => (side === "buy" ? tokens(x) : hype(x));
  const short = fromBal !== undefined && amountIn > fromBal;

  async function swap() {
    if (!market) return;
    setRes({});
    const p = priv ?? (await unlock());
    if (!p) return;
    try {
      setBusy("Loading the prover…");
      await getProver();
      if (mode === "batch") {
        const r = await p.batch(market.token as Address, side, amountIn, { onStatus: setBusy });
        const rounds = [...new Set(r.orders.map((o) => o.round.toString()))];
        setRes({ ok: `${r.orders.length} sealed ${side} order${r.orders.length > 1 ? "s" : ""} placed in round ${rounds.join(", ")}. They fill privately when the round settles.`, tx: r.orders.at(-1)?.txHash });
      } else {
        const r = side === "buy" ? await p.buy(market.token as Address, amountIn, { onStatus: setBusy }) : await p.sell(market.token as Address, amountIn, { onStatus: setBusy });
        setRes({ ok: `Swapped privately for ~${fmtOut(r.expectedOut)} ${toSym}.`, tx: r.txHash });
      }
      refreshBal();
    } catch (e) {
      setRes({ err: friendly(e) });
    } finally {
      setBusy("");
    }
  }

  let cta: { label: string; act?: () => void; disabled?: boolean; href?: string };
  if (!wallet) cta = { label: "Connect wallet", act: () => connect() };
  else if (!priv) cta = { label: unlocking ? "Sign in your wallet…" : "Unlock private account", act: unlock, disabled: unlocking };
  else if (busy) cta = { label: busy, disabled: true };
  else if (amountIn === 0n) cta = { label: "Enter an amount", disabled: true };
  else if (short) cta = side === "buy" ? { label: "Shield HYPE first", href: "/app/portfolio" } : { label: `Not enough private ${fromSym}`, disabled: true };
  else if (mode === "batch" && split.sizes.length === 0) cta = { label: "Amount too small", disabled: true };
  else cta = { label: mode === "batch" ? `Place ${split.sizes.length} sealed order${split.sizes.length > 1 ? "s" : ""}` : "Swap privately", act: swap };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Private swap</h1>
          <p>Swap launch tokens from your private balance. A relayer submits for you, so your wallet is never on the trade. Batch mode also hides how much you traded.</p>
        </div>
      </div>
      {err && <div className="err">{err}</div>}
      {markets?.length === 0 && <div className="empty"><h3>No private markets yet</h3>Private trading opens for a launch once it settles. <Link to="/app" className="link">See launches</Link></div>}
      {market && (
        <div className="swap-wrap">
          <div>
            <div className="swap">
              <div className="swap-box">
                <div className="k"><span>You pay (private)</span>{fromBal !== undefined && <span className="link" onClick={async () => {
                  // instant trades pay the relayer from the same balance; batch mode makes room for its own fees
                  const pool = side === "buy" ? priv?.hypeMarket.pool : market.pool;
                  const most = mode === "instant" && priv && pool ? await priv.maxSpendable(pool, "privateSwap").catch(() => fromBal) : fromBal;
                  setAmt(formatEther(most));
                }}>Balance {fmtIn(fromBal)}</span>}</div>
                <div className="amt">
                  <input value={amt} onChange={(e) => setAmt(e.target.value)} inputMode="decimal" aria-label="Amount" />
                  {side === "buy" ? <TokenSel label="HYPE" hypeSide /> : <TokenSel label={market.symbol} token={market.token} markets={markets!} onPick={setMarket} />}
                </div>
              </div>
              <button className="flip" aria-label="Switch direction" onClick={() => { setSide(side === "buy" ? "sell" : "buy"); setAmt(""); setRes({}); }}><Icon.arrowDown /></button>
              <div className="swap-box">
                <div className="k"><span>You receive (private)</span>{bal && <span>Balance {side === "buy" ? tokens(bal.tok) : hype(bal.hype)}</span>}</div>
                <div className="amt">
                  <input value={q ? fmtOut(q).replace(/,/g, "") : ""} readOnly placeholder="0" aria-label="Estimated output" />
                  {side === "buy" ? <TokenSel label={market.symbol} token={market.token} markets={markets!} onPick={setMarket} /> : <TokenSel label="HYPE" hypeSide />}
                </div>
              </div>
              {BATCHER && market.batchable && (
                <div className="mode">
                  <button className={mode === "batch" ? "on" : ""} onClick={() => setMode("batch")}><b>Batch · hides size</b><span>{round ? `Next round in ${Math.max(0, Math.ceil(round.endsAt - now))}s` : "Settles every 30 s"}</span></button>
                  <button className={mode === "instant" ? "on" : ""} onClick={() => setMode("instant")}><b>Instant</b><span>Fills now · size visible</span></button>
                </div>
              )}
              {mode === "batch" && split.sizes.length > 0 && (
                <div className="summary" style={{ margin: "0 0 12px" }}>
                  <div className="row"><span className="mute">Standard orders</span><span className="mono">{split.sizes.map(fmtIn).join(" + ")}</span></div>
                  {split.rest > 0n && <div className="row"><span className="mute">Stays in your balance</span><span className="mono">{fmtIn(split.rest)}</span></div>}
                </div>
              )}
              {cta.href ? (
                <Link to={cta.href} className="btn btn-ink btn-lg btn-block">{cta.label}</Link>
              ) : (
                <button className="btn btn-ink btn-lg btn-block" disabled={cta.disabled} onClick={cta.act}>{cta.label}</button>
              )}
              {res.err && <div className="err">{res.err}</div>}
              {res.ok && <div className="okmsg">{res.ok} {res.tx && txLink(res.tx) && <a href={txLink(res.tx)} target="_blank" rel="noreferrer">View tx ↗</a>}</div>}
            </div>
            <p className="note" style={{ padding: "0 8px" }}>Proofs are generated on this device (a 12 MB circuit downloads on first use, then each trade takes about 4 s). 1% max slippage on instant trades. Fees: {feePct} Cloak fee on the amount traded, plus a small relayer fee that covers gas, both taken from your private balance.</p>
          </div>
          <div className="col">
            <div className="card">
              <div className="card-head"><h3>What the chain sees</h3><span className="pill sealed-p">● shielded</span></div>
              <div className="fl" style={{ gridTemplateColumns: "1fr" }}>
                <div className="row"><span className="mute">Sender</span><span>Relayer, <b style={{ fontWeight: 500 }}>not you</b></span></div>
                <div className="row"><span className="mute">Your balance</span><span><span className="sealed" style={{ width: 70, height: 14 }} /></span></div>
                <div className="row"><span className="mute">Your other trades</span><span>Unlinkable</span></div>
                <div className="row"><span className="mute">Trade size</span><span className={mode === "instant" ? "warn-t" : "signal"}>{mode === "instant" ? "Visible on the pool" : "Hidden among standard orders"}</span></div>
              </div>
            </div>
            <div className="card flat">
              <div className="card-head"><h3>{market.name} <span className="mute">${market.symbol}</span></h3><Link to={`/app`} className="xs arrow">Launches</Link></div>
              <div className="fl" style={{ gridTemplateColumns: "1fr 1fr" }}>
                <div className="row"><span className="mute">Pool price</span><span className="mono">{hype(market.price)} HYPE</span></div>
                <div className="row"><span className="mute">Liquidity</span><span className="mono">{hype(market.reserveHype)} HYPE</span></div>
              </div>
            </div>
            <div className="card flat">
              <h3>How batch mode works</h3>
              <ol className="small soft" style={{ paddingLeft: 18, margin: "10px 0 0", display: "grid", gap: 6 }}>
                <li>Your amount is split into the standard sizes everyone uses.</li>
                <li>Orders wait in a ~30 s round alongside everyone else's.</li>
                <li>Buys and sells cross at the pool's average price over the round, which no single trade can move. Only the net trades on the pool.</li>
                <li>Everyone in the round gets the same price, paid back into private balances.</li>
              </ol>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
