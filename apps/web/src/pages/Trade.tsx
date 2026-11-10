import { markDone } from "../guide";
import { useEffect, useMemo, useState } from "react";
import { formatUnits, parseAbi, parseEventLogs, parseUnits, toHex, type Address, type Hex } from "viem";
import { standardSizesFor } from "@cloakely/sdk";
import { GLOAM, txLink } from "../config";
import { hype, tokens, usd } from "../format";
import { Link, useRoute } from "../router";
import { useApp } from "../state";
import { friendly } from "../errors";
import { Icon, TokenIcon } from "../ui";
import { quoteRoute, useFeePct, useMarkets, useTradeFeePct, vaultOf, type Market } from "./markets";
import { isHidden } from "../hidden";
import { usePrivateBalances } from "../balances";
import { Skel } from "../skel";
import { publicClient } from "../wallet";

/**
 * The batcher behind batch mode: Cloak's own, or on the launch vault (Cloak v2 on Gloam) CloakGloamBatcherV4 for
 * launches' v4 pools, else the V2 CloakGloamBatcher.
 */
const BATCHER = (GLOAM?.batcherV4 ?? GLOAM?.batcher) as Address | undefined;
/** CloakGloamBatcher's reads (its Order and Batch structs, field by field) and its order event. */
const GLOAM_BATCHER = parseAbi([
  "function orders(bytes32) view returns (address token, uint64 round, bool buy, bool paid, uint128 net)",
  "function batches(address, uint64) view returns (uint128 buyHype, uint128 sellTokens, uint128 tokensForBuyers, uint128 hypeForSellers, uint256 spotStart, uint64 settledAt, bool settled, bool cancelled, uint256 cumStart, uint64 tStart, uint256 refStart)",
  "function currentRound() view returns (uint64)",
  "event OrderPlaced(bytes32 indexed id, address indexed token, uint64 indexed round, bool buy, uint256 size, uint256 net)",
]);
import { every } from "../every";

/** An amount of a market's token (null is HYPE) for display. */
function fmtOf(m: Market | null, x: bigint): string {
  if (!m) return hype(x);
  if (m.kind === "asset") return usd(x, m.decimals);
  return tokens(m.decimals === 18 ? x : x * 10n ** BigInt(18 - m.decimals));
}

/** Placed batch orders, followed until each is paid or refunded (B4). */
type Track = { batcher: Address; token: Address; ids: Hex[]; rounds: bigint[]; outSym: string; inSym: string; at: number };
type OrderState = { round: bigint; done: boolean; settled: boolean; cancelled: boolean };

/** Where a swap's orders are, read from the batcher. */
function useOrderStatus(t: Track | null) {
  const [st, setSt] = useState<OrderState[] | null>(null);
  useEffect(() => {
    if (!t) return setSt(null);
    let alive = true;
    let stop = () => {};
    const read = async () => {
      const c = { address: t.batcher, abi: GLOAM_BATCHER } as const;
      const orders = await Promise.all(t.ids.map((id) => publicClient.readContract({ ...c, functionName: "orders", args: [id] })));
      const out: OrderState[] = await Promise.all(
        orders.map(async (o, i) => {
          const round = o[1] || t.rounds[i];
          const b = await publicClient.readContract({ ...c, functionName: "batches", args: [t.token, round] });
          return { round, done: o[3], settled: b[6], cancelled: b[7] };
        }),
      );
      if (!alive) return;
      setSt(out);
      // everything paid or refunded, or 20 minutes passed: stop asking
      if (out.every((o) => o.done) || Date.now() - t.at > 20 * 60_000) stop();
    };
    read().catch(() => {});
    stop = every(() => read().catch(() => {}), 5_000);
    return () => {
      alive = false;
      stop();
    };
  }, [t]);
  return st;
}

/** One plain line for where the orders are now. */
function trackText(t: Track, st: OrderState[] | null, now: number, roundSecs: number): { text: string; tone: "wait" | "ok" | "warn" } {
  if (!st) return { text: "Checking your orders", tone: "wait" };
  const n = st.length;
  const paid = st.filter((o) => o.done && o.settled).length;
  const refunded = st.filter((o) => o.done && o.cancelled).length;
  if (paid + refunded === n) {
    if (!refunded) return { text: `All ${n} order${n > 1 ? "s" : ""} filled. Your ${t.outSym} is in your private balance.`, tone: "ok" };
    const rs = [...new Set(st.filter((o) => o.cancelled).map((o) => o.round.toString()))].join(" and ");
    return { text: `${refunded} order${refunded > 1 ? "s were" : " was"} refunded because the pool price moved more than 2% during round ${rs}. That ${t.inSym} is back in your private balance.${paid ? ` ${paid} filled.` : ""}`, tone: "warn" };
  }
  const open = st.filter((o) => !o.done);
  const r = open.reduce((m, o) => (o.round < m ? o.round : m), open[0].round);
  const end = Number(r + 1n) * roundSecs;
  if (open.some((o) => o.settled)) return { text: `Round ${r} settled. Paying into your private balance (${paid} of ${n} done).`, tone: "wait" };
  if (now < end) return { text: `Waiting for round ${r} to close (${Math.ceil(end - now)} s). ${paid} of ${n} filled so far.`, tone: "wait" };
  if (now > end + 600) return { text: `Round ${r} couldn't settle because the price moved too far. Your orders are being refunded into your private balance.`, tone: "warn" };
  return { text: `Round ${r} closed. Settling at one price for everyone in it (${paid} of ${n} filled).`, tone: "wait" };
}

/** How many orders the market's current round holds, for the side panel (batch mode only). */
function useRoundCrowd(batcher: Address | undefined, token: Address | undefined) {
  const [n, setN] = useState<number | null>(null);
  useEffect(() => {
    if (!batcher || !token) return setN(null);
    let alive = true;
    // the round's orders, counted from its OrderPlaced events (recent blocks: a round lasts about a minute)
    const read = async () => {
      try {
        const [round, head] = await Promise.all([publicClient.readContract({ address: batcher, abi: GLOAM_BATCHER, functionName: "currentRound" }), publicClient.getBlockNumber()]);
        const logs = await publicClient.getContractEvents({ address: batcher, abi: GLOAM_BATCHER, eventName: "OrderPlaced", args: { token, round }, fromBlock: head > 5000n ? head - 5000n : 0n });
        if (alive) setN(logs.length);
      } catch {}
    };
    read();
    const stop = every(read, 10_000);
    return () => {
      alive = false;
      stop();
    };
  }, [batcher, token]);
  return n;
}

/** Launch and outside tokens show their own image; HYPE and USDC their built-in marks. */
const iconToken = (m: Market | null) => (m && (m.kind === "launch" || m.kind === "eco") ? m.token : undefined);

function TokenSel({ label, token, onPick, markets, held }: { label: string; token?: string; onPick?: (m: Market) => void; markets?: Market[]; hypeSide?: boolean; held?: Record<string, bigint> }) {
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
          {/* test tokens stay off the list, unless you hold some: then you can always swap out */}
          {markets.filter((m) => !isHidden(m.token) || m.token.toLowerCase() === token?.toLowerCase() || (held?.[m.token] ?? 0n) > 0n).map((m) => (
            <button key={m.token} onClick={() => { onPick?.(m); setOpen(false); }}>
              <TokenIcon symbol={m.symbol} token={iconToken(m)} />
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
  // what the token is bought with or sold for: HYPE (null), or through HYPE another market such as USDC (router only)
  const [base, setBase] = useState<Market | null>(null);
  const [side, setSide] = useState<"buy" | "sell">(query.get("side") === "sell" ? "sell" : "buy");
  const [amt, setAmt] = useState("0.001");
  const [modePick, setMode] = useState<"instant" | "batch">("instant") // instant first: most swaps want the fill now (batch stays one click away);
  const mode = market && (!market.batchable || base) ? "instant" : modePick;
  const from = side === "buy" ? base : market;
  const to = side === "buy" ? market : base;
  const feePct = useFeePct(vaultOf(from));
  const cloakPct = useTradeFeePct(from, to);
  // the "pay with" list: HYPE and USDC (or any market but the one traded), once the router is live
  const bases = useMemo(() => (GLOAM?.router && markets ? markets.filter((m) => m.kind === "asset") : []), [markets]);
  const [q, setQ] = useState(0n);
  const [round, setRound] = useState<{ endsAt: number; round: bigint; roundSecs: number } | null>(null);
  const [now, setNow] = useState(Date.now() / 1000);
  const [busy, setBusy] = useState("");
  const [res, setRes] = useState<{ ok?: string; tx?: Hex; err?: string }>({});
  const [track, setTrack] = useState<Track | null>(null);
  const orderStatus = useOrderStatus(track);

  useEffect(() => {
    if (!markets?.length || market) return;
    const want = query.get("token")?.toLowerCase();
    setMarket(markets.find((m) => m.token.toLowerCase() === want) ?? markets.find((m) => !isHidden(m.token)) ?? markets[0]);
  }, [markets]);

  const decIn = from?.decimals ?? 18;
  const amountIn = useMemo(() => {
    try {
      return parseUnits(amt || "0", decIn);
    } catch {
      return 0n;
    }
  }, [amt, decIn]);

  useEffect(() => {
    if (!market) return;
    let alive = true;
    quoteRoute(from, to, amountIn).then((x) => alive && setQ(x)).catch(() => alive && setQ(0n));
    return () => {
      alive = false;
    };
  }, [market, base, side, amountIn]);

  // a big instant trade goes in parts that fit the private vault's per-deposit cap: show how many, in few words
  const [plan, setPlan] = useState<{ parts: number; cap: string } | null>(null);
  useEffect(() => {
    setPlan(null);
    if (!priv || !market || amountIn <= 0n) return;
    let alive = true;
    const tok = (m: Market | null) => (m ? m.token : priv.hypeMarket.token) as Address;
    const t = setTimeout(async () => {
      const parts = await priv.tradePlan(tok(from), tok(to), amountIn).catch(() => [amountIn]);
      if (!alive || parts.length < 2) return;
      const caps = await priv.depositCaps(tok(to)).catch(() => null);
      if (alive) setPlan({ parts: parts.length, cap: caps?.perDeposit ? `${fmtOf(to, caps.perDeposit)} ${to ? to.symbol : "HYPE"}` : "" });
    }, 400);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [priv, market, base, side, amountIn]);

  // the same private balances as the Portfolio: last known at once, refreshed together in the background
  const { bals, loaded: balLoaded, refresh: refreshBal } = usePrivateBalances();
  const balOf = (m: Market | null) => (m ? bals[m.token] ?? 0n : bals.HYPE ?? 0n);
  const bal = priv && balLoaded && market ? { from: balOf(from), to: balOf(to) } : null;

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!priv || !BATCHER) return;
    if (!round || now > round.endsAt) priv.roundInfo(market?.token as Address | undefined).then(setRound).catch(() => {});
  }, [priv, market?.token, now > (round?.endsAt ?? 0)]);

  // a preview: the account picks the exact sizes from the notes it holds when the orders are placed
  const split = standardSizesFor(amountIn, [amountIn], 6);
  const symOf = (m: Market | null) => (m ? m.symbol : market ? "HYPE" : "…");
  const fromSym = symOf(from);
  const toSym = symOf(to);
  const fromBal = bal ? bal.from : undefined;
  const fmtIn = (x: bigint) => fmtOf(from, x);
  const fmtOut = (x: bigint) => fmtOf(to, x);
  const short = fromBal !== undefined && amountIn > fromBal;

  async function swap() {
    if (!market) return;
    setRes({});
    setTrack(null);
    const p = priv ?? (await unlock());
    if (!p) return;
    try {
      setBusy("Loading the prover…");
      if (mode === "batch") {
        const r = await p.batch(market.token as Address, side, amountIn, { onStatus: setBusy });
        const rounds = [...new Set(r.orders.map((o) => o.round.toString()))];
        markDone("swap");
        // follow the orders: the batcher is whatever contract emitted them
        const rc = await publicClient.getTransactionReceipt({ hash: r.orders[0].txHash }).catch(() => null);
        const placed = rc ? parseEventLogs({ abi: GLOAM_BATCHER, logs: rc.logs, eventName: "OrderPlaced" })[0] : undefined;
        if (placed) setTrack({ batcher: placed.address, token: market.token as Address, ids: r.orders.map((o) => toHex(o.id, { size: 32 })), rounds: r.orders.map((o) => o.round), outSym: toSym, inSym: fromSym, at: Date.now() });
        setRes({ ok: `${r.orders.length} sealed ${side} order${r.orders.length > 1 ? "s" : ""} placed in round ${rounds.join(", ")}. They fill privately when the round settles. What you get back moves into your private balance the next time Cloak is open.${r.rest > 0n ? ` ${fmtIn(r.rest)} ${fromSym} was held back: it pays the relayer fees, and anything left stays in your balance.` : ""}`, tx: r.orders.at(-1)?.txHash });
      } else {
        // HYPE is WHYPE's address to the account; through HYPE when neither side is HYPE
        const tokenOf = (m: Market | null) => (m ? m.token : p.hypeMarket.token) as Address;
        const r = await p.trade(tokenOf(from), tokenOf(to), amountIn, { onStatus: setBusy });
        markDone("swap");
        setRes({ ok: `Swapped privately for ~${fmtOut(r.expectedOut)} ${toSym}${r.pieces && r.pieces > 1 ? ` in ${r.pieces} trades, since the private vault takes this much at a time for now` : ""}.`, tx: r.txHash });
      }
      refreshBal();
    } catch (e) {
      setRes({ err: friendly(e) });
    } finally {
      setBusy("");
    }
  }

  const crowd = useRoundCrowd(mode === "batch" ? BATCHER : undefined, market?.token as Address | undefined);
  const tracked = track ? trackText(track, orderStatus, now, round?.roundSecs ?? 30) : null;

  let cta: { label: string; act?: () => void; disabled?: boolean; href?: string };
  if (!wallet) cta = { label: "Connect wallet", act: () => connect() };
  else if (!priv) cta = { label: unlocking ? "Sign in your wallet…" : "Unlock private account", act: unlock, disabled: unlocking };
  else if (busy) cta = { label: busy, disabled: true };
  else if (amountIn <= 0n) cta = { label: "Enter an amount", disabled: true }; // a pasted "-0.01" parses (review W-13)
  else if (short) cta = from?.kind !== "launch" && from?.kind !== "eco" ? { label: `Shield ${fromSym} first`, href: `/app/portfolio/shield${from ? `?token=${from.token}` : ""}` } : { label: `Not enough private ${fromSym}`, disabled: true };
  else if (mode === "batch" && split.sizes.length === 0) cta = { label: "Amount too small", disabled: true };
  else cta = { label: mode === "batch" ? `Place ${split.sizes.length} sealed order${split.sizes.length > 1 ? "s" : ""}` : "Swap privately", act: swap };

  // the token traded (any market but the one paid with), and what it's paid with (HYPE or USDC)
  const marketSel = market && markets ? <TokenSel label={market.symbol} token={iconToken(market)} markets={markets.filter((m) => m.token !== base?.token)} onPick={(m) => { setMarket(m); setRes({}); }} held={bals} /> : null;
  const hypeChoice = { token: "HYPE" as Address, symbol: "HYPE", name: "Hyperliquid" } as Market;
  const baseSel = bases.length ? (
    <TokenSel label={base?.symbol ?? "HYPE"} markets={[hypeChoice, ...bases.filter((m) => m.token !== market?.token)]} onPick={(m) => { setBase(m.token === hypeChoice.token ? null : m); setAmt(""); setRes({}); }} held={bals} />
  ) : (
    <TokenSel label="HYPE" hypeSide />
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Private swap</h1>
          <p>Swap launch tokens{bases.length ? ", outside tokens and USDC" : ""} from your private balance. A relayer submits for you, so your wallet is never on the trade. Batch mode also hides how much you traded.</p>
        </div>
      </div>
      {err && <div className="err">{err}</div>}
      {markets?.length === 0 && <div className="empty"><h3>No private markets yet</h3>Private trading opens for a launch once it settles. <Link to="/app/launches" className="link">See launches</Link></div>}
      {market && (
        <div className="swap-wrap">
          <div>
            <div className="swap">
              <div className="swap-box">
                <div className="k"><span>You pay (private)</span>{priv && !bal && <Skel w="9ch" />}{fromBal !== undefined && <span className="link" onClick={async () => {
                  // instant trades pay the relayer from the same balance; batch mode makes room for its own fees
                  const pool = from ? from.pool : priv?.hypeMarket.pool;
                  const most = mode === "instant" && priv && pool ? await priv.maxSpendable(pool).catch(() => fromBal) : fromBal;
                  setAmt(formatUnits(most, decIn));
                }}>Balance {fmtIn(fromBal)}</span>}</div>
                <div className="amt">
                  <input value={amt} onChange={(e) => setAmt(e.target.value)} inputMode="decimal" aria-label="Amount" />
                  {side === "buy" ? baseSel : marketSel}
                </div>
              </div>
              <button className="flip" aria-label="Switch direction" onClick={() => { setSide(side === "buy" ? "sell" : "buy"); setAmt(""); setRes({}); }}><Icon.arrowDown /></button>
              <div className="swap-box">
                <div className="k"><span>You receive (private)</span>{priv && !bal && <Skel w="9ch" />}{bal && <span>Balance {fmtOut(bal.to)}</span>}</div>
                <div className="amt">
                  <input value={q ? fmtOut(q).replace(/,/g, "") : ""} readOnly placeholder="0" aria-label="Estimated output" />
                  {side === "buy" ? marketSel : baseSel}
                </div>
              </div>
              {base && <div className="summary small" style={{ margin: "0 0 12px" }}>Routed {fromSym} to HYPE to {toSym} in one private swap, through two pools.</div>}
              {BATCHER && market.batchable && !base && (
                <div className="mode">
                  <button className={mode === "instant" ? "on" : ""} onClick={() => setMode("instant")}><b>Instant</b><span>Fills now · size visible</span></button>
                  <button className={mode === "batch" ? "on" : ""} onClick={() => setMode("batch")}><b>Batch · hides size</b><span>{round ? `Next round in ${Math.max(0, Math.ceil(round.endsAt - now))}s` : "Settles every 30 s"}</span></button>
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
              {tracked && <div className={tracked.tone === "warn" ? "err" : tracked.tone === "ok" ? "okmsg" : "summary small"} style={{ marginTop: 8 }} aria-live="polite">{tracked.tone === "wait" && <span className="dot live" style={{ marginRight: 8 }} />}{tracked.text}</div>}
            </div>
            <p className="note" style={{ padding: "0 8px" }}>Proofs are generated on this device (a 12 MB circuit downloads on first use, then each trade takes about 4 s). 1% max slippage on instant trades. Fees. {from && feePct !== "no" ? `${feePct} vault fee on the amount sold.` : !from ? `Gloam's vault keeps ${feePct} of the HYPE spent.` : ""} {cloakPct !== "no" ? `Cloak keeps ${cloakPct} of what a sale brings, in ${to ? to.symbol : "HYPE"}.` : ""} The relayer pays the gas, and whatever the trade didn't need comes back to your private balance.</p>
          </div>
          <div className="col">
            <div className="card">
              <div className="card-head"><h3>What the chain sees</h3><span className="pill sealed-p">● shielded</span></div>
              <div className="fl" style={{ gridTemplateColumns: "1fr" }}>
                <div className="row"><span className="mute">Sender</span><span>Relayer, <b style={{ fontWeight: 500 }}>not you</b></span></div>
                <div className="row"><span className="mute">Your balance</span><span><span className="sealed" style={{ width: 70, height: 14 }} /></span></div>
                <div className="row"><span className="mute">Your other trades</span><span>Unlinkable</span></div>
                <div className="row"><span className="mute">Trade size</span><span className={mode === "instant" ? "warn-t" : "signal"}>{mode === "instant" ? "Visible on the pool" : "Hidden among standard orders"}</span></div>
                {mode === "batch" && (
                  <div className="row"><span className="mute">Orders in this round</span><span className={crowd ? "signal" : "warn-t"}>{crowd === null ? "…" : crowd === 0 ? "None yet" : crowd.toLocaleString()}</span></div>
                )}
              </div>
              <div className="fl" style={{ gridTemplateColumns: "1fr", marginTop: 6 }}>
                {mode === "instant" && plan && <div className="row"><span className="mute">Parts</span><span>{plan.parts} trades{plan.cap ? ` · vault cap ${plan.cap}` : ""}</span></div>}
                <div className="row"><span className="mute">Time</span><span>{mode === "instant" ? (plan ? `About ${plan.parts * 5} seconds` : "A few seconds") : "About 1 to 3 minutes"}</span></div>
                <div className="row"><span className="mute">Risk</span><span className="warn-t" style={{ textAlign: "right" }}>{mode === "instant" ? "Price can slip up to 1%" : "Refunded if the price moves over 2%"}</span></div>
                {mode === "batch" && crowd === 0 && <div className="row"><span className="mute">Cover</span><span className="warn-t" style={{ textAlign: "right" }}>Alone so far, so the round total is your trade</span></div>}
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
                <li>Orders wait in a round of about a minute alongside everyone else's.</li>
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
