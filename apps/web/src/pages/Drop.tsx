import { useEffect, useRef, useState } from "react";
import { every } from "../every";
import { PageSkel } from "../skel";
import { getAddress, isAddress, parseEther, type Address, type Hex } from "viem";
import { CloakDrops, CloakSpots, drandRoundTime, spotKind, type DropBid, type DropDetails, type DropState, type SpotSale, type SpotWinner } from "@cloakely/sdk";
import { addrLink, txLink } from "../config";
import { collectionInfo, dropsClient, imageSrc, itemPreview, pct, spotsClient, tokenMetas, type ItemMeta } from "../drops";
import { checked, friendly, Hint } from "../errors";
import { duration, hype, short } from "../format";
import { Link } from "../router";
import { useApp } from "../state";
import { Icon } from "../ui";
import { coverStyle, DropArt, Verified, phaseBadge, phaseText, soldShare } from "./Drops";
import { Who } from "../who";

/**
 * The wallet a bidder wants on a spot sale's list, when it isn't the one they bid from (say they bid from a fresh
 * wallet funded from their private balance). Kept only in this browser: putting it on chain at bid time would link
 * the two wallets for everyone, losers included. Once the bid wins, the page fills it in and the winner confirms it.
 */
const listKey = (drop: string, bid: bigint) => `cloak.listWallet.${drop.toLowerCase()}.${bid}`;
function savedListWallet(drop: string, bid: bigint): Address | null {
  try {
    const v = localStorage.getItem(listKey(drop, bid));
    return v && isAddress(v) ? getAddress(v) : null;
  } catch {
    return null;
  }
}
function saveListWallet(drop: string, bid: bigint, wallet: Address) {
  try {
    localStorage.setItem(listKey(drop, bid), wallet);
  } catch {
    /* private window or blocked storage: the winner can still name it after the sale */
  }
}
const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

type Me = { wl: boolean; gtdSpots: number; gtdMinted: number };
type Tab = "mint" | "items" | "details";
const LINK_LABEL = { website: "Website", x: "X", discord: "Discord", telegram: "Telegram" } as const;
const when = (t: number) => new Date(t * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** One sealed NFT drop: GTD minting, sealed bidding, then results, claims and refunds. */
/** Copy the drop's link, or post it on X. Shared links show a card with the collection's art, status and price. */
function ShareDrop({ s }: { s: DropState }) {
  const { toast } = useApp();
  const url = `${location.origin}/app/drop/${s.address}`;
  const name = s.name || s.symbol;
  const text =
    s.phase === "gtd" || s.phase === "bidding"
      ? `${name} is dropping on Cloak. Sealed bids nobody can see until bidding closes, and every winner pays one price`
      : s.settled && !s.failed
        ? `${name} sold through a sealed-bid auction on Cloak`
        : `${name} on Cloak`;
  return (
    <>
      <button className="btn btn-ghost btn-sm" onClick={() => { navigator.clipboard?.writeText(url).catch(() => {}); toast("Drop link copied"); }}><Icon.copy size={14} />Copy link</button>
      <a className="btn btn-ghost btn-sm" href={`https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`} target="_blank" rel="noreferrer">Share on X</a>
    </>
  );
}

export function Drop({ drop }: { drop: Address }) {
  const { wallet, connect, toast } = useApp();
  const [s, setS] = useState<DropState | null>(null);
  const [details, setDetails] = useState<DropDetails>({});
  const [me, setMe] = useState<Me | null>(null);
  const [mine, setMine] = useState<DropBid[]>([]);
  const [now, setNow] = useState(Date.now() / 1000);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const going = useRef(false);
  const [price, setPrice] = useState("");
  const [listWallet, setListWallet] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [qty, setQty] = useState(1);
  const [gtdQty, setGtdQty] = useState(1);
  const [to, setTo] = useState("");
  const [tx, setTx] = useState<{ hash: Hex; what: string } | null>(null);
  const [sale, setSale] = useState<SpotSale | null>(null);
  const [winnersRaw, setWinners] = useState<SpotWinner[] | null>(null);
  const winners = winnersRaw ?? [];
  const [named, setNamed] = useState<Record<string, string[]>>({});
  const [held, setHeld] = useState(0n);
  const [stale, setStale] = useState(false);
  /** The error from a failed load, so a later good refresh can clear it (an action's error stays until the next action). */
  const loadErr = useRef("");
  const [tab, setTab] = useState<Tab>("mint");
  const [items, setItems] = useState<ItemMeta[]>([]);
  const [colName, setColName] = useState("");
  const [wonIds, setWonIds] = useState<Record<string, bigint[]>>({});
  // a preview of the first items, when the collection brings its own metadata folder
  useEffect(() => {
    let live = true;
    if (s?.escrow) {
      tokenMetas(s.escrow.collection, s.escrow.tokenIds, 60).then((x) => live && setItems(x)).catch(() => {});
      collectionInfo(s.escrow.collection).then((x) => live && setColName(x?.name ?? "")).catch(() => {});
    } else if (s?.baseURI) itemPreview(s.baseURI, Math.min(24, s.supply)).then((x) => live && setItems(x)).catch(() => {});
    return () => void (live = false);
  }, [s?.baseURI, s?.escrow?.collection]);
  // which tokens each of my winning bids got (escrow auctions, once settled)
  useEffect(() => {
    if (!s?.escrow || s.phase !== "settled" || !mine.some((b) => b.nfts > 0)) return;
    let live = true;
    Promise.all(mine.filter((b) => b.nfts > 0).map(async (b) => [String(b.id), await dropsClient().tokensOf(drop, b.id)] as const))
      .then((x) => live && setWonIds(Object.fromEntries(x)))
      .catch(() => {});
    return () => void (live = false);
  }, [s?.phase, s?.escrow?.collection, mine.length]);

  async function load() {
    const c = dropsClient();
    const sp = spotsClient();
    const [st, det, sl] = await Promise.all([c.get(drop), c.details(drop).catch(() => ({}) as DropDetails), sp ? sp.sale(drop).catch(() => null) : null]);
    setS(st);
    setDetails(det);
    setSale(sl);
    if (sp && sl && st.phase === "settled" && !st.failed) setWinners(await sp.winners(drop));
    document.title = `Cloak · ${st.name}`;
    if (wallet) {
      const [l, b] = await Promise.all([c.listed(drop, wallet.account.address), c.bids(drop, wallet.account.address)]);
      setMe(l);
      setMine(b);
      setHeld(st.settled ? await c.refundOwed(drop, wallet.account.address).catch(() => 0n) : 0n);
    } else {
      setMe(null);
      setMine([]);
    }
  }
  useEffect(() => {
    load().catch((e) => {
      loadErr.current = friendly(e);
      setErr(loadErr.current);
    });
    const t = setInterval(() => setNow(Date.now() / 1000), 1000);
    // one refresh at a time: a slow one from a network outage must not land after a newer one and undo it
    let inFlight = false;
    const r = every(() => {
      if (inFlight) return;
      inFlight = true;
      // a hung request (a network switch, a stalled connection) must never block the refreshes after it
      Promise.race([load(), new Promise((_, no) => setTimeout(() => no(new Error("refresh timed out")), 30000))])
        .then(
          () => {
            setStale(false);
            if (loadErr.current) {
              const was = loadErr.current;
              loadErr.current = "";
              setErr((x) => (x === was ? "" : x));
            }
          },
          (e) => { console.warn("drop refresh failed", e); setStale(true); },
        )
        .finally(() => (inFlight = false));
    }, 15000);
    return () => (clearInterval(t), r());
  }, [drop, wallet]);
  useEffect(() => { if (s && !price) setPrice(hype(s.floor, 6).replace(/,/g, "")); }, [s]);

  async function run(what: string, f: () => Promise<Hex | void>) {
    if (going.current) return;
    setErr("");
    setTx(null);
    try {
      going.current = true;
      setBusy("Confirm in your wallet…");
      const h = await f();
      if (h) setTx({ hash: h, what });
      toast(what);
      await load();
    } catch (e) {
      setErr(friendly(e));
    } finally {
      going.current = false;
      setBusy("");
    }
  }
  /** The first click on a signed-out page only connects, so the person sees their status and the form before money moves. */
  const act = (what: string, f: (w: NonNullable<typeof wallet>) => Promise<Hex | void>) => () => {
    if (!wallet) return void connect().catch((e) => setErr(friendly(e)));
    return run(what, () => f(wallet));
  };

  if (!s) return <div>{err ? <div className="err">{err}</div> : <PageSkel label="Loading the drop" />}</div>;
  const p = phaseText(s, now);
  const isCreator = !!wallet && wallet.account.address.toLowerCase() === s.creator.toLowerCase();
  const myWon = mine.reduce((a, b) => a + b.nfts, 0);
  const priceWei = (() => { try { return parseEther(price.trim() || "0"); } catch { return 0n; } })();
  const tick = priceWei >= s.floor ? CloakDrops.tickFor(s, priceWei) : 0;
  const level = CloakDrops.priceAt(s, tick);
  const wlBid = !!me?.wl;
  const ranks = wlBid ? (level * BigInt(10_000 + s.wlBoostBps)) / 10_000n : level;
  const gtdLeft = me ? me.gtdSpots - me.gtdMinted : 0;
  const left = s.supply - s.gtdMinted - (s.failed ? 0 : s.sold) - (s.escrow?.returned ?? 0);
  const esc = s.escrow;
  const sk = spotKind(details);
  const reqs = details.requirements;
  const myWins = sale ? mine.filter((b) => b.nfts > 0) : [];
  const walletsOpen = !!sale && now < sale.deadline;
  const totalSpots = winners.reduce((a, w) => a + w.spots, 0);
  const listRows = CloakSpots.rows(winners);
  const namedSpots = listRows.filter((r) => r.wallet).length;
  /** The wallets typed for a bid, falling back to what it has already named. */
  const onChain = (b: DropBid) => winners.find((w) => w.bidId === b.id)?.wallets ?? [];
  /** A wallet chosen in this browser at bid time and not yet put on the list. */
  const pendingChoice = (b: DropBid) => { const c = savedListWallet(drop, b.id); return c && !onChain(b).some((a) => a.toLowerCase() === c.toLowerCase()) && !onChain(b).length ? c : null; };
  const typed = (b: DropBid) => named[String(b.id)] ?? Array.from({ length: b.nfts }, (_, i) => onChain(b)[i] ?? (i === 0 ? pendingChoice(b) ?? "" : ""));
  const unit = sale ? "spot" : "NFT";
  function downloadCsv() {
    const url = URL.createObjectURL(new Blob([CloakSpots.csv(winners, details.fields)], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(sale?.partner || s!.name).replace(/[^A-Za-z0-9]+/g, "-").toLowerCase()}-${sk.toLowerCase()}-list.csv`;
    // attached to the page: some browsers (Safari, Firefox) ignore a click on a detached link
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const b = phaseBadge(s, now);
  const sold = s.settled && !s.failed;
  // an auction of existing NFTs shows its tokens' own art when no collection image was published
  const art: DropDetails = details.image || !esc ? details : { ...details, image: items.find((m) => m.image)?.image };
  const one = esc && s.supply === 1 ? items[0] : undefined; // a single-token auction: that token is the star
  const kind = sale ? "sale" : esc ? "auction" : "drop";
  const hasPicture = !!(imageSrc(art.banner) || imageSrc(art.image));
  const opening = s.phase === "reveal" || s.phase === "settle" || s.phase === "numbering";
  const stages: { name: string; when: string; state: "done" | "live" | "next" }[] = [
    ...(s.hasGtd ? [{ name: "GTD mint", when: `${hype(s.gtdPrice)} HYPE · ends ${when(s.gtdEnd)}`, state: (s.phase === "gtd" ? "live" : "done") as "live" | "done" }] : []),
    { name: "Sealed bidding", when: `from ${hype(s.floor)} HYPE · closes ${when(s.commitEnd)}`, state: s.phase === "gtd" ? "next" : s.phase === "bidding" ? "live" : "done" },
    { name: "Bids open", when: `drand round ${s.tlockRound} · by ${when(s.revealEnd)} at the latest`, state: opening ? "live" : s.phase === "settled" ? "done" : "next" },
    { name: sale ? "Winners can change wallets" : "Results and delivery", when: sale ? `until ${when(sale.deadline)}` : "one price for every winner, refunds for the rest", state: s.phase === "settled" ? (sale && now < sale.deadline ? "live" : "done") : "next" },
  ];
  // the bar shows sales once settled, else how far through the current window we are
  const winStart = s.phase === "gtd" ? s.gtdEnd - Math.max(600, s.commitEnd - s.gtdEnd) : s.phase === "bidding" ? (s.hasGtd ? s.gtdEnd : s.commitEnd - Math.max(600, s.commitEnd - s.gtdEnd)) : 0;
  const winEnd = s.phase === "gtd" ? s.gtdEnd : s.phase === "bidding" ? s.commitEnd : 0;
  const timeShare = winEnd > winStart ? Math.min(1, Math.max(0, (now - winStart) / (winEnd - winStart))) : opening ? s.reveals / Math.max(1, s.bids) : 1;

  return (
    <div className="dp">
      <Link to="/app/drops" className="back-btn"><span aria-hidden>←</span>All drops</Link>
      {stale && <p className="xs mute" style={{ marginBottom: 8 }}>Couldn't reach the network to refresh. Showing the last update, retrying…</p>}
      <div className={`dp-banner ${hasPicture ? "" : "dcard-cover-ph"}`} style={coverStyle(art)} />
      <div className="dp-id">
        <DropArt details={art} name={s.name} size={128} className="dp-avatar" />
        <div className="dp-name">
          <div className="dp-pills">
            <span className={`pill ${p.live ? "ok" : ""}`}>{p.live && <span className="dot live" />}{p.text}</span>
            {sale && <span className="pill">{sk} spots · {sale.partner}</span>}
            {details.category && <span className="pill">{details.category}</span>}
            {esc && <span className={`pill ${esc.held === s.supply || s.settled ? "ok" : "warn"}`} title="Checked on chain: the tokens this auction holds">{s.settled ? `NFT auction · ${s.supply - esc.held} of ${s.supply} out of escrow` : `NFT auction · ${esc.held} of ${s.supply} in escrow`}</span>}
          </div>
          <h1>{s.name} <Verified drop={s.address} creator={s.creator} size={26} /> <span className="mute">{s.symbol}</span></h1>
          {one?.name && <p className="small">{one.name}{colName ? ` from ${colName}` : ""}, token #{String(esc!.tokenIds[0])}</p>}
          <p className="small mute">by {addrLink(s.creator) ? <a className="link" href={addrLink(s.creator)} target="_blank" rel="noreferrer"><Who address={s.creator} /></a> : <Who address={s.creator} />} · {s.supply.toLocaleString()} {sale ? `spot${s.supply > 1 ? "s" : ""}` : esc ? `existing token${s.supply > 1 ? "s" : ""}${colName ? ` from ${colName}` : ""}` : "items"} · Elysium{!sale && s.royaltyBps ? ` · ${pct(s.royaltyBps)} royalty` : ""}</p>
        </div>
        <div className="dp-links">
          <ShareDrop s={s} />
          {details.links && (["website", "x", "discord", "telegram"] as const).map((k) => details.links![k] && <a key={k} className="btn btn-ghost btn-sm" href={details.links![k]} target="_blank" rel="noreferrer nofollow">{LINK_LABEL[k]} ↗</a>)}
        </div>
      </div>
      <div className="dp-stats">
        <div><span className="xs mute">Floor</span><b className="mono">{hype(s.floor)} <small>HYPE</small></b></div>
        {sold && <div><span className="xs mute">Sold at</span><b className="mono">{hype(s.publicPrice)} <small>HYPE</small></b></div>}
        <div><span className="xs mute">{sale ? `${sk} spots` : esc ? "Tokens" : "Supply"}</span><b className="mono">{s.supply.toLocaleString()}</b></div>
        <div><span className="xs mute">Sealed bids</span><b className="mono">{s.bids}</b></div>
        {s.hasGtd && <div><span className="xs mute">GTD minted</span><b className="mono">{s.gtdMinted} <small>at {hype(s.gtdPrice)}</small></b></div>}
        {s.hasWl && <div><span className="xs mute">WL bid boost</span><b className="mono">{pct(s.wlBoostBps)}</b></div>}
        <div><span className="xs mute">Per bid</span><b className="mono">up to {s.maxPerBid}</b></div>
      </div>
      {details.description && <p className="dp-desc">{details.description}</p>}

      <div className="tabs details-tabs dp-tabs" role="tablist">
        {(["mint", ...(items.length && !one ? ["items"] : []), "details"] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`tab ${tab === t ? "on" : ""}`} onClick={() => setTab(t)}>{t === "mint" ? (sale || esc ? "Bid" : "Mint") : t === "items" ? "Items" : "Details"}</button>
        ))}
      </div>

      {tab === "items" && (
        <div className="dgrid items">
          {items.map((it) => (
            <div key={it.id} className="item-card">
              {imageSrc(it.image) ? <img src={imageSrc(it.image)} alt="" loading="lazy" /> : <span className="drop-art-ph item-ph">#{it.id}</span>}
              <div className="item-body">
                <b className="small">{it.name || `${s.name} #${it.id}`}</b>
                {!!it.traits.length && <div className="traits">{it.traits.slice(0, 6).map((t, i) => <span key={i} className="trait"><span className="xs mute">{t.trait}</span>{t.value}</span>)}</div>}
              </div>
            </div>
          ))}
          <p className="xs mute" style={{ gridColumn: "1 / -1" }}>{esc ? `The ${items.length === s.supply ? "" : `first ${items.length} of the `}${s.supply.toLocaleString()} tokens in this auction, read from the collection. Which winner gets which is drawn at random once the bids open.` : `The first ${items.length} of ${s.supply.toLocaleString()} items, read from the collection's metadata folder. Winners get items in the order they're minted.`}</p>
        </div>
      )}

      {tab === "details" && (
        <div className="dp-main">
          <div className="card dp-facts">
            <h3 className="dp-h3">Details</h3>
            <div className="summary">
              <div className="row"><span className="mute">Contract</span><a className="link mono" href={addrLink(s.address)} target="_blank" rel="noreferrer">{short(s.address)} ↗</a></div>
              {esc && <div className="row"><span className="mute">Collection</span><a className="link mono" href={addrLink(esc.collection)} target="_blank" rel="noreferrer">{colName ? `${colName} · ` : ""}{short(esc.collection)} ↗</a></div>}
              {esc && <div className="row"><span className="mute">Held in escrow</span><span className="mono">{esc.held} of {s.supply} tokens</span></div>}
              {esc && <div className="row"><span className="mute">Token ids</span><span className="mono" style={{ overflowWrap: "anywhere", textAlign: "right" }}>{esc.tokenIds.slice(0, 40).map((x) => `#${x}`).join(" ")}{esc.tokenIds.length > 40 ? " …" : ""}</span></div>}
              <div className="row"><span className="mute">Token standard</span><span>ERC-721{s.royaltyBps ? " · ERC-2981" : ""}</span></div>
              <div className="row"><span className="mute">Chain</span><span>Elysium</span></div>
              <div className="row"><span className="mute">Creator</span><a className="link" href={addrLink(s.creator)} target="_blank" rel="noreferrer"><Who address={s.creator} /> ↗</a></div>
              {!sale && <div className="row"><span className="mute">Royalty</span><span>{esc ? "the collection's own" : pct(s.royaltyBps)}</span></div>}
              {!esc && <div className="row"><span className="mute">Metadata</span><span className="mono" style={{ overflowWrap: "anywhere", textAlign: "right" }}>{!s.baseURI || s.baseURI.includes("/api/nft/") ? "served by Cloak" : s.baseURI}</span></div>}
              <div className="row"><span className="mute">Bid levels</span><span className="mono">{s.numTicks} · {hype(s.tickSize)} HYPE apart</span></div>
              {s.hasGtd && <div className="row"><span className="mute">GTD list</span><span>{details.gtd?.length ?? "?"} wallets</span></div>}
              {s.hasWl && <div className="row"><span className="mute">WL</span><span>{details.wl?.length ?? "?"} wallets</span></div>}
              <div className="row"><span className="mute">Bids sealed to</span><span className="mono">drand round {s.tlockRound}</span></div>
            </div>
          </div>
          <div className="card">
                <h3 className="dp-h3">How this {kind} works</h3>
                {sale ? (
                <ol className="small" style={{ paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6 }}>
                  <li>{sale.partner} gave {s.supply} {sk} spot{s.supply > 1 ? "s" : ""}. Bid sealed, at {hype(s.floor)} HYPE or more per spot. Nobody sees any bid until bidding closes.</li>
                  {s.hasWl && <li>WL bids rank {pct(s.wlBoostBps)} higher, and WL winners pay {pct(s.wlBoostBps)} less, never under the floor.</li>}
                  <li>The highest bids win, and every winner pays one price: the lowest winning bid. Ties at that price are drawn at random.</li>
                  <li>The wallet you bid with goes on the {sk} list, so winners don't need to do anything. To use another wallet, change it until {new Date(sale.deadline * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}. Everyone else gets their deposit back.</li>
                  {!!reqs?.length && <li>{sale.partner} only honours winners who meet the requirements listed with the bid box, so do them before you bid.</li>}
                  <li>The {sk} list on this page is the list {sale.partner} receives, with a CSV to download.</li>
                </ol>
                ) : (
                <ol className="small" style={{ paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6 }}>
                  {esc && <li>These {s.supply} tokens already exist and sit in this auction's contract. The page checks on chain that it holds every one.</li>}
                  {s.hasGtd && <li>GTD wallets mint their spots at {hype(s.gtdPrice)} HYPE. Unused spots roll into the auction.</li>}
                  <li>Everyone else bids sealed, at {hype(s.floor)} HYPE or more. Nobody sees any bid until bidding closes.</li>
                  {s.hasWl && <li>WL bids rank {pct(s.wlBoostBps)} higher, and WL winners pay {pct(s.wlBoostBps)} less, never under the floor.</li>}
                  <li>The highest bids win, and every winner pays one price: the lowest winning bid. Ties at that price are drawn at random.</li>
                  {esc ? <li>Which winner gets which token is drawn at random once the bids open, so claiming early or late changes nothing. Unsold tokens go back to their owner.</li> : null}
                  <li>Winners get their NFTs, everyone else gets their deposit back, automatically.</li>
                </ol>
                )}

          </div>
        </div>
      )}

      {tab === "mint" && (
        <div className="dp-main">
          <div className="dp-media">
            <div className="dp-art">
              <DropArt details={art} name={s.name} size={560} />
              <span className={`dbadge ${b.tone}`}>{b.tone === "live" && <span className="dot live" />}{b.text}</span>
            </div>
            {one && !!one.traits.length && <div className="traits one-traits">{one.traits.map((t, i) => <span key={i} className="trait"><span className="xs mute">{t.trait}</span>{t.value}</span>)}</div>}
            {!!items.length && !one && (
              <div className="dp-thumbs">
                {items.slice(0, 4).map((it) => imageSrc(it.image) && <img key={it.id} src={imageSrc(it.image)} alt="" loading="lazy" />)}
                <button className="btn btn-ghost btn-sm" onClick={() => setTab("items")}>See the items</button>
              </div>
            )}
            <div className="card dp-how">
                <h3 className="dp-h3">How this {kind} works</h3>
                {sale ? (
                <ol className="small" style={{ paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6 }}>
                  <li>{sale.partner} gave {s.supply} {sk} spot{s.supply > 1 ? "s" : ""}. Bid sealed, at {hype(s.floor)} HYPE or more per spot. Nobody sees any bid until bidding closes.</li>
                  {s.hasWl && <li>WL bids rank {pct(s.wlBoostBps)} higher, and WL winners pay {pct(s.wlBoostBps)} less, never under the floor.</li>}
                  <li>The highest bids win, and every winner pays one price: the lowest winning bid. Ties at that price are drawn at random.</li>
                  <li>The wallet you bid with goes on the {sk} list, so winners don't need to do anything. To use another wallet, change it until {new Date(sale.deadline * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}. Everyone else gets their deposit back.</li>
                  {!!reqs?.length && <li>{sale.partner} only honours winners who meet the requirements listed with the bid box, so do them before you bid.</li>}
                  <li>The {sk} list on this page is the list {sale.partner} receives, with a CSV to download.</li>
                </ol>
                ) : (
                <ol className="small" style={{ paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6 }}>
                  {esc && <li>These {s.supply} tokens already exist and sit in this auction's contract. The page checks on chain that it holds every one.</li>}
                  {s.hasGtd && <li>GTD wallets mint their spots at {hype(s.gtdPrice)} HYPE. Unused spots roll into the auction.</li>}
                  <li>Everyone else bids sealed, at {hype(s.floor)} HYPE or more. Nobody sees any bid until bidding closes.</li>
                  {s.hasWl && <li>WL bids rank {pct(s.wlBoostBps)} higher, and WL winners pay {pct(s.wlBoostBps)} less, never under the floor.</li>}
                  <li>The highest bids win, and every winner pays one price: the lowest winning bid. Ties at that price are drawn at random.</li>
                  {esc ? <li>Which winner gets which token is drawn at random once the bids open, so claiming early or late changes nothing. Unsold tokens go back to their owner.</li> : null}
                  <li>Winners get their NFTs, everyone else gets their deposit back, automatically.</li>
                </ol>
                )}

            </div>
          </div>
          <div className="dp-panel">
            <h2 className="dp-title">{sale ? `Bid on ${sale.partner} ${sk} spots` : one?.name ? `Bid on ${one.name}` : `${s.phase === "gtd" && s.hasGtd ? "Mint" : "Bid on"} ${s.name}`}</h2>
            <div className="dp-progress">
              <div className="row"><span className="small">{s.settled ? (sale ? "Spots sold" : esc ? "Tokens sold" : "Items sold") : s.phase === "gtd" ? (s.hasGtd ? "GTD window" : "Bidding opens") : s.phase === "bidding" ? "Bidding window" : "Opening the bids"}</span><span className="small mono">{s.settled ? `${s.sold + s.gtdMinted} / ${s.supply}` : s.phase === "gtd" ? `${duration(s.gtdEnd - now)} left` : s.phase === "bidding" ? `${duration(s.commitEnd - now)} left` : `${s.reveals} of ${s.bids} open`}</span></div>
              <div className="dprog lg"><i style={{ width: `${(s.settled ? soldShare(s) : timeShare) * 100}%` }} /></div>
            </div>
            {!!reqs?.length && (
              <div className="card dp-reqs" style={{ marginBottom: 12 }}>
                <div className="card-head"><h3>Requirements</h3><span className="pill warn">to keep what you win</span></div>
                <ol className="small" style={{ paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6, margin: 0 }}>
                  {reqs.map((q, i) => <li key={i}>{q.url ? <a className="link" href={q.url} target="_blank" rel="noreferrer nofollow">{q.text} ↗</a> : q.text}</li>)}
                </ol>
                <p className="xs mute" style={{ marginTop: 8 }}>{sale ? `${sale.partner} checks these before honouring a spot` : "The creator checks these"}; Cloak can't. A winner who skips them may lose the spot, and the bid isn't refunded.</p>
              </div>
            )}
            <div className="card dp-stage">
              {s.phase === "gtd" && !s.hasGtd && (
                <>
                  <div className="card-head"><h3>Sealed bidding</h3><span className="pill">opens in {duration(s.gtdEnd - now)}</span></div>
                  <p className="small mute">Bidding opens in a moment. Bid what you'd pay, at {hype(s.floor)} HYPE or more. Nobody sees any bid until bidding closes, and every winner pays one price.</p>
                </>
              )}

              {s.phase === "gtd" && s.hasGtd && (
                <>
                  <div className="card-head"><h3>GTD mint</h3><span className="pill">bidding opens in {duration(s.gtdEnd - now)}</span></div>
                  {!wallet ? (
                    <><p className="small mute">Connect to see if your wallet has a guaranteed spot.</p><button className="btn btn-ghost" onClick={() => connect()}>Connect wallet</button></>
                  ) : gtdLeft > 0 ? (
                    <>
                      <p className="small">You have <b>{gtdLeft}</b> guaranteed spot{gtdLeft > 1 ? "s" : ""} at <b>{hype(s.gtdPrice)} HYPE</b> each.</p>
                      <div className="field"><label><span>How many</span></label><select className="input" value={gtdQty} onChange={(e) => setGtdQty(Number(e.target.value))}>{Array.from({ length: gtdLeft }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}</select></div>
                      <button className="btn btn-ink btn-lg btn-block" disabled={!!busy} onClick={act(`Minted ${gtdQty} GTD`, (w) => dropsClient(w).gtdMint(drop, gtdQty))}>{busy || `Mint ${gtdQty} for ${hype(s.gtdPrice * BigInt(gtdQty))} HYPE`}</button>
                    </>
                  ) : (
                    <p className="small mute">{me && me.gtdSpots ? "You've minted all your GTD spots." : "This wallet isn't on the GTD list."} The sealed auction opens when the GTD window closes{me?.wl ? ", and you're on the WL, so your bids get the boost" : ""}.</p>
                  )}
                </>
              )}

              {s.phase === "bidding" && (
                <>
                  <div className="card-head"><h3>Place a sealed bid</h3><span className="pill ok"><Icon.lock size={12} />sealed</span></div>
                  <div className="field-row">
                    <div className="field"><label><span>Most you'd pay, each</span><span>HYPE, at least {hype(s.floor)}</span></label><input className="input mono" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} /></div>
                    <div className="field"><label><span>{sale ? "Spots" : "How many"}</span></label><select className="input" value={qty} onChange={(e) => setQty(Number(e.target.value))}>{Array.from({ length: s.maxPerBid }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}</select></div>
                  </div>
                  {details.fields?.map((fd) => (
                    <div className="field" key={fd.label}>
                      <label><span>{fd.label}</span><span>{fd.required ? "required" : "optional"} · sealed with your bid</span></label>
                      <input className="input" value={answers[fd.label] ?? ""} maxLength={100} onChange={(e) => setAnswers((a) => ({ ...a, [fd.label]: e.target.value }))} placeholder={/x username|twitter/i.test(fd.label) ? "@yourname" : fd.label} />
                    </div>
                  ))}
                  {!!details.fields?.length && <p className="xs mute" style={{ marginTop: -6, marginBottom: 12 }}>{sale ? sale.partner : "The creator"} needs this from every winner. It's sealed inside your bid: nobody can read it until bidding closes.</p>}
                  {sale && (
                    <div className="field">
                      <label><span>Wallet for the {sk} list</span><span>optional</span></label>
                      <input className="input mono" value={listWallet} onChange={(e) => setListWallet(e.target.value.trim())} placeholder={wallet ? `empty = ${shortAddr(wallet.account.address)}, the wallet you bid from` : "0x… empty = the wallet you bid from"} />
                      <span className="xs mute">Bidding from a fresh wallet, say from your private balance? Put the wallet you'll mint with. It stays in this browser and nobody else sees it, so losing bids reveal nothing. If you win, this page fills it in and you confirm it once.</span>
                    </div>
                  )}
                  <div className="summary">
                    <div className="row"><span className="mute">Your bid level</span><span className="mono">{hype(level)} HYPE</span></div>
                    {priceWei > level + s.tickSize && tick === s.numTicks - 1 && <div className="row"><span className="mute">Highest level in this drop</span><span className="mono">{hype(level)} HYPE</span></div>}
                    {wlBid && <div className="row"><span className="mute">Ranks as (WL +{pct(s.wlBoostBps)})</span><span className="mono">{hype(ranks)} HYPE</span></div>}
                    <div className="row"><span className="mute">Deposit (refunded above what you pay)</span><span className="mono">{hype(level * BigInt(qty))} HYPE</span></div>
                  </div>
                  <p className="note">Nobody can read your bid until bidding closes in {duration(s.commitEnd - now)}. Every winner pays one price, the lowest winning bid, so bid what it's really worth to you.{sale ? ` If you win, the wallet you bid from goes on ${sale.partner}'s ${sk} list with nothing more to do, unless you name another one above.` : ""}{wlBid ? " You're on the WL: you pay that price ÷ " + (1 + s.wlBoostBps / 10_000).toFixed(2) + ", never under the floor." : ""}</p>
                  <button className="btn btn-ink btn-lg btn-block" disabled={!!busy} onClick={act("Sealed bid placed", async (w) => {
                    if (priceWei < s.floor) throw new Hint(`Bid at least the creator's price, ${hype(s.floor)} HYPE.`);
                    if (sale && listWallet && !isAddress(listWallet)) throw new Hint(`${listWallet.length > 20 ? `${listWallet.slice(0, 10)}…${listWallet.slice(-6)}` : listWallet} isn't a wallet address. Paste the full 0x address, or leave it empty.`);
                    const c = dropsClient(w);
                    // read the WL fresh: a quick click must never send a WL wallet's bid without its boost
                    const listed = await c.listed(drop, w.account.address);
                    const missing = details.fields?.find((fd) => fd.required && !(answers[fd.label] ?? "").trim());
                    if (missing) throw new Hint(`Fill in "${missing.label}" first: this sale needs it from every bidder.`);
                    const r = await c.bid(drop, { price: priceWei, quantity: qty, wl: listed.wl, fields: answers });
                    if (sale && listWallet && getAddress(listWallet) !== getAddress(w.account.address)) saveListWallet(drop, r.id, getAddress(listWallet));
                    return r.txHash;
                  })}>{busy || (wallet ? `Seal a bid for ${qty} at ${hype(level)} HYPE` : "Connect wallet to bid")}</button>
                </>
              )}

              {(s.phase === "reveal" || s.phase === "settle" || s.phase === "numbering") && (() => {
                const roundAt = drandRoundTime(s.tlockRound);
                // the keeper normally does each step within seconds; if it's late, anyone can do it from here
                const openLate = s.phase === "reveal" && s.reveals < s.bids && now > roundAt + 90;
                const settleLate = (s.phase === "settle" && now > Math.min(s.revealEnd, roundAt) + 60) || (s.phase === "numbering" && now > s.revealEnd + 60);
                return (
                  <>
                    <div className="card-head"><h3>Opening the bids</h3>{s.bids > 0 && <span className="pill">{s.reveals} of {s.bids} open</span>}</div>
                    <p className="small mute">
                      {now < roundAt
                        ? `Bidding closed. The bids unlock when the drand round comes out, in about ${duration(roundAt - now)}.`
                        : s.phase === "reveal"
                          ? `Cloak's keeper is opening every sealed bid now. It settles as soon as they're all open, or when the window ends in ${duration(s.revealEnd - now)}.`
                          : "Every bid is open. Settling the sale now, and results show here."}
                    </p>
                    {(openLate || settleLate) && (
                      <>
                        <p className="xs mute" style={{ marginTop: 8 }}>The keeper is taking longer than usual. Anyone can do this step, so you can do it yourself for a little gas. {openLate ? `Bids still sealed when the window ends lose 10% of their deposit.` : ""}</p>
                        <button className="btn btn-ghost btn-block" style={{ marginTop: 8 }} disabled={!!busy} onClick={act(openLate ? "Bids opened" : "Sale settled", async (w) => {
                          const c = dropsClient(w);
                          if (openLate) await c.revealAll(drop);
                          else await c.settle(drop);
                        })}>{busy || (wallet ? (openLate ? "Open the bids now" : "Settle now") : "Connect to do it yourself")}</button>
                      </>
                    )}
                  </>
                );
              })()}

              {s.phase === "settled" && (
                <>
                  <div className="card-head"><h3>{s.failed ? "No sale" : "Results"}</h3></div>
                  {s.failed ? (
                    <p className="small mute">{s.auctionSupply === 0 ? "GTD took the whole supply." : "Nobody bid."} Every deposit is refunded in full.</p>
                  ) : (
                    <div className="summary">
                      <div className="row"><span className="mute">Sold in the auction</span><span className="mono">{s.sold}</span></div>
                      <div className="row"><span className="mute">Public winners paid</span><span className="mono">{hype(s.publicPrice)} HYPE</span></div>
                      {s.hasWl && <div className="row"><span className="mute">WL winners paid</span><span className="mono">{hype(s.wlPrice)} HYPE</span></div>}
                      {s.tieSupply > 0 && <div className="row"><span className="mute">Tied at the clearing price</span><span className="mono">{s.tieSupply} drawn from {s.tieDemand}</span></div>}
                    </div>
                  )}
                </>
              )}

              {mine.length > 0 && (
                <>
                  <div className="card-head" style={{ marginTop: 18 }}><h3>Your bids</h3></div>
                  <div className="drop-bids">
                    {mine.map((b) => (
                      <div key={String(b.id)}>
                        <span className="small"><span className="mono">{b.revealed ? `${b.quantity} × ${hype(b.price)} HYPE` : `Sealed bid · ${hype(b.deposit)} HYPE deposit`}</span>{b.wl && <span className="pill ok" style={{ marginLeft: 6 }}>WL</span>}{!s.settled && !!details.fields?.length && <span className="xs mute" style={{ marginLeft: 6 }}>your info is sealed with it</span>}{sale && !s.settled && savedListWallet(drop, b.id) && <span className="xs mute" style={{ marginLeft: 6 }}>list wallet {shortAddr(savedListWallet(drop, b.id)!)}, kept in this browser</span>}</span>
                        <span className="small mute">
                          {!s.settled ? (b.revealed ? "opened" : "sealed") : s.phase !== "settled" ? "settling" : !b.revealed ? `never opened · ${b.deposit ? Number(((b.deposit - b.refund) * 100n) / b.deposit) : 0}% kept` : b.nfts ? `won ${b.nfts}${sale ? ` spot${b.nfts > 1 ? "s" : ""}` : ""}${wonIds[String(b.id)]?.length ? ` (${wonIds[String(b.id)].map((x) => `#${x}`).join(", ")})` : ""} · paid ${hype(b.paid)}` : "not won"}
                          {s.phase === "settled" && (b.claimed ? " · delivered" : b.refund > 0n ? ` · ${hype(b.refund)} back` : "")}
                        </span>
                      </div>
                    ))}
                  </div>
                  {s.phase === "settled" && myWins.length > 0 && (
                    <>
                      <div className="card-head" style={{ marginTop: 18 }}><h3>Wallet on the {sk} list</h3>{walletsOpen && <span className="pill">{duration(sale!.deadline - now)} left</span>}</div>
                      {myWins.some((b) => pendingChoice(b)) ? (
                        <p className="small" style={{ color: "var(--signal)" }}>When you bid, you chose {myWins.map((b) => pendingChoice(b)).filter(Boolean).map((a) => shortAddr(a!)).join(", ")} for the list. It's filled in below: confirm it once to put it on the list. Until then your bidding wallet holds the spot.</p>
                      ) : (
                        <p className="xs mute">Nothing to do: the wallet you bid with is on {sale!.partner}'s {sk} list. To use a different Elysium wallet, enter it below and save, until the deadline.</p>
                      )}
                      {myWins.map((b) => (
                        <div key={String(b.id)}>
                          {typed(b).map((v, i) => (
                            <div className="field" key={i}>
                              <label><span>Spot {i + 1}{myWins.length > 1 ? ` · bid #${b.id}` : ""}</span>{(() => { const row = listRows.filter((x) => x.bidId === b.id)[i]; return row?.source === "named" ? <span style={{ color: "var(--signal)" }}>your choice</span> : i === 0 && pendingChoice(b) ? <span style={{ color: "var(--seal)" }}>chosen when you bid · not saved yet</span> : row?.source === "bidder" ? <span style={{ color: "var(--signal)" }}>your bidding wallet</span> : <span>no wallet yet</span>; })()}</label>
                              <input className="input mono" value={v} disabled={!walletsOpen} placeholder={i === 0 ? b.bidder : "0x… wallet for this spot"} onChange={(e) => { const next = [...typed(b)]; next[i] = e.target.value.trim(); setNamed((x) => ({ ...x, [String(b.id)]: next })); }} />
                            </div>
                          ))}
                          {walletsOpen && (
                            <button className="btn btn-ink btn-block" disabled={!!busy} onClick={act("Wallets saved", async (w) => {
                              const list = typed(b);
                              const bad = list.find((a) => !isAddress(a));
                              if (bad !== undefined) throw new Hint(bad ? `${bad.length > 20 ? `${bad.slice(0, 10)}…${bad.slice(-6)}` : bad} isn't a wallet address. Paste the full 0x address.` : "Enter a wallet for every spot.");
                              if (new Set(list.map((a) => a.toLowerCase())).size !== list.length) throw new Hint("Each spot needs a different wallet.");
                              const h = await spotsClient(w)!.setWallets(drop, b.id, list);
                              setNamed((x) => { const { [String(b.id)]: _, ...rest } = x; return rest; });
                              return h;
                            })}>{busy || (onChain(b).length ? "Update wallet" : pendingChoice(b) ? `Put ${shortAddr(pendingChoice(b)!)} on the list` : "Use this wallet instead")}</button>
                          )}
                        </div>
                      ))}
                      {!walletsOpen && <p className="small mute">The deadline has passed, so the whitelist is final.</p>}
                    </>
                  )}
                  {s.phase === "settled" && !sale && mine.some((b) => !b.claimed && b.nfts > 0) && (
                    <>
                      <p className="xs mute" style={{ marginTop: 8 }}>Cloak delivers to the wallet that bid within the hour. To keep them apart from that wallet, send your NFTs to a fresh one now.</p>
                      <div className="field"><label><span>Send my NFTs to</span></label><input className="input mono" value={to} onChange={(e) => setTo(e.target.value.trim())} placeholder="0x… a fresh wallet" /></div>
                      <button className="btn btn-ink btn-block" disabled={!!busy} onClick={act("NFTs claimed", async (w) => {
                        const dest = checked(() => { if (!isAddress(to)) throw new Error("Enter the 0x address to send them to."); return to as Address; });
                        let h: Hex | undefined;
                        for (const b of mine.filter((x) => !x.claimed && x.nfts > 0)) h = await dropsClient(w).claimTo(drop, b.id, dest);
                        return h;
                      })}>{busy || "Claim to that wallet"}</button>
                    </>
                  )}
                  {s.phase === "settled" && mine.some((b) => !b.claimed) && (
                    <button className="btn btn-ghost btn-block" style={{ marginTop: 8 }} disabled={!!busy} onClick={act("Delivered", async (w) => {
                      let h: Hex | undefined;
                      for (const b of mine.filter((x) => !x.claimed)) h = await dropsClient(w).claim(drop, b.id);
                      return h;
                    })}>{busy || (myWon > 0 ? `Claim ${sale ? "my receipt" : "to my bidding wallet"} now` : "Get my refund now")}</button>
                  )}
                  {s.phase === "settled" && myWon > 0 && <p className="okmsg small" style={{ marginTop: 8 }}><Icon.check size={14} /> You won {myWon} {unit}{myWon > 1 ? "s" : ""}.{sale ? " A receipt NFT comes to your bidding wallet." : ""}</p>}
                </>
              )}
              {held > 0n && (
                <>
                  <p className="small" style={{ marginTop: 12 }}>{hype(held)} HYPE of your refund couldn't be sent to this wallet automatically, so it's waiting for you.</p>
                  <button className="btn btn-ink btn-block" disabled={!!busy} onClick={act("Refund withdrawn", (w) => dropsClient(w).withdrawRefund(drop, w.account.address))}>{busy || `Withdraw ${hype(held)} HYPE`}</button>
                </>
              )}
              {err && <div className="err">{err}</div>}
              {tx && txLink(tx.hash) && <a className="link small" href={txLink(tx.hash)} target="_blank" rel="noreferrer">{tx.what}: view the transaction ↗</a>}

            </div>
            <div className="dp-schedule">
              <h3 className="dp-h3">{sale ? "Sale" : esc ? "Auction" : "Mint"} schedule</h3>
              <ol>
                {stages.map((st) => (
                  <li key={st.name} className={st.state}>
                    <span className="dp-dot" />
                    <div><b className="small">{st.name}</b> <span className={`xs ${st.state === "live" ? "dp-live" : "mute"}`}>{st.state === "live" ? "Live now" : st.state === "done" ? "Ended" : "Up next"}</span><br /><span className="xs mute">{st.when}</span></div>
                  </li>
                ))}
              </ol>
            </div>
            <div className="dp-extra">
              {sale && s.phase === "settled" && !s.failed && (
                <>
                  <div className="card-head" style={{ marginTop: 18 }}><h3>{sk === "GTD" ? "GTD list" : "Whitelist"}</h3><span className="pill">{winnersRaw ? `${namedSpots} of ${totalSpots} wallets` : "loading…"}</span></div>
                  <div className="drop-bids">
                    {listRows.map((r, i) => (
                      <div key={`${r.bidId}-${i}`}>
                        <span className="small mono" style={{ overflowWrap: "anywhere" }}>{r.wallet ?? "no wallet yet"}</span>
                        <span className="xs mute">{Object.values(r.fields).length ? `${Object.values(r.fields).join(" · ")} · ` : ""}bid #{String(r.bidId)}{r.source === "bidder" ? " · bidding wallet" : r.source === "named" ? " · named" : ""}</span>
                      </div>
                    ))}
                  </div>
                  <button className="btn btn-ghost btn-block" style={{ marginTop: 10 }} disabled={!winners.length} onClick={downloadCsv}>Download the {sk} list (CSV)</button>
                </>
              )}
              {isCreator && !sale && details.spots && !s.settled && spotsClient() && (
                <>
                  <div className="card-head" style={{ marginTop: 18 }}><h3>Finish setting up</h3></div>
                  <p className="small mute">This drop was made to sell {details.spots.partner} WL spots but isn't marked as a spot sale yet, so winners can't name wallets. Finish it before the bids open.</p>
                  <button className="btn btn-ink btn-block" disabled={!!busy} onClick={act("Marked as a WL spot sale", (w) => spotsClient(w)!.open(drop, details.spots!.partner, s.revealEnd + 3 * 86400))}>{busy || "Mark as a WL spot sale"}</button>
                </>
              )}
              {me && (me.wl || me.gtdSpots > 0) && <p className="small" style={{ marginTop: 10 }}><span className="pill ok">{me.gtdSpots ? `GTD · ${me.gtdSpots} spot${me.gtdSpots > 1 ? "s" : ""}` : ""}{me.gtdSpots && me.wl ? " · " : ""}{me.wl ? "WL" : ""}</span> This wallet is listed.</p>}
              {isCreator && sale && s.phase === "settled" && left > 0 && <p className="small mute" style={{ marginTop: 10 }}>{left} spot{left > 1 ? "s" : ""} went unsold. They aren't on this list, so they're yours to give out with {sale.partner}.</p>}
              {!wallet && !sale && s.phase === "settled" && left > 0 && (
                <p className="small mute" style={{ marginTop: 14 }}>{left} {esc ? "token" : "NFT"}{left > 1 ? "s" : ""} went unsold. {esc ? "The owner can take them back" : "The creator can mint them"}: <button className="link small" onClick={() => connect().catch(() => {})}>connect the creator's wallet</button>.</p>
              )}
              {isCreator && !sale && s.phase === "settled" && left > 0 && (
                <>
                  <div className="card-head" style={{ marginTop: 18 }}><h3>Unsold {esc ? "tokens" : "NFTs"}</h3></div>
                  <p className="small mute">{left} {esc ? "token" : "NFT"}{left > 1 ? "s" : ""} went unsold. {esc ? "Take them back to your wallet." : "They're yours to mint."}</p>
                  <button className="btn btn-ghost btn-block" disabled={!!busy} onClick={act(esc ? `Took back ${Math.min(left, 100)} unsold` : `Minted ${left} unsold`, (w) => dropsClient(w).mintUnsold(drop, w.account.address, Math.min(left, 100)))}>{busy || (esc ? `Take back ${Math.min(left, 100)} to my wallet` : `Mint ${Math.min(left, 100)} to my wallet`)}</button>
                </>
              )}

            </div>
          </div>
        </div>
      )}
    </div>
  );
}
