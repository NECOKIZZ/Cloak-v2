import { useEffect, useRef, useState } from "react";
import { formatEther, isAddress, parseEther, type Address, type Hex } from "viem";
import { txLink } from "../config";
import { hype, tokens } from "../format";
import { getProver, useApp } from "../state";
import { Icon } from "../ui";
import { useMarkets } from "./markets";

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

  async function refresh() {
    if (!priv || !markets || syncing.current) return;
    syncing.current = true;
    try {
      const entries = await Promise.all([
        priv.balance(priv.hypeMarket.pool).then((b) => ["HYPE", b] as const),
        ...markets.map((m) => priv.balance(m.pool).then((b) => [m.token, b] as const)),
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
        <div className="page-head"><div><h1>Portfolio</h1><p>Your private balances: HYPE and every launch token you hold privately.</p></div></div>
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

  const sym = asset === "HYPE" ? "HYPE" : markets?.find((m) => m.token === asset)?.symbol ?? "";
  const fmt = (x: bigint, a: string) => (a === "HYPE" ? hype(x) : tokens(x));

  async function act() {
    if (!priv || !wallet) return;
    setRes({});
    let a: bigint;
    try {
      a = parseEther(amt || "0");
    } catch {
      return setRes({ err: "Enter a valid amount" });
    }
    try {
      if (tab === "shield") {
        setBusy("Depositing into your private balance…");
        const tx = await priv.shieldHype(wallet, a);
        setRes({ ok: `${amt} HYPE is now private.`, tx });
      } else {
        setBusy("Loading the prover…");
        await getProver();
        if (tab === "send") {
          if (!to.startsWith("cloak:")) throw new Error("Paste the recipient's cloak: address");
          const tx = await priv.send(asset === "HYPE" ? priv.hypeMarket.token : asset, to, a, setBusy);
          setRes({ ok: "Sent privately. The chain can't see who paid whom, or how much.", tx });
        } else {
          if (!isAddress(to)) throw new Error("Enter the 0x address to withdraw to (a fresh one keeps you unlinkable)");
          const tx = asset === "HYPE" ? await priv.unshieldHype(to, a, setBusy) : await priv.unshieldToken(asset, to, a, setBusy);
          setRes({ ok: `${amt} ${sym} withdrawn to ${to.slice(0, 6)}…${to.slice(-4)}.`, tx });
        }
      }
      refresh();
    } catch (e) {
      setRes({ err: (e as { shortMessage?: string }).shortMessage ?? (e as Error).message });
    } finally {
      setBusy("");
    }
  }

  const assets: { key: "HYPE" | Address; label: string }[] = [{ key: "HYPE", label: "HYPE" }, ...(markets ?? []).map((m) => ({ key: m.token, label: m.symbol }))];
  const max = tab === "shield" ? undefined : bals[asset];

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
              <span className={`token-avatar sm ${x.key === "HYPE" ? "hype" : ""}`}>{x.label.slice(0, 2)}</span>
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
              <button key={t} className={`tab ${tab === t ? "on" : ""}`} onClick={() => { setTab(t); setRes({}); if (t === "shield") setAsset("HYPE"); }}>{t[0].toUpperCase() + t.slice(1)}</button>
            ))}
          </div>
          {tab !== "shield" && (
            <div className="buckets" style={{ marginBottom: 14 }}>
              {assets.map((x) => <button key={x.key} className={`bucket ${asset === x.key ? "on" : ""}`} onClick={() => setAsset(x.key)}>{x.label}</button>)}
            </div>
          )}
          <div className="field">
            <label>
              <span>{tab === "shield" ? "Deposit HYPE from your wallet" : tab === "send" ? `Send private ${sym}` : `Withdraw private ${sym}`}</span>
              {max !== undefined && <span className="link" onClick={() => setAmt(formatEther(max))}>max {fmt(max, asset)}</span>}
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
            {busy || (tab === "shield" ? "Shield HYPE" : tab === "send" ? "Send privately" : "Withdraw privately")}
          </button>
          {res.err && <div className="err">{res.err}</div>}
          {res.ok && <div className="okmsg">{res.ok} {res.tx && txLink(res.tx) && <a href={txLink(res.tx)} target="_blank" rel="noreferrer">View tx ↗</a>}</div>}
          <p className="note">
            {tab === "shield"
              ? "Shielding is the one public step: your wallet deposits HYPE. It lands on a one-time key, so it can't be linked to anything you do next."
              : tab === "send"
                ? "A transfer inside the vault. The chain only sees that a private transaction happened."
                : "Withdrawing is public on purpose: funds land in a normal wallet. A brand-new address keeps the most privacy."}
          </p>
        </div>
        <div className="col">
          <div className="card">
            <div className="card-head"><h3>Your cloak address</h3><Icon.send /></div>
            <p className="small mute">Share it to receive private payments. It doesn't reveal your wallet.</p>
            <div className="summary mono xs" style={{ wordBreak: "break-all", marginTop: 12 }}>{privAddress}</div>
            <button className="btn btn-ghost btn-sm" onClick={() => { navigator.clipboard?.writeText(privAddress).catch(() => {}); toast("Cloak address copied"); }}><Icon.copy size={14} />Copy</button>
          </div>
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
