import { useEffect, useState } from "react";
import { formatEther, type Address } from "viem";
import { cloakPairAbi, type AuctionState } from "@cloakely/sdk";
import { FACTORY } from "../config";
import { duration, hype, pctChange } from "../format";
import { Link } from "../router";
import { TokenIcon } from "../ui";
import { friendly } from "../errors";
import { publicClient, readCloak } from "../wallet";
import { getSnapshot, save, saved } from "../snapshot";

const ZERO = "0x0000000000000000000000000000000000000000";
const FAILED_SHOWN = 6;

/** The price each trading launch has now, from the keeper's snapshot, else from its pool. */
async function pricesNow(list: AuctionState[]): Promise<Record<string, bigint>> {
  const snap = await getSnapshot();
  const out: Record<string, bigint> = {};
  for (const m of (snap?.markets ?? []) as { token: string; price: bigint }[]) out[m.token.toLowerCase()] = m.price;
  const missing = list.filter((s) => s.settled && !s.failed && s.pair !== ZERO && out[s.token.toLowerCase()] === undefined);
  await Promise.all(
    missing.map((s) =>
      publicClient.readContract({ address: s.pair, abi: cloakPairAbi, functionName: "price" }).then((p) => (out[s.token.toLowerCase()] = p), () => {}),
    ),
  );
  return out;
}

function change(now: bigint, from: bigint) {
  if (!from || !now) return null;
  const pct = (Number(formatEther(now)) / Number(formatEther(from)) - 1) * 100;
  return pct;
}

function Card({ s, price, now }: { s: AuctionState; price?: bigint; now: number }) {
  const trading = s.settled && !s.failed;
  const p = trading ? price ?? s.clearingPrice : s.minPrice;
  const ch = trading ? change(p, s.clearingPrice) : null;
  const left = s.phase === "commit" ? s.commitEnd - now : 0;
  return (
    <Link to={`/app/launch/${s.address}`} className="tcard">
      <TokenIcon symbol={s.tokenSymbol} token={s.token} size={48} />
      <div className="tcard-id">
        <b>{s.tokenName}</b>
        <span className="mute">${s.tokenSymbol}</span>
      </div>
      <div className="tcard-price">
        <span className="xs mute">{trading ? "Price" : s.failed ? "Start price" : "Starts at"}</span>
        <span className="mono">{hype(p)} <span className="xs mute">HYPE</span></span>
      </div>
      <div className="tcard-foot xs">
        {trading ? (
          (() => {
            const c = pctChange(ch);
            return c ? <span className={c.dir === "flat" ? "mute" : c.dir}>{c.text} since launch</span> : <span className="mute">Trading</span>;
          })()
        ) : s.failed ? (
          <span className="mute">Refunds open</span>
        ) : left > 0 ? (
          <span><span className="dot live" style={{ marginRight: 6 }} />Closes in <span className="mono">{duration(left)}</span></span>
        ) : (
          <span className="mute">Opening bids</span>
        )}
      </div>
    </Link>
  );
}

function Section({ title, note, items, count, prices, now, empty, more }: { title: string; count?: number; note: string; items: AuctionState[]; prices: Record<string, bigint>; now: number; empty?: string; more?: React.ReactNode }) {
  if (!items.length && !empty) return null;
  return (
    <section className="tsection">
      <div className="tsection-head">
        <h2>{title} <span className="mute">{count ?? items.length}</span></h2>
        <span className="xs mute">{note}</span>
      </div>
      {items.length ? <div className="tgrid">{items.map((s) => <Card key={s.address} s={s} price={prices[s.token.toLowerCase()]} now={now} />)}</div> : <div className="empty small">{empty}</div>}
      {more}
    </section>
  );
}

export function Launches() {
  // last visit's list at once, then the keeper's snapshot (or the chain)
  const [list, setList] = useState<AuctionState[] | null>(() => saved<AuctionState[]>("launches") ?? null);
  const [prices, setPrices] = useState<Record<string, bigint>>({});
  const [err, setErr] = useState("");
  const [now, setNow] = useState(Date.now() / 1000);
  const [allFailed, setAllFailed] = useState(false);
  const [q, setQ] = useState("");
  const term = q.trim().toLowerCase().replace(/^\$/, "");
  const match = (s: AuctionState) => !term || [s.tokenName, s.tokenSymbol, s.token, s.address].some((x) => x.toLowerCase().includes(term));
  useEffect(() => {
    if (!FACTORY) return;
    (async () => {
      const snap = await getSnapshot();
      const states = (snap?.launches as AuctionState[] | undefined) ?? (await Promise.all((await readCloak.listLaunches()).map((l) => readCloak.getAuction(l.auction as Address)))).reverse();
      setList(states);
      save("launches", states);
      setPrices(await pricesNow(states));
    })().catch((e) => setErr(friendly(e)));
    const t = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(t);
  }, []);

  const shown = (list ?? []).filter(match);
  const live = shown.filter((s) => !s.settled).sort((a, b) => a.commitEnd - b.commitEnd);
  const trading = shown.filter((s) => s.settled && !s.failed);
  const failed = shown.filter((s) => s.failed);
  const failedShown = allFailed || term ? failed : failed.slice(0, FAILED_SHOWN);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Launches</h1>
          <p>Fair launches with sealed bids. Everyone pays one price, and trading opens on Uniswap with its liquidity locked.</p>
        </div>
        <Link to="/app/create" className="btn btn-ink">Create a launch</Link>
      </div>
      {err && <div className="err">{err}</div>}
      {!FACTORY && <div className="empty"><h3>Not configured</h3>Set VITE_FACTORY for this deployment.</div>}
      {list === null && FACTORY && !err && <div className="empty">Loading launches…</div>}
      {list?.length === 0 && <div className="empty"><h3>No launches yet</h3>Be the first: create a sealed-bid launch.</div>}
      {!!list?.length && (
        <>
          <input className="input tsearch" placeholder="Search by name, ticker or contract address" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search launches" />
          {term && !shown.length && <div className="empty">Nothing matches "{q.trim()}".</div>}
          <Section title="Bidding now" note="Bids stay sealed until bidding closes" items={live} prices={prices} now={now} empty={term ? undefined : "No launch is taking bids right now."} />
          <Section title="Trading" note="Filled launches, newest first" items={trading} prices={prices} now={now} />
          <Section
            title="Didn't make it"
            note="No valid bids opened. Every deposit is refundable"
            items={failedShown}
            count={failed.length}
            prices={prices}
            now={now}
            more={!term && failed.length > FAILED_SHOWN && (
              <button className="btn btn-text btn-sm" style={{ marginTop: 10 }} onClick={() => setAllFailed(!allFailed)}>
                {allFailed ? "Show fewer" : `Show all ${failed.length}`}
              </button>
            )}
          />
        </>
      )}
    </>
  );
}
