import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";
import { Cloak, cloakAuctionAbi, drandRoundTime, privateRouterAbi, type AuctionState } from "@cloakely/sdk";
import { BidCard, DemandChart, FairLaunchCard, MyBids, TradeCard } from "../components";
import { addrLink, KEEPER_URL, ROUTER } from "../config";
import { duration, hype, short, tokens } from "../format";
import { Link } from "../router";
import { useApp } from "../state";
import { LaunchRecord } from "./LaunchRecord";
import { friendly } from "../errors";
import { Icon, TokenIcon } from "../ui";
import { useTokenMeta } from "../tokenMeta";
import { publicClient, readCloak } from "../wallet";

type MyBidsT = Awaited<ReturnType<typeof readCloak.bidsOf>>;
const PHASES = [
  { k: "commit", label: "Sealed bidding" },
  { k: "reveal", label: "Auto-reveal" },
  { k: "settle", label: "Settle" },
  { k: "settled", label: "Trading" },
] as const;
const ZERO = "0x0000000000000000000000000000000000000000";

export function Launch({ auction }: { auction: Address }) {
  const { wallet, setError } = useApp();
  const [s, setS] = useState<AuctionState | null>(null);
  const [curve, setCurve] = useState<bigint[]>([]);
  const [mine, setMine] = useState<MyBidsT>([]);
  const [now, setNow] = useState(Date.now() / 1000);
  const [keeper, setKeeper] = useState<{ keeper: string } | null>(null);
  const [busy, setBusy] = useState("");
  const [privMarket, setPrivMarket] = useState<boolean | null>(null);
  const [notFound, setNotFound] = useState(false);
  const meta = useTokenMeta(auction);

  const refresh = useCallback(async () => {
    try {
      const [st, c] = await Promise.all([
        readCloak.getAuction(auction),
        publicClient.readContract({ address: auction, abi: cloakAuctionAbi, functionName: "demandCurve" }),
      ]);
      setS(st);
      setCurve([...c]);
      if (wallet) setMine(await readCloak.bidsOf(auction, wallet.account.address));
    } catch (e) {
      // no contract (or not an auction) at this address: show a clear page instead of an error banner
      if (/returned no data|"0x"|does not have the function|reverted/i.test(String((e as Error)?.message))) setNotFound(true);
      else setError(friendly(e));
    }
  }, [auction, wallet]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() / 1000), 250);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (KEEPER_URL) fetch(KEEPER_URL).then((r) => r.json()).then(setKeeper).catch(() => {});
  }, []);
  useEffect(() => {
    if (!ROUTER || !s?.settled) return;
    publicClient.readContract({ address: ROUTER, abi: privateRouterAbi, functionName: "poolOf", args: [s.token] }).then((p) => setPrivMarket(p !== ZERO)).catch(() => {});
  }, [s?.settled, s?.token]);

  async function run(label: string, fn: (c: Cloak) => Promise<unknown>) {
    if (!wallet) return;
    setBusy(label);
    try {
      await fn(new Cloak(publicClient, wallet));
      await refresh();
    } catch (e) {
      setError(friendly(e));
    } finally {
      setBusy("");
    }
  }

  async function enablePrivate() {
    if (!wallet || !ROUTER || !s) return;
    const n = await readCloak.listLaunches();
    const idx = n.findIndex((l) => l.auction.toLowerCase() === s.address.toLowerCase());
    if (idx < 0) return setError("This launch wasn't made with the Cloak factory, so it can't get private trading.");
    await run("enable", async () => {
      const h = await wallet.writeContract({ address: ROUTER!, abi: privateRouterAbi, functionName: "createPool", args: [BigInt(idx)] });
      await publicClient.waitForTransactionReceipt({ hash: h });
      setPrivMarket(true);
    });
  }

  if (notFound && !s)
    return (
      <div className="empty">
        <h3>No launch at this address</h3>
        <p className="mute small"><span className="mono">{short(auction)}</span> isn't a Cloak launch on this network. Check the link, or pick one from the list.</p>
        <Link to="/app" className="btn btn-ink" style={{ marginTop: 14 }}>See all launches</Link>
      </div>
    );
  if (!s) return <div className="empty">Loading launch {short(auction)}…</div>;
  const phaseIdx = PHASES.findIndex((p) => p.k === s.phase);
  const target = s.phase === "commit" ? s.commitEnd : s.phase === "reveal" ? s.revealEnd : 0;

  return (
    <>
      <div className="xs mute" style={{ marginBottom: 14 }}>
        <Link to="/app" className="arrow" style={{ display: "inline" }}>All launches</Link>
        <span style={{ margin: "0 8px" }}>·</span>
        {addrLink(s.address) ? <a href={addrLink(s.address)} target="_blank" rel="noreferrer" className="mono">{short(s.address)} ↗</a> : <span className="mono">{short(s.address)}</span>}
      </div>
      <div className="launch-hero">
        <div className="launch-title">
          <span className="eyebrow"><span className="dot live" style={{ marginRight: 8 }} />Sealed-bid launch</span>
          <h1 style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 16 }}><TokenIcon symbol={s.tokenSymbol} token={s.token} size={52} /><span style={{ color: "inherit" }}>{s.tokenName} <span>${s.tokenSymbol}</span></span></h1>
          {meta?.description && <p className="small soft" style={{ marginTop: 12, maxWidth: 560 }}>{meta.description}</p>}
          <p className="mute small" style={{ marginTop: 12, maxWidth: 520 }}>
            Bids stay sealed until bidding closes, hidden even from the sequencer. Every winner pays one clearing price, and liquidity is locked at that price.
          </p>
        </div>
        <div className="phase-card">
          <div className="phases">
            {PHASES.map((p, i) => <div key={p.k} className={`ph ${i === phaseIdx ? "on" : i < phaseIdx ? "done" : ""}`}>{p.label}</div>)}
          </div>
          {s.phase === "commit" || s.phase === "reveal" ? (
            <>
              <div className="small mute">{s.phase === "commit" ? "Bidding closes in" : "Reveal window closes in"}</div>
              <div className="countdown">{duration(target - now)}</div>
              {s.phase === "reveal" && <div className="xs mute">drand round #{s.tlockRound} published · {s.reveals}/{s.commits} bids opened</div>}
            </>
          ) : s.phase === "settle" ? (
            <>
              <div className="small mute">The reveal window has closed. Anyone can settle.</div>
              <button className="btn btn-ink" style={{ marginTop: 12 }} disabled={!wallet || !!busy} onClick={() => run("settle", (c) => c.settle(s.address))}>{busy === "settle" ? "Settling…" : "Settle launch"}</button>
            </>
          ) : s.failed ? (
            <>
              <div className="small mute">This launch didn't fill</div>
              <div className="countdown" style={{ fontSize: 28 }}>No clearing price</div>
              <div className="xs mute">Not enough valid bids above the minimum price. Every deposit is refundable in full.</div>
            </>
          ) : (
            <>
              <div className="small mute">Cleared at</div>
              <div className="countdown">{hype(s.clearingPrice)} <span className="small mute">HYPE / {s.tokenSymbol}</span></div>
            </>
          )}
        </div>
      </div>

      <div className="stats">
        <div className="stat"><div className="k">For sale</div><div className="v">{tokens(s.saleSupply)}</div></div>
        <div className="stat"><div className="k">Sealed bids</div><div className="v">{s.commits}</div></div>
        <div className="stat"><div className="k">Locked deposits</div><div className="v">{hype(s.totalDeposits)} <span className="small mute">HYPE</span></div></div>
        <div className="stat"><div className="k">Demand</div><div className="v">{s.phase === "commit" ? <span className="sealed" style={{ width: 90, height: 22 }} /> : tokens(s.totalDemand)}</div></div>
      </div>

      <div className="grid">
        <div className="col">
          <DemandChart s={s} curve={curve} />
          <FairLaunchCard s={s} />
          <MyBids s={s} wallet={wallet} bids={mine} onDone={refresh} />
          <LaunchRecord s={s} />
        </div>
        <div className="col">
          {s.phase === "commit" && <BidCard s={s} wallet={wallet} onDone={refresh} />}
          {s.phase !== "commit" && !s.settled && (
            <div className="card">
              <h3>Bidding is closed</h3>
              <p className="mute small" style={{ marginTop: 8 }}>
                Sealed bids open themselves. The drand beacon publishes round #{s.tlockRound}, and any keeper can decrypt and reveal every bid.
                {keeper && <> Keeper <span className="mono">{short(keeper.keeper)}</span> is online.</>}
              </p>
              {s.phase === "reveal" && s.reveals < s.commits && now >= drandRoundTime(s.tlockRound) && (
                <button className="btn btn-ghost btn-block" style={{ marginTop: 14 }} disabled={!wallet || !!busy} onClick={() => run("reveal", (c) => c.revealAll(s.address))}>
                  {busy === "reveal" ? "Opening bids with the beacon…" : wallet ? "Open all sealed bids yourself" : "Connect to open bids"}
                </button>
              )}
            </div>
          )}
          {s.settled && !s.failed && s.pair !== ZERO && (
            <div className="card" style={{ background: "var(--signal-soft)", borderColor: "transparent" }}>
              <div className="card-head"><h3>Trade privately</h3><Icon.lock /></div>
              <p className="small soft">Hold, buy and sell ${s.tokenSymbol} from a private balance. Your wallet never appears on the trade, and batch mode hides how much you traded.</p>
              {privMarket === false ? (
                <button className="btn btn-ink btn-block" style={{ marginTop: 14 }} disabled={!wallet || !!busy} onClick={enablePrivate}>{busy === "enable" ? "Creating private market…" : wallet ? "Enable private trading" : "Connect a wallet"}</button>
              ) : (
                <Link to={`/app/trade?token=${s.token}`} className="btn btn-ink btn-block" style={{ marginTop: 14 }}>Trade ${s.tokenSymbol} privately</Link>
              )}
            </div>
          )}
          <TradeCard s={s} wallet={wallet} />
        </div>
      </div>
    </>
  );
}
