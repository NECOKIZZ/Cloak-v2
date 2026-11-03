import { useEffect, useState } from "react";
import type { DropDetails, DropState } from "@cloakely/sdk";
import { DROP_FACTORY, SPOT_BOOK } from "../config";
import { dropsClient, imageSrc, pct } from "../drops";
import { friendly } from "../errors";
import { duration, hype } from "../format";
import { Link } from "../router";
import { Icon } from "../ui";

type Row = DropState & { details: DropDetails };

export function phaseText(s: DropState, now: number): { text: string; live: boolean } {
  if (s.phase === "gtd") return { text: `GTD mint · bidding opens in ${duration(s.gtdEnd - now)}`, live: true };
  if (s.phase === "bidding") return { text: `Sealed bidding · closes in ${duration(s.commitEnd - now)}`, live: true };
  if (s.phase === "reveal" || s.phase === "settle" || s.phase === "numbering") return { text: "Opening the sealed bids", live: false };
  if (s.failed) return { text: "Ended with no sale · refunds open", live: false };
  return { text: `Sold ${s.sold + s.gtdMinted} of ${s.supply}`, live: false };
}

export function DropArt({ details, name, size = 64 }: { details?: DropDetails; name: string; size?: number }) {
  const src = imageSrc(details?.image);
  return src ? (
    <img className="drop-art" src={src} alt="" width={size} height={size} style={{ width: size, height: size }} />
  ) : (
    <span className="drop-art drop-art-ph" style={{ width: size, height: size, fontSize: size / 3 }}>{name.slice(0, 2).toUpperCase()}</span>
  );
}

function Card({ s, now }: { s: Row; now: number }) {
  const p = phaseText(s, now);
  return (
    <Link to={`/app/drop/${s.address}`} className="tcard">
      <DropArt details={s.details} name={s.name} size={48} />
      <div className="tcard-id">
        <b>{s.name}</b>
        <span className="mute">{s.details.spots ? `${s.supply.toLocaleString()} WL spot${s.supply > 1 ? "s" : ""} · ${s.details.spots.partner}` : `${s.supply.toLocaleString()} NFTs`}{s.hasWl && s.wlBoostBps ? ` · WL +${pct(s.wlBoostBps)}` : ""}</span>
      </div>
      <div className="tcard-price">
        <span className="xs mute">{s.settled && !s.failed ? "Sold at" : "From"}</span>
        <span className="mono">{hype(s.settled && !s.failed ? s.publicPrice : s.floor)} <span className="xs mute">HYPE</span></span>
      </div>
      <div className="tcard-foot xs">{p.live ? <span><span className="dot live" style={{ marginRight: 6 }} />{p.text}</span> : <span className="mute">{p.text}</span>}</div>
    </Link>
  );
}

/** Every sealed NFT drop: live ones first. */
export function Drops() {
  const [list, setList] = useState<Row[] | null>(null);
  const [err, setErr] = useState("");
  const [now, setNow] = useState(Date.now() / 1000);
  useEffect(() => {
    document.title = "Cloak · NFT drops";
    const t = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!DROP_FACTORY) return setList([]);
    const c = dropsClient();
    c.list()
      .then((as) => Promise.all(as.reverse().map(async (a) => ({ ...(await c.get(a)), details: await c.details(a).catch(() => ({})) }))))
      .then(setList)
      .catch((e) => setErr(friendly(e)));
  }, []);
  const live = (list ?? []).filter((s) => s.phase === "gtd" || s.phase === "bidding");
  const opening = (list ?? []).filter((s) => s.phase === "reveal" || s.phase === "settle" || s.phase === "numbering");
  const done = (list ?? []).filter((s) => s.phase === "settled");
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>NFT drops</h1>
          <p>Sealed mints with no race, no bots and no gas war. Bid what you'd pay above the creator's price; every winner pays one price, and WL bids get a boost. Partner WL spots sell the same way.</p>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {SPOT_BOOK && <Link to="/app/drops/create?spots" className="btn btn-ghost">Sell WL spots</Link>}
          <Link to="/app/drops/create" className="btn btn-ink"><Icon.plus size={16} />Create a drop</Link>
        </div>
      </div>
      {err && <div className="err">{err}</div>}
      {!list ? (
        <p className="mute">Loading drops…</p>
      ) : !list.length ? (
        <div className="empty">
          <h3>No drops yet</h3>
          <p className="mute small">Be the first: a sealed drop takes a minute to set up.</p>
          <Link to="/app/drops/create" className="btn btn-ghost" style={{ marginTop: 10 }}>Create a drop</Link>
        </div>
      ) : (
        <>
          {[["Live now", live, "GTD minting or sealed bidding"], ["Opening bids", opening, "the keeper is opening and settling"], ["Ended", done, "sold, with refunds paid"]].map(([title, items, note]) =>
            (items as Row[]).length ? (
              <section key={title as string} className="tsection">
                <div className="tsection-head"><h2>{title as string} <span className="mute">{(items as Row[]).length}</span></h2><span className="xs mute">{note as string}</span></div>
                <div className="tgrid">{(items as Row[]).map((s) => <Card key={s.address} s={s} now={now} />)}</div>
              </section>
            ) : null,
          )}
        </>
      )}
    </div>
  );
}
