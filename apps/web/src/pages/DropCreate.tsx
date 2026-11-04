import { useEffect, useMemo, useState } from "react";
import { getAddress, isAddress, parseEther, type Address } from "viem";
import { DROP_LIST_MAX, DROP_MAX_SUPPLY, type GtdEntry } from "@cloakely/sdk";
import { dropsClient, imageSrc, itemPreview, pct, spotsClient, type ItemMeta } from "../drops";
import { friendly, Hint } from "../errors";
import { hype } from "../format";
import { Link, navigate } from "../router";
import { useApp } from "../state";
import { compressBanner, compressImage } from "../tokenMeta";
import { Icon } from "../ui";
import { EscrowCreate } from "./EscrowCreate";
import { ESCROW_DROP_FACTORY } from "../config";

const WALLET_DAYS = [1, 2, 3, 7, 14];
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
  const { wallet, connect, toast } = useApp();
  const canSpots = !!spotsClient();
  const [spots, setSpots] = useState(() => canSpots && typeof location !== "undefined" && /[?&]spots\b/.test(location.search));
  const [existing, setExisting] = useState(() => !!ESCROW_DROP_FACTORY && typeof location !== "undefined" && /[?&]existing\b/.test(location.search));
  const [partner, setPartner] = useState("");
  const [walletDays, setWalletDays] = useState(3);
  const [f, setF] = useState({ name: "", symbol: "", supply: "1000", price: "0.5", maxPerBid: "2", royalty: "5", baseURI: "", description: "", gtdOn: false, gtdList: "", gtdPrice: "0.4", gtdSecs: 86400, wlOn: false, wlList: "", boost: 20, biddingSecs: 86400 });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const [image, setImage] = useState("");
  const [banner, setBanner] = useState("");
  const [folder, setFolder] = useState<{ items: ItemMeta[]; state: "" | "reading" | "none" }>({ items: [], state: "" });
  const [category, setCategory] = useState("");
  const [links, setLinks] = useState({ website: "", x: "", discord: "", telegram: "" });
  const [imgBusy, setImgBusy] = useState(false);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => { document.title = existing ? "Cloak · Auction your NFTs" : spots ? "Cloak · Sell WL spots" : "Cloak · Create a drop"; }, [spots, existing]);
  // opened straight in WL spots mode (/app/drops/create?spots): start from the spot defaults too
  useEffect(() => { if (spots) mode(true); }, []);
  /** Switch between selling NFTs and selling a partner's WL spots, with defaults that fit each. */
  function mode(on: boolean) {
    setExisting(false);
    setSpots(on);
    setF((x) => (on ? { ...x, supply: x.supply === "1000" ? "5" : x.supply, maxPerBid: "1", gtdOn: false, royalty: "0", baseURI: "" } : { ...x, supply: x.supply === "5" ? "1000" : x.supply, maxPerBid: "2", royalty: "5" }));
  }

  // read the first items of a metadata folder as it's typed, to show they load (and use the first image as the cover)
  useEffect(() => {
    const uri = f.baseURI.trim();
    if (!/^(ipfs|ar|https):\/\/\S+$/.test(uri)) return setFolder({ items: [], state: "" });
    let live = true;
    setFolder({ items: [], state: "reading" });
    const t = setTimeout(() => itemPreview(uri, 4).then((items) => live && setFolder({ items, state: items.length ? "" : "none" })).catch(() => live && setFolder({ items: [], state: "none" })), 600);
    return () => { live = false; clearTimeout(t); };
  }, [f.baseURI]);
  const folderCover = folder.items.find((m) => m.image)?.image;

  const plan = useMemo(() => {
    const supply = Number(f.supply);
    const price = wei(f.price);
    const gtd = f.gtdOn ? parseList(f.gtdList, true) : { gtd: [], wl: [], bad: [] };
    const wl = f.wlOn ? parseList(f.wlList, false) : { gtd: [], wl: [], bad: [] };
    const gtdSpots = gtd.gtd.reduce((a, e) => a + e.spots, 0);
    const gtdPrice = f.gtdOn ? (f.gtdPrice.trim() === "0" ? 0n : wei(f.gtdPrice)) : 0n;
    let problem = "";
    if (spots && !partner.trim()) problem = "Name the partner collection giving the spots.";
    else if (!f.name.trim()) problem = spots ? "Name the sale, like Moonfoxes WL spots." : "Name the collection.";
    else if (!f.symbol.trim()) problem = "Give it a short symbol, like MOON.";
    else if (spots && (!Number.isInteger(supply) || supply < 1 || supply > 1000)) problem = "Sell 1 to 1,000 spots.";
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
    const badLink = Object.entries(links).find(([, v]) => v.trim() && !/^https:\/\/[^\s"<>]+$/.test(v.trim()));
    if (!problem && badLink) problem = `The ${badLink[0] === "x" ? "X" : badLink[0]} link starts with https://.`;
    if (!problem && banner && !/^(https:\/\/|ipfs:\/\/|data:image\/)/.test(banner)) problem = "The banner link starts with https:// or ipfs://.";
    return { supply, price, gtd: gtd.gtd, wl: wl.wl, gtdSpots, gtdPrice: gtdPrice ?? 0n, problem };
  }, [f, spots, partner, links, banner]);

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

  async function pickBanner(file?: File) {
    if (!file) return;
    setImgBusy(true);
    setErr("");
    try {
      setBanner(await compressBanner(file));
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
      setBusy(spots ? "Confirm 1 of 2 in your wallet…" : "Confirm in your wallet…");
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
        image: image || (folderCover && /^(https|ipfs|ar):\/\//.test(folderCover) ? folderCover : undefined),
        banner: banner || undefined,
        category: category || undefined,
        links: Object.fromEntries(Object.entries(links).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v)),
        description: f.description.trim() || undefined,
        spots: spots ? { partner: partner.trim() } : undefined,
      });
      if (spots) {
        // the drop exists now; mark it as a spot sale (if this step fails, the drop page offers it again)
        try {
          setBusy("Confirm 2 of 2: mark it as a WL spot sale…");
          const sp = spotsClient(w)!;
          const st = await sp.drops.get(drop);
          await sp.open(drop, partner.trim(), st.revealEnd + walletDays * 86400);
        } catch (e) {
          toast(`The sale was created but not marked as a WL spot sale yet: ${friendly(e)}`);
        }
      }
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
          <h1>{existing ? "Auction your NFTs" : spots ? "Sell WL spots" : "Create a drop"}</h1>
          {existing ? <p>Auction NFTs that already exist, from any Elysium collection. Your tokens go into escrow when you create the auction, bids are sealed, the highest win, and every winner pays one price. Unsold tokens come back to you.</p> : spots ? <p>A partner collection gave you whitelist spots. Sell them in a sealed auction: your price is the floor, the highest bids win, every winner pays one price, and each winner names the wallet to whitelist. You hand the partner the list.</p> : <p>Your price is the floor. GTD wallets mint first; everyone else bids sealed, and every winner pays one price. If demand is higher than your price, you earn the difference instead of flippers.</p>}
        </div>
      </div>
      {(canSpots || ESCROW_DROP_FACTORY) && (
        <div className="tabs create-modes" role="tablist">
          <button role="tab" aria-selected={!spots && !existing} className={`tab ${!spots && !existing ? "on" : ""}`} onClick={() => mode(false)}>Mint a new collection</button>
          {ESCROW_DROP_FACTORY && <button role="tab" aria-selected={existing} className={`tab ${existing ? "on" : ""}`} onClick={() => { setSpots(false); setExisting(true); }}>Auction NFTs you own</button>}
          {canSpots && <button role="tab" aria-selected={spots && !existing} className={`tab ${spots && !existing ? "on" : ""}`} onClick={() => mode(true)}>Sell WL spots</button>}
        </div>
      )}
      {existing ? <EscrowCreate /> : (
      <div className="drop-grid">
        <div className="card">
          {spots && (
            <>
              <div className="card-head"><h3>Partner</h3></div>
              <div className="field"><label><span>Partner collection</span><span>who gave the spots</span></label><input className="input" value={partner} maxLength={200} onChange={(e) => {
                const v = e.target.value;
                const sym = (t: string) => (t.replace(/[^A-Za-z0-9]/g, "").slice(0, 6).toUpperCase() + "WL").slice(0, 16);
                setPartner(v);
                // keep the sale's name and symbol following the partner until the creator edits them
                setF((x) => ({
                  ...x,
                  name: !x.name || x.name === `${partner.trim()} WL spots` ? (v.trim() ? `${v.trim()} WL spots`.slice(0, 64) : "") : x.name,
                  symbol: !x.symbol || x.symbol === sym(partner) ? (v.trim() ? sym(v) : "") : x.symbol,
                }));
              }} placeholder="Moonfoxes" /></div>
              <div className="field"><label><span>Time for winners to name wallets</span><span>after the bids open</span></label><select className="input" value={walletDays} onChange={(e) => setWalletDays(Number(e.target.value))}>{WALLET_DAYS.map((n) => <option key={n} value={n}>{n} day{n > 1 ? "s" : ""}</option>)}</select></div>
            </>
          )}
          <div className="card-head"><h3>{spots ? "Sale" : "Collection"}</h3></div>
          <div className="field-row">
            <div className="field"><label><span>Name</span></label><input className="input" value={f.name} maxLength={64} onChange={(e) => set("name", e.target.value)} placeholder="Moonfoxes" /></div>
            <div className="field"><label><span>Symbol</span></label><input className="input" value={f.symbol} maxLength={16} onChange={(e) => set("symbol", e.target.value.replace(/\s/g, ""))} placeholder="MOON" /></div>
          </div>
          <label style={{ marginBottom: 14 }} className={`img-drop ${image ? "has" : ""}`} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); pick(e.dataTransfer.files[0]); }}>
            <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
            {image ? <img src={image} alt="Collection image preview" /> : <span className="img-ph">{(f.symbol || "?").slice(0, 2).toUpperCase()}</span>}
            <span className="small"><b>{imgBusy ? "Preparing image…" : image ? "Change the image" : spots ? "Upload the partner's image" : "Upload the collection image"}</b><br /><span className="xs mute">{spots ? "Shown on the sale page and on each winner's receipt NFT." : "Stored on chain, shown on the drop page and on every NFT unless you link your own metadata."}</span></span>
          </label>
          <div className="card-head" style={{ marginTop: 6 }}><h3>Drop page</h3></div>
          <label style={{ marginBottom: 14 }} className={`img-drop banner-drop ${banner ? "has" : ""}`} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); pickBanner(e.dataTransfer.files[0]); }}>
            <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => { pickBanner(e.target.files?.[0]); e.target.value = ""; }} />
            {imageSrc(banner) ? <img src={imageSrc(banner)} alt="Banner preview" /> : <span className="img-ph banner-ph" />}
            <span className="small"><b>{banner ? "Change the banner" : "Upload a banner"}</b> <span className="xs mute">optional · wide 3:1, shown across the top of the drop page</span></span>
          </label>
          <div className="field"><label><span>Or link a banner</span><span>https:// or ipfs://</span></label><input className="input mono" value={banner.startsWith("data:") ? "" : banner} onChange={(e) => setBanner(e.target.value.trim())} placeholder={banner.startsWith("data:") ? "uploaded" : "ipfs://… or https://…"} /></div>
          <div className="field"><label><span>Description</span><span>optional</span></label><textarea className="input" rows={2} maxLength={1000} value={f.description} onChange={(e) => set("description", e.target.value)} placeholder={spots ? "What winners get, from the partner" : "What the collection is"} /></div>
          <div className="field-row">
            <div className="field"><label><span>{spots ? "WL spots" : "Supply"}</span></label><input className="input" inputMode="numeric" value={f.supply} onChange={(e) => set("supply", e.target.value.replace(/\D/g, ""))} /></div>
            <div className="field"><label><span>Your price (floor)</span><span>HYPE</span></label><input className="input" inputMode="decimal" value={f.price} onChange={(e) => set("price", e.target.value)} /></div>
          </div>
          <div className="field-row">
            <div className="field"><label><span>{spots ? "Spots per bid" : "Max per bid"}</span></label><select className="input" value={f.maxPerBid} onChange={(e) => set("maxPerBid", e.target.value)}>{[1, 2, 3, 5, 10].map((n) => <option key={n} value={n}>{n}</option>)}</select></div>
            {!spots && <div className="field"><label><span>Royalty</span><span>%</span></label><select className="input" value={f.royalty} onChange={(e) => set("royalty", e.target.value)}>{[0, 2.5, 5, 7.5, 10].map((n) => <option key={n} value={n}>{n}%</option>)}</select></div>}
          </div>
          {!spots && <div className="field"><label><span>Category</span><span>optional</span></label><select className="input" value={category} onChange={(e) => setCategory(e.target.value)}>{["", "Art", "PFP", "Gaming", "Music", "Photography", "Membership", "Utility"].map((c) => <option key={c} value={c}>{c || "None"}</option>)}</select></div>}
          <div className="field-row">
            <div className="field"><label><span>Website</span><span>optional</span></label><input className="input" value={links.website} onChange={(e) => setLinks((l) => ({ ...l, website: e.target.value }))} placeholder="https://…" /></div>
            <div className="field"><label><span>X</span><span>optional</span></label><input className="input" value={links.x} onChange={(e) => setLinks((l) => ({ ...l, x: e.target.value }))} placeholder="https://x.com/…" /></div>
          </div>
          <div className="field-row">
            <div className="field"><label><span>Discord</span><span>optional</span></label><input className="input" value={links.discord} onChange={(e) => setLinks((l) => ({ ...l, discord: e.target.value }))} placeholder="https://discord.gg/…" /></div>
            <div className="field"><label><span>Telegram</span><span>optional</span></label><input className="input" value={links.telegram} onChange={(e) => setLinks((l) => ({ ...l, telegram: e.target.value }))} placeholder="https://t.me/…" /></div>
          </div>
          {!spots && <div className="field"><label><span>Metadata folder</span><span>optional</span></label><input className="input mono" value={f.baseURI} onChange={(e) => set("baseURI", e.target.value)} placeholder="ipfs://… (token n reads <folder>n)" /><span className="xs mute">Your own ERC-721 metadata, with each item's image and traits. The drop page previews the first items from it. Leave empty and every NFT shows the collection image.</span>
            {folder.state === "reading" && <span className="xs mute">Reading the first items…</span>}
            {folder.state === "none" && <span className="xs" style={{ color: "var(--seal)" }}>No items could be read from {f.baseURI.trim()}1. Check the folder: token n is read from the folder followed by n.</span>}
            {!!folder.items.length && (
              <div className="folder-peek">
                {folder.items.map((m) => (
                  <div key={m.id} className="folder-item">{imageSrc(m.image) ? <img src={imageSrc(m.image)} alt="" loading="lazy" /> : <span className="drop-art-ph item-ph">#{m.id}</span>}<span className="xs">{m.name || `#${m.id}`}</span></div>
                ))}
                <span className="xs mute">{image ? "Loaded from your folder." : "Loaded from your folder. With no image uploaded, the first one becomes the collection image."}</span>
              </div>
            )}
          </div>}

          {!spots && <>
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
          </>}

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
          <div className="field"><label><span>Sealed bidding window</span><span>{spots ? "opens about a minute after you create" : "opens when GTD closes"}</span></label><select className="input" value={f.biddingSecs} onChange={(e) => set("biddingSecs", Number(e.target.value))}>{DURATIONS.map(([l, s]) => <option key={s} value={s}>{l}</option>)}</select></div>
        </div>

        <div className="card">
          <div className="create-preview">
            <div className={`dcard-cover ${imageSrc(banner) || imageSrc(image) ? "" : "dcard-cover-ph"}`} style={imageSrc(banner) ? { backgroundImage: `url("${imageSrc(banner)}")` } : imageSrc(image) ? ({ ["--img" as string]: `url("${imageSrc(image)}")`, ["--blur" as string]: "1" } as React.CSSProperties) : {}} />
            <div className="dcard-body">
              {image ? <img className="drop-art dcard-avatar" src={image} alt="" width={52} height={52} style={{ width: 52, height: 52 }} /> : <span className="drop-art drop-art-ph dcard-avatar" style={{ width: 52, height: 52, fontSize: 17 }}>{(f.symbol || f.name || "?").slice(0, 2).toUpperCase()}</span>}
              <div className="dcard-title"><b>{f.name.trim() || (spots ? "Your WL spot sale" : "Your collection")}</b><span className="xs mute">{category || "Elysium"} · {Number(f.supply || 0).toLocaleString()} {spots ? "spots" : "items"}</span></div>
            </div>
          </div>
          <div className="card-head"><h3>Summary</h3></div>
          <div className="summary">
            {spots && <div className="row"><span className="mute">Partner</span><span style={{ overflowWrap: "anywhere" }}>{partner.trim() || "?"}</span></div>}
            <div className="row"><span className="mute">{spots ? "WL spots" : "NFTs"}</span><span className="mono">{Number.isFinite(plan.supply) ? plan.supply.toLocaleString() : "?"}</span></div>
            {f.gtdOn && <div className="row"><span className="mute">GTD spots</span><span className="mono">{plan.gtdSpots} at {hype(plan.gtdPrice)} HYPE</span></div>}
            <div className="row"><span className="mute">In the sealed auction</span><span className="mono">{auction >= 0 ? auction.toLocaleString() : "?"}{f.gtdOn ? " or more" : ""}</span></div>
            <div className="row"><span className="mute">Floor (your price)</span><span className="mono">{plan.price ? hype(plan.price) : "?"} HYPE</span></div>
            {f.wlOn && <div className="row"><span className="mute">WL boost</span><span className="mono">{pct(f.boost * 100)}</span></div>}
            <div className="row"><span className="mute">Bidding</span><span>{DURATIONS.find(([, s]) => s === f.biddingSecs)?.[0]}{f.gtdOn ? `, after ${DURATIONS.find(([, s]) => s === f.gtdSecs)?.[0]} of GTD` : ""}</span></div>
            {spots && <div className="row"><span className="mute">Winners name wallets</span><span>for {walletDays} day{walletDays > 1 ? "s" : ""}</span></div>}
            <div className="row"><span className="mute">Cloak fee</span><span>1.5% of sales</span></div>
          </div>
          {spots ? <p className="note">Bids are sealed to a drand round: nobody, Cloak included, can read one before bidding closes. Once the bids open, each winner names the Elysium wallet to whitelist, one per spot, and gets a receipt NFT. The sale page shows the list as it fills, with a CSV for the partner. Creating a sale takes two confirmations.</p> : <p className="note">Bids are sealed to a drand round: nobody, Cloak included, can read one before bidding closes. Cloak's keeper opens them, settles, and delivers NFTs and refunds. Unused GTD spots roll into the auction, and anything left unsold is yours to mint.</p>}
          <button className="btn btn-ink btn-lg btn-block" style={{ marginTop: 12 }} disabled={!!busy || imgBusy} onClick={create}>{busy || (wallet ? (spots ? "Create the WL spot sale" : "Create the drop") : "Connect wallet and create")}</button>
          {err && <div className="err">{err}</div>}
          {!err && plan.problem && <p className="xs mute" style={{ marginTop: 8 }}>{plan.problem}</p>}
        </div>
      </div>
      )}
    </div>
  );
}
