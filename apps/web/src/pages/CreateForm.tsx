import { useMemo, useState } from "react";
import { parseEther, type Address } from "viem";
import { Cloak, type Wallet } from "@cloakely/sdk";
import { FACTORY } from "../config";
import { hype, tokens } from "../format";
import { friendly } from "../errors";
import { useApp } from "../state";
import { compressImage, encodeMeta, loadAllMeta } from "../tokenMeta";
import { publicClient } from "../wallet";

/**
 * Create a launch: a preset for most people, every technical setting for those who want them, and a live summary of
 * what the launch will do (raise range, pool, timeline, fees) before anything is signed.
 */

type LpMode = "fees" | "burn" | "date";
interface Form {
  sale: string; // tokens for sale
  start: string; // HYPE per token at the lowest level
  ceiling: string; // HYPE per token at the highest level
  levels: string; // price levels, 1 to 256
  commitMin: string;
  revealMin: string;
  lpPct: string; // share of the net raise that seeds the pool
  lp: LpMode;
  lockDays: string;
  penaltyPct: string; // burned from bids never revealed (10 to 50)
  creatorPct: string; // creator's share of the total supply (0 to 20)
  vestDays: string;
}

const PRESETS: { id: string; name: string; blurb: string; f: Partial<Form> }[] = [
  { id: "quick", name: "Quick", blurb: "15 minutes of bidding. Good for a first launch or a community drop.", f: { sale: "1000000", start: "0.000001", ceiling: "0.0001", levels: "100", commitMin: "15", revealMin: "3" } },
  { id: "standard", name: "Standard", blurb: "6 hours of bidding, so people in every time zone can take part.", f: { sale: "10000000", start: "0.0000001", ceiling: "0.00001", levels: "100", commitMin: "360", revealMin: "10" } },
  { id: "extended", name: "Extended", blurb: "24 hours of bidding for a larger sale with a wide price range.", f: { sale: "100000000", start: "0.00000001", ceiling: "0.000002", levels: "200", commitMin: "1440", revealMin: "15" } },
];
const BASE: Form = { sale: "1000000", start: "0.000001", ceiling: "0.0001", levels: "100", commitMin: "15", revealMin: "3", lpPct: "50", lp: "fees", lockDays: "180", penaltyPct: "10", creatorPct: "0", vestDays: "90" };
const LAUNCH_FEE_BPS = 150n;

function Field({ label, unit, help, value, onChange, mode, disabled }: { label: string; unit?: string; help: string; value: string; onChange: (e: React.ChangeEvent<HTMLInputElement>) => void; mode: "decimal" | "numeric"; disabled?: boolean }) {
  return (
    <div className="field">
      <label><span>{label}</span>{unit && <span>{unit}</span>}</label>
      <input className="input" value={value} onChange={onChange} inputMode={mode} disabled={disabled} />
      <span className="field-help">{help}</span>
    </div>
  );
}

const num = (v: string) => /^\s*\d*\.?\d+\s*$/.test(v) && Number(v) >= 0;
const pos = (v: string) => num(v) && Number(v) > 0;
const wei = (v: string) => {
  try {
    return parseEther(v.trim() || "0");
  } catch {
    return -1n;
  }
};
const when = (secs: number) => new Date(secs * 1000).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" });
const mins = (m: number) => (m >= 1440 && m % 1440 === 0 ? `${m / 1440} day${m === 1440 ? "" : "s"}` : m >= 60 && m % 60 === 0 ? `${m / 60} hour${m === 60 ? "" : "s"}` : `${m} min`);

export function CreateForm({ wallet, onCreated }: { wallet: Wallet | null; onCreated: (a: Address) => void }) {
  const { connect } = useApp();
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [desc, setDesc] = useState("");
  const [image, setImage] = useState("");
  const [imgBusy, setImgBusy] = useState(false);
  const [preset, setPreset] = useState("quick");
  const [f, setF] = useState<Form>(BASE);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setF({ ...f, [k]: e.target.value });
    if (["sale", "start", "ceiling", "levels", "commitMin", "revealMin"].includes(k)) setPreset("custom");
  };
  const pick = (id: string) => {
    const p = PRESETS.find((x) => x.id === id)!;
    setPreset(id);
    setF({ ...f, ...p.f });
  };

  async function pickImage(file?: File) {
    if (!file) return;
    setErr("");
    setImgBusy(true);
    try {
      setImage(await compressImage(file));
    } catch (e) {
      setErr(friendly(e));
    } finally {
      setImgBusy(false);
    }
  }

  // everything the summary shows, and the first problem with the settings
  const plan = useMemo(() => {
    const levels = Math.round(Number(f.levels));
    const sale = wei(f.sale);
    const start = wei(f.start);
    const ceiling = wei(f.ceiling);
    const problem = (() => {
      if (!name.trim()) return "Give the token a name.";
      if (name.trim().length > 40) return "Keep the name under 40 characters.";
      if (!/^[A-Za-z0-9]{1,11}$/.test(symbol.trim())) return "The symbol should be 1 to 11 letters or numbers, like SHADE.";
      if (!pos(f.sale) || sale <= 0n) return "Tokens for sale must be a number above zero.";
      if (!pos(f.start) || start <= 0n) return "The starting price must be above zero.";
      if (!/^\d+$/.test(f.levels.trim()) || levels < 1 || levels > 256) return "Price levels must be a whole number from 1 to 256.";
      if (levels > 1 && (!pos(f.ceiling) || ceiling <= start)) return "The top price must be above the starting price.";
      if (!pos(f.commitMin) || Number(f.commitMin) < 1) return "Bidding must last at least 1 minute.";
      if (!pos(f.revealMin) || Number(f.revealMin) < 1) return "The reveal window must be at least 1 minute, so every sealed bid can open.";
      if (!num(f.lpPct) || Number(f.lpPct) > 100) return "The pool's share of the raise must be between 0 and 100%.";
      if (f.lp === "date" && (!/^\d+$/.test(f.lockDays.trim()) || Number(f.lockDays) < 1)) return "Lock the pool for at least 1 day.";
      if (!num(f.penaltyPct) || Number(f.penaltyPct) < 10 || Number(f.penaltyPct) > 50) return "The penalty for unrevealed bids must be between 10% and 50%.";
      if (!num(f.creatorPct) || Number(f.creatorPct) > 20) return "Your own share can be at most 20% of the supply.";
      if (Number(f.creatorPct) > 0 && (!/^\d+$/.test(f.vestDays.trim()) || Number(f.vestDays) < 30)) return "Your share has to vest over at least 30 days.";
      return "";
    })();
    if (sale <= 0n || start <= 0n || levels < 1) return { problem, ok: false as const };
    const tick = levels > 1 && ceiling > start ? (ceiling - start) / BigInt(levels - 1) : start;
    const top = start + BigInt(Math.max(levels - 1, 0)) * tick;
    const lpBps = BigInt(Math.round(Number(f.lpPct || "0") * 100));
    const raiseAt = (price: bigint) => (price * sale) / 10n ** 18n;
    const pool = (price: bigint) => {
      const net = raiseAt(price) - (raiseAt(price) * LAUNCH_FEE_BPS) / 10_000n;
      const h = (net * lpBps) / 10_000n;
      return { hype: h, tokens: (h * 10n ** 18n) / price, creator: net - h };
    };
    // the LP reserve equals the sale, so the pool always has enough tokens; the creator share is a % of everything
    const sold = sale * 2n;
    const pct = Number(f.creatorPct || "0");
    const creatorAlloc = pct > 0 ? (sold * BigInt(Math.round(pct * 100))) / BigInt(10_000 - Math.round(pct * 100)) : 0n;
    return { problem, ok: true as const, levels, tick, top, start, sale, lpBps, minRaise: raiseAt(start), maxRaise: raiseAt(top), poolMin: pool(start), poolMax: pool(top), creatorAlloc, supply: sold + creatorAlloc };
  }, [f, name, symbol]);

  async function create() {
    if (!wallet || !FACTORY || !plan.ok || plan.problem) return;
    setBusy(true);
    setErr("");
    try {
      const now = Number((await publicClient.getBlock()).timestamp);
      const commitEnd = now + Math.round(Number(f.commitMin) * 60);
      const revealEnd = commitEnd + Math.round(Number(f.revealMin) * 60);
      const r = await new Cloak(publicClient, wallet, FACTORY).createLaunch({
        name: name.trim(),
        symbol: symbol.trim().toUpperCase(),
        saleSupply: plan.sale,
        lpReserve: plan.sale,
        minPrice: plan.start,
        tickSize: plan.tick,
        numTicks: plan.levels,
        commitEnd,
        revealEnd,
        lpBps: Number(plan.lpBps),
        lpLockUntil: f.lp === "fees" ? "fees" : f.lp === "burn" ? "burn" : revealEnd + Number(f.lockDays) * 86400,
        noRevealPenaltyBps: Math.round(Number(f.penaltyPct) * 100),
        creatorAlloc: plan.creatorAlloc,
        creatorVestSecs: Number(f.vestDays) * 86400,
        metadataURI: encodeMeta({ image, description: desc }),
      });
      loadAllMeta(true);
      onCreated(r.auction);
    } catch (e) {
      setErr(friendly(e));
    } finally {
      setBusy(false);
    }
  }

  const commitM = Number(f.commitMin) || 0;
  const revealM = Number(f.revealMin) || 0;
  const t0 = Date.now() / 1000;
  return (
    <div className="grid create-grid">
      <div className="col">
        <div className="card">
          <div className="card-head"><h3>1. The token</h3></div>
          <div className="field">
            <label><span>Image</span><span>optional</span></label>
            <label className={`img-drop ${image ? "has" : ""}`} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); pickImage(e.dataTransfer.files[0]); }}>
              <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => { pickImage(e.target.files?.[0]); e.target.value = ""; }} />
              {image ? <img src={image} alt="Token image preview" /> : <span className="img-ph">{(symbol || "?").slice(0, 2).toUpperCase()}</span>}
              <span className="img-copy">
                <b>{imgBusy ? "Preparing image…" : image ? "Change image" : "Upload an image"}</b>
                <span className="xs mute">PNG, JPG, WebP or GIF. Cropped to a square and stored on-chain with the launch.</span>
              </span>
              {image && <button type="button" className="btn btn-text btn-sm" onClick={(e) => { e.preventDefault(); setImage(""); }}>Remove</button>}
            </label>
          </div>
          <div className="fl" style={{ gridTemplateColumns: "1fr 1fr", gap: "0 12px" }}>
            <div className="field"><label>Name</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Shade" maxLength={40} /></div>
            <div className="field"><label>Symbol</label><input className="input" value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} placeholder="SHADE" maxLength={11} /></div>
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label><span>Description</span><span>{desc.length}/280</span></label>
            <textarea className="input" rows={2} maxLength={280} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="One or two lines about the project" />
          </div>
        </div>

        <div className="card">
          <div className="card-head"><h3>2. The sale</h3><span className="pill">{preset === "custom" ? "custom" : PRESETS.find((p) => p.id === preset)?.name}</span></div>
          <div className="preset-grid">
            {PRESETS.map((p) => (
              <button key={p.id} type="button" className={`choice ${preset === p.id ? "on" : ""}`} onClick={() => pick(p.id)}>
                <b>{p.name}</b>
                <span className="xs mute">{p.blurb}</span>
              </button>
            ))}
          </div>
          <p className="small mute" style={{ margin: "14px 0 0" }}>
            {tokens(plan.ok ? plan.sale : 0n)} tokens for sale, bids from {plan.ok ? hype(plan.start) : "…"} to {plan.ok ? hype(plan.top) : "…"} HYPE each, {mins(commitM)} of sealed bidding.
          </p>
          <button type="button" className="btn btn-text btn-sm adv-toggle" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}>
            {advanced ? "Hide advanced settings" : "Advanced settings"} <span aria-hidden>{advanced ? "▴" : "▾"}</span>
          </button>
          {advanced && (
            <div className="advanced">
              <div className="fl adv-fields" style={{ gridTemplateColumns: "1fr 1fr", gap: "0 12px" }}>
                <Field label="Tokens for sale" help="How many tokens bidders can buy. The same amount again is set aside for the trading pool." value={f.sale} onChange={set("sale")} mode="decimal" />
                <Field label="Price levels" unit="1 to 256" help="The steps a bidder can choose between. More levels means finer prices." value={f.levels} onChange={set("levels")} mode="numeric" />
                <Field label="Starting price" unit="HYPE per token" help="The lowest price anyone can bid. If bids don't cover the whole sale, everyone who bid is filled and the unsold tokens are burned." value={f.start} onChange={set("start")} mode="decimal" />
                <Field label="Top price" unit="HYPE per token" help="The highest price anyone can bid. It caps how much the launch can raise." value={f.ceiling} onChange={set("ceiling")} mode="decimal" disabled={f.levels.trim() === "1"} />
                <Field label="Bidding" unit="minutes" help="How long people can place sealed bids. Longer gives more people a chance to join." value={f.commitMin} onChange={set("commitMin")} mode="numeric" />
                <Field label="Reveal window" unit="minutes" help="The pause after bidding while sealed bids open themselves. A few minutes is plenty." value={f.revealMin} onChange={set("revealMin")} mode="numeric" />
                <Field label="Pool's share of the raise" unit="%" help="How much of the HYPE raised goes into the trading pool. More means a deeper pool and steadier price, less means more for you." value={f.lpPct} onChange={set("lpPct")} mode="decimal" />
                <Field label="Penalty for unrevealed bids" unit="10 to 50%" help="Taken from a bid that never opens, so nobody can place fake bids to make demand look bigger." value={f.penaltyPct} onChange={set("penaltyPct")} mode="decimal" />
                <Field label="Your own share" unit="0 to 20% of supply" help="Tokens kept for you on top of the sale. Bidders see this before they bid." value={f.creatorPct} onChange={set("creatorPct")} mode="decimal" />
                <Field label="Your share unlocks over" unit="days, at least 30" help="Your tokens unlock a little each day, so you can't dump them all at once." value={f.vestDays} onChange={set("vestDays")} mode="numeric" disabled={!Number(f.creatorPct)} />
              </div>
              <p className="xs mute" style={{ margin: 0 }}>
                Price levels sit {plan.ok ? `${hype(plan.tick)} HYPE` : "…"} apart. When bidding ends, the launch finds the highest level where bids cover every token for sale, and every winner pays that one price. If bids never cover it, the lowest bid sets the price.
              </p>
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-head"><h3>3. Liquidity</h3></div>
          <div className="choice-list">
            <button type="button" className={`choice ${f.lp === "fees" ? "on" : ""}`} onClick={() => setF({ ...f, lp: "fees" })}>
              <b>Locked forever, you earn the trading fees <span className="pill ok" style={{ marginLeft: 6 }}>recommended</span></b>
              <span className="xs mute">The pool can never be emptied. Every trade on it pays a 0.3% fee into the pool, and you can collect that share any time.</span>
            </button>
            <button type="button" className={`choice ${f.lp === "burn" ? "on" : ""}`} onClick={() => setF({ ...f, lp: "burn" })}>
              <b>Burned forever</b>
              <span className="xs mute">The pool can never be emptied and nobody collects its fees. They stay in the pool and deepen it.</span>
            </button>
            <button type="button" className={`choice ${f.lp === "date" ? "on" : ""}`} onClick={() => setF({ ...f, lp: "date" })}>
              <b>Locked until a date</b>
              <span className="xs mute">After the date, the pool's liquidity is yours to keep or withdraw. Bidders will see when.</span>
            </button>
          </div>
          {f.lp === "date" && (
            <div className="field" style={{ marginTop: 12, marginBottom: 0 }}>
              <label><span>Lock for</span><span>days after the auction</span></label>
              <input className="input" value={f.lockDays} onChange={set("lockDays")} inputMode="numeric" />
            </div>
          )}
        </div>
      </div>

      <div className="col">
        <div className="card create-summary">
          <div className="card-head"><h3>Your launch</h3>{symbol && <span className="pill">${symbol.toUpperCase()}</span>}</div>
          <div className="summary" style={{ marginTop: 0 }}>
            <div className="row"><span className="mute">For sale</span><span className="mono">{plan.ok ? tokens(plan.sale) : "—"}</span></div>
            <div className="row"><span className="mute">Raise, sold out at the start price</span><span className="mono">{plan.ok ? `${hype(plan.minRaise)} HYPE` : "—"}</span></div>
            <div className="row"><span className="mute">Raise, sold out at the top price</span><span className="mono">{plan.ok ? `${hype(plan.maxRaise)} HYPE` : "—"}</span></div>
            <div className="row"><span className="mute">Goes into the pool</span><span className="mono">{plan.ok ? `${f.lpPct}% · ${hype(plan.poolMin.hype)} to ${hype(plan.poolMax.hype)} HYPE` : "—"}</span></div>
            <div className="row"><span className="mute">You receive</span><span className="mono">{plan.ok ? `${hype(plan.poolMin.creator)} to ${hype(plan.poolMax.creator)} HYPE` : "—"}</span></div>
            {plan.ok && plan.creatorAlloc > 0n && <div className="row"><span className="mute">Your share, vesting</span><span className="mono">{tokens(plan.creatorAlloc)} over {f.vestDays} days</span></div>}
            <div className="row"><span className="mute">Total supply</span><span className="mono">{plan.ok ? tokens(plan.supply) : "—"}</span></div>
          </div>
          <div className="timeline">
            <div><span className="dot live" /> <b>Now</b> <span className="mute">Sealed bidding opens</span></div>
            <div><span className="dot" /> <b>{when(t0 + commitM * 60)}</b> <span className="mute">Bidding closes, bids open themselves</span></div>
            <div><span className="dot" /> <b>{when(t0 + (commitM + revealM) * 60)}</b> <span className="mute">One clearing price, Uniswap pool opens at it</span></div>
          </div>
          <div className="summary">
            <div className="row"><span className="mute">Liquidity</span><span>{f.lp === "fees" ? "locked forever, fees to you" : f.lp === "burn" ? "burned forever" : `locked ${f.lockDays} days`}</span></div>
            <div className="row"><span className="mute">Cloak's fee</span><span>1.5% of the raise, none if unfilled</span></div>
            <div className="row"><span className="mute">Unsold tokens</span><span>burned</span></div>
            <div className="row"><span className="mute">Per bid during beta</span><span>up to 100 HYPE</span></div>
          </div>
          {plan.problem && (name || symbol) && <div className="hint">{plan.problem}</div>}
          <button className="btn btn-primary btn-block" disabled={!FACTORY || (!!wallet && (busy || !!plan.problem))} onClick={wallet ? create : () => connect()}>
            {!FACTORY ? "Launches aren't available on this network" : !wallet ? "Connect a wallet" : busy ? "Creating the launch…" : "Create sealed-bid launch"}
          </button>
          {err && <div className="err">{err}</div>}
          <p className="note">
            One transaction deploys the token (fixed supply, no owner, no mint, no tax) and its auction. Bids stay sealed until bidding closes, bots and front-runners see nothing, and every winner pays one price.
            Launchpads can make the same call with <span className="mono">cloak.createLaunch()</span>.
          </p>
        </div>
      </div>
    </div>
  );
}

