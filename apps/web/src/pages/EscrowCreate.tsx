import { useEffect, useMemo, useState } from "react";
import { getAddress, isAddress, parseEther, type Address } from "viem";
import { DROP_LIST_MAX, ESCROW_MAX_TOKENS } from "@cloakely/sdk";
import { collectionInfo, dropsClient, imageSrc, pct, tokenMetas, type ItemMeta } from "../drops";
import { friendly, Hint } from "../errors";
import { hype, short } from "../format";
import { navigate } from "../router";
import { useApp } from "../state";
import { compressBanner } from "../tokenMeta";

const DURATIONS: [string, number][] = [["10 minutes", 600], ["1 hour", 3600], ["6 hours", 21600], ["24 hours", 86400], ["3 days", 259200]];

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

/** Token ids from text: "1, 2, 5-9" style. */
function parseIds(text: string): { ids: bigint[]; bad: string[] } {
  const ids = new Set<bigint>();
  const bad: string[] = [];
  for (const part of text.split(/[\s,;]+/).filter(Boolean)) {
    const r = /^(\d+)-(\d+)$/.exec(part);
    if (r) {
      const [a, b] = [BigInt(r[1]), BigInt(r[2])];
      if (b < a || b - a > BigInt(ESCROW_MAX_TOKENS)) bad.push(part);
      else for (let i = a; i <= b; i++) ids.add(i);
    } else if (/^\d+$/.test(part)) ids.add(BigInt(part));
    else bad.push(part);
  }
  return { ids: [...ids].sort((x, y) => (x < y ? -1 : 1)), bad };
}

/** Auction NFTs you already own: pick the tokens, set the floor, they move into the auction when you create it. */
export function EscrowCreate() {
  const { wallet, connect, toast } = useApp();
  const [collection, setCollection] = useState("");
  const [info, setInfo] = useState<{ name: string; symbol: string } | null | undefined>(undefined);
  const [owned, setOwned] = useState<ItemMeta[] | null>(null);
  const [loading, setLoading] = useState("");
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [idsText, setIdsText] = useState("");
  const [f, setF] = useState({ name: "", symbol: "", price: "1", maxPerBid: "1", description: "", wlOn: false, wlList: "", boost: 20, biddingSecs: 86400 });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const [banner, setBanner] = useState("");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const addr = isAddress(collection.trim()) ? (getAddress(collection.trim()) as Address) : null;

  // read the collection as soon as a full address is in
  useEffect(() => {
    setInfo(undefined);
    setOwned(null);
    setPicked(new Set());
    if (!addr) return;
    let live = true;
    collectionInfo(addr).then((i) => {
      if (!live) return;
      setInfo(i);
      if (i) setF((x) => ({ ...x, name: x.name || `${i.name} auction`.slice(0, 64), symbol: x.symbol || `${(i.symbol || "NFT").replace(/[^A-Za-z0-9]/g, "").slice(0, 12)}A`.slice(0, 16) }));
    });
    return () => void (live = false);
  }, [addr]);

  async function loadMine() {
    setErr("");
    try {
      if (!addr) throw new Hint("Enter the collection's contract address first.");
      const w = wallet ?? (await connect());
      if (!w) return;
      setLoading("Finding your tokens in this collection…");
      const ids = await dropsClient().ownedTokens(addr, w.account.address);
      if (!ids.length) throw new Hint("This wallet holds no tokens from this collection. Paste token ids instead if you hold them elsewhere.");
      setLoading(`Reading ${Math.min(ids.length, 60)} token${ids.length > 1 ? "s" : ""}…`);
      const metas = await tokenMetas(addr, ids, 60);
      setOwned(metas);
      setPicked(new Set(metas.map((m) => m.id)));
      if (ids.length > 60) toast(`Showing the first 60 of ${ids.length}. Paste more ids below.`);
    } catch (e) {
      setErr(friendly(e));
    } finally {
      setLoading("");
    }
  }

  const typed = useMemo(() => parseIds(idsText), [idsText]);
  const tokenIds = useMemo(() => [...new Set([...[...picked].map(BigInt), ...typed.ids])].sort((a, b) => (a < b ? -1 : 1)), [picked, typed]);
  const wl = useMemo(() => {
    if (!f.wlOn) return { list: [] as Address[], bad: [] as string[] };
    const list = new Map<string, Address>();
    const bad: string[] = [];
    for (const a of f.wlList.split(/[\s,;]+/).filter(Boolean)) (isAddress(a) ? list.set(a.toLowerCase(), getAddress(a)) : bad.push(a));
    return { list: [...list.values()], bad };
  }, [f.wlOn, f.wlList]);
  const price = wei(f.price);
  const cover = owned?.find((m) => picked.has(m.id) && imageSrc(m.image))?.image;
  const problem = !addr
    ? "Enter the collection's contract address."
    : info === null
      ? "That address isn't an NFT collection (ERC-721)."
      : !tokenIds.length
        ? "Pick the tokens to auction, or paste their ids."
        : tokenIds.length > ESCROW_MAX_TOKENS
          ? `One auction takes up to ${ESCROW_MAX_TOKENS} tokens.`
          : typed.bad.length
            ? `This isn't a token id: ${typed.bad[0].slice(0, 30)}`
            : !f.name.trim()
              ? "Name the auction."
              : !f.symbol.trim()
                ? "Give it a short symbol."
                : !price
                  ? "Set your price in HYPE, above zero."
                  : wl.bad.length
                    ? `This isn't a wallet address: ${wl.bad[0].slice(0, 60)}`
                    : f.wlOn && !wl.list.length
                      ? "Paste the WL wallets, or turn the WL off."
                      : wl.list.length > DROP_LIST_MAX
                        ? `A list holds up to ${DROP_LIST_MAX.toLocaleString()} wallets.`
                        : "";

  async function create() {
    setErr("");
    try {
      if (problem) throw new Hint(problem);
      const w = wallet ?? (await connect());
      if (!w) return;
      setBusy("Confirm in your wallet: approve the auction factory for this collection, then create…");
      const { drop } = await dropsClient(w).createEscrow({
        collection: addr!,
        tokenIds,
        name: f.name.trim(),
        symbol: f.symbol.trim().toUpperCase(),
        floor: price!,
        maxPerBid: Number(f.maxPerBid),
        biddingSecs: f.biddingSecs,
        wl: f.wlOn ? { list: wl.list, boostBps: f.boost * 100 } : undefined,
        image: cover && /^(https|ipfs):\/\//.test(cover) ? cover : undefined,
        banner: banner || undefined,
        description: f.description.trim() || undefined,
      });
      navigate(`/app/drop/${drop}`);
    } catch (e) {
      setErr(friendly(e));
    } finally {
      setBusy("");
    }
  }

  const toggle = (id: number) => setPicked((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  return (
    <div className="drop-grid">
      <div className="card">
        <div className="card-head"><h3>Collection</h3></div>
        <div className="field"><label><span>Collection contract</span><span>an ERC-721 on Elysium</span></label><input className="input mono" value={collection} onChange={(e) => setCollection(e.target.value.trim())} placeholder="0x…" /></div>
        {addr && info === undefined && <p className="xs mute">Reading the collection…</p>}
        {info === null && <p className="xs" style={{ color: "var(--danger)" }}>That address isn't an NFT collection (ERC-721).</p>}
        {info && (
          <div className="escrow-col">
            <b>{info.name}</b> <span className="mute small">{info.symbol}</span>
            <button className="btn btn-ghost btn-sm" disabled={!!loading} onClick={loadMine}>{loading || (owned ? "Reload my tokens" : wallet ? "Load my tokens" : "Connect and load my tokens")}</button>
          </div>
        )}
        {owned && (
          <>
            <div className="escrow-pick-head"><span className="small">{picked.size} of {owned.length} picked</span><span><button className="link small" onClick={() => setPicked(new Set(owned.map((m) => m.id)))}>All</button> · <button className="link small" onClick={() => setPicked(new Set())}>None</button></span></div>
            <div className="escrow-pick">
              {owned.map((m) => (
                <button key={m.id} type="button" className={`escrow-tok ${picked.has(m.id) ? "on" : ""}`} onClick={() => toggle(m.id)} aria-pressed={picked.has(m.id)}>
                  {imageSrc(m.image) ? <img src={imageSrc(m.image)} alt="" loading="lazy" /> : <span className="drop-art-ph item-ph">#{m.id}</span>}
                  <span className="xs">{m.name || `#${m.id}`}</span>
                </button>
              ))}
            </div>
          </>
        )}
        <div className="field" style={{ marginTop: 12 }}><label><span>{owned ? "More token ids" : "Token ids"}</span><span>like 12, 15, 30-34</span></label><input className="input mono" value={idsText} onChange={(e) => setIdsText(e.target.value)} placeholder="1, 2, 7-9" /></div>

        <div className="card-head" style={{ marginTop: 18 }}><h3>Auction</h3></div>
        <div className="field-row">
          <div className="field"><label><span>Name</span></label><input className="input" value={f.name} maxLength={64} onChange={(e) => set("name", e.target.value)} placeholder="Elympus treasury auction" /></div>
          <div className="field"><label><span>Symbol</span></label><input className="input" value={f.symbol} maxLength={16} onChange={(e) => set("symbol", e.target.value.replace(/\s/g, ""))} placeholder="ELYMA" /></div>
        </div>
        <div className="field"><label><span>Description</span><span>optional</span></label><textarea className="input" rows={2} maxLength={1000} value={f.description} onChange={(e) => set("description", e.target.value)} placeholder="What's on offer, and why" /></div>
        <label style={{ marginBottom: 14 }} className={`img-drop banner-drop ${banner ? "has" : ""}`}>
          <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={async (e) => { const file = e.target.files?.[0]; e.target.value = ""; if (!file) return; try { setBanner(await compressBanner(file)); } catch (x) { setErr(friendly(x)); } }} />
          {imageSrc(banner) ? <img src={imageSrc(banner)} alt="Banner preview" /> : <span className="img-ph banner-ph" />}
          <span className="small"><b>{banner ? "Change the banner" : "Upload a banner"}</b> <span className="xs mute">optional · the page also shows the tokens' own art</span></span>
        </label>
        <div className="field-row">
          <div className="field"><label><span>Your price (floor)</span><span>HYPE per token</span></label><input className="input" inputMode="decimal" value={f.price} onChange={(e) => set("price", e.target.value)} /></div>
          <div className="field"><label><span>Max per bid</span></label><select className="input" value={f.maxPerBid} onChange={(e) => set("maxPerBid", e.target.value)}>{[1, 2, 3, 5, 10].map((n) => <option key={n} value={n}>{n}</option>)}</select></div>
        </div>
        <label className="check"><input type="checkbox" checked={f.wlOn} onChange={(e) => set("wlOn", e.target.checked)} /> A WL whose bids get a boost (holders, say)</label>
        {f.wlOn && (
          <>
            <div className="field"><label><span>WL wallets</span><span>{wl.list.length} wallets</span></label><textarea className="input list-input" value={f.wlList} onChange={(e) => set("wlList", e.target.value)} placeholder={"0xabc…\n0xdef…"} /></div>
            <div className="field"><label><span>WL bid boost</span><span className="mono">{f.boost}%</span></label><input type="range" min={0} max={30} value={f.boost} onChange={(e) => set("boost", Number(e.target.value))} style={{ width: "100%" }} /></div>
          </>
        )}
        <div className="field"><label><span>Sealed bidding window</span><span>opens about a minute after you create</span></label><select className="input" value={f.biddingSecs} onChange={(e) => set("biddingSecs", Number(e.target.value))}>{DURATIONS.map(([l, s]) => <option key={s} value={s}>{l}</option>)}</select></div>
      </div>

      <div className="card">
        <div className="create-preview">
          <div className={`dcard-cover ${imageSrc(banner) || imageSrc(cover) ? "" : "dcard-cover-ph"}`} style={imageSrc(banner) ? { backgroundImage: `url("${imageSrc(banner)}")` } : imageSrc(cover) ? ({ ["--img" as string]: `url("${imageSrc(cover)}")`, ["--blur" as string]: "1" } as React.CSSProperties) : {}} />
          <div className="dcard-body">
            {imageSrc(cover) ? <img className="drop-art dcard-avatar" src={imageSrc(cover)} alt="" width={52} height={52} style={{ width: 52, height: 52 }} /> : <span className="drop-art drop-art-ph dcard-avatar" style={{ width: 52, height: 52, fontSize: 17 }}>{(f.symbol || "?").slice(0, 2).toUpperCase()}</span>}
            <div className="dcard-title"><b>{f.name.trim() || "Your auction"}</b><span className="xs mute">{info?.name ?? "Existing NFTs"} · {tokenIds.length} token{tokenIds.length === 1 ? "" : "s"}</span></div>
          </div>
        </div>
        <div className="card-head"><h3>Summary</h3></div>
        <div className="summary">
          <div className="row"><span className="mute">Collection</span><span className="mono">{addr ? short(addr) : "?"}</span></div>
          <div className="row"><span className="mute">Tokens in the auction</span><span className="mono">{tokenIds.length}</span></div>
          <div className="row"><span className="mute">Floor (your price)</span><span className="mono">{price ? hype(price) : "?"} HYPE</span></div>
          {f.wlOn && <div className="row"><span className="mute">WL boost</span><span className="mono">{pct(f.boost * 100)}</span></div>}
          <div className="row"><span className="mute">Bidding</span><span>{DURATIONS.find(([, s]) => s === f.biddingSecs)?.[0]}</span></div>
          <div className="row"><span className="mute">Cloak fee</span><span>1.5% of sales</span></div>
        </div>
        <p className="note">Your tokens move into the auction contract when you create it, so bidders can check on chain that every one is there. Bids are sealed until bidding closes, the highest win, and every winner pays one price. Which winner gets which token is drawn at random once the bids open. Anything unsold comes back to you, and so does everything if nobody bids. The collection's own royalties still apply on resale. Creating takes up to two confirmations: approving the auction factory for this collection, then the auction.</p>
        <button className="btn btn-ink btn-lg btn-block" style={{ marginTop: 12 }} disabled={!!busy || !!loading} onClick={create}>{busy || (wallet ? `List ${tokenIds.length || ""} token${tokenIds.length === 1 ? "" : "s"} for auction` : "Connect wallet and create")}</button>
        {err && <div className="err">{err}</div>}
        {!err && problem && <p className="xs mute" style={{ marginTop: 8 }}>{problem}</p>}
      </div>
    </div>
  );
}
