import { useEffect, useMemo, useState } from "react";
import { formatEther, parseEther, type Address, type Hex } from "viem";
import { budgetBuckets, cloakAuctionAbi, cloakPairAbi, cloakTokenAbi, cloakVaultsAbi, sharedVaultAbi, type AuctionState, type Wallet, Cloak } from "@cloakely/sdk";
import { addrLink, DEPLOYMENT, FACTORY, SHARED, txLink, VAULTS } from "./config";
import { hype, short, tokens } from "./format";
import { loadSecrets, publicClient, saveSecret } from "./wallet";
import { sharedFor, useApp } from "./state";
import { friendly } from "./errors";
import { markDone } from "./guide";
import { compressImage, encodeMeta, loadAllMeta } from "./tokenMeta";
import { Who } from "./who";

const WAD = 10n ** 18n;
const errMsg = friendly;

function Tx({ hash, label = "view tx" }: { hash?: Hex; label?: string }) {
  if (!hash) return null;
  const l = txLink(hash);
  return l ? <a href={l} target="_blank" rel="noreferrer">{label} ↗</a> : <span className="mono faint">{short(hash)}</span>;
}

// ───────────────────────────── demand curve ─────────────────────────────

export function DemandChart({ s, curve }: { s: AuctionState; curve: bigint[] }) {
  const sealed = s.phase === "commit";
  const max = curve.reduce((m, d) => (d > m ? d : m), 0n);
  // during commit, show sealed placeholder bars: the chart exists, its contents are a black box
  const ghost = useMemo(() => curve.map((_, i) => 18 + ((i * 37) % 61)), [curve.length]);
  const clearIdx = s.settled && !s.failed ? s.clearingTick : -1;
  const leftPct = clearIdx >= 0 ? ((clearIdx + 0.5) / curve.length) * 100 : 0;
  return (
    <div className="card">
      <div className="card-head">
        <h3>Demand curve</h3>
        {sealed ? (
          <span className="pill sealed-p">● sealed until {new Date(s.commitEnd * 1000).toLocaleTimeString()}</span>
        ) : s.settled ? (
          <span className="pill ok">cleared at {hype(s.clearingPrice)} HYPE</span>
        ) : (
          <span className="pill warn">revealing · {s.reveals}/{s.commits}</span>
        )}
      </div>
      <div className="chart" aria-label="Demand by price level">
        {curve.map((d, i) => {
          const h = sealed ? ghost[i] : max === 0n ? 0 : Number((d * 1000n) / max) / 10;
          const cls = sealed
            ? "sealedbar"
            : clearIdx < 0
              ? "win"
              : i > clearIdx
                ? "win"
                : i === clearIdx
                  ? "margin"
                  : "lose";
          return <div key={i} className={`bar ${cls}`} style={{ height: `${Math.max(h, d > 0n || sealed ? 1.5 : 0)}%` }} title={sealed ? "sealed" : `${hype(s.minPrice + BigInt(i) * s.tickSize)} HYPE · ${tokens(d)} tokens`} />;
        })}
        {clearIdx >= 0 && (
          <>
            <div className="clear-line" style={{ left: `${leftPct}%` }} />
            <div className="clear-tag" style={{ left: `${leftPct}%` }}>clearing price</div>
          </>
        )}
      </div>
      <div className="axis">
        <span>{hype(s.minPrice)} HYPE</span>
        <span>price per token →</span>
        <span>{hype(s.minPrice + BigInt(s.numTicks - 1) * s.tickSize)} HYPE</span>
      </div>
      <div className="legend">
        {sealed ? (
          <span><i className="sw" style={{ background: "var(--sealed)" }} />Bids are hashes + timelock ciphertexts. Nobody, not even the sequencer, can see this chart yet.</span>
        ) : (
          <>
            <span><i className="sw" style={{ background: "var(--signal)" }} />filled</span>
            <span><i className="sw" style={{ background: "repeating-linear-gradient(135deg,var(--signal) 0 3px,var(--signal-line) 3px 6px)" }} />pro rata</span>
            <span><i className="sw" style={{ background: "var(--line-strong)" }} />below price, refunded</span>
          </>
        )}
      </div>
    </div>
  );
}

// ───────────────────────────── bid ─────────────────────────────

export function BidCard({ s, wallet, onDone }: { s: AuctionState; wallet: Wallet | null; onDone: () => void }) {
  const { connect, priv, unlock, unlocking, toast } = useApp();
  const [from, setFrom] = useState<"wallet" | "private">("wallet");
  const [privBal, setPrivBal] = useState<bigint | null>(null);
  const [privNeed, setPrivNeed] = useState<bigint>(0n);
  const [status, setStatus] = useState("");
  const defaultPrice = formatEther(s.minPrice + BigInt(Math.floor(s.numTicks / 4)) * s.tickSize);
  const [maxPrice, setMaxPrice] = useState(defaultPrice);
  const [qty, setQty] = useState("10000");
  const [bucket, setBucket] = useState<bigint | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState<Hex | undefined>();

  const quote = useMemo(() => {
    try {
      const p = parseEther(maxPrice.trim() || "0");
      const q = parseEther(qty.trim() || "0");
      if (q === 0n) return null;
      return new Cloak(publicClient).quoteBid(s, p, q);
    } catch {
      return null;
    }
  }, [maxPrice, qty, s.minPrice, s.tickSize, s.numTicks]);
  const deposit = quote ? (bucket && bucket >= quote.cost ? bucket : quote.deposit) : 0n;
  const [walletBal, setWalletBal] = useState<bigint | null>(null);
  useEffect(() => {
    if (!wallet) return;
    publicClient.getBalance({ address: wallet.account.address }).then(setWalletBal).catch(() => {});
  }, [wallet, ok]);
  // paying from the private balance: what it holds, and what the deposit costs on top (gas for the one-time wallet,
  // the relayer's fee and the 0.25% withdrawal fee)
  useEffect(() => {
    if (from !== "private" || !priv) return;
    let alive = true;
    (async () => {
      const [spend, gas, q] = await Promise.all([priv.maxSpendable(priv.hypeMarket.pool, "unshieldHype"), priv.bidGasReserve(), priv.relayFee("unshieldHype", priv.hypeMarket.pool)]);
      if (!alive) return;
      setPrivBal(spend);
      setPrivNeed(gas + q.fee);
    })().catch(() => {});
    return () => {
      alive = false;
    };
  }, [from, priv, ok]);
  // explain why the bid can't be placed yet, instead of a silent disabled button
  const problem = (() => {
    const num = (v: string) => /^\s*\d*\.?\d+\s*$/.test(v);
    if (!num(maxPrice) || !num(qty)) return "Enter numbers only, like 0.00002.";
    let p = 0n, q = 0n;
    try {
      p = parseEther(maxPrice.trim());
      q = parseEther(qty.trim());
    } catch {
      return "That number has too many decimals.";
    }
    if (q === 0n) return "Enter how many tokens you want.";
    if (p < s.minPrice) return `Your max price is below this launch's minimum of ${hype(s.minPrice)} HYPE.`;
    if (!quote) return "Those amounts don't work for this launch. Try a different price or quantity.";
    if (from === "wallet" && wallet && walletBal !== null && deposit > walletBal) return `Your wallet has ${hype(walletBal)} HYPE, which isn't enough for this deposit. Pick a smaller one or get testnet HYPE from the faucet.`;
    if (from === "private" && priv && privBal !== null && (deposit * 10_025n) / 10_000n + privNeed > privBal)
      return `Your private balance can spend ${hype(privBal)} HYPE. This deposit needs about ${hype((deposit * 10_025n) / 10_000n + privNeed)} with fees and gas. Shield more HYPE on Portfolio or pick a smaller deposit.`;
    return "";
  })();

  async function submit() {
    if (!wallet || !quote || problem) return;
    setBusy(true);
    setErr("");
    setOk(undefined);
    try {
      if (from === "private") {
        const p = priv ?? (await unlock());
        if (!p) throw new Error("Unlock your private account to bid from it.");
        const r = await p.bidPrivately(s.address, { maxPrice: parseEther(maxPrice), quantity: parseEther(qty), deposit }, setStatus);
        saveSecret(r.secret);
        setOk(r.secret.txHash);
        toast("Bid sealed from a one-time wallet");
      } else {
        const c = new Cloak(publicClient, wallet);
        const secret = await c.bid(s.address, { maxPrice: parseEther(maxPrice), quantity: parseEther(qty), deposit });
        saveSecret(secret);
        setOk(secret.txHash);
      }
      markDone("bid");
      onDone();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
      setStatus("");
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <h3>Place a sealed bid</h3>
        <span className="pill">one price for all</span>
      </div>
      <div className="field">
        <label><span>Pay from</span><span>{from === "private" ? (priv ? (privBal === null ? "checking…" : `${hype(privBal)} HYPE private`) : "locked") : walletBal !== null ? `${hype(walletBal)} HYPE in wallet` : ""}</span></label>
        <div className="tabs" style={{ marginBottom: 0 }}>
          <button className={`tab ${from === "wallet" ? "on" : ""}`} onClick={() => setFrom("wallet")}>Wallet</button>
          <button className={`tab ${from === "private" ? "on" : ""}`} onClick={() => setFrom("private")}>Private balance</button>
        </div>
      </div>
      {from === "private" && (
        <p className="xs mute" style={{ margin: "-4px 0 14px" }}>
          Your private balance pays a fresh one-time wallet, and that wallet places the bid, so nobody can tie the bid to you.
          After the launch, one click claims your tokens into your private balance and moves any refund back.
          {!priv && (
            <> <button className="btn btn-text btn-sm" style={{ padding: 0 }} disabled={unlocking} onClick={() => unlock()}>{unlocking ? "Unlocking…" : "Unlock your private account"}</button></>
          )}
        </p>
      )}
      <div className="field">
        <label>
          <span>Highest price you'd pay per token</span>
          <span>from {hype(s.minPrice)} HYPE</span>
        </label>
        <input className="input" value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)} inputMode="decimal" />
      </div>
      <div className="field">
        <label>
          <span>How many {s.tokenSymbol}</span>
          <span>{tokens(s.saleSupply)} for sale</span>
        </label>
        <input className="input" value={qty} onChange={(e) => setQty(e.target.value)} inputMode="decimal" />
      </div>
      <div className="field">
        <label>
          <span>Amount to lock</span>
          <span>extra comes back</span>
        </label>
        <div className="buckets">
          {(quote ? budgetBuckets(quote.cost, 6) : []).map((b) => (
            <button
              key={b.toString()}
              className={`bucket ${deposit === b ? "on" : ""}`}
              disabled={!quote || b < quote.cost}
              title={walletBal !== null && b > walletBal ? "More than your wallet balance" : undefined}
              onClick={() => setBucket(b)}
            >
              {hype(b)}
            </button>
          ))}
        </div>
      </div>
      <div className="summary">
        <div className="row"><span className="mute">If you win, you pay at most</span><span className="mono">{quote ? `${hype(quote.cost)} HYPE` : "—"}</span></div>
        <div className="row"><span className="mute">You lock now</span><span className="mono">{quote ? `${hype(deposit)} HYPE` : "—"}</span></div>
      </div>
      {problem && <div className="hint">{problem}</div>}
      <button className="btn btn-ink btn-block" disabled={!!wallet && (!!problem || busy)} onClick={wallet ? submit : () => connect()}>
        {!wallet ? "Connect a wallet to bid" : busy ? status || "Sealing your bid…" : from === "private" ? "Seal bid from private balance" : "Seal bid"}
      </button>
      {err && <div className="err">{err}</div>}
      {ok && <div className="okmsg">Bid sealed. You can close this tab, it opens by itself. <Tx hash={ok} /></div>}
      <p className="note">
        Nobody sees your price or amount until bidding closes. Every winner pays the same final price, which can be lower than your max, and whatever you locked beyond that comes back to you.
      </p>
    </div>
  );
}

// ───────────────────────────── my bids ─────────────────────────────

type MyBid = Awaited<ReturnType<Cloak["bidsOf"]>>[number];

/**
 * Whether this wallet's won bids can be claimed straight into the private vault: a v4 launch whose vault is open, and
 * each claim within the vault's beta deposit cap (checked by simulating it). "cap" when the cap blocks it.
 */
function usePrivateClaim(s: AuctionState, won: MyBid[], account?: Address): "yes" | "no" | "cap" | "shared" {
  const [ok, setOk] = useState<"yes" | "no" | "cap" | "shared">("no");
  const ids = won.map((b) => b.id.toString()).join(",");
  useEffect(() => {
    let alive = true;
    (async (): Promise<"yes" | "no" | "cap" | "shared"> => {
      if (!FACTORY || !s.settled || s.failed || !account || !won.length) return "no";
      // a launch whose token lives in the shared vault: claim to the wallet, then move the tokens in
      if (SHARED && (await publicClient.readContract({ address: SHARED, abi: sharedVaultAbi, functionName: "admitted", args: [s.token] }).catch(() => false))) return "shared";
      if (!VAULTS) return "no";
      const factory = await publicClient.readContract({ address: s.address, abi: cloakAuctionAbi, functionName: "factory" }).catch(() => undefined);
      const ours = [FACTORY, ...(DEPLOYMENT?.earlierFactories ?? [])].map((x) => x.toLowerCase());
      if (!factory || !ours.includes(factory.toLowerCase())) return "no"; // launches before v4 have no private claim
      const pool = await publicClient.readContract({ address: VAULTS, abi: cloakVaultsAbi, functionName: "poolOf", args: [s.token] });
      if (pool === "0x0000000000000000000000000000000000000000") return "no";
      for (const b of won) {
        const fits = await publicClient
          .simulateContract({ address: s.address, abi: cloakAuctionAbi, functionName: "claimPrivate", args: [b.id, 1n, 1n, "0x"], account })
          .then(() => true, () => false);
        if (!fits) return "cap";
      }
      return "yes";
    })()
      .then((v) => alive && setOk(v))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [s.address, s.settled, s.failed, s.token, account, ids]);
  return ok;
}

export function MyBids({ s, wallet, bids, onDone }: { s: AuctionState; wallet: Wallet | null; bids: MyBid[]; onDone: () => void }) {
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const { priv, unlock, toast } = useApp();
  const unclaimed = bids.filter((b) => !b.claimed).map((b) => b.id);
  const won = bids.filter((b) => !b.claimed && b.tokens > 0n);
  const privateClaim = usePrivateClaim(s, won, wallet?.account.address);
  const canPrivate = privateClaim === "yes" || privateClaim === "shared";
  if (!wallet) return null;
  const secrets = loadSecrets(s.address);

  async function act(label: string, fn: (c: Cloak) => Promise<unknown>) {
    setBusy(label);
    setErr("");
    try {
      await fn(new Cloak(publicClient, wallet!));
      onDone();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy("");
    }
  }

  const claimPrivately = () =>
    act("pclaim", async () => {
      const p = priv ?? (await unlock());
      if (!p) throw new Error("Unlock your private account to claim privately.");
      if (privateClaim === "shared") {
        const sh = sharedFor(p, wallet);
        if (!sh) throw new Error("Private claims aren't available on this deployment.");
        await sh.claimInto(wallet!, s.address, won.map((b) => b.id));
      } else for (const b of won) await p.claimPrivately(wallet!, s.address, b.id);
      toast(`${s.tokenSymbol} claimed into your private balance`);
    });
  return (
    <div className="card">
      <div className="card-head">
        <h3>Your bids</h3>
        {s.settled && unclaimed.length > 0 && (
          <div style={{ display: "flex", gap: 8 }}>
            {canPrivate && won.length > 0 && (
              <button className="btn btn-primary btn-sm" disabled={!!busy} onClick={claimPrivately}>
                {busy === "pclaim" ? "Claiming…" : "Claim privately"}
              </button>
            )}
            <button className={`btn ${canPrivate && won.length > 0 ? "btn-ghost" : "btn-primary"} btn-sm`} disabled={!!busy} onClick={() => act("claim", (c) => c.claim(s.address, unclaimed))}>
              {busy === "claim" ? "Claiming…" : canPrivate && won.length > 0 ? "Claim to wallet" : "Claim all"}
            </button>
          </div>
        )}
      </div>
      {s.settled && canPrivate && won.length > 0 && (
        <p className="xs mute" style={{ margin: "0 0 10px" }}>
          Claim privately to put your {s.tokenSymbol} straight into your private balance, so your later trades can't be linked to this bid. Any HYPE refund still goes to your wallet. Bids nobody claims are sent to wallets about an hour after bidding closes.
        </p>
      )}
      {s.settled && privateClaim === "cap" && (
        <p className="xs mute" style={{ margin: "0 0 10px" }}>
          Your {s.tokenSymbol} is more than the private vault takes in one deposit during the beta, so it can only be claimed to your wallet for now.
        </p>
      )}
      {bids.length === 0 ? (
        <p className="mute small" style={{ margin: 0 }}>No bids from <Who address={wallet.account.address} /> yet.</p>
      ) : (
        <div className="bids">
          {bids.map((b) => {
            const secret = secrets.find((x) => x.id === b.id);
            return (
              <div className="bidrow" key={b.id.toString()}>
                <span className="bidno">#{b.id.toString()}</span>
                <div>
                  {b.revealed ? (
                    <div className="mono">{tokens(b.quantity)} @ ≤ {hype(s.minPrice + BigInt(b.tick) * s.tickSize)}</div>
                  ) : (
                    <div><span className="sealed" style={{ width: 120, height: 13 }} /></div>
                  )}
                  <div className="xs mute">deposit {hype(b.deposit)} HYPE{s.settled && ` · gets ${tokens(b.tokens)} ${s.tokenSymbol} + ${hype(b.refund)} HYPE back`}</div>
                </div>
                {b.claimed ? (
                  <span className="pill ok">claimed</span>
                ) : s.settled ? (
                  <span className={`pill ${b.tokens > 0n ? "ok" : "warn"}`}>{b.tokens > 0n ? "won" : b.revealed ? "refund" : "unrevealed"}</span>
                ) : b.revealed ? (
                  <span className="pill ok">revealed</span>
                ) : s.phase === "reveal" && secret ? (
                  <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => act(`r${b.id}`, (c) => c.reveal(secret))}>
                    reveal now
                  </button>
                ) : (
                  <span className="pill sealed-p">sealed</span>
                )}
              </div>
            );
          })}
        </div>
      )}
      {err && <div className="err">{err}</div>}
    </div>
  );
}

// ───────────────────────────── fair launch record ─────────────────────────────

export function FairLaunchCard({ s }: { s: AuctionState }) {
  const [poolPrice, setPoolPrice] = useState<bigint>(0n);
  const [lp, setLp] = useState<{ hype: bigint; tok: bigint; burned: boolean } | null>(null);
  const [top, setTop] = useState<{ bidders: number; topShare: number } | null>(null);

  useEffect(() => {
    if (!s.settled || s.failed) return;
    (async () => {
      const zero = "0x0000000000000000000000000000000000000000";
      if (s.pair !== zero) {
        const [price, rH, rT, dead, total] = await Promise.all([
          publicClient.readContract({ address: s.pair, abi: cloakPairAbi, functionName: "price" }),
          publicClient.readContract({ address: s.pair, abi: cloakPairAbi, functionName: "reserveHype" }),
          publicClient.readContract({ address: s.pair, abi: cloakPairAbi, functionName: "reserveToken" }),
          publicClient.readContract({ address: s.pair, abi: cloakPairAbi, functionName: "sharesOf", args: ["0x000000000000000000000000000000000000dEaD"] }),
          publicClient.readContract({ address: s.pair, abi: cloakPairAbi, functionName: "totalShares" }),
        ]);
        setPoolPrice(price);
        // a Uniswap pool keeps its own 1000 minimum LP at address(0); everything else at 0x…dEaD means burned
        const uni = BigInt(s.uniPair ?? zero) !== 0n;
        setLp({ hype: rH, tok: rT, burned: dead + (uni ? 1000n : 0n) === total });
      }
      const logs = await publicClient.getContractEvents({ address: s.address, abi: cloakAuctionAbi, eventName: "Revealed", fromBlock: 0n, strict: true });
      const [mRem, mDem] = await Promise.all([
        publicClient.readContract({ address: s.address, abi: cloakAuctionAbi, functionName: "marginalRemaining" }),
        publicClient.readContract({ address: s.address, abi: cloakAuctionAbi, functionName: "marginalDemand" }),
      ]);
      const fills = new Map<string, bigint>();
      for (const l of logs) {
        if (l.args.tick < s.clearingTick) continue;
        const f = l.args.tick > s.clearingTick ? l.args.quantity : mDem === 0n ? 0n : (l.args.quantity * mRem) / mDem;
        fills.set(l.args.bidder, (fills.get(l.args.bidder) ?? 0n) + f);
      }
      const biggest = [...fills.values()].reduce((m, x) => (x > m ? x : m), 0n);
      setTop({ bidders: new Set(logs.map((l) => l.args.bidder)).size, topShare: s.sold === 0n ? 0 : Number((biggest * 10000n) / s.sold) / 100 });
    })().catch(() => {});
  }, [s.settled, s.pair, s.address]);

  if (!s.settled) return null;
  if (s.failed) return <div className="card"><h3>Launch failed</h3><p className="mute">No valid bids were revealed. Every deposit is refundable in full and tokens went back to the creator.</p></div>;
  const forever = s.creatorFees || s.lpLockUntil >= 2 ** 63;
  const lockLabel = s.lpLockUntil === 0 ? "burned forever" : forever ? "locked forever, trading fees to the creator" : `locked until ${new Date(s.lpLockUntil * 1000).toLocaleDateString()}`;
  return (
    <div className="card">
      <div className="badge">
        <span style={{ fontSize: 22 }}>✓</span>
        <div className="small"><b>Fair launch verified on-chain.</b> One clearing price for every winner, {BigInt(s.uniPair ?? 0) !== 0n ? "Uniswap pool" : "pool"} seeded at that price, liquidity {lockLabel}.</div>
      </div>
      <div className="fl">
        <div className="row"><span className="mute">Clearing price</span><span className="mono">{hype(s.clearingPrice)} HYPE</span></div>
        <div className="row"><span className="mute">Sold</span><span className="mono">{tokens(s.sold)} {s.tokenSymbol}</span></div>
        <div className="row"><span className="mute">Raised</span><span className="mono">{hype(s.raised)} HYPE</span></div>
        <div className="row"><span className="mute">LP shares</span><span>{lp?.burned ? <span className="pill ok">burned</span> : forever ? <span className="pill ok">locked forever</span> : <span className="pill warn">{lockLabel}</span>}</span></div>
        <div className="row"><span className="mute">Bidders</span><span className="mono">{top?.bidders ?? s.reveals}</span></div>
        <div className="row"><span className="mute">Largest single fill</span><span className="mono">{top ? `${top.topShare}%` : "—"}</span></div>
      </div>
    </div>
  );
}

// ───────────────────────────── trade ─────────────────────────────

export function TradeCard({ s, wallet }: { s: AuctionState; wallet: Wallet | null }) {
  const { connect } = useApp();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amt, setAmt] = useState("0.01");
  const [out, setOut] = useState<bigint>(0n);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok?: Hex; err?: string }>({});
  const zero = "0x0000000000000000000000000000000000000000";

  useEffect(() => {
    if (s.pair === zero) return;
    (async () => {
      try {
        const a = parseEther(amt || "0");
        const [rH, rT] = await Promise.all([
          publicClient.readContract({ address: s.pair, abi: cloakPairAbi, functionName: "reserveHype" }),
          publicClient.readContract({ address: s.pair, abi: cloakPairAbi, functionName: "reserveToken" }),
        ]);
        const o = await publicClient.readContract({ address: s.pair, abi: cloakPairAbi, functionName: "getAmountOut", args: side === "buy" ? [a, rH, rT] : [a, rT, rH] });
        setOut(o);
      } catch {
        setOut(0n);
      }
    })();
  }, [amt, side, s.pair]);

  if (!s.settled || s.pair === zero) return null;

  async function trade() {
    if (!wallet) return;
    setBusy(true);
    setMsg({});
    try {
      const a = parseEther(amt);
      const minOut = (out * 98n) / 100n;
      let h: Hex;
      if (side === "buy") {
        h = await wallet.writeContract({ address: s.pair, abi: cloakPairAbi, functionName: "swapExactHypeForTokens", args: [minOut, wallet.account.address], value: a });
      } else {
        const ap = await wallet.writeContract({ address: s.token, abi: cloakTokenAbi, functionName: "approve", args: [s.pair, a] });
        await publicClient.waitForTransactionReceipt({ hash: ap });
        h = await wallet.writeContract({ address: s.pair, abi: cloakPairAbi, functionName: "swapExactTokensForHype", args: [a, minOut, wallet.account.address] });
      }
      await publicClient.waitForTransactionReceipt({ hash: h });
      setMsg({ ok: h });
    } catch (e) {
      setMsg({ err: errMsg(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="card-head"><h3>Trade from your wallet</h3><span className="pill">public</span></div>
      <div className="tabs">
        <button className={`tab ${side === "buy" ? "on" : ""}`} onClick={() => setSide("buy")}>Buy</button>
        <button className={`tab ${side === "sell" ? "on" : ""}`} onClick={() => setSide("sell")}>Sell</button>
      </div>
      <div className="field">
        <label><span>{side === "buy" ? "You pay (HYPE)" : `You sell (${s.tokenSymbol})`}</span></label>
        <input className="input" value={amt} onChange={(e) => setAmt(e.target.value)} inputMode="decimal" />
      </div>
      <div className="summary">
        <div className="row"><span className="mute">You receive ≈</span><span className="mono">{side === "buy" ? `${tokens(out)} ${s.tokenSymbol}` : `${hype(out)} HYPE`}</span></div>
      </div>
      <button className="btn btn-primary btn-block" disabled={!!wallet && (busy || out === 0n)} onClick={wallet ? trade : () => connect()}>
        {!wallet ? "Connect a wallet" : busy ? "Swapping…" : side === "buy" ? `Buy ${s.tokenSymbol}` : `Sell ${s.tokenSymbol}`}
      </button>
      {msg.err && <div className="err">{msg.err}</div>}
      {msg.ok && <div className="okmsg">Done. <Tx hash={msg.ok} /></div>}
    </div>
  );
}

// ───────────────────────────── launches + create ─────────────────────────────

export function CreateLaunch({ wallet, onCreated }: { wallet: Wallet | null; onCreated: (a: Address) => void }) {
  const { connect } = useApp();
  const [image, setImage] = useState("");
  const [desc, setDesc] = useState("");
  const [imgBusy, setImgBusy] = useState(false);
  const [f, setF] = useState({ name: "", symbol: "", supply: "1000000", minPrice: "0.000001", tick: "0.000001", commitMin: "10", revealMin: "3", lpPct: "50", lock: "burn" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  async function pickImage(file?: File) {
    if (!file) return;
    setErr("");
    setImgBusy(true);
    try {
      setImage(await compressImage(file));
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setImgBusy(false);
    }
  }

  function check(): string {
    const num = (v: string) => /^\s*\d*\.?\d+\s*$/.test(v) && Number(v) > 0;
    if (!f.name.trim()) return "Give the token a name.";
    if (f.name.trim().length > 40) return "Keep the name under 40 characters.";
    if (!/^[A-Za-z0-9]{1,11}$/.test(f.symbol.trim())) return "The symbol should be 1 to 11 letters or numbers, like SHADE.";
    if (!num(f.supply)) return "Tokens for sale must be a number above zero, like 1000000.";
    if (!num(f.minPrice)) return "Min price must be a number above zero, like 0.000001.";
    if (!num(f.tick)) return "Price step must be a number above zero, like 0.000001.";
    if (!/^\d+(\.\d+)?$/.test(f.lpPct.trim()) || Number(f.lpPct) > 100) return "LP share must be between 0 and 100.";
    if (!num(f.commitMin) || Number(f.commitMin) < 0.5) return "The bidding window must be at least 0.5 minutes.";
    if (!num(f.revealMin) || Number(f.revealMin) < 1) return "The reveal window must be at least 1 minute.";
    return "";
  }

  async function create() {
    if (!wallet || !FACTORY) return;
    const bad = check();
    if (bad) return setErr(bad);
    setBusy(true);
    setErr("");
    try {
      const now = Number((await publicClient.getBlock()).timestamp);
      const commitEnd = now + Math.round(Number(f.commitMin) * 60);
      const revealEnd = commitEnd + Math.round(Number(f.revealMin) * 60);
      const c = new Cloak(publicClient, wallet, FACTORY);
      const supply = parseEther(f.supply);
      const r = await c.createLaunch({
        name: f.name.trim(),
        symbol: f.symbol.trim().toUpperCase(),
        saleSupply: supply,
        lpReserve: supply,
        minPrice: parseEther(f.minPrice),
        tickSize: parseEther(f.tick),
        numTicks: 100,
        commitEnd,
        revealEnd,
        lpBps: Math.round(Number(f.lpPct) * 100),
        lpLockUntil: f.lock === "burn" ? "burn" : revealEnd + Number(f.lock) * 86400,
        metadataURI: encodeMeta({ image, description: desc }),
      });
      loadAllMeta(true);
      onCreated(r.auction);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="card-head"><h3>Launch a token</h3><span className="pill">for projects & launchpads</span></div>
      <div className="field">
        <label><span>Token image</span><span>optional</span></label>
        <label
          className={`img-drop ${image ? "has" : ""}`}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); pickImage(e.dataTransfer.files[0]); }}
        >
          <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => { pickImage(e.target.files?.[0]); e.target.value = ""; }} />
          {image ? <img src={image} alt="Token image preview" /> : <span className="img-ph">{(f.symbol || "?").slice(0, 2).toUpperCase()}</span>}
          <span className="img-copy">
            <b>{imgBusy ? "Preparing image…" : image ? "Change image" : "Upload an image"}</b>
            <span className="xs mute">PNG, JPG, WebP or GIF. Drop it here or click. It's cropped to a square, shrunk to 256 × 256 and stored on-chain with the launch.</span>
          </span>
          {image && <button type="button" className="btn btn-text btn-sm" onClick={(e) => { e.preventDefault(); setImage(""); }}>Remove</button>}
        </label>
      </div>
      <div className="field">
        <label><span>Description</span><span>{desc.length}/280</span></label>
        <textarea className="input" rows={2} maxLength={280} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="One or two lines about the project" />
      </div>
      <div className="fl" style={{ gridTemplateColumns: "1fr 1fr", gap: "0 12px" }}>
        <div className="field"><label>Name</label><input className="input" value={f.name} onChange={set("name")} placeholder="Shade" /></div>
        <div className="field"><label>Symbol</label><input className="input" value={f.symbol} onChange={set("symbol")} placeholder="SHADE" /></div>
        <div className="field"><label>Tokens for sale</label><input className="input" value={f.supply} onChange={set("supply")} /></div>
        <div className="field"><label>LP share of raise (%)</label><input className="input" value={f.lpPct} onChange={set("lpPct")} /></div>
        <div className="field"><label>Min price (HYPE)</label><input className="input" value={f.minPrice} onChange={set("minPrice")} /></div>
        <div className="field"><label>Price step (HYPE)</label><input className="input" value={f.tick} onChange={set("tick")} /></div>
        <div className="field"><label>Bidding window (min)</label><input className="input" value={f.commitMin} onChange={set("commitMin")} /></div>
        <div className="field"><label>Reveal window (min)</label><input className="input" value={f.revealMin} onChange={set("revealMin")} /></div>
      </div>
      <div className="field">
        <label>Liquidity</label>
        <select className="input" value={f.lock} onChange={set("lock")}>
          <option value="burn">Burn LP shares (locked forever)</option>
          <option value="30">Lock LP 30 days</option>
          <option value="180">Lock LP 180 days</option>
        </select>
      </div>
      <button className="btn btn-primary btn-block" disabled={!FACTORY || (!!wallet && (busy || !f.name || !f.symbol))} onClick={wallet ? create : () => connect()}>
        {!FACTORY ? "Set VITE_FACTORY to enable" : !wallet ? "Connect a wallet" : busy ? "Deploying…" : "Create sealed-bid launch"}
      </button>
      {err && <div className="err">{err}</div>}
      <p className="note">Cloak takes a launch fee from a successful raise only (none if the launch doesn't fill). Same as <span className="mono">cloak.createLaunch(&#123;…&#125;)</span> in <span className="mono">@cloakely/sdk</span>. A launchpad can call <span className="mono">CloakFactory.createLaunch</span> from its own contracts.</p>
    </div>
  );
}

export { WAD };
