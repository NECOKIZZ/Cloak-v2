import { useEffect, useState } from "react";
import type { Address } from "viem";
import type { AuctionState } from "@cloak/sdk";
import { FACTORY } from "../config";
import { duration, hype, tokens } from "../format";
import { Link } from "../router";
import { readCloak } from "../wallet";

const PHASE: Record<string, [string, string]> = {
  commit: ["Sealed bidding", "ok"],
  reveal: ["Auto-revealing", "warn"],
  settle: ["Settling", "warn"],
  settled: ["Trading", ""],
};

export function Launches() {
  const [list, setList] = useState<AuctionState[] | null>(null);
  const [err, setErr] = useState("");
  const [now, setNow] = useState(Date.now() / 1000);
  useEffect(() => {
    if (!FACTORY) return;
    (async () => {
      const ls = await readCloak.listLaunches();
      const states = await Promise.all(ls.map((l) => readCloak.getAuction(l.auction as Address)));
      setList(states.reverse());
    })().catch((e) => setErr(e.shortMessage ?? e.message));
    const t = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Launches</h1>
          <p>Every launch is a sealed-bid auction. Nobody sees bids until bidding closes, everyone pays one price, and liquidity is locked at that price.</p>
        </div>
        <Link to="/app/create" className="btn btn-ink">Create a launch</Link>
      </div>
      {err && <div className="err">{err}</div>}
      {!FACTORY && <div className="empty"><h3>Not configured</h3>Set VITE_FACTORY for this deployment.</div>}
      {list === null && FACTORY && !err && <div className="empty">Loading launches from Elysium…</div>}
      {list?.length === 0 && <div className="empty"><h3>No launches yet</h3>Be the first: create a sealed-bid launch.</div>}
      <div className="launches">
        {list?.map((s) => {
          const [label, tone] = PHASE[s.phase];
          const t = s.phase === "commit" ? s.commitEnd - now : s.phase === "reveal" ? s.revealEnd - now : 0;
          return (
            <Link key={s.address} to={`/app/launch/${s.address}`} className="launch-item">
              <span className="token-avatar">{s.tokenSymbol.slice(0, 2)}</span>
              <span>
                <b style={{ fontWeight: 500 }}>{s.tokenName}</b> <span className="mute">${s.tokenSymbol}</span>
                <div className="xs mute" style={{ marginTop: 2 }}>
                  {s.settled ? `Cleared at ${hype(s.clearingPrice)} HYPE · ${tokens(s.sold)} sold · ${s.reveals} bidders` : `${tokens(s.saleSupply)} for sale · ${s.commits} sealed bids`}
                </div>
              </span>
              <span className="mono small mute">{t > 0 ? duration(t) : ""}</span>
              <span className={`pill ${tone}`}>{label}</span>
            </Link>
          );
        })}
      </div>
    </>
  );
}
