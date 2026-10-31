import { useEffect, useRef, useState } from "react";
import { formatUnits, isAddress, parseUnits, type Address, type Hex } from "viem";
import { CloakPrivate, shieldedPoolAbi } from "@cloakely/sdk";
import { ASSETS, CHAIN_ID, MIGRATOR, PREVIOUS, txLink } from "../config";
import { publicClient } from "../wallet";
import { hype, tokens, usd } from "../format";
import { getProver, useApp } from "../state";
import { friendly, Hint } from "../errors";
import { Icon, TokenIcon } from "../ui";
import { useFeePct, useMarkets } from "./markets";

type Tab = "shield" | "send" | "withdraw";

export function Portfolio() {
  const { wallet, connect, priv, privAddress, unlock, unlocking, toast } = useApp();
  const { markets } = useMarkets();
  const [bals, setBals] = useState<Record<string, bigint>>({});
  const [tab, setTab] = useState<Tab>("shield");
  const [asset, setAsset] = useState<"HYPE" | Address>("HYPE");
  const [amt, setAmt] = useState("0.001");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState("");
  const [res, setRes] = useState<{ ok?: string; tx?: Hex; err?: string }>({});
  const syncing = useRef(false);
  const feePct = useFeePct();
  const [moveMsg, setMoveMsg] = useState<{ busy?: string; ok?: string; err?: string }>({});

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

  async function refresh() {
    if (!priv || !markets || syncing.current) return;
    syncing.current = true;
    try {
      const entries = await Promise.all([
        priv.balance(priv.hypeMarket.pool).then((b) => ["HYPE", b] as const),
        ...markets.map((m) => priv.balance(m.pool).then((b) => [m.token, b] as const)),
        ...ASSETS.map((x) => priv.balance(x.pool).then((b) => [x.token, b] as const)),
      ]);
      setBals(Object.fromEntries(entries));
    } catch {
    } finally {
      syncing.current = false;
    }
  }
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 8000);
    return () => clearInterval(t);
  }, [priv, markets]);

  if (!wallet || !priv) {
    return (
      <>
        <div className="page-head"><div><h1>Portfolio</h1><p>Your private balances: HYPE{ASSETS.length ? ", USDC" : ""} and every launch token you hold privately.</p></div></div>
        <div className="empty">
          <Icon.lock size={26} />
          <h3 style={{ marginTop: 12 }}>Your private account is locked</h3>
          <p>Sign one message (free, no transaction) to derive your private keys on this device.</p>
          <button className="btn btn-ink" style={{ marginTop: 18 }} disabled={unlocking} onClick={() => (wallet ? unlock() : connect().then((w) => w && unlock()))}>
            {unlocking ? "Sign in your wallet…" : wallet ? "Unlock private account" : "Connect wallet"}
          </button>
        </div>
      </>
    );
  }

  const stable = (a: string) => ASSETS.find((x) => x.token.toLowerCase() === a.toLowerCase());
  const sym = asset === "HYPE" ? "HYPE" : stable(asset)?.symbol ?? markets?.find((m) => m.token === asset)?.symbol ?? "";
  const decimalsOf = (a: string) => stable(a)?.decimals ?? 18;
  const fmt = (x: bigint, a: string) => (a === "HYPE" ? hype(x) : stable(a) ? usd(x, stable(a)!.decimals) : tokens(x));

  async function act() {
    if (!priv || !wallet) return;
    setRes({});
    let a: bigint;
    try {
      a = parseUnits(amt.trim() || "0", decimalsOf(asset));
    } catch {
      return setRes({ err: "Enter an amount, like 0.01." });
    }
    if (a <= 0n) return setRes({ err: "Enter an amount above zero." });
    const have = bals[asset];
    if (tab !== "shield" && have !== undefined && a > have) return setRes({ err: `You have ${fmt(have, asset)} private ${sym}. Enter that or less.` });
    try {
      if (tab === "shield") {
        setBusy("Depositing into your private balance…");
        const tx = asset === "HYPE" ? await priv.shieldHype(wallet, a) : await priv.shieldToken(wallet, asset, a, setBusy);
        setRes({ ok: `${amt} ${sym} is now private.`, tx });
      } else {
        setBusy("Loading the prover…");
        await getProver();
        if (tab === "send") {
          if (!to.startsWith("cloak:")) throw new Hint("Paste the recipient's cloak: address. They can copy it from their Portfolio page.");
          const tx = await priv.send(asset === "HYPE" ? priv.hypeMarket.token : asset, to, a, setBusy);
          setRes({ ok: "Sent privately. The chain can't see who paid whom, or how much.", tx });
        } else {
          if (!isAddress(to)) throw new Hint("Enter the 0x address to withdraw to. A brand-new address keeps you unlinkable.");
          const tx = asset === "HYPE" ? await priv.unshieldHype(to, a, setBusy) : await priv.unshieldToken(asset, to, a, setBusy);
          setRes({ ok: `${amt} ${sym} withdrawn to ${to.slice(0, 6)}…${to.slice(-4)}.`, tx });
        }
      }
      refresh();
    } catch (e) {
      setRes({ err: friendly(e) });
    } finally {
      setBusy("");
    }
  }

  const assets: { key: "HYPE" | Address; label: string }[] = [
    { key: "HYPE", label: "HYPE" },
    ...ASSETS.map((x) => ({ key: x.token, label: x.symbol })),
    ...(markets ?? []).map((m) => ({ key: m.token, label: m.symbol })),
  ];
  // shielding from a wallet: HYPE, or a stablecoin pool (launch tokens arrive privately by trading)
  const shieldable = assets.filter((x) => x.key === "HYPE" || stable(x.key));
  const max = tab === "shield" ? undefined : bals[asset];
  /** Fill in the whole balance, minus the relayer's fee for this call. */
  async function useMax() {
    if (!priv || max === undefined) return;
    const pool = asset === "HYPE" ? priv.hypeMarket.pool : priv.market(asset).pool;
    const kind = tab === "withdraw" && asset === "HYPE" ? "unshieldHype" : "transact";
    setAmt(formatUnits(await priv.maxSpendable(pool, kind).catch(() => max), decimalsOf(asset)));
  }

  return (
    <>
      <div className="page-head">
        <div><h1>Portfolio</h1><p>Only you can see these balances. On-chain they're encrypted notes in shared vaults.</p></div>
        <span className="pill ok"><Icon.lock size={13} />Private account unlocked</span>
      </div>
      <div className="bal-grid" style={{ marginBottom: 20 }}>
        {assets.map((x) => (
          <div key={x.key} className="bal">
            <div className="row-flex" style={{ gap: 10 }}>
              <TokenIcon symbol={x.label} token={x.key === "HYPE" || stable(x.key) ? undefined : x.key} />
              <span style={{ fontWeight: 500 }}>{x.label}</span>
              <span className="spacer" />
              <span className="xs signal">● only you</span>
            </div>
            <div className="v">{bals[x.key] === undefined ? "…" : fmt(bals[x.key], x.key)}</div>
          </div>
        ))}
      </div>
      <div className="grid">
        <div className="card">
          <div className="tabs">
            {(["shield", "send", "withdraw"] as Tab[]).map((t) => (
              <button key={t} className={`tab ${tab === t ? "on" : ""}`} onClick={() => { setTab(t); setRes({}); if (t === "shield" && !shieldable.some((x) => x.key === asset)) setAsset("HYPE"); }}>{t[0].toUpperCase() + t.slice(1)}</button>
            ))}
          </div>
          {(tab !== "shield" || shieldable.length > 1) && (
            <div className="buckets" style={{ marginBottom: 14 }}>
              {(tab === "shield" ? shieldable : assets).map((x) => <button key={x.key} className={`bucket ${asset === x.key ? "on" : ""}`} onClick={() => setAsset(x.key)}>{x.label}</button>)}
            </div>
          )}
          <div className="field">
            <label>
              <span>{tab === "shield" ? `Deposit ${sym} from your wallet` : tab === "send" ? `Send private ${sym}` : `Withdraw private ${sym}`}</span>
              {max !== undefined && <span className="link" onClick={useMax}>max {fmt(max, asset)}</span>}
            </label>
            <input className="input" value={amt} onChange={(e) => setAmt(e.target.value)} inputMode="decimal" />
          </div>
          {tab !== "shield" && (
            <div className="field">
              <label><span>{tab === "send" ? "Recipient cloak: address" : "To address"}</span><span>{tab === "send" ? "amount stays hidden" : "use a fresh one"}</span></label>
              <input className="input" value={to} onChange={(e) => setTo(e.target.value.trim())} placeholder={tab === "send" ? "cloak:…" : "0x…"} />
            </div>
          )}
          <button className="btn btn-ink btn-lg btn-block" disabled={!!busy} onClick={act}>
            {busy || (tab === "shield" ? `Shield ${sym}` : tab === "send" ? "Send privately" : "Withdraw privately")}
          </button>
          {res.err && <div className="err">{res.err}</div>}
          {res.ok && <div className="okmsg">{res.ok} {res.tx && txLink(res.tx) && <a href={txLink(res.tx)} target="_blank" rel="noreferrer">View tx ↗</a>}</div>}
          <p className="note">
            {tab === "shield"
              ? `Shielding is the one public step: your wallet deposits ${sym}. It lands on a one-time key, so it can't be linked to anything you do next.${stable(asset) ? " USDC needs two confirmations the first time: an approval, then the deposit." : ""}`
              : tab === "send"
                ? "A transfer inside the vault. The chain only sees that a private transaction happened."
                : `Withdrawing is public on purpose: funds land in a normal wallet. A brand-new address keeps the most privacy. Cloak keeps ${feePct} fee on withdrawals, and the relayer takes a small fee for gas.`}
          </p>
        </div>
        <div className="col">
          <div className="card">
            <div className="card-head"><h3>Your cloak address</h3><Icon.send /></div>
            <p className="small mute">Share it to receive private payments. It doesn't reveal your wallet.</p>
            <div className="summary mono xs" style={{ wordBreak: "break-all", marginTop: 12 }}>{privAddress}</div>
            <button className="btn btn-ghost btn-sm" onClick={() => { navigator.clipboard?.writeText(privAddress).catch(() => {}); toast("Cloak address copied"); }}><Icon.copy size={14} />Copy</button>
          </div>
          {MIGRATOR && PREVIOUS.length > 0 && (
            <div className="card">
              <div className="card-head"><h3>Balance in the old vaults?</h3><Icon.lock size={16} /></div>
              <p className="small mute">Cloak's vaults are now permanent, and your private account stays the same from here on. If you held a private balance in an earlier version, move it here once. It stays private, and nobody can redirect it.</p>
              <button className="btn btn-ghost btn-sm" disabled={!!moveMsg.busy} onClick={moveOld}>{moveMsg.busy ?? "Move my old balance"}</button>
              {moveMsg.ok && <div className="okmsg">{moveMsg.ok}</div>}
              {moveMsg.err && <div className="err">{moveMsg.err}</div>}
            </div>
          )}
          <div className="card flat">
            <h3>Tips for staying private</h3>
            <ul className="small soft" style={{ paddingLeft: 18, margin: "10px 0 0", display: "grid", gap: 6 }}>
              <li>Wait a bit between shielding and trading.</li>
              <li>Don't trade the exact amount you just shielded.</li>
              <li>Use batch mode to hide your size.</li>
              <li>Withdraw to a fresh address.</li>
            </ul>
          </div>
        </div>
      </div>
    </>
  );
}
