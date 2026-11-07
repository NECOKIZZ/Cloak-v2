import { useEffect, useMemo, useState } from "react";
import { formatUnits, parseUnits, type Address } from "viem";
import { decodeFundsProof, encodeFundsProof, loadFundsProver, verifyFundsProof, type FundsCheck, type FundsProof, type FundsProver } from "@cloakely/sdk";
import { ASSETS, VAULTS } from "../config";
import { publicClient } from "../wallet";
import { useApp } from "../state";
import { Link } from "../router";
import { friendly } from "../errors";
import { Icon } from "../ui";
import { QR } from "../qr";
import { usePrivateBalances } from "../balances";
import { useMarkets } from "./markets";

// the circuit (18 MB, checked against the SDK's hashes) loads the first time someone proves
let fundsProver: Promise<FundsProver> | null = null;
const getFundsProver = () => (fundsProver ??= loadFundsProver(["/circuits"]).catch((e) => ((fundsProver = null), Promise.reject(e))));
let vk: Promise<unknown> | null = null;
const getVk = () => (vk ??= fetch("/circuits/fundsProof3_vk.json").then((r) => r.json()));

const DAYS = [1, 7, 30];

/** Prove "I hold at least X" without showing the balance, the notes or the wallet: a link anyone can check. */
export function ProveFunds() {
  const { priv } = useApp();
  const { bals } = usePrivateBalances();
  const { markets } = useMarkets();
  const assets = useMemo(
    () => [
      { key: "HYPE", symbol: "HYPE", decimals: 18 },
      ...ASSETS.map((a) => ({ key: a.token as string, symbol: a.symbol, decimals: a.decimals })),
      ...(markets ?? []).filter((m) => !m.shared).map((m) => ({ key: m.token as string, symbol: m.symbol, decimals: 18 })),
    ].filter((a) => (bals[a.key] ?? 0n) > 0n),
    [bals, markets],
  );
  const [asset, setAsset] = useState("HYPE");
  const [amt, setAmt] = useState("");
  const [label, setLabel] = useState("");
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [proof, setProof] = useState<FundsProof | null>(null);
  const [copied, setCopied] = useState(false);
  const cur = assets.find((a) => a.key === asset) ?? assets[0];

  async function make() {
    if (!priv || !cur) return;
    setErr("");
    let threshold: bigint;
    try {
      threshold = parseUnits(amt.trim() || "0", cur.decimals);
    } catch {
      return setErr("Enter an amount, like 100.");
    }
    if (threshold <= 0n) return setErr("Enter an amount above zero.");
    if (threshold > (bals[cur.key] ?? 0n)) return setErr(`You hold less than that privately.`);
    if (!label.trim()) return setErr("Say who it's for, so it can't be reused somewhere else.");
    try {
      setBusy("Loading the proving files…");
      const prover = await getFundsProver();
      const token = (cur.key === "HYPE" ? priv.hypeMarket.token : cur.key) as Address;
      const p = await priv.proveFunds(token, threshold, { label: label.trim(), expiresAt: Math.floor(Date.now() / 1000) + days * 86400, prover, symbol: cur.symbol, decimals: cur.decimals, onStatus: setBusy });
      setProof(p);
    } catch (e) {
      setErr(friendly(e));
    } finally {
      setBusy("");
    }
  }

  const link = proof ? `${location.origin}/proof#${encodeFundsProof(proof)}` : "";
  const back = <Link to="/app" className="back-btn"><span aria-hidden>←</span>Back to Portfolio</Link>;
  if (!priv) return <>{back}<div className="empty">Unlock your private account on the Portfolio first.</div></>;
  return (
    <>
      {back}
      <div className="page-head"><div><h1>Prove what you hold</h1><p>Show someone you hold at least an amount, without showing your balance, your wallet or anything you've done.</p></div></div>
      <div className="grid">
        <div className="card">
          {!proof ? (
            <>
              <div className="field"><label><span>Token</span></label>
                <select className="input" value={cur?.key ?? ""} onChange={(e) => setAsset(e.target.value)}>
                  {assets.map((a) => <option key={a.key} value={a.key}>{a.symbol}</option>)}
                </select>
              </div>
              <div className="field"><label><span>At least</span>{cur && <span>you hold {formatUnits(bals[cur.key] ?? 0n, cur.decimals)}</span>}</label>
                <input className="input" value={amt} onChange={(e) => setAmt(e.target.value)} inputMode="decimal" placeholder="100" />
              </div>
              <div className="field"><label><span>Who it's for</span><span>shown on the proof</span></label>
                <input className="input" value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} placeholder="OTC desk, Nov 7" />
              </div>
              <div className="field"><label><span>Valid for</span></label>
                <select className="input" value={days} onChange={(e) => setDays(Number(e.target.value))}>{DAYS.map((d) => <option key={d} value={d}>{d} day{d > 1 ? "s" : ""}</option>)}</select>
              </div>
              <button className="btn btn-ink btn-lg btn-block" disabled={!!busy || !cur} onClick={make}>{busy || "Create the proof"}</button>
              {err && <div className="err">{err}</div>}
              <p className="note">The proof is made on this device. It shows the amount you claim, the token and the label, nothing else.</p>
            </>
          ) : (
            <div style={{ display: "grid", gap: 14, justifyItems: "center", textAlign: "center" }}>
              <div className="pill ok"><Icon.lock size={12} />Proof ready</div>
              <h3 style={{ margin: 0 }}>At least {formatUnits(BigInt(proof.threshold), proof.decimals)} {proof.symbol}</h3>
              <p className="small mute" style={{ margin: 0 }}>For "{proof.label}" · valid until {new Date(proof.expiresAt * 1000).toLocaleString()}</p>
              <QR text={link} size={180} label="Proof link" />
              <button className="btn btn-ink" onClick={() => { navigator.clipboard?.writeText(link).catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 1500); }}><Icon.copy size={16} />{copied ? "Copied" : "Copy the link"}</button>
              <a className="link small" href={link} target="_blank" rel="noreferrer">Open it like they will ↗</a>
              <button className="btn btn-ghost btn-sm" onClick={() => setProof(null)}>Make another</button>
            </div>
          )}
        </div>
        <div className="col">
          <div className="card flat">
            <h3>What they see</h3>
            <ul className="small soft" style={{ paddingLeft: 18, margin: "10px 0 0", display: "grid", gap: 6 }}>
              <li>That you hold at least the amount, in a Cloak vault, as of now.</li>
              <li>Who it's for and until when. The proof fails anywhere else or after that.</li>
              <li>Not your balance, your wallet, your cloak address or your history.</li>
              <li>One trade-off: whoever has the proof could notice when that money is next moved. Moving it to yourself privately first, before you spend it, avoids that.</li>
            </ul>
          </div>
        </div>
      </div>
    </>
  );
}

/** The public page a proof link opens: checks it in the browser and against the chain. */
export function ProofPage() {
  const [p, setP] = useState<FundsProof | null>(null);
  const [res, setRes] = useState<FundsCheck | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    try {
      const x = decodeFundsProof(location.hash.slice(1));
      setP(x);
      getVk()
        .then((k) => verifyFundsProof(publicClient, x, k, { vaults: VAULTS }))
        .then(setRes)
        .catch((e) => setErr(friendly(e)));
    } catch {
      setErr("This link doesn't hold a Cloak proof of funds.");
    }
  }, []);
  return (
    <div style={{ maxWidth: 640, margin: "0 auto" }}>
      <div className="page-head"><div><h1>Proof of funds</h1><p>Checked in your browser against the Elysium chain. Nothing about the holder is revealed.</p></div></div>
      {err && <div className="err">{err}</div>}
      {p && (
        <div className="card">
          <div className="row-flex" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <div>
              <div className="xs mute">Someone holds at least</div>
              <div style={{ font: "500 34px var(--font-display)", letterSpacing: "-0.02em" }}>{formatUnits(BigInt(p.threshold), p.decimals)} {p.symbol}</div>
              <div className="small mute">For "{p.label}"</div>
            </div>
            {!res ? <span className="pill">Checking…</span> : res.ok ? <span className="pill ok">Verified</span> : <span className="pill warn">Not valid</span>}
          </div>
          {res && (
            <div className="asset-list" style={{ marginTop: 14 }}>
              {res.checks.map((c) => (
                <div key={c.name} className="asset-row"><div className="nm"><b>{c.ok ? "✓" : "✗"} {c.name}</b><span className="xs mute">{c.detail}</span></div></div>
              ))}
              {res.ok && res.spentSince && <div className="note">The funds behind this proof have moved since it was made: it held when it was made, at block {p.block}.</div>}
            </div>
          )}
        </div>
      )}
      <p className="note">Proofs of funds are made with <Link to="/app" className="link">Cloak</Link> on Elysium.</p>
    </div>
  );
}
