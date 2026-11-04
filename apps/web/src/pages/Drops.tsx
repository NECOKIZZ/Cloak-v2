import { useEffect, useMemo, useState } from "react";
import type { DropDetails, DropState } from "@cloakely/sdk";
import { DROP_FACTORY, ESCROW_DROP_FACTORY, SPOT_BOOK } from "../config";
import { dropsClient, imageSrc, pct } from "../drops";
import { friendly } from "../errors";
import { duration, hype, short } from "../format";
import { Link } from "../router";
import { Icon } from "../ui";

export type Row = DropState & { details: DropDetails };

export function phaseText(s: DropState, now: number): { text: string; live: boolean } {
  if (s.phase === "gtd") return { text: s.hasGtd ? `GTD mint · bidding opens in ${duration(s.gtdEnd - now)}` : `Bidding opens in ${duration(s.gtdEnd - now)}`, live: true };
  if (s.phase === "bidding") return { text: `Sealed bidding · closes in ${duration(s.commitEnd - now)}`, live: true };
  if (s.phase === "reveal" || s.phase === "settle" || s.phase === "numbering") return { text: "Opening the sealed bids", live: false };
  if (s.failed) return { text: "Ended with no sale · refunds open", live: false };
  return { text: `Sold ${s.sold + s.gtdMinted} of ${s.supply}`, live: false };
}

/** A short status for a badge on artwork. */
export function phaseBadge(s: DropState, now: number): { text: string; tone: "live" | "soon" | "done" } {
  if (s.phase === "gtd") return s.hasGtd ? { text: `GTD live · ${duration(s.gtdEnd - now)}`, tone: "live" } : { text: `Opens in ${duration(s.gtdEnd - now)}`, tone: "soon" };
  if (s.phase === "bidding") return { text: `Bidding · ${duration(s.commitEnd - now)} left`, tone: "live" };
  if (s.phase === "reveal" || s.phase === "settle" || s.phase === "numbering") return { text: "Opening bids", tone: "soon" };
  if (s.failed) return { text: "No sale", tone: "done" };
  return { text: s.sold + s.gtdMinted >= s.supply ? "Sold out" : "Ended", tone: "done" };
}

export function DropArt({ details, name, size = 64, className = "" }: { details?: DropDetails; name: string; size?: number; className?: string }) {
  const src = imageSrc(details?.image);
  return src ? (
    <img className={`drop-art ${className}`} src={src} alt="" width={size} height={size} style={{ width: size, height: size }} />
  ) : (
    <span className={`drop-art drop-art-ph ${className}`} style={{ width: size, height: size, fontSize: size / 3 }}>{name.slice(0, 2).toUpperCase()}</span>
  );
}

/** The wide picture for a drop: its banner, else its artwork, else a brand gradient. */
export function coverStyle(details?: DropDetails): React.CSSProperties {
  const b = imageSrc(details?.banner);
  const a = imageSrc(details?.image);
  return b ? { backgroundImage: `url("${b}")` } : a ? ({ ["--img" as string]: `url("${a}")`, ["--blur" as string]: "1" } as React.CSSProperties) : {};
}

/** Sold so far, as a share of supply (for the progress bars). */
export const soldShare = (s: DropState) => Math.min(1, (s.sold + s.gtdMinted) / Math.max(1, s.supply));

function kindText(s: Row) {
  return s.details.spots ? `${s.supply.toLocaleString()} WL spot${s.supply > 1 ? "s" : ""} · ${s.details.spots.partner}` : s.escrow ? `${s.supply.toLocaleString()} existing NFT${s.supply > 1 ? "s" : ""}` : `${s.supply.toLocaleString()} items`;
}

function Card({ s, now }: { s: Row; now: number }) {
  const b = phaseBadge(s, now);
  const sold = s.settled && !s.failed;
  return (
    <Link to={`/app/drop/${s.address}`} className="dcard">
      <div className={`dcard-cover ${imageSrc(s.details.banner) || imageSrc(s.details.image) ? "" : "dcard-cover-ph"}`} style={coverStyle(s.details)}>
        <span className={`dbadge ${b.tone}`}>{b.tone === "live" && <span className="dot live" />}{b.text}</span>
        {s.details.spots && <span className="dbadge kind">WL spots</span>}
        {s.escrow && <span className="dbadge kind">Existing NFTs</span>}
      </div>
      <div className="dcard-body">
        <DropArt details={s.details} name={s.name} size={52} className="dcard-avatar" />
        <div className="dcard-title">
          <b>{s.name}</b>
          <span className="xs mute">by {short(s.creator)}{s.details.category ? ` · ${s.details.category}` : ""}</span>
        </div>
        <div className="dcard-stats">
          <div><span className="xs mute">{sold ? "Sold at" : "Floor"}</span><b className="mono">{hype(sold ? s.publicPrice : s.floor)} <small>HYPE</small></b></div>
          <div><span className="xs mute">{s.details.spots ? "Spots" : "Items"}</span><b className="mono">{s.supply.toLocaleString()}</b></div>
          <div><span className="xs mute">{s.settled ? "Sold" : "Sealed bids"}</span><b className="mono">{s.settled ? (s.sold + s.gtdMinted).toLocaleString() : s.bids}</b></div>
        </div>
        {s.settled ? (
          <div className="dprog" aria-label={`${Math.round(soldShare(s) * 100)}% sold`}><i style={{ width: `${soldShare(s) * 100}%` }} /></div>
        ) : (
          <p className="xs mute dcard-note">{s.hasWl && s.wlBoostBps ? `WL bids +${pct(s.wlBoostBps)} · ` : ""}{s.hasGtd ? "GTD then sealed bids" : "Sealed bids, one price for all"}</p>
        )}
      </div>
    </Link>
  );
}

function Featured({ s, now }: { s: Row; now: number }) {
  const b = phaseBadge(s, now);
  const sold = s.settled && !s.failed;
  return (
    <Link to={`/app/drop/${s.address}`} className="dfeat">
      <div className={`dfeat-cover ${imageSrc(s.details.banner) || imageSrc(s.details.image) ? "" : "dcard-cover-ph"}`} style={coverStyle(s.details)}>
        <span className={`dbadge ${b.tone}`}>{b.tone === "live" && <span className="dot live" />}{b.text}</span>
      </div>
      <div className="dfeat-bar">
        <DropArt details={s.details} name={s.name} size={96} className="dfeat-avatar" />
        <div className="dfeat-id">
          <span className="xs mute">{s.details.category ? `${s.details.category} · ` : ""}Elysium · {kindText(s)}</span>
          <h2>{s.name}</h2>
          <span className="small mute">by {short(s.creator)}</span>
        </div>
        <div className="dfeat-stats">
          <div><span className="xs mute">{sold ? "Sold at" : "Floor"}</span><b className="mono">{hype(sold ? s.publicPrice : s.floor)} <small>HYPE</small></b></div>
          <div><span className="xs mute">Sealed bids</span><b className="mono">{s.bids}</b></div>
          {s.hasWl && <div><span className="xs mute">WL boost</span><b className="mono">{pct(s.wlBoostBps)}</b></div>}
        </div>
        <span className="btn btn-ink dfeat-cta">View drop</span>
      </div>
    </Link>
  );
}

type Filter = "all" | "live" | "opening" | "ended";
const FILTERS: [Filter, string][] = [["all", "All"], ["live", "Live"], ["opening", "Opening bids"], ["ended", "Ended"]];
const group = (s: DropState): Filter => (s.phase === "gtd" || s.phase === "bidding" ? "live" : s.phase === "settled" ? "ended" : "opening");

/** Every sealed NFT drop: a featured one up top, then a gallery, live ones first. */
export function Drops() {
  const [list, setList] = useState<Row[] | null>(null);
  const [err, setErr] = useState("");
  const [now, setNow] = useState(Date.now() / 1000);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
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
  const order: Record<Filter, number> = { live: 0, opening: 1, ended: 2, all: 3 };
  const sorted = useMemo(() => [...(list ?? [])].sort((a, b) => order[group(a)] - order[group(b)]), [list]);
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: sorted.length, live: 0, opening: 0, ended: 0 };
    for (const s of sorted) c[group(s)]++;
    return c;
  }, [sorted]);
  // the featured drop: a live one with art if there is one, else the newest
  const featured = sorted.find((s) => group(s) === "live" && (s.details.banner || s.details.image)) ?? sorted.find((s) => group(s) === "live") ?? sorted[0];
  const needle = q.trim().toLowerCase();
  const shown = sorted.filter((s) => (filter === "all" || group(s) === filter) && (!needle || `${s.name} ${s.symbol} ${s.details.spots?.partner ?? ""}`.toLowerCase().includes(needle)));
  return (
    <div className="drops-page">
      <div className="page-head">
        <div>
          <h1>NFT drops</h1>
          <p>Sealed mints with no race, no bots and no gas war. Bid what you'd pay above the creator's price, every winner pays one price, and WL bids get a boost. Partner WL spots sell the same way.</p>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {SPOT_BOOK && <Link to="/app/drops/create?spots" className="btn btn-ghost">Sell WL spots</Link>}
          {ESCROW_DROP_FACTORY && <Link to="/app/drops/create?existing" className="btn btn-ghost">Auction your NFTs</Link>}
          <Link to="/app/drops/create" className="btn btn-ink"><Icon.plus size={16} />Create a drop</Link>
        </div>
      </div>
      {err && <div className="err">{err}</div>}
      {!list ? (
        <div className="dgrid">{Array.from({ length: 4 }, (_, i) => <div key={i} className="dcard dcard-skel" />)}</div>
      ) : !list.length ? (
        <div className="empty">
          <h3>No drops yet</h3>
          <p className="mute small">Be the first: a sealed drop takes a minute to set up.</p>
          <Link to="/app/drops/create" className="btn btn-ghost" style={{ marginTop: 10 }}>Create a drop</Link>
        </div>
      ) : (
        <>
          {featured && <Featured s={featured} now={now} />}
          <div className="dtoolbar">
            <div className="tabs dfilters" role="tablist">
              {FILTERS.map(([k, label]) => (
                <button key={k} role="tab" aria-selected={filter === k} className={`tab ${filter === k ? "on" : ""}`} onClick={() => setFilter(k)}>{label} <span className="mute">{counts[k]}</span></button>
              ))}
            </div>
            <input className="input dsearch" placeholder="Search drops" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search drops" />
          </div>
          {shown.length ? (
            <div className="dgrid">{shown.map((s) => <Card key={s.address} s={s} now={now} />)}</div>
          ) : (
            <p className="mute small" style={{ padding: "24px 0" }}>No drops here{needle ? ` match "${q.trim()}"` : ""}.</p>
          )}
        </>
      )}
    </div>
  );
}
