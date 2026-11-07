import { useEffect, useState } from "react";
import { erc20Abi, formatEther, formatUnits, isAddress, parseUnits, type Address, type Hex } from "viem";
import { CloakPrivate, shieldedPoolAbi } from "@cloakely/sdk";
import { ASSETS, CHAIN_ID, CLOAK_TOKEN, MIGRATOR, PREVIOUS, RECEIVE, txLink } from "../config";
import { publicClient } from "../wallet";
import { hype, tokens, usd } from "../format";
import { getProver, getSharedProver, useApp } from "../state";
import { friendly, Hint } from "../errors";
import { markDone } from "../guide";
import { Link, navigate, useRoute } from "../router";
import { Icon, TokenIcon } from "../ui";
import { recipientNow } from "../names";
import { RecipientNote } from "../recipient";
import { TokenPicker, type PickerOption } from "../tokenPicker";
import { useFeePct, useMarkets, type Market } from "./markets";
import { usePrivateBalances } from "../balances";
import { schedule, useScheduled } from "../scheduled";
import { Skel } from "../skel";

type Kind = "shield" | "send" | "withdraw";
type Key = "HYPE" | Address;

/** One asset as the portfolio shows it: HYPE, a dollar stablecoin (USDC) or a launch token. */
interface Asset {
  key: Key;
  symbol: string;
  name: string;
  /** For the icon: launch tokens only (HYPE and USDC use built-in marks). */
  iconToken?: Address;
  decimals: number;
  kind: "hype" | "stable" | "launch";
  market?: Market;
}

// ───────────── shared data ─────────────

let pxCache: { at: number; px: number } | null = (() => {
  try {
    const n = Number(localStorage.getItem("cloak.hypeUsd"));
    return n > 0 ? { at: 0, px: n } : null; // last visit's price, shown at once and refreshed right away
  } catch {
    return null;
  }
})();
/** HYPE's dollar price (Hyperliquid's mid, the same price the relayer uses), refreshed every minute. */
function useHypeUsd(): number | null {
  const [px, setPx] = useState<number | null>(pxCache?.px ?? null);
  useEffect(() => {
    let alive = true;
    const go = async () => {
      if (pxCache && Date.now() - pxCache.at < 60_000) return alive && setPx(pxCache.px);
      try {
        const r = await fetch("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "allMids" }) });
        const n = Number((await r.json()).HYPE);
        if (n > 0) {
          pxCache = { at: Date.now(), px: n };
          try {
            localStorage.setItem("cloak.hypeUsd", String(n));
          } catch {}
          if (alive) setPx(n);
        }
      } catch {}
    };
    go();
    const t = setInterval(go, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return px;
}

function useAssets(): Asset[] {
  const { markets } = useMarkets();
  return [
    { key: "HYPE", symbol: "HYPE", name: "Hyperliquid", decimals: 18, kind: "hype" },
    ...ASSETS.map((x): Asset => ({ key: x.token, symbol: x.symbol, name: x.symbol === "USDC" ? "USD Coin" : x.symbol, decimals: x.decimals, kind: "stable" })),
    ...(markets ?? []).map((m): Asset => ({ key: m.token, symbol: m.symbol, name: m.name, iconToken: m.token, decimals: 18, kind: "launch", market: m })),
  ];
}

/** Dollar value of an amount (null when there's no price for it). */
function valueUsd(a: Asset, amount: bigint, px: number | null): number | null {
  if (a.kind === "stable") return Number(formatUnits(amount, a.decimals));
  if (px === null) return null;
  if (a.kind === "hype") return Number(formatEther(amount)) * px;
  return a.market ? Number(formatEther(amount)) * Number(formatEther(a.market.price)) * px : null;
}
const dollars = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const amountOf = (a: Asset, x: bigint) => (a.kind === "hype" ? hype(x) : a.kind === "stable" ? usd(x, a.decimals) : tokens(x));

function Locked({ title, back }: { title: string; back?: boolean }) {
  const { wallet, connect, unlock, unlocking } = useApp();
  return (
    <>
      {back && <Link to="/app" className="back-btn"><span aria-hidden>←</span>Back to Portfolio</Link>}
      <div className="page-head"><div><h1>{title}</h1><p>Your private balance, visible only to you.</p></div></div>
      <div className="card wallet-hero">
        <div className="row-flex"><span className="soft">Private balance</span><span className="pill ok"><Icon.lock size={12} />Only you</span></div>
        <div className="wallet-total mute">$0.00</div>
        <p className="small mute" style={{ margin: "0 0 18px" }}>{wallet ? "Sign one message (free, no transaction) to unlock your private account on this device." : "Connect a wallet to see your private balance."}</p>
        <button className="btn btn-ink" disabled={unlocking} onClick={() => (wallet ? unlock() : connect().then((w) => w && unlock(w)))}>
          {unlocking ? "Sign in your wallet…" : wallet ? "Unlock private account" : "Connect wallet"}
        </button>
      </div>
    </>
  );
}

// ───────────── the portfolio ─────────────

export function Portfolio() {
  const { wallet, priv, privAddress, toast } = useApp();
  const assets = useAssets();
  const { bals, refresh, loaded, synced } = usePrivateBalances();
  const px = useHypeUsd();
  const [moveMsg, setMoveMsg] = useState<{ busy?: string; ok?: string; err?: string }>({});
  const anyHeld = Object.values(bals).some((b) => b > 0n);
  useEffect(() => {
    if (anyHeld) markDone("shield");
  }, [anyHeld]);

  /** Move private balances from every earlier Cloak deployment (one extra signature each, for that version's keys). */
  async function moveOld() {
    if (!priv || !wallet) return;
    try {
      await getProver();
      let n = 0;
      for (const p of PREVIOUS) {
        setMoveMsg({ busy: `Sign once more to open your v${p.version} private account…` });
        const keys = await CloakPrivate.keysForVersion(wallet, { chainId: CHAIN_ID, version: p.version, router: p.router });
        const legacy = new CloakPrivate(publicClient, p.router, keys, getProver, priv.submit, p.routerBlock);
        // vaults that version kept outside its router (v2's USDC vault)
        for (const x of p.pools ?? []) {
          const token = await publicClient.readContract({ address: x.pool, abi: shieldedPoolAbi, functionName: "token" });
          const a = ASSETS.find((y) => y.token.toLowerCase() === token.toLowerCase());
          legacy.addAsset({ symbol: a?.symbol ?? "token", token, pool: x.pool, decimals: a?.decimals ?? 18, fromBlock: x.fromBlock });
        }
        n += (await priv.migrateFrom(legacy, (m) => setMoveMsg({ busy: `v${p.version}: ${m}` }))).length;
      }
      setMoveMsg({ ok: n ? `Moved ${n} private balance${n > 1 ? "s" : ""} into the permanent vaults.` : "Nothing to move: your old private accounts are empty." });
      refresh();
    } catch (e) {
      setMoveMsg({ err: friendly(e) });
    }
  }

  if (!wallet || !priv) return <Locked title="Portfolio" />;

  // only what's held, biggest dollar value first
  const held = assets
    .filter((a) => (bals[a.key] ?? 0n) > 0n)
    .map((a) => ({ a, bal: bals[a.key]!, v: valueUsd(a, bals[a.key]!, px) }))
    .sort((x, y) => (y.v ?? -1) - (x.v ?? -1));
  const total = held.reduce((s, h) => s + (h.v ?? 0), 0);
  const unpriced = held.some((h) => h.v === null);
  const copy = () => {
    navigator.clipboard?.writeText(privAddress).catch(() => {});
    toast("Cloak address copied");
  };

  return (
    <>
      <div className="page-head"><div><h1>Portfolio</h1><p>Only you can see these balances. On-chain they're encrypted notes in shared vaults.</p></div></div>
      <div className="card wallet-hero">
        <div className="row-flex"><span className="soft">Private balance</span><span className="pill ok"><Icon.lock size={12} />Only you</span></div>
        <div className="wallet-total">{!loaded || (px === null && held.some((h) => h.a.kind !== "stable")) ? <Skel w="5.5ch" /> : <span className="fade-in" key={dollars(total)}>{dollars(total)}</span>}</div>
        <p className="xs mute" style={{ margin: 0 }}>
          {!loaded ? "Syncing your private balance. The first time on a device can take a minute." : !synced ? <span className="updating">Updating from the chain</span> : held.length ? `${held.length} asset${held.length > 1 ? "s" : ""}, valued at HYPE's market price${unpriced ? " (some without a price yet)" : ""}. Testnet balances are play money.` : "Nothing private yet. Shield HYPE, USDC or CLOAK to start."}
        </p>
        <div className="wallet-actions">
          <Link to="/app/portfolio/shield" className="btn btn-ink"><Icon.plus size={16} />Shield</Link>
          <Link to="/app/portfolio/send" className="btn btn-ghost"><Icon.send size={16} />Send privately</Link>
          <Link to="/app/portfolio/withdraw" className="btn btn-ghost"><Icon.arrowDown size={16} />Withdraw</Link>
          {RECEIVE && <Link to="/app/portfolio/receive" className="btn btn-ghost"><Icon.wallet size={16} />Receive</Link>}
          <button className="btn btn-ghost" onClick={copy} title={privAddress}><Icon.copy size={16} />Copy cloak address</button>
        </div>
      </div>

      <div className="grid">
        <div className="card">
          <div className="card-head"><h3>Assets</h3><span className="xs mute">PRIVATE</span></div>
          {!loaded ? (
            <div className="asset-list" aria-busy="true" aria-label="Loading your balances">
              {[0, 1, 2].map((i) => (
                <div key={i} className="asset-row">
                  <Skel w={34} h={34} round />
                  <div className="nm"><Skel w="6ch" /><Skel w="9ch" h={11} /></div>
                  <div className="amt"><Skel w="8ch" /><Skel w="5ch" h={11} /></div>
                </div>
              ))}
            </div>
          ) : held.length === 0 ? (
            <div className="empty" style={{ padding: "36px 20px" }}>
              <p style={{ margin: "0 0 14px" }}>Shield HYPE, USDC or CLOAK, then swap privately into any launch token.</p>
              <Link to="/app/portfolio/shield" className="btn btn-ink btn-sm">Shield</Link>
            </div>
          ) : (
            <div className="asset-list">
              {held.map(({ a, bal, v }) => (
                <div key={a.key} className="asset-row">
                  <TokenIcon symbol={a.symbol} token={a.iconToken} size={34} />
                  <div className="nm"><b>{a.symbol}</b><span className="xs mute">{a.name}</span></div>
                  <div className="amt"><b className="mono">{amountOf(a, bal)}</b><span className="xs mute">{v === null ? a.symbol : dollars(v)}</span></div>
                  <div className="asset-acts">
                    {a.market && <Link to={`/app/trade?token=${a.key}&side=sell`} className="btn btn-ghost btn-xs" title={`Swap ${a.symbol} for HYPE privately`}>Swap</Link>}
                    <Link to={`/app/portfolio/withdraw?token=${a.key}`} className="btn btn-ghost btn-xs" title={`Withdraw ${a.symbol} to a wallet`}>Withdraw</Link>
                  </div>
                </div>
              ))}
            </div>
          )}
          <p className="note">Shield HYPE, USDC or CLOAK, then <Link to="/app/trade" className="link">swap privately</Link> into other tokens.</p>
        </div>
        <div className="col">
          {MIGRATOR && PREVIOUS.length > 0 && (
            <div className="card">
              <div className="card-head"><h3>Balance in the old vaults?</h3><Icon.lock size={16} /></div>
              <p className="small mute">Cloak's vaults are now permanent, and your private account stays the same from here on. If you held a private balance in an earlier version, move it here once. It stays private, and nobody can redirect it.</p>
              <button className="btn btn-ghost btn-sm" disabled={!!moveMsg.busy} onClick={moveOld}>{moveMsg.busy ?? "Move my old balance"}</button>
              {moveMsg.ok && <div className="okmsg">{moveMsg.ok}</div>}
              {moveMsg.err && <div className="err">{moveMsg.err}</div>}
            </div>
          )}
          <ScheduledCard />
          <Tips />
        </div>
      </div>
    </>
  );
}

/** Withdrawals sent in pieces: what's still waiting, what went out. */
function ScheduledCard() {
  const items = useScheduled();
  if (!items.length) return null;
  const at = (t: number) => new Date(t * 1000).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
  return (
    <div className="card">
      <div className="card-head"><h3>Scheduled withdrawals</h3><span className="xs mute">{items.filter((x) => (x.status?.state ?? "waiting") === "waiting").length} waiting</span></div>
      <div className="asset-list">
        {items.map((x) => {
          const st = x.status?.state ?? "waiting";
          return (
            <div key={x.id} className="asset-row">
              <div className="nm"><b className="mono">{formatUnits(x.piece.amount, x.decimals)} {x.symbol}</b><span className="xs mute">to {x.piece.to.slice(0, 6)}…{x.piece.to.slice(-4)}</span></div>
              <div className="amt">
                <span className={`pill ${st === "sent" ? "ok" : st === "dropped" ? "warn" : ""}`}>{st === "sent" ? "Sent" : st === "dropped" ? "Not sent" : "Waiting"}</span>
                <span className="xs mute">{st === "sent" && x.status?.txHash && txLink(x.status.txHash) ? <a href={txLink(x.status.txHash)} target="_blank" rel="noreferrer">View tx ↗</a> : st === "dropped" ? x.status?.error ?? "" : `around ${at(x.piece.notBefore)}`}</span>
              </div>
            </div>
          );
        })}
      </div>
      <p className="note">The relayer sends each piece at its time, even with Cloak closed. It can't change where any piece goes.</p>
    </div>
  );
}

function Tips() {
  return (
    <div className="card flat">
      <h3>Tips for staying private</h3>
      <ul className="small soft" style={{ paddingLeft: 18, margin: "10px 0 0", display: "grid", gap: 6 }}>
        <li>Wait a bit between shielding and trading.</li>
        <li>Don't trade the exact amount you just shielded.</li>
        <li>Use batch mode to hide your size.</li>
        <li>Withdraw to a fresh address.</li>
      </ul>
    </div>
  );
}

// ───────────── token picker ─────────────

type Option = PickerOption<Key>;


// ───────────── shield, send, withdraw ─────────────

const TITLES: Record<Kind, [string, string]> = {
  shield: ["Shield", "Move HYPE, USDC or CLOAK from your wallet into your private balance."],
  send: ["Send privately", "Pay any cloak: address from your private balance. Nobody can see who paid whom, or how much."],
  withdraw: ["Withdraw", "Move funds from your private balance to a normal wallet address."],
};

export function PortfolioAction({ kind }: { kind: Kind }) {
  const { wallet, priv, shared } = useApp();
  const { query } = useRoute();
  const assets = useAssets();
  const { bals, refresh } = usePrivateBalances();
  const feePct = useFeePct();
  const [pub, setPub] = useState<Record<string, bigint>>({});
  const [asset, setAsset] = useState<Key | undefined>((query.get("token") as Key | null) ?? (kind === "shield" ? "HYPE" : undefined));
  const [amt, setAmt] = useState("");
  const [to, setTo] = useState("");
  // withdraw in pieces over time (HYPE and per-token vaults; not the shared vault yet)
  const [spread, setSpread] = useState(false);
  const [windowSecs, setWindowSecs] = useState(3600);
  const [busy, setBusy] = useState("");
  const [res, setRes] = useState<{ ok?: string; tx?: Hex; err?: string }>({});
  // send and withdraw start on the first token held, once balances arrive
  const firstHeld = assets.find((a) => (bals[a.key] ?? 0n) > 0n)?.key;
  useEffect(() => {
    if (kind !== "shield" && asset === undefined && firstHeld) setAsset(firstHeld);
  }, [firstHeld]);

  // shield: HYPE, USDC and CLOAK, with what the wallet holds of each
  const shieldable = assets.filter((a) => a.kind !== "launch" || a.market?.shared || (CLOAK_TOKEN && a.key.toLowerCase() === CLOAK_TOKEN.toLowerCase()));
  useEffect(() => {
    if (kind !== "shield" || !wallet) return;
    const me = wallet.account.address;
    Promise.all(
      shieldable.map(async (a) => [a.key, a.key === "HYPE" ? await publicClient.getBalance({ address: me }) : await publicClient.readContract({ address: a.key, abi: erc20Abi, functionName: "balanceOf", args: [me] })] as const),
    ).then((e) => setPub(Object.fromEntries(e))).catch(() => {});
  }, [kind, wallet, shieldable.length, res.tx]);

  if (!wallet || !priv) return <Locked title={TITLES[kind][0]} back />;

  const list: Asset[] = kind === "shield" ? shieldable : assets.filter((a) => (bals[a.key] ?? 0n) > 0n);
  const balOf = (k: Key) => (kind === "shield" ? pub[k] : bals[k]);
  const options: Option[] = list.map((a) => ({ a, sub: balOf(a.key) === undefined ? "…" : `${amountOf(a, balOf(a.key)!)} ${kind === "shield" ? "in wallet" : "private"}` }));
  const cur = list.find((a) => a.key === asset);

  async function useMax() {
    if (!cur || !priv) return;
    const have = balOf(cur.key) ?? 0n;
    if (kind === "shield") {
      // leave a little HYPE for gas
      const x = cur.key === "HYPE" ? (have > 2_000_000_000_000_000n ? have - 2_000_000_000_000_000n : 0n) : have;
      return setAmt(formatUnits(x, cur.decimals));
    }
    if (cur.market?.shared && shared) return setAmt(formatUnits(kind === "send" ? have : await shared.maxWithdraw(cur.key as Address).catch(() => have), cur.decimals));
    const pool = cur.key === "HYPE" ? priv.hypeMarket.pool : priv.market(cur.key).pool;
    const k = kind === "withdraw" && cur.key === "HYPE" ? "unshieldHype" : "transact";
    setAmt(formatUnits(await priv.maxSpendable(pool, k).catch(() => have), cur.decimals));
  }

  async function act() {
    if (!priv || !wallet || !cur) return setRes({ err: "Pick a token first." });
    setRes({});
    let a: bigint;
    try {
      a = parseUnits(amt.trim() || "0", cur.decimals);
    } catch {
      return setRes({ err: "Enter an amount, like 0.01." });
    }
    if (a <= 0n) return setRes({ err: "Enter an amount above zero." });
    const have = balOf(cur.key);
    if (have !== undefined && a > have) return setRes({ err: `You have ${amountOf(cur, have)} ${cur.symbol}${kind === "shield" ? " in your wallet" : " private"}. Enter that or less.` });
    try {
      if (kind === "shield") {
        setBusy("Depositing into your private balance…");
        const tx = cur.key === "HYPE" ? await priv.shieldHype(wallet, a) : cur.market?.shared && shared ? await shared.shield(wallet, cur.key as Address, a, setBusy) : await priv.shieldToken(wallet, cur.key, a, setBusy);
        markDone("shield");
        setRes({ ok: `${amt} ${cur.symbol} is now private.`, tx });
      } else {
        setBusy("Loading the prover…");
        await (cur.market?.shared ? getSharedProver() : getProver());
        if (kind === "send") {
          if (!to.startsWith("cloak:")) throw new Hint("Paste the recipient's cloak: address. They can copy it from their Portfolio page.");
          if (cur.market?.shared && shared) {
            await getProver(); // the relayer's fee is proven from your private HYPE
            const tx = await shared.send(cur.key as Address, a, to, setBusy);
            setRes({ ok: "Sent privately. The chain can't see who paid whom, how much, or even which token.", tx });
          } else {
            const tx = await priv.send(cur.key === "HYPE" ? priv.hypeMarket.token : cur.key, to, a, setBusy);
            setRes({ ok: "Sent privately. The chain can't see who paid whom, or how much.", tx });
          }
        } else {
          // a .ely name is looked up again now: names expire and change hands
          const dest = await recipientNow(to).catch((e) => {
            throw new Hint(isAddress(to) ? e.message : `${e.message} Enter a 0x address or a .ely name. A brand-new address keeps you unlinkable.`);
          });
          const name = dest.name ?? `${dest.address.slice(0, 6)}…${dest.address.slice(-4)}`;
          if (spread && !cur.market?.shared) {
            const token = cur.key === "HYPE" ? priv.hypeMarket.token : (cur.key as Address);
            const pieces = await priv.planSplitWithdraw(token, dest.address, a, { pieces: 3, windowSecs, onStatus: setBusy });
            setBusy("Handing the pieces to the relayer…");
            await schedule(priv, pieces, cur.symbol, cur.decimals);
            const at = (t: number) => new Date(t * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
            setRes({ ok: `${amt} ${cur.symbol} goes to ${name} in ${pieces.length} pieces: ${pieces.map((p) => `${amountOf(cur, p.amount)} around ${at(p.notBefore)}`).join(", ")}. You can close Cloak: the relayer sends them.` });
          } else {
            const tx = cur.key === "HYPE" ? await priv.unshieldHype(dest.address, a, setBusy) : cur.market?.shared && shared ? await shared.unshield(cur.key as Address, a, dest.address, setBusy) : await priv.unshieldToken(cur.key, dest.address, a, setBusy);
            setRes({ ok: `${amt} ${cur.symbol} withdrawn to ${name}.`, tx });
          }
        }
      }
      refresh();
    } catch (e) {
      setRes({ err: friendly(e) });
    } finally {
      setBusy("");
    }
  }

  const [title, lede] = TITLES[kind];
  const have = cur ? balOf(cur.key) : undefined;
  return (
    <>
      <Link to="/app" className="back-btn"><span aria-hidden>←</span>Back to Portfolio</Link>
      <div className="page-head"><div><h1>{title}</h1><p>{lede}</p></div></div>
      <div className="grid">
        <div className="card">
          {kind !== "shield" && list.length === 0 ? (
            <div className="empty" style={{ padding: "36px 20px" }}>
              <p style={{ margin: "0 0 14px" }}>You have no private balance to {kind} yet.</p>
              <button className="btn btn-ink btn-sm" onClick={() => navigate("/app/portfolio/shield")}>Shield first</button>
            </div>
          ) : (
            <>
              <div className="field">
                <label><span>Token</span></label>
                <TokenPicker options={options} value={cur?.key} onChange={(k) => { setAsset(k); setAmt(""); setRes({}); }} />
              </div>
              <div className="field">
                <label>
                  <span>Amount</span>
                  {cur && have !== undefined && <span className="link" onClick={useMax}>max {amountOf(cur, have)}</span>}
                </label>
                <input className="input" value={amt} onChange={(e) => setAmt(e.target.value)} inputMode="decimal" placeholder="0.0" />
              </div>
              {kind !== "shield" && (
                <div className="field">
                  <label><span>{kind === "send" ? "Recipient cloak: address" : "To address"}</span><span>{kind === "send" ? "amount stays hidden" : "use a fresh one"}</span></label>
                  <input className="input" value={to} onChange={(e) => setTo(e.target.value.trim())} placeholder={kind === "send" ? "cloak:…" : "0x… or name.ely"} />
                  {kind === "withdraw" && <RecipientNote input={to} />}
                </div>
              )}
              {kind === "withdraw" && cur && !cur.market?.shared && (
                <div className="field spread">
                  <label className="check">
                    <input type="checkbox" checked={spread} onChange={(e) => setSpread(e.target.checked)} />
                    <span><b>Send it in pieces over time</b><span className="xs mute"> 3 pieces of different sizes at random times, so the amount coming out doesn't match anything that went in. It costs a few small relayer fees more than one withdrawal</span></span>
                  </label>
                  {spread && (
                    <select className="input" value={windowSecs} onChange={(e) => setWindowSecs(Number(e.target.value))} aria-label="Over how long">
                      <option value={3600}>Over the next hour</option>
                      <option value={6 * 3600}>Over the next 6 hours</option>
                      <option value={24 * 3600}>Over the next 24 hours</option>
                    </select>
                  )}
                </div>
              )}
              <button className="btn btn-ink btn-lg btn-block" disabled={!!busy || !cur} onClick={act}>
                {busy || (kind === "shield" ? `Shield ${cur?.symbol ?? ""}` : kind === "send" ? "Send privately" : "Withdraw privately")}
              </button>
              {res.err && <div className="err">{res.err}</div>}
              {res.ok && <div className="okmsg">{res.ok} {res.tx && txLink(res.tx) && <a href={txLink(res.tx)} target="_blank" rel="noreferrer">View tx ↗</a>}</div>}
              <p className="note">
                {kind === "shield"
                  ? `Shielding is the one public step: your wallet deposits ${cur?.symbol ?? "it"}. It lands on a one-time key, so it can't be linked to anything you do next.${cur && cur.key !== "HYPE" ? ` ${cur.symbol} needs two confirmations the first time: an approval, then the deposit.` : ""} Then swap privately into other tokens on Trade.`
                  : kind === "send"
                    ? <>A transfer inside the vault. The chain only sees that a private transaction happened. No cloak: address to send to? <Link to="/app/links" className="link">Send it as a link</Link> they can claim to any wallet.</>
                    : `Withdrawing is public on purpose: funds land in a normal wallet. A brand-new address keeps the most privacy. Cloak keeps ${feePct} fee on withdrawals, and the relayer takes a small fee for gas.`}
              </p>
            </>
          )}
        </div>
        <div className="col"><Tips /></div>
      </div>
    </>
  );
}

