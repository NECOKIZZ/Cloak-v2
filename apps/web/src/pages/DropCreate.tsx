import { useEffect, useMemo, useState } from "react";
import { getAddress, isAddress, parseEther, type Address } from "viem";
import { DROP_LIST_MAX, DROP_MAX_SUPPLY, type GtdEntry } from "@cloakely/sdk";
import { dropsClient, pct } from "../drops";
import { friendly, Hint } from "../errors";
import { hype } from "../format";
import { Link, navigate } from "../router";
import { useApp } from "../state";
import { compressImage } from "../tokenMeta";
import { Icon } from "../ui";

const DURATIONS: [string, number][] = [["10 minutes", 600], ["1 hour", 3600], ["6 hours", 21600], ["24 hours", 86400], ["3 days", 259200]];

/** Wallets from pasted text: one per line, or separated by commas or spaces. GTD lines may end in a spot count. */
function parseList(text: string, withSpots: boolean): { gtd: GtdEntry[]; wl: Address[]; bad: string[] } {
  const gtd = new Map<string, GtdEntry>();
  const wl = new Map<string, Address>();
  const bad: string[] = [];
  for (const raw of text.split(/\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (withSpots) {
      const [a, n] = line.split(/[\s,;]+/);
      const spots = n === undefined ? 1 : Number(n);
      if (!isAddress(a ?? "") || !Number.isInteger(spots) || spots < 1 || spots > 100) bad.push(line);
      else gtd.set(a.toLowerCase(), { wallet: getAddress(a), spots });
    } else {
      for (const a of line.split(/[\s,;]+/)) {
        if (!a) continue;
        if (!isAddress(a)) bad.push(a);
        else wl.set(a.toLowerCase(), getAddress(a));
      }
    }
  }
  return { gtd: [...gtd.values()], wl: [...wl.values()], bad };
}

function wei(v: string): bigint | null {
  try {
    const s = v.trim();
    if (!/^\d*\.?\d+$/.test(s)) return null;
    const w = parseEther(s);
    return w > 0n ? w : null;
  } catch {
    return null;
  }
}

/** Set up a sealed NFT drop: the collection, an optional GTD list and WL, the price and the bidding window. */
export function DropCreate() {
  const { wallet, connect } = useApp();
  const [f, setF] = useState({ name: "", symbol: "", supply: "1000", price: "0.5", maxPerBid: "2", royalty: "5", baseURI: "", description: "", gtdOn: false, gtdList: "", gtdPrice: "0.4", gtdSecs: 86400, wlOn: false, wlList: "", boost: 20, biddingSecs: 86400 });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const [image, setImage] = useState("");
  const [imgBusy, setImgBusy] = useState(false);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => { document.title = "Cloak · Create a drop"; }, []);

  const plan = useMemo(() => {
    const supply = Number(f.supply);
    const price = wei(f.price);
    const gtd = f.gtdOn ? parseList(f.gtdList, true) : { gtd: [], wl: [], bad: [] };
    const wl = f.wlOn ? parseList(f.wlList, false) : { gtd: [], wl: [], bad: [] };
    const gtdSpots = gtd.gtd.reduce((a, e) => a + e.spots, 0);
    const gtdPrice = f.gtdOn ? (f.gtdPrice.trim() === "0" ? 0n : wei(f.gtdPrice)) : 0n;
    let problem = "";
    if (!f.name.trim()) problem = "Name the collection.";
    else if (!f.symbol.trim()) problem = "Give it a short symbol, like MOON.";
    else if (!Number.isInteger(supply) || supply < 1 || supply > DROP_MAX_SUPPLY) problem = `Supply is 1 to ${DROP_MAX_SUPPLY.toLocaleString()}.`;
    else if (!price) problem = "Set your price in HYPE, above zero.";
    else if (gtd.bad.length) problem = `This GTD line isn't a wallet and spot count: ${gtd.bad[0].slice(0, 60)}`;
    else if (wl.bad.length) problem = `This isn't a wallet address: ${wl.bad[0].slice(0, 60)}`;
    else if (f.gtdOn && !gtd.gtd.length) problem = "Paste the GTD wallets, or turn GTD off.";
    else if (f.wlOn && !wl.wl.length) problem = "Paste the WL wallets, or turn the WL off.";
    else if (gtd.gtd.length > DROP_LIST_MAX || wl.wl.length > DROP_LIST_MAX) problem = `A list holds up to ${DROP_LIST_MAX.toLocaleString()} wallets.`;
    else if (gtdSpots > supply) problem = `The GTD list has ${gtdSpots} spots, more than the ${supply} NFTs.`;
    else if (f.gtdOn && gtdPrice === null) problem = "Set the GTD price (0 for free).";
    else if (f.baseURI.trim() && !/^(ipfs|https):\/\/\S+$/.test(f.baseURI.trim())) problem = "The metadata folder starts with ipfs:// or https://.";
    return { supply, price, gtd: gtd.gtd, wl: wl.wl, gtdSpots, gtdPrice: gtdPrice ?? 0n, problem };
  }, [f]);

  async function pick(file?: File) {
    if (!file) return;
    setImgBusy(true);
    setErr("");
    try {
      setImage(await compressImage(file));
    } catch (e) {
      setErr(friendly(e));
    } finally {
      setImgBusy(false);
    }
  }

  async function create() {
    setErr("");
    try {
      if (plan.problem) throw new Hint(plan.problem);
      const w = wallet ?? (await connect());
      if (!w) return;
      setBusy("Confirm in your wallet…");
      const { drop } = await dropsClient(w).create({
        name: f.name.trim(),
        symbol: f.symbol.trim().toUpperCase(),
        baseURI: f.baseURI.trim(),
        supply: plan.supply,
        floor: plan.price!,
        maxPerBid: Number(f.maxPerBid),
        royaltyBps: Math.round(Number(f.royalty) * 100),
        gtd: f.gtdOn ? { list: plan.gtd, price: plan.gtdPrice, durationSecs: f.gtdSecs } : undefined,
        wl: f.wlOn ? { list: plan.wl, boostBps: f.boost * 100 } : undefined,
        biddingSecs: f.biddingSecs,
        image: image || undefined,
        description: f.description.trim() || undefined,
      });
      navigate(`/app/drop/${drop}`);
    } catch (e) {
      setErr(friendly(e));
    } finally {
      setBusy("");
    }
  }

  const auction = plan.supply - plan.gtdSpots;
  return (
    <div>
      <Link to="/app/drops" className="back-btn"><span aria-hidden>←</span>All drops</Link>
      <div className="page-head">
        <div>
          <h1>Create a drop</h1>
          <p>Your price is the floor. GTD wallets mint first; everyone else bids sealed, and every winner pays one price. If demand is higher than your price, you earn the difference instead of flippers.</p>
        </div>
      </div>
      <div className="drop-grid">
        <div className="card">
          <div className="card-head"><h3>Collection</h3></div>
          <div className="field-row">
            <div className="field"><label><span>Name</span></label><input className="input" value={f.name} maxLength={64} onChange={(e) => set("name", e.target.value)} placeholder="Moonfoxes" /></div>
            <div className="field"><label><span>Symbol</span></label><input className="input" value={f.symbol} maxLength={16} onChange={(e) => set("symbol", e.target.value.replace(/\s/g, ""))} placeholder="MOON" /></div>
          </div>
          <label style={{ marginBottom: 14 }} className={`img-drop ${image ? "has" : ""}`} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); pick(e.dataTransfer.files[0]); }}>
            <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
            {image ? <img src={image} alt="Collection image preview" /> : <span className="img-ph">{(f.symbol || "?").slice(0, 2).toUpperCase()}</span>}
            <span className="small"><b>{imgBusy ? "Preparing image…" : image ? "Change the collection image" : "Upload the collection image"}</b><br /><span className="xs mute">Stored on chain, shown on the drop page and on every NFT unless you link your own metadata.</span></span>
          </label>
          <div className="field"><label><span>Description</span><span>optional</span></label><textarea className="input" rows={2} maxLength={1000} value={f.description} onChange={(e) => set("description", e.target.value)} placeholder="What the collection is" /></div>
          <div className="field-row">
            <div className="field"><label><span>Supply</span></label><input className="input" inputMode="numeric" value={f.supply} onChange={(e) => set("supply", e.target.value.replace(/\D/g, ""))} /></div>
            <div className="field"><label><span>Your price (floor)</span><span>HYPE</span></label><input className="input" inputMode="decimal" value={f.price} onChange={(e) => set("price", e.target.value)} /></div>
          </div>
          <div className="field-row">
            <div className="field"><label><span>Max per bid</span></label><select className="input" value={f.maxPerBid} onChange={(e) => set("maxPerBid", e.target.value)}>{[1, 2, 3, 5, 10].map((n) => <option key={n} value={n}>{n}</option>)}</select></div>
            <div className="field"><label><span>Royalty</span><span>%</span></label><select className="input" value={f.royalty} onChange={(e) => set("royalty", e.target.value)}>{[0, 2.5, 5, 7.5, 10].map((n) => <option key={n} value={n}>{n}%</option>)}</select></div>
          </div>
          <div className="field"><label><span>Metadata folder</span><span>optional</span></label><input className="input mono" value={f.baseURI} onChange={(e) => set("baseURI", e.target.value)} placeholder="ipfs://… (token n reads <folder>n)" /></div>

          <div className="card-head" style={{ marginTop: 18 }}><h3>GTD</h3></div>
          <label className="check"><input type="checkbox" checked={f.gtdOn} onChange={(e) => set("gtdOn", e.target.checked)} /> Guaranteed spots for a list of wallets, minted before the auction</label>
          {f.gtdOn && (
            <>
              <div className="field"><label><span>GTD wallets</span><span>{plan.gtd.length} wallets · {plan.gtdSpots} spots</span></label><textarea className="input list-input" value={f.gtdList} onChange={(e) => set("gtdList", e.target.value)} placeholder={"0xabc…, 2\n0xdef…  (1 spot when no number)"} /></div>
              <div className="field-row">
                <div className="field"><label><span>GTD price</span><span>HYPE</span></label><input className="input" inputMode="decimal" value={f.gtdPrice} onChange={(e) => set("gtdPrice", e.target.value)} /></div>
                <div className="field"><label><span>GTD window</span></label><select className="input" value={f.gtdSecs} onChange={(e) => set("gtdSecs", Number(e.target.value))}>{DURATIONS.map(([l, s]) => <option key={s} value={s}>{l}</option>)}</select></div>
              </div>
            </>
          )}

          <div className="card-head" style={{ marginTop: 18 }}><h3>WL</h3></div>
          <label className="check"><input type="checkbox" checked={f.wlOn} onChange={(e) => set("wlOn", e.target.checked)} /> A WL whose bids get a boost</label>
          {f.wlOn && (
            <>
              <div className="field"><label><span>WL wallets</span><span>{plan.wl.length} wallets</span></label><textarea className="input list-input" value={f.wlList} onChange={(e) => set("wlList", e.target.value)} placeholder={"0xabc…\n0xdef…"} /></div>
              <div className="field">
                <label><span>WL bid boost</span><span className="mono">{f.boost}%</span></label>
                <input type="range" min={0} max={30} step={1} value={f.boost} onChange={(e) => set("boost", Number(e.target.value))} style={{ width: "100%" }} />
                <span className="xs mute">A WL bid ranks as if it were {f.boost}% higher, and WL winners pay the clearing price ÷ {(1 + f.boost / 100).toFixed(2)}, never under your price. Shown publicly on the drop page.</span>
              </div>
            </>
          )}

          <div className="card-head" style={{ marginTop: 18 }}><h3>Bidding</h3></div>
          <div className="field"><label><span>Sealed bidding window</span><span>opens when GTD closes</span></label><select className="input" value={f.biddingSecs} onChange={(e) => set("biddingSecs", Number(e.target.value))}>{DURATIONS.map(([l, s]) => <option key={s} value={s}>{l}</option>)}</select></div>
        </div>

        <div className="card">
          <div className="card-head"><h3>Summary</h3></div>
          <div className="summary">
            <div className="row"><span className="mute">NFTs</span><span className="mono">{Number.isFinite(plan.supply) ? plan.supply.toLocaleString() : "?"}</span></div>
            {f.gtdOn && <div className="row"><span className="mute">GTD spots</span><span className="mono">{plan.gtdSpots} at {hype(plan.gtdPrice)} HYPE</span></div>}
            <div className="row"><span className="mute">In the sealed auction</span><span className="mono">{auction >= 0 ? auction.toLocaleString() : "?"} or more</span></div>
            <div className="row"><span className="mute">Floor (your price)</span><span className="mono">{plan.price ? hype(plan.price) : "?"} HYPE</span></div>
            {f.wlOn && <div className="row"><span className="mute">WL boost</span><span className="mono">{pct(f.boost * 100)}</span></div>}
            <div className="row"><span className="mute">Bidding</span><span>{DURATIONS.find(([, s]) => s === f.biddingSecs)?.[0]}{f.gtdOn ? `, after ${DURATIONS.find(([, s]) => s === f.gtdSecs)?.[0]} of GTD` : ""}</span></div>
            <div className="row"><span className="mute">Cloak fee</span><span>1.5% of sales</span></div>
          </div>
          <p className="note">Bids are sealed to a drand round: nobody, Cloak included, can read one before bidding closes. Cloak's keeper opens them, settles, and delivers NFTs and refunds. Unused GTD spots roll into the auction, and anything left unsold is yours to mint.</p>
          <button className="btn btn-ink btn-lg btn-block" style={{ marginTop: 12 }} disabled={!!busy || imgBusy} onClick={create}>{busy || (wallet ? "Create the drop" : "Connect wallet and create")}</button>
          {err && <div className="err">{err}</div>}
          {!err && plan.problem && <p className="xs mute" style={{ marginTop: 8 }}>{plan.problem}</p>}
        </div>
      </div>
    </div>
  );
}
