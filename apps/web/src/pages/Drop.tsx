import { useEffect, useRef, useState } from "react";
import { isAddress, parseEther, type Address, type Hex } from "viem";
import { CloakDrops, type DropBid, type DropDetails, type DropState } from "@cloakely/sdk";
import { addrLink, txLink } from "../config";
import { dropsClient, pct } from "../drops";
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

  async function load() {
    const c = dropsClient();
    const [st, det] = await Promise.all([c.get(drop), c.details(drop).catch(() => ({}) as DropDetails)]);
    setS(st);
    setDetails(det);
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
  const need = async () => wallet ?? (await connect());

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

  return (
    <div>
      <Link to="/app/drops" className="back-btn"><span aria-hidden>←</span>All drops</Link>
      <div className="drop-hero">
        <DropArt details={details} name={s.name} size={220} />
        <div style={{ minWidth: 0 }}>
          <span className={`pill ${p.live ? "ok" : ""}`}>{p.live && <span className="dot live" />}{p.text}</span>
          <h1 style={{ marginTop: 10 }}>{s.name} <span className="mute" style={{ fontSize: "0.5em" }}>{s.symbol}</span></h1>
          {details.description && <p className="mute" style={{ marginTop: 8, overflowWrap: "anywhere" }}>{details.description}</p>}
          <p className="xs mute" style={{ marginTop: 6 }}>by {addrLink(s.creator) ? <a className="link mono" href={addrLink(s.creator)} target="_blank" rel="noreferrer">{short(s.creator)}</a> : <span className="mono">{short(s.creator)}</span>} · contract <a className="link mono" href={addrLink(s.address)} target="_blank" rel="noreferrer">{short(s.address)}</a></p>
          <div className="drop-stats">
            <div><span className="xs mute">Supply</span><b>{s.supply.toLocaleString()}</b></div>
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
                  <button className="btn btn-ink btn-lg btn-block" disabled={!!busy} onClick={() => run(`Minted ${gtdQty} GTD`, async () => dropsClient(await need()).gtdMint(drop, gtdQty))}>{busy || `Mint ${gtdQty} for ${hype(s.gtdPrice * BigInt(gtdQty))} HYPE`}</button>
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
                <div className="field"><label><span>How many</span></label><select className="input" value={qty} onChange={(e) => setQty(Number(e.target.value))}>{Array.from({ length: s.maxPerBid }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}</select></div>
              </div>
              <div className="summary">
                <div className="row"><span className="mute">Your bid level</span><span className="mono">{hype(level)} HYPE</span></div>
                {wlBid && <div className="row"><span className="mute">Ranks as (WL +{pct(s.wlBoostBps)})</span><span className="mono">{hype(ranks)} HYPE</span></div>}
                <div className="row"><span className="mute">Deposit (refunded above what you pay)</span><span className="mono">{hype(level * BigInt(qty))} HYPE</span></div>
              </div>
              <p className="note">Nobody can read your bid until bidding closes in {duration(s.commitEnd - now)}. Every winner pays one price, the lowest winning bid, so bid what it's really worth to you.{wlBid ? " You're on the WL: you pay that price ÷ " + (1 + s.wlBoostBps / 10_000).toFixed(2) + ", never under the floor." : ""}</p>
              <button className="btn btn-ink btn-lg btn-block" disabled={!!busy} onClick={() => run("Sealed bid placed", async () => {
                const w = await need();
                if (!w) return;
                if (priceWei < s.floor) throw new Hint(`Bid at least the creator's price, ${hype(s.floor)} HYPE.`);
                return (await dropsClient(w).bid(drop, { price: priceWei, quantity: qty, wl: wlBid })).txHash;
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
                    <span className="small"><span className="mono">{b.quantity} × {s.settled || b.revealed ? `${hype(b.price)} HYPE` : "sealed"}</span>{b.wl && <span className="pill ok" style={{ marginLeft: 6 }}>WL</span>}</span>
                    <span className="small mute">
                      {!s.settled ? (b.revealed ? "opened" : "sealed") : s.phase !== "settled" ? "settling" : b.nfts ? `won ${b.nfts} · paid ${hype(b.paid)}` : "not won"}
                      {s.phase === "settled" && (b.claimed ? " · delivered" : b.refund > 0n ? ` · ${hype(b.refund)} back` : "")}
                    </span>
                  </div>
                ))}
              </div>
              {s.phase === "settled" && mine.some((b) => !b.claimed && b.nfts > 0) && (
                <>
                  <p className="xs mute" style={{ marginTop: 8 }}>Cloak delivers to the wallet that bid within the hour. To keep them apart from that wallet, send your NFTs to a fresh one now.</p>
                  <div className="field"><label><span>Send my NFTs to</span></label><input className="input mono" value={to} onChange={(e) => setTo(e.target.value.trim())} placeholder="0x… a fresh wallet" /></div>
                  <button className="btn btn-ink btn-block" disabled={!!busy} onClick={() => run("NFTs claimed", async () => {
                    const w = await need();
                    if (!w) return;
                    const dest = checked(() => { if (!isAddress(to)) throw new Error("Enter the 0x address to send them to."); return to as Address; });
                    let h: Hex | undefined;
                    for (const b of mine.filter((x) => !x.claimed && x.nfts > 0)) h = await dropsClient(w).claimTo(drop, b.id, dest);
                    return h;
                  })}>{busy || "Claim to that wallet"}</button>
                </>
              )}
              {s.phase === "settled" && myWon > 0 && <p className="okmsg small" style={{ marginTop: 8 }}><Icon.check size={14} /> You won {myWon} NFT{myWon > 1 ? "s" : ""}.</p>}
            </>
          )}
          {err && <div className="err">{err}</div>}
          {tx && txLink(tx.hash) && <a className="link small" href={txLink(tx.hash)} target="_blank" rel="noreferrer">{tx.what}: view the transaction ↗</a>}
        </div>

        <div className="card">
          <div className="card-head"><h3>How this drop works</h3></div>
          <ol className="small" style={{ paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6 }}>
            {s.hasGtd && <li>GTD wallets mint their spots at {hype(s.gtdPrice)} HYPE. Unused spots roll into the auction.</li>}
            <li>Everyone else bids sealed, at {hype(s.floor)} HYPE or more. Nobody sees any bid until bidding closes.</li>
            {s.hasWl && <li>WL bids rank {pct(s.wlBoostBps)} higher, and WL winners pay {pct(s.wlBoostBps)} less, never under the floor.</li>}
            <li>The highest bids win, and every winner pays one price: the lowest winning bid. Ties at that price are drawn at random.</li>
            <li>Winners get their NFTs, everyone else gets their deposit back, automatically.</li>
          </ol>
          {me && (me.wl || me.gtdSpots > 0) && <p className="small" style={{ marginTop: 10 }}><span className="pill ok">{me.gtdSpots ? `GTD · ${me.gtdSpots} spot${me.gtdSpots > 1 ? "s" : ""}` : ""}{me.gtdSpots && me.wl ? " · " : ""}{me.wl ? "WL" : ""}</span> This wallet is listed.</p>}
          {isCreator && s.phase === "settled" && left > 0 && (
            <>
              <div className="card-head" style={{ marginTop: 18 }}><h3>Unsold NFTs</h3></div>
              <p className="small mute">{left} NFT{left > 1 ? "s" : ""} went unsold. They're yours to mint.</p>
              <button className="btn btn-ghost btn-block" disabled={!!busy} onClick={() => run(`Minted ${left} unsold`, async () => dropsClient(await need()).mintUnsold(drop, wallet!.account.address, Math.min(left, 100)))}>{busy || `Mint ${Math.min(left, 100)} to my wallet`}</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
