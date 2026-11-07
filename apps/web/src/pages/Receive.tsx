import { useEffect, useState } from "react";
import { formatEther, formatUnits, type Address, type Hex } from "viem";
import { cloakReceiveAbi, receiveAddress, receiveDeliveries, watchReceive, type CloakPrivate, type ReceiveAddress } from "@cloakely/sdk";
import { ASSETS, KEEPER_URL, RECEIVE, txLink } from "../config";
import { openBox, sealBox } from "../deviceBox";
import { publicClient } from "../wallet";
import { useApp } from "../state";
import { Link } from "../router";
import { Icon } from "../ui";
import { QR } from "../qr";

/** The receive addresses this account has handed out (only their numbers matter: each is derived again from the keys). */
interface Issued {
  n: number;
  address: Address;
  at: number;
}

let codeHash: Promise<Hex> | null = null;
const boxCodeHash = () => (codeHash ??= publicClient.readContract({ address: RECEIVE!, abi: cloakReceiveAbi, functionName: "boxCodeHash" }));
const load = async (p: CloakPrivate): Promise<Issued[]> => {
  try {
    return JSON.parse((await openBox(p, "receive")) ?? "[]") as Issued[];
  } catch {
    return [];
  }
};

/** Hand the keeper every address this account gave out, so it delivers what arrives (it forgets on a restart). */
async function rewatch(p: CloakPrivate, issued: Issued[]) {
  if (!KEEPER_URL || !RECEIVE || !issued.length) return;
  const h = await boxCodeHash();
  const all: ReceiveAddress[] = await Promise.all(issued.map((x) => receiveAddress(p.keys, RECEIVE!, h, x.n)));
  for (let i = 0; i < all.length; i += 20) await watchReceive(KEEPER_URL, all.slice(i, i + 20)).catch(() => {});
}

export function Receive() {
  const { priv } = useApp();
  const [issued, setIssued] = useState<Issued[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [state, setState] = useState<Record<string, { waiting: string[]; delivered: { amount: string; tx: Hex }[] }>>({});
  const [copied, setCopied] = useState(false);

  async function fresh(p: CloakPrivate, list: Issued[]) {
    setBusy(true);
    setErr("");
    try {
      const n = list.reduce((m, x) => Math.max(m, x.n + 1), 0);
      const rx = await receiveAddress(p.keys, RECEIVE!, await boxCodeHash(), n);
      if (KEEPER_URL) await watchReceive(KEEPER_URL, [rx]);
      const next = [...list, { n, address: rx.address, at: Math.floor(Date.now() / 1000) }];
      await sealBox(p, "receive", JSON.stringify(next));
      setIssued(next);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!priv || !RECEIVE) return;
    (async () => {
      const list = await load(priv);
      if (!list.length) return fresh(priv, list);
      setIssued(list);
      rewatch(priv, list);
    })();
  }, [priv]);

  // what each address holds now (on its way in) and what the relayer has delivered
  useEffect(() => {
    if (!issued?.length) return;
    let live = true;
    const go = async () => {
      const addrs = issued.map((x) => x.address);
      const [del, bals] = await Promise.all([
        KEEPER_URL ? receiveDeliveries(KEEPER_URL, addrs).catch(() => ({}) as Record<string, never[]>) : ({} as Record<string, never[]>),
        Promise.all(addrs.map((a) => publicClient.getBalance({ address: a }).catch(() => 0n))),
      ]);
      const out: typeof state = {};
      addrs.forEach((a, i) => {
        const symbolOf = (t: string) => (/^0x0+$/.test(t) ? "HYPE" : ASSETS.find((x) => x.token.toLowerCase() === t.toLowerCase())?.symbol ?? "tokens");
        const decOf = (t: string) => (/^0x0+$/.test(t) ? 18 : ASSETS.find((x) => x.token.toLowerCase() === t.toLowerCase())?.decimals ?? 18);
        out[a] = {
          waiting: bals[i] > 0n ? [`${formatEther(bals[i])} HYPE`] : [],
          delivered: ((del as Record<string, { token: string; amount: string; fee: string; txHash: Hex }[]>)[a] ?? []).map((d) => ({ amount: `${formatUnits(BigInt(d.amount) - BigInt(d.fee), decOf(d.token))} ${symbolOf(d.token)}`, tx: d.txHash })),
        };
      });
      if (live) setState(out);
    };
    go();
    const t = setInterval(go, 20_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [issued]);

  const back = <Link to="/app" className="back-btn"><span aria-hidden>←</span>Back to Portfolio</Link>;
  if (!RECEIVE) return <>{back}<div className="empty">Receive addresses aren't available on this network yet.</div></>;
  if (!priv) return <>{back}<div className="empty">Unlock your private account on the Portfolio first.</div></>;
  const cur = issued?.at(-1);
  const curUsed = cur && ((state[cur.address]?.waiting.length ?? 0) > 0 || (state[cur.address]?.delivered.length ?? 0) > 0);
  const copy = () => {
    if (!cur) return;
    navigator.clipboard?.writeText(cur.address).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <>
      {back}
      <div className="page-head"><div><h1>Receive</h1><p>A normal address anyone can pay: an exchange, a bridge or any wallet. What arrives goes straight into your private balance.</p></div></div>
      <div className="grid">
        <div className="card">
          {!cur ? (
            <div className="empty" style={{ padding: "36px 20px" }}>{busy ? "Making your address…" : err || "…"}</div>
          ) : (
            <div style={{ display: "grid", gap: 16, justifyItems: "center", textAlign: "center" }}>
              <QR text={cur.address} size={196} label="Your receive address" />
              <div className="mono" style={{ wordBreak: "break-all", fontSize: 15 }}>{cur.address}</div>
              <div className="row-flex" style={{ gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
                <button className="btn btn-ink" onClick={copy}><Icon.copy size={16} />{copied ? "Copied" : "Copy address"}</button>
                <button className="btn btn-ghost" disabled={busy} onClick={() => priv && issued && fresh(priv, issued)}>{busy ? "Making…" : "New address"}</button>
              </div>
              {curUsed && <div className="okmsg" style={{ margin: 0 }}>This address has been paid. Make a new one for the next payment, so the two can't be linked.</div>}
              {err && <div className="err">{err}</div>}
            </div>
          )}
          <p className="note">
            Send HYPE or USDC on Elysium. It usually lands in your private balance a few minutes after it arrives (the relayer waits a random moment, then keeps at most 1% for gas). The address has no key and only the vault can take what's sent to it. Use a new address for every payment.
          </p>
        </div>
        <div className="col">
          {issued && issued.length > 0 && (
            <div className="card">
              <div className="card-head"><h3>Your addresses</h3><span className="xs mute">{issued.length}</span></div>
              <div className="asset-list">
                {[...issued].reverse().slice(0, 12).map((x) => {
                  const s = state[x.address];
                  return (
                    <div key={x.n} className="asset-row">
                      <div className="nm"><b className="mono">{x.address.slice(0, 8)}…{x.address.slice(-6)}</b><span className="xs mute">#{x.n + 1} · {new Date(x.at * 1000).toLocaleDateString()}</span></div>
                      <div className="amt">
                        {s?.waiting.length ? <span className="pill">Arriving {s.waiting.join(", ")}</span> : s?.delivered.length ? <span className="pill ok">Received</span> : <span className="xs mute">Nothing yet</span>}
                        {s?.delivered.map((d) => (
                          <span key={d.tx} className="xs mute">{d.amount} {txLink(d.tx) && <a href={txLink(d.tx)} target="_blank" rel="noreferrer">↗</a>}</span>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          <div className="card flat">
            <h3>What stays private</h3>
            <ul className="small soft" style={{ paddingLeft: 18, margin: "10px 0 0", display: "grid", gap: 6 }}>
              <li>Who received it: the address isn't linked to your wallet or your other addresses.</li>
              <li>What you do with it afterwards.</li>
              <li>Public, as with any deposit: the sender and the amount.</li>
            </ul>
          </div>
        </div>
      </div>
    </>
  );
}
