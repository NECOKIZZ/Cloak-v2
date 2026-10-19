import { useEffect, useMemo, useState } from "react";
import { formatEther, parseEther, type Address, type Hex } from "viem";
import { budgetBuckets, cloakAuctionAbi, cloakPairAbi, cloakTokenAbi, type AuctionState, type Wallet, Cloak } from "@cloak/sdk";
import { FACTORY, txLink } from "./config";
import { hype, short, tokens } from "./format";
import { loadSecrets, publicClient, saveSecret } from "./wallet";
import { useApp } from "./state";
import { friendly } from "./errors";
import { compressImage, encodeMeta, loadAllMeta } from "./tokenMeta";

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
  const { connect } = useApp();
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

  async function submit() {
    if (!wallet || !quote) return;
    setBusy(true);
    setErr("");
    setOk(undefined);
    try {
      const c = new Cloak(publicClient, wallet);
      const secret = await c.bid(s.address, { maxPrice: parseEther(maxPrice), quantity: parseEther(qty), deposit });
      saveSecret(secret);
      setOk(secret.txHash);
      onDone();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <h3>Place a sealed bid</h3>
        <span className="pill">uniform price</span>
      </div>
      <div className="field">
        <label>
          <span>Max price per token</span>
          <span>min {hype(s.minPrice)} HYPE</span>
        </label>
        <input className="input" value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)} inputMode="decimal" />
      </div>
      <div className="field">
        <label>
          <span>Quantity</span>
          <span>{tokens(s.saleSupply)} {s.tokenSymbol} for sale</span>
        </label>
        <input className="input" value={qty} onChange={(e) => setQty(e.target.value)} inputMode="decimal" />
      </div>
      <div className="field">
        <label>
          <span>Deposit (hides your bid size)</span>
          <span>excess refunded</span>
        </label>
        <div className="buckets">
          {(quote ? budgetBuckets(quote.cost, 6) : []).map((b) => (
            <button
              key={b.toString()}
              className={`bucket ${deposit === b ? "on" : ""}`}
              disabled={!quote || b < quote.cost}
              onClick={() => setBucket(b)}
            >
              {hype(b)}
            </button>
          ))}
        </div>
      </div>
      <div className="summary">
        <div className="row"><span className="mute">Price level</span><span className="mono">{quote ? `${hype(quote.price)} HYPE (tick ${quote.tick})` : "—"}</span></div>
        <div className="row"><span className="mute">Max cost</span><span className="mono">{quote ? `${hype(quote.cost)} HYPE` : "—"}</span></div>
        <div className="row"><span className="mute">You lock</span><span className="mono">{quote ? `${hype(deposit)} HYPE` : "—"}</span></div>
        <div className="row"><span className="mute">Visible on-chain</span><span>a hash + <span className="sealed" style={{ width: 54, height: 12 }} /></span></div>
      </div>
      <button className="btn btn-ink btn-block" disabled={!!wallet && (!quote || busy)} onClick={wallet ? submit : () => connect()}>
        {!wallet ? "Connect a wallet to bid" : busy ? "Sealing & committing…" : "Seal bid"}
      </button>
      {err && <div className="err">{err}</div>}
      {ok && <div className="okmsg">Bid sealed. You can close this tab; it reveals itself. <Tx hash={ok} /></div>}
      <p className="note">
        Your bid is encrypted to drand round <span className="mono">#{s.tlockRound}</span>, which is published right after bidding closes. Then any keeper can open it.
        Everyone who wins pays the same clearing price, so there is nothing to gain from bidding early, fast or with a higher gas fee.
      </p>
    </div>
  );
}

// ───────────────────────────── my bids ─────────────────────────────

type MyBid = Awaited<ReturnType<Cloak["bidsOf"]>>[number];

export function MyBids({ s, wallet, bids, onDone }: { s: AuctionState; wallet: Wallet | null; bids: MyBid[]; onDone: () => void }) {
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
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

  const unclaimed = bids.filter((b) => !b.claimed).map((b) => b.id);
  return (
    <div className="card">
      <div className="card-head">
        <h3>Your bids</h3>
        {s.settled && unclaimed.length > 0 && (
          <button className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => act("claim", (c) => c.claim(s.address, unclaimed))}>
            {busy === "claim" ? "Claiming…" : "Claim all"}
          </button>
        )}
      </div>
      {bids.length === 0 ? (
        <p className="mute small" style={{ margin: 0 }}>No bids from {short(wallet.account.address)} yet.</p>
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
        setLp({ hype: rH, tok: rT, burned: dead === total });
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
  const lockLabel = s.lpLockUntil === 0 ? "burned forever" : `locked until ${new Date(s.lpLockUntil * 1000).toLocaleDateString()}`;
  return (
    <div className="card">
      <div className="badge">
        <span style={{ fontSize: 22 }}>✓</span>
        <div className="small"><b>Fair launch verified on-chain.</b> One clearing price for every winner, pool seeded at that price, liquidity {lockLabel}.</div>
      </div>
      <div className="fl">
        <div className="row"><span className="mute">Clearing price</span><span className="mono">{hype(s.clearingPrice)} HYPE</span></div>
        <div className="row"><span className="mute">Pool price now</span><span className="mono">{poolPrice ? `${hype(poolPrice)} HYPE` : "—"}</span></div>
        <div className="row"><span className="mute">Sold</span><span className="mono">{tokens(s.sold)} {s.tokenSymbol}</span></div>
        <div className="row"><span className="mute">Raised</span><span className="mono">{hype(s.raised)} HYPE</span></div>
        <div className="row"><span className="mute">Liquidity</span><span className="mono">{lp ? `${hype(lp.hype)} HYPE + ${tokens(lp.tok)}` : "—"}</span></div>
        <div className="row"><span className="mute">LP shares</span><span>{lp?.burned ? <span className="pill ok">burned</span> : <span className="pill warn">{lockLabel}</span>}</span></div>
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
      <div className="card-head"><h3>Public trade</h3><span className="pill ok">live</span></div>
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

  async function create() {
    if (!wallet || !FACTORY) return;
    setBusy(true);
    setErr("");
    try {
      const now = Number((await publicClient.getBlock()).timestamp);
      const commitEnd = now + Math.round(Number(f.commitMin) * 60);
      const revealEnd = commitEnd + Math.round(Number(f.revealMin) * 60);
      const c = new Cloak(publicClient, wallet, FACTORY);
      const supply = parseEther(f.supply);
      const r = await c.createLaunch({
        name: f.name,
        symbol: f.symbol,
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
      <p className="note">Same as <span className="mono">cloak.createLaunch(&#123;…&#125;)</span> in <span className="mono">@cloak/sdk</span>. A launchpad can call <span className="mono">CloakFactory.createLaunch</span> from its own contracts.</p>
    </div>
  );
}

export { WAD };
