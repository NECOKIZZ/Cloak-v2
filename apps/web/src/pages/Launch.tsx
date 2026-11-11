import { useCallback, useEffect, useState } from "react";
import { PageSkel, Skel } from "../skel";
import { formatEther, parseAbi, parseEther, type Address } from "viem";
import { Cloak, cloakAuctionAbi, cloakPairAbi, cloakTokenAbi, drandRoundTime, type AuctionState } from "@cloakely/sdk";
import { BidCard, DemandChart, FairLaunchCard, MyBids, TradeCard } from "../components";
import { CreatorFeesCard, CreatorProceedsCard, DemandMeter, PrivateBids } from "../launchParts";
import { addrLink, GLOAM, KEEPER_URL } from "../config";
import { duration, hype, pctChange, short } from "../format";
import { PriceChart, usePrice } from "../chart";
import { Link, useRoute } from "../router";
import { useApp } from "../state";
import { LaunchRecord } from "./LaunchRecord";
import { friendly } from "../errors";
import { Icon, TokenIcon } from "../ui";
import { launchCreatedLogs, useTokenMeta } from "../tokenMeta";
import { publicClient, readCloak } from "../wallet";
import { every } from "../every";
import { GloakCard, useGloak } from "../gloak";
import { LaunchTerms } from "../launchTerms";

type MyBidsT = Awaited<ReturnType<typeof readCloak.bidsOf>>;
const ZERO = "0x0000000000000000000000000000000000000000";
const LAUNCH_VAULT = parseAbi(["function isLaunchToken(address) view returns (bool)", "function admitLaunch(uint256 launchIndex) returns (address)"]);
const DEAD = "0x000000000000000000000000000000000000dEaD";

/** Copy the launch's link, or post it on X. Shared links show the token's name, image and status as a preview. */
function Share({ s, big }: { s: AuctionState; big?: boolean }) {
  const { toast } = useApp();
  const url = `${location.origin}/app/launch/${s.address}`;
  const text =
    s.phase === "commit"
      ? `Bid on $${s.tokenSymbol} on Cloak. Sealed bids nobody can see until bidding closes, and every winner pays one price`
      : s.settled && !s.failed
        ? `$${s.tokenSymbol} launched on Cloak with a sealed-bid auction and now trades privately`
        : `$${s.tokenSymbol} on Cloak`;
  const size = big ? "" : "btn-sm";
  return (
    <span className="row-flex" style={{ gap: 8 }}>
      <button className={`btn btn-ghost ${size}`} onClick={() => { navigator.clipboard?.writeText(url).catch(() => {}); toast("Launch link copied"); }}><Icon.copy size={14} />Copy link</button>
      <a className={`btn btn-ghost ${size}`} href={`https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`} target="_blank" rel="noreferrer">Share on X</a>
      <a className={`btn btn-ghost ${size}`} href={`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`} target="_blank" rel="noreferrer">Telegram</a>
      {/* phones: the system share sheet (WhatsApp, Discord, messages) */}
      {typeof navigator !== "undefined" && "share" in navigator && <button className={`btn btn-ghost ${size}`} onClick={() => navigator.share({ title: `$${s.tokenSymbol} on Cloak`, text, url }).catch(() => {})}>More</button>}
    </span>
  );
}

export function Launch({ auction }: { auction: Address }) {
  const { wallet, setError, toast } = useApp();
  const { query } = useRoute();
  const [isNew, setIsNew] = useState(query.get("new") === "1");
  const gloak = useGloak();
  const [s, setS] = useState<AuctionState | null>(null);
  const [curve, setCurve] = useState<bigint[]>([]);
  const [mine, setMine] = useState<MyBidsT>([]);
  const [now, setNow] = useState(Date.now() / 1000);
  const [keeper, setKeeper] = useState<{ keeper: string } | null>(null);
  const [busy, setBusy] = useState("");
  const [privMarket, setPrivMarket] = useState<boolean | "soon" | null>(null);
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
    return every(refresh, 4000);
  }, [refresh]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() / 1000), 250);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (KEEPER_URL) fetch(KEEPER_URL).then((r) => r.json()).then(setKeeper).catch(() => {});
  }, []);
  useEffect(() => {
    if (!s?.settled) return;
    if (!GLOAM) return;
    // the keeper admits every settled launch to the launch vault by itself (review W-09); anyone can do it too
    publicClient
      .readContract({ address: GLOAM.launchVault, abi: LAUNCH_VAULT, functionName: "isLaunchToken", args: [s.token] })
      .then((ok) => setPrivMarket(ok ? true : "soon"))
      .catch(() => {});
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

  /** Admits this settled launch to the launch vault now (permissionless; the keeper does it too, a minute or two later). */
  async function enablePrivate() {
    if (!wallet || !GLOAM || !s) return;
    const l = (await readCloak.listLaunches()).find((x) => x.auction.toLowerCase() === s.address.toLowerCase());
    if (!l) return setError("This launch wasn't made with Cloak's factory, so it can't get private trading.");
    await run("enable", async () => {
      const h = await wallet.writeContract({ address: GLOAM!.launchVault, abi: LAUNCH_VAULT, functionName: "admitLaunch", args: [l.index] });
      await publicClient.waitForTransactionReceipt({ hash: h });
      setPrivMarket(true);
    });
  }

  if (notFound && !s)
    return (
      <div className="empty">
        <h3>No launch at this address</h3>
        <p className="mute small"><span className="mono">{short(auction)}</span> isn't a Cloak launch on this network. Check the link, or pick one from the list.</p>
        <Link to="/app/launches" className="btn btn-ink" style={{ marginTop: 14 }}>See all launches</Link>
      </div>
    );
  if (!s) return <PageSkel label={`Loading launch ${short(auction)}`} />;
  const trading = s.settled && !s.failed;
  const status: [string, string] = s.failed ? ["Didn't fill", "warn"] : s.settled ? ["Trading", "ok"] : s.phase === "commit" ? ["Bidding open", "ok"] : ["Opening bids", "warn"];
  const hasPool = trading && s.pair !== ZERO;
  const uni = BigInt(s.uniPair ?? 0) !== 0n;

  return (
    <>
      <div className="xs mute row-flex" style={{ marginBottom: 14, gap: 12 }}>
        <Link to="/app/launches" className="back-btn" style={{ marginBottom: 0 }}><span aria-hidden>←</span>All launches</Link>
      </div>
      {isNew && (
        <div className="card" style={{ marginBottom: 20, display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <Icon.check size={20} />
          <div style={{ flex: 1, minWidth: 220 }}>
            <h3>Your launch is live</h3>
            <p className="small mute" style={{ margin: "4px 0 0" }}>Share the link so people can bid. It shows ${s.tokenSymbol}'s name, image and countdown wherever you post it.</p>
          </div>
          <button className="btn btn-text xs" onClick={() => setIsNew(false)} aria-label="Dismiss">✕</button>
        </div>
      )}

      <div className="card token-card">
        <TokenIcon symbol={s.tokenSymbol} token={s.token} size={64} />
        <div className="token-card-main">
          <div className="token-card-title">
            <h1>{s.tokenName}</h1>
            <span className="tc-ticker">${s.tokenSymbol}</span>
            <span className={`pill ${status[1]}`}>{status[0]}</span>
            {gloak.is(s.token) && <span className="pill" title="Free to trade privately; 10% burned when it leaves for a wallet">Private-only</span>}
          </div>
          <div className="token-card-ca">
            <span className="mute">Contract</span>
            <button className="ca-btn mono" onClick={() => { navigator.clipboard?.writeText(s.token).catch(() => {}); toast("Contract address copied"); }} title="Copy the token's contract address">
              {short(s.token)} <Icon.copy size={13} />
            </button>
            {addrLink(s.token) && <a href={addrLink(s.token)} target="_blank" rel="noreferrer" className="link">Explorer ↗</a>}
            {uni && trading && <a href={addrLink(s.uniPair)} target="_blank" rel="noreferrer" className="link">{s.pool === "v4" ? "Uniswap v4 pool ↗" : "Uniswap pool ↗"}</a>}
            {!s.settled && <span className="mute">Uniswap v4 pool opens when the launch settles</span>}
          </div>
          {meta?.description && <p className="token-card-desc">{meta.description}</p>}
        </div>
        <div className="token-card-share"><Share s={s} /></div>
      </div>

      <div className="grid">
        <div className="col">
          {s.phase === "commit" && <DemandMeter s={s} now={now} />}
          {(s.phase === "reveal" || s.phase === "settle") && (
            <div className="card">
              <div className="card-head"><h3>Opening the bids</h3><span className="pill warn">{s.reveals} of {s.commits} open</span></div>
              <div className="progress"><i style={{ width: `${s.commits ? (s.reveals / s.commits) * 100 : 100}%` }} /></div>
              <p className="small mute" style={{ margin: "12px 0 0" }}>
                {s.phase === "reveal"
                  ? <>Bidding has closed. Every sealed bid now opens itself with a public time-lock key, so nobody can change or pull a bid. Trading starts in about <b className="mono">{duration(s.revealEnd - now)}</b>.</>
                  : "Every bid that could open has opened. The launch settles at one price next, then trading starts."}
              </p>
              <Unopenable auction={s.address} live={s.phase === "reveal"} />
            </div>
          )}
          {hasPool && <Market s={s} />}
          {s.failed && (
            <div className="card">
              <h3>This launch didn't fill</h3>
              <p className="small mute" style={{ margin: "8px 0 0" }}>No valid bids opened, so nothing was sold. Every deposit comes back in full, and the tokens went back to the creator.</p>
            </div>
          )}
          <MyBids s={s} wallet={wallet} bids={mine} onDone={refresh} />
          <PrivateBids s={s} onDone={refresh} />
        </div>
        <div className="col">
          {s.phase === "commit" && <BidCard s={s} wallet={wallet} onDone={refresh} />}
          {s.phase !== "commit" && !s.settled && (
            <div className="card">
              <h3>Bidding is closed</h3>
              <p className="mute small" style={{ marginTop: 8 }}>
                Nothing to do. Your bid opens and settles by itself, then you claim your tokens here.
                {keeper && <> The keeper that does this is online.</>}
              </p>
              {s.phase === "reveal" && s.reveals < s.commits && now >= drandRoundTime(s.tlockRound) && (
                <button className="btn btn-ghost btn-block" style={{ marginTop: 14 }} disabled={!wallet || !!busy} onClick={() => run("reveal", (c) => c.revealAll(s.address))}>
                  {busy === "reveal" ? "Opening bids…" : wallet ? "Open the bids yourself" : "Connect to open bids"}
                </button>
              )}
              {s.phase === "settle" && (
                <button className="btn btn-ink btn-block" style={{ marginTop: 14 }} disabled={!wallet || !!busy} onClick={() => run("settle", (c) => c.settle(s.address))}>{busy === "settle" ? "Settling…" : wallet ? "Settle it now" : "Connect to settle"}</button>
              )}
            </div>
          )}
          {hasPool && (
            <div className="card" style={{ background: "var(--signal-soft)", borderColor: "transparent" }}>
              <div className="card-head"><h3>Trade privately</h3><Icon.lock /></div>
              <p className="small soft" style={{ margin: 0 }}>Buy and sell ${s.tokenSymbol} from your private balance. Your wallet never shows up on the trade.</p>
              {privMarket === "soon" ? (
                <>
                  <p className="small mute" style={{ marginTop: 14 }}>Private trading opens in a minute or two, once the keeper adds this token to the private vault. You can also open it now.</p>
                  {wallet && <button className="btn btn-ghost btn-block" style={{ marginTop: 8 }} disabled={!!busy} onClick={enablePrivate}>{busy === "enable" ? "Opening private trading…" : "Open private trading now"}</button>}
                </>
              ) : (
                <Link to={`/app/trade?token=${s.token}`} className="btn btn-ink btn-block" style={{ marginTop: 14 }}>Trade ${s.tokenSymbol} privately</Link>
              )}
            </div>
          )}
          {gloak.is(s.token) ? <GloakCard info={gloak.info} /> : <TradeCard s={s} wallet={wallet} />}
          <CreatorProceedsCard s={s} wallet={wallet} />
          <CreatorFeesCard s={s} wallet={wallet} />
        </div>
      </div>
      <Details s={s} curve={curve} />
    </>
  );
}

/** Price, change since launch, chart and the numbers traders look for. */
function Market({ s }: { s: AuctionState }) {
  const pts = usePrice(s);
  const [info, setInfo] = useState<{ supply: bigint; reserve: bigint } | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      Promise.all([
        publicClient.readContract({ address: s.token, abi: cloakTokenAbi, functionName: "totalSupply" }),
        // unsold and unused tokens are burned to the dead address: they still count in totalSupply, never in the market cap
        publicClient.readContract({ address: s.token, abi: cloakTokenAbi, functionName: "balanceOf", args: [DEAD] }),
        publicClient.readContract({ address: s.pair, abi: cloakPairAbi, functionName: "reserveHype" }),
      ]).then(([total, burned, reserve]) => alive && setInfo({ supply: total - burned, reserve }), () => {});
    load();
    const stop = every(load, 20_000);
    return () => {
      alive = false;
      stop();
    };
  }, [s.token, s.pair]);
  const last = pts?.at(-1)?.p;
  const clear = Number(formatEther(s.clearingPrice));
  const ch = last !== undefined && clear > 0 ? (last / clear - 1) * 100 : null;
  const priceWei = last !== undefined ? parseEther(last.toFixed(18).replace(/0+$/, "").replace(/\.$/, "") || "0") : s.clearingPrice;
  return (
    <div className="card">
      <div className="market-top">
        <div>
          <div className="xs mute">Price</div>
          <div className="market-price">{hype(priceWei)} <span className="small mute">HYPE</span></div>
          {(() => {
            const c = pctChange(ch);
            return c && <div className={`small ${c.dir === "flat" ? "mute" : c.dir}`}>{c.dir === "flat" ? "Same as the launch price" : `${c.text} since launch`}</div>;
          })()}
        </div>
        <div className="market-stats">
          <div><span className="xs mute">Market cap</span><span className="mono">{info ? `${hype((priceWei * info.supply) / 10n ** 18n, 2)} HYPE` : "—"}</span></div>
          <div><span className="xs mute">Liquidity</span><span className="mono">{info ? `${hype(info.reserve * 2n, 2)} HYPE` : "—"}</span></div>
          <div><span className="xs mute">Launch price</span><span className="mono">{hype(s.clearingPrice)}</span></div>
        </div>
      </div>
      {pts === null ? <Skel h={160} /> : <PriceChart pts={pts} clearing={s.clearingPrice} />}
    </div>
  );
}

/** The launch's own story, out of the way until someone wants it: results, the demand behind the price, every transaction. */
function Details({ s, curve }: { s: AuctionState; curve: bigint[] }) {
  const tabs = [
    ["terms", "Terms and maths"],
    ...(s.settled && !s.failed ? [["results", "Launch results"]] : []),
    ...(s.phase !== "commit" ? [["demand", "Bids by price"]] : []),
    ["record", "On-chain record"],
  ] as [string, string][];
  // always open: the terms while bidding is open, the results once it settles, unless someone picks another tab
  const [tab, setTab] = useState(s.settled && !s.failed ? "results" : "terms");
  const open = tabs.some((t) => t[0] === tab) ? tab : "terms";
  return (
    <div className="details" style={{ marginTop: 20 }}>
      <div className="tabs details-tabs" role="tablist">
        {tabs.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={open === k} className={`tab ${open === k ? "on" : ""}`} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>
      {open === "terms" && <LaunchTerms s={s} />}
      {open === "results" && <FairLaunchCard s={s} />}
      {open === "demand" && <DemandChart s={s} curve={curve} />}
      {open === "record" && <LaunchRecord s={s} />}
    </div>
  );
}

/**
 * Sealed bids the public time-lock key couldn't open (the keeper publishes them once the drand round passes). Only
 * their bidders can still reveal them, after seeing every other reveal, so everyone should see that they exist.
 */
function Unopenable({ auction, live }: { auction: Address; live: boolean }) {
  const [n, setN] = useState<{ count: number; deposit: bigint } | null>(null);
  useEffect(() => {
    if (!KEEPER_URL) return;
    let alive = true;
    const go = () =>
      fetch(`${(KEEPER_URL ?? "").replace(/\/+$/, "")}/unopenable?auction=${auction}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { checked?: boolean; bids?: { deposit: string }[] } | null) => {
          if (alive && j?.checked) setN({ count: j.bids?.length ?? 0, deposit: (j.bids ?? []).reduce((a, b) => a + BigInt(b.deposit), 0n) });
        })
        .catch(() => {});
    go();
    const stop = live ? every(go, 60_000) : undefined;
    return () => {
      alive = false;
      stop?.();
    };
  }, [auction, live]);
  if (!n || n.count === 0) return null;
  return (
    <p className="small" style={{ margin: "10px 0 0" }}>
      <b>{n.count} sealed {n.count === 1 ? "bid" : "bids"} ({hype(n.deposit)} HYPE deposited) couldn't be opened by the time-lock key.</b> Only {n.count === 1 ? "its bidder" : "their bidders"} can still reveal {n.count === 1 ? "it" : "them"} before the window closes. A bid that stays sealed loses its penalty.
    </p>
  );
}
