import { useEffect, useRef, useState } from "react";
import { isAddress, parseEther, type Address, type Hex } from "viem";
import { CloakDrops, CloakSpots, type DropBid, type DropDetails, type DropState, type SpotSale, type SpotWinner } from "@cloakely/sdk";
import { addrLink, txLink } from "../config";
import { dropsClient, pct, spotsClient } from "../drops";
import { checked, friendly, Hint } from "../errors";
import { duration, hype, short } from "../format";
import { Link } from "../router";
import { useApp } from "../state";
import { Icon } from "../ui";
import { DropArt, phaseText } from "./Drops";

type Me = { wl: boolean; gtdSpots: number; gtdMinted: number };

/** One sealed NFT drop: GTD minting, sealed bidding, then results, claims and refunds. */
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
  const [qty, setQty] = useState(1);
  const [gtdQty, setGtdQty] = useState(1);
  const [to, setTo] = useState("");
  const [tx, setTx] = useState<{ hash: Hex; what: string } | null>(null);
  const [sale, setSale] = useState<SpotSale | null>(null);
  const [winnersRaw, setWinners] = useState<SpotWinner[] | null>(null);
  const winners = winnersRaw ?? [];
  const [named, setNamed] = useState<Record<string, string[]>>({});

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
    } else {
      setMe(null);
      setMine([]);
    }
  }
  useEffect(() => {
    load().catch((e) => setErr(friendly(e)));
    const t = setInterval(() => setNow(Date.now() / 1000), 1000);
    const r = setInterval(() => load().catch(() => {}), 15000);
    return () => (clearInterval(t), clearInterval(r));
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

  if (!s) return <div>{err ? <div className="err">{err}</div> : <p className="mute">Loading the drop…</p>}</div>;
  const p = phaseText(s, now);
  const isCreator = !!wallet && wallet.account.address.toLowerCase() === s.creator.toLowerCase();
  const myWon = mine.reduce((a, b) => a + b.nfts, 0);
  const priceWei = (() => { try { return parseEther(price.trim() || "0"); } catch { return 0n; } })();
  const tick = priceWei >= s.floor ? CloakDrops.tickFor(s, priceWei) : 0;
  const level = CloakDrops.priceAt(s, tick);
  const wlBid = !!me?.wl;
  const ranks = wlBid ? (level * BigInt(10_000 + s.wlBoostBps)) / 10_000n : level;
  const gtdLeft = me ? me.gtdSpots - me.gtdMinted : 0;
  const left = s.supply - s.gtdMinted - s.sold;
  const myWins = sale ? mine.filter((b) => b.nfts > 0) : [];
  const walletsOpen = !!sale && now < sale.deadline;
  const totalSpots = winners.reduce((a, w) => a + w.spots, 0);
  const namedSpots = winners.reduce((a, w) => a + Math.min(w.wallets.length, w.spots), 0);
  /** The wallets typed for a bid, falling back to what it has already named. */
  const typed = (b: DropBid) => named[String(b.id)] ?? Array.from({ length: b.nfts }, (_, i) => winners.find((w) => w.bidId === b.id)?.wallets[i] ?? "");
  const unit = sale ? "spot" : "NFT";
  function downloadCsv() {
    const url = URL.createObjectURL(new Blob([CloakSpots.csv(winners)], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(sale?.partner || s!.name).replace(/[^A-Za-z0-9]+/g, "-").toLowerCase()}-whitelist.csv`;
    // attached to the page: some browsers (Safari, Firefox) ignore a click on a detached link
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <div>
      <Link to="/app/drops" className="back-btn"><span aria-hidden>←</span>All drops</Link>
      <div className="drop-hero">
        <DropArt details={details} name={s.name} size={220} />
        <div style={{ minWidth: 0 }}>
          <span className={`pill ${p.live ? "ok" : ""}`}>{p.live && <span className="dot live" />}{p.text}</span>
          {sale && <span className="pill" style={{ marginLeft: 6 }}>WL spots · {sale.partner}</span>}
          <h1 style={{ marginTop: 10 }}>{s.name} <span className="mute" style={{ fontSize: "0.5em" }}>{s.symbol}</span></h1>
          {details.description && <p className="mute" style={{ marginTop: 8, overflowWrap: "anywhere" }}>{details.description}</p>}
          <p className="xs mute" style={{ marginTop: 6 }}>by {addrLink(s.creator) ? <a className="link mono" href={addrLink(s.creator)} target="_blank" rel="noreferrer">{short(s.creator)}</a> : <span className="mono">{short(s.creator)}</span>} · contract <a className="link mono" href={addrLink(s.address)} target="_blank" rel="noreferrer">{short(s.address)}</a></p>
          <div className="drop-stats">
            <div><span className="xs mute">{sale ? "WL spots" : "Supply"}</span><b>{s.supply.toLocaleString()}</b></div>
            <div><span className="xs mute">Floor</span><b>{hype(s.floor)} HYPE</b></div>
            {s.hasGtd && <div><span className="xs mute">GTD minted</span><b>{s.gtdMinted} at {hype(s.gtdPrice)}</b></div>}
            {s.hasWl && <div><span className="xs mute">WL bid boost</span><b>{pct(s.wlBoostBps)}</b></div>}
            <div><span className="xs mute">Sealed bids</span><b>{s.bids}</b></div>
            {s.settled && !s.failed && <div><span className="xs mute">Sold at</span><b>{hype(s.publicPrice)} HYPE</b></div>}
          </div>
        </div>
      </div>

      <div className="drop-grid">
        <div className="card">
          {s.phase === "gtd" && (
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
              <div className="summary">
                <div className="row"><span className="mute">Your bid level</span><span className="mono">{hype(level)} HYPE</span></div>
                {wlBid && <div className="row"><span className="mute">Ranks as (WL +{pct(s.wlBoostBps)})</span><span className="mono">{hype(ranks)} HYPE</span></div>}
                <div className="row"><span className="mute">Deposit (refunded above what you pay)</span><span className="mono">{hype(level * BigInt(qty))} HYPE</span></div>
              </div>
              <p className="note">Nobody can read your bid until bidding closes in {duration(s.commitEnd - now)}. Every winner pays one price, the lowest winning bid, so bid what it's really worth to you.{wlBid ? " You're on the WL: you pay that price ÷ " + (1 + s.wlBoostBps / 10_000).toFixed(2) + ", never under the floor." : ""}</p>
              <button className="btn btn-ink btn-lg btn-block" disabled={!!busy} onClick={act("Sealed bid placed", async (w) => {
                if (priceWei < s.floor) throw new Hint(`Bid at least the creator's price, ${hype(s.floor)} HYPE.`);
                const c = dropsClient(w);
                // read the WL fresh: a quick click must never send a WL wallet's bid without its boost
                const listed = await c.listed(drop, w.account.address);
                return (await c.bid(drop, { price: priceWei, quantity: qty, wl: listed.wl })).txHash;
              })}>{busy || (wallet ? `Seal a bid for ${qty} at ${hype(level)} HYPE` : "Connect wallet to bid")}</button>
            </>
          )}

          {(s.phase === "reveal" || s.phase === "settle" || s.phase === "numbering") && (
            <>
              <div className="card-head"><h3>Opening the bids</h3></div>
              <p className="small mute">Bidding closed. Cloak's keeper is opening every sealed bid now that the drand round is out, then settles the sale. This takes a few minutes, and results show here.</p>
            </>
          )}

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
                    <span className="small"><span className="mono">{b.revealed ? `${b.quantity} × ${hype(b.price)} HYPE` : `Sealed bid · ${hype(b.deposit)} HYPE deposit`}</span>{b.wl && <span className="pill ok" style={{ marginLeft: 6 }}>WL</span>}</span>
                    <span className="small mute">
                      {!s.settled ? (b.revealed ? "opened" : "sealed") : s.phase !== "settled" ? "settling" : b.nfts ? `won ${b.nfts}${sale ? ` spot${b.nfts > 1 ? "s" : ""}` : ""} · paid ${hype(b.paid)}` : "not won"}
                      {s.phase === "settled" && (b.claimed ? " · delivered" : b.refund > 0n ? ` · ${hype(b.refund)} back` : "")}
                    </span>
                  </div>
                ))}
              </div>
              {s.phase === "settled" && myWins.length > 0 && (
                <>
                  <div className="card-head" style={{ marginTop: 18 }}><h3>Wallets to whitelist</h3>{walletsOpen && <span className="pill">{duration(sale!.deadline - now)} left</span>}</div>
                  <p className="xs mute">Name the Elysium wallet {sale!.partner} should whitelist, one per spot. It can be a different wallet from the one you bid with. You can change it until the deadline.</p>
                  {myWins.map((b) => (
                    <div key={String(b.id)}>
                      {typed(b).map((v, i) => (
                        <div className="field" key={i}>
                          <label><span>Spot {i + 1}{myWins.length > 1 ? ` · bid #${b.id}` : ""}</span>{winners.find((w) => w.bidId === b.id)?.wallets[i] ? <span style={{ color: "var(--signal)" }}>named</span> : <span>not named yet</span>}</label>
                          <input className="input mono" value={v} disabled={!walletsOpen} placeholder="0x… wallet to whitelist" onChange={(e) => { const next = [...typed(b)]; next[i] = e.target.value.trim(); setNamed((x) => ({ ...x, [String(b.id)]: next })); }} />
                        </div>
                      ))}
                      {walletsOpen && (
                        <button className="btn btn-ink btn-block" disabled={!!busy} onClick={act("Wallets saved", async (w) => {
                          const list = typed(b);
                          const bad = list.find((a) => !isAddress(a));
                          if (bad !== undefined) throw new Hint(bad ? `${short(bad)} isn't a wallet address.` : "Enter a wallet for every spot.");
                          if (new Set(list.map((a) => a.toLowerCase())).size !== list.length) throw new Hint("Each spot needs a different wallet.");
                          const h = await spotsClient(w)!.setWallets(drop, b.id, list);
                          setNamed((x) => { const { [String(b.id)]: _, ...rest } = x; return rest; });
                          return h;
                        })}>{busy || (winners.find((w) => w.bidId === b.id)?.wallets.length ? "Update wallets" : "Save wallets")}</button>
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
              {s.phase === "settled" && myWon > 0 && <p className="okmsg small" style={{ marginTop: 8 }}><Icon.check size={14} /> You won {myWon} {unit}{myWon > 1 ? "s" : ""}.{sale ? " A receipt NFT comes to your bidding wallet." : ""}</p>}
            </>
          )}
          {err && <div className="err">{err}</div>}
          {tx && txLink(tx.hash) && <a className="link small" href={txLink(tx.hash)} target="_blank" rel="noreferrer">{tx.what}: view the transaction ↗</a>}
        </div>

        <div className="card">
          <div className="card-head"><h3>How this {sale ? "sale" : "drop"} works</h3></div>
          {sale ? (
          <ol className="small" style={{ paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6 }}>
            <li>{sale.partner} gave {s.supply} WL spot{s.supply > 1 ? "s" : ""}. Bid sealed, at {hype(s.floor)} HYPE or more per spot. Nobody sees any bid until bidding closes.</li>
            {s.hasWl && <li>WL bids rank {pct(s.wlBoostBps)} higher, and WL winners pay {pct(s.wlBoostBps)} less, never under the floor.</li>}
            <li>The highest bids win, and every winner pays one price: the lowest winning bid. Ties at that price are drawn at random.</li>
            <li>Winners name the wallet to whitelist, one per spot, until {new Date(sale.deadline * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}. Everyone else gets their deposit back.</li>
            <li>The list below is the whitelist {sale.partner} receives.</li>
          </ol>
          ) : (
          <ol className="small" style={{ paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6 }}>
            {s.hasGtd && <li>GTD wallets mint their spots at {hype(s.gtdPrice)} HYPE. Unused spots roll into the auction.</li>}
            <li>Everyone else bids sealed, at {hype(s.floor)} HYPE or more. Nobody sees any bid until bidding closes.</li>
            {s.hasWl && <li>WL bids rank {pct(s.wlBoostBps)} higher, and WL winners pay {pct(s.wlBoostBps)} less, never under the floor.</li>}
            <li>The highest bids win, and every winner pays one price: the lowest winning bid. Ties at that price are drawn at random.</li>
            <li>Winners get their NFTs, everyone else gets their deposit back, automatically.</li>
          </ol>
          )}
          {sale && s.phase === "settled" && !s.failed && (
            <>
              <div className="card-head" style={{ marginTop: 18 }}><h3>Whitelist</h3><span className="pill">{winnersRaw ? `${namedSpots} of ${totalSpots} named` : "loading…"}</span></div>
              <div className="drop-bids">
                {winners.flatMap((w) => Array.from({ length: w.spots }, (_, i) => (
                  <div key={`${w.bidId}-${i}`}>
                    <span className="small mono" style={{ overflowWrap: "anywhere" }}>{w.wallets[i] ?? "not named yet"}</span>
                    <span className="xs mute">bid #{String(w.bidId)}</span>
                  </div>
                )))}
              </div>
              <button className="btn btn-ghost btn-block" style={{ marginTop: 10 }} disabled={!winners.length} onClick={downloadCsv}>Download the whitelist (CSV)</button>
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
          {isCreator && !sale && s.phase === "settled" && left > 0 && (
            <>
              <div className="card-head" style={{ marginTop: 18 }}><h3>Unsold NFTs</h3></div>
              <p className="small mute">{left} NFT{left > 1 ? "s" : ""} went unsold. They're yours to mint.</p>
              <button className="btn btn-ghost btn-block" disabled={!!busy} onClick={act(`Minted ${left} unsold`, (w) => dropsClient(w).mintUnsold(drop, w.account.address, Math.min(left, 100)))}>{busy || `Mint ${Math.min(left, 100)} to my wallet`}</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
