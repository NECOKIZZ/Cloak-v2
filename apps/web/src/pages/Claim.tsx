import { useEffect, useRef, useState } from "react";
import { parseClaimLink, type CloakPrivate, type ClaimLink, type LinkToken } from "@cloakely/sdk";
import { formatUnits, isAddress, parseUnits, type Address, type Hex } from "viem";
import { friendly, Hint, linkProblem } from "../errors";
import { linkBalances, openLinkAccount, tokenOf, TOKEN_DECIMALS } from "../links";
import { txLink } from "../config";
import { Link } from "../router";
import { useApp } from "../state";
import { Icon } from "../ui";
import { publicClient } from "../wallet";

const fmt = (t: LinkToken, v: bigint) => {
  const s = formatUnits(v, TOKEN_DECIMALS[t]);
  const [i, f = ""] = s.split(".");
  return f ? `${i}.${f.slice(0, t === "USDC" ? 2 : 6).replace(/0+$/, "")}`.replace(/\.$/, "") : i;
};

/** Opening a claim link: the money it holds, then one click into your private balance or out to any wallet. */
export function Claim() {
  const { wallet, priv, unlock, unlocking } = useApp();
  const [link, setLink] = useState<ClaimLink | null>(null);
  const [bad, setBad] = useState("");
  const [code, setCode] = useState("");
  const [acct, setAcct] = useState<CloakPrivate | null>(null);
  const [bals, setBals] = useState<Record<LinkToken, bigint> | null>(null);
  /** A link split into shares: how many are still unclaimed. */
  const [left, setLeft] = useState<number | null>(null);
  const [fees, setFees] = useState<Record<string, bigint>>({});
  const [dest, setDest] = useState<"private" | "wallet">("private");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState("");
  /** a quick second click must not pay or claim twice */
  const going = useRef(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState<{ t: LinkToken; amount: bigint; tx: Hex }[] | null>(null);

  useEffect(() => {
    document.title = "Cloak · You've been sent money";
    try {
      const l = parseClaimLink(location.hash);
      setLink(l);
      if (!l.locked) open(l);
    } catch (e) {
      setBad(linkProblem(e));
    }
  }, []);
  useEffect(() => { if (wallet && !to) setTo(wallet.account.address); }, [wallet]);

  async function open(l = link, passcode?: string) {
    if (!l) return;
    setErr("");
    setBusy(l.locked ? "Checking the passcode…" : "Opening the link…");
    try {
      const a = await openLinkAccount(l.secret, passcode);
      setBusy("Finding the money in the vault…");
      const b = await linkBalances(a);
      if (l.locked && b.HYPE === 0n && b.USDC === 0n) throw new Hint("Nothing opens with that passcode. Check it, or the link was already claimed.");
      const pool = (t: LinkToken) => a.market(tokenOf(a, t)).pool;
      const [tr, un, us] = await Promise.all([a.relayFee("transact", pool("HYPE")), a.relayFee("unshieldHype", pool("HYPE")), a.relayFee("transact", pool("USDC")).catch(() => ({ fee: 0n }))]);
      setFees({ HYPEprivate: tr.fee, HYPEwallet: un.fee, USDCprivate: us.fee, USDCwallet: us.fee });
      if (l.shares && l.token) {
        const notes = await a.sync(a.market(tokenOf(a, l.token)).pool);
        setLeft(notes.length);
      }
      setAcct(a);
      setBals(b);
    } catch (e) {
      setErr(friendly(e));
    } finally {
      setBusy("");
    }
  }

  async function claim() {
    if (!acct || !bals) return;
    if (going.current) return;
    setErr("");
    try {
      going.current = true;
      let dst: string;
      if (dest === "private") {
        const p = priv ?? (await unlock());
        if (!p) return;
        dst = await p.address();
      } else {
        if (!isAddress(to.trim())) throw new Hint("Enter the 0x wallet address to claim to.");
        dst = to.trim() as Address;
      }
      const out: { t: LinkToken; amount: bigint; tx: Hex }[] = [];
      for (const t of ["HYPE", "USDC"] as LinkToken[]) {
        if (bals[t] === 0n) continue;
        // a split link: take one share, and if someone grabbed the same one a moment earlier, try another
        let r: Awaited<ReturnType<typeof acct.sweep>> | undefined;
        for (let attempt = 0; ; attempt++) {
          try {
            r = await acct.sweep(tokenOf(acct, t), dst, setBusy, { one: !!link?.shares });
            setBusy("Waiting for it to land…");
            await publicClient.waitForTransactionReceipt({ hash: r.txHash });
            break;
          } catch (e) {
            if (!link?.shares || attempt >= 3 || !/already|spent|nullifier|in use|being used/i.test(String(e))) throw e;
            setBusy("Someone took that share first, trying another…");
          }
        }
        out.push({ t, amount: dest === "wallet" ? await acct.afterFee(acct.market(tokenOf(acct, t)).pool, r!.amount) : r!.amount, tx: r!.txHash });
        if (link?.shares) break;
      }
      setDone(out);
      setBals({ HYPE: 0n, USDC: 0n });
    } catch (e) {
      setErr(/already|spent|nullifier/i.test(String(e)) ? (link?.shares ? "Every share was taken a moment before you." : "Someone claimed this link a moment before you.") : friendly(e));
    } finally {
      going.current = false;
      setBusy("");
    }
  }

  if (bad) {
    return (
      <div className="claim-wrap"><div className="card claim-card">
        <h2>This link doesn't work</h2>
        <p className="mute">{bad}</p>
        <Link to="/app/links" className="btn btn-ghost">About payment links</Link>
      </div></div>
    );
  }
  if (!link) return null;
  const held = bals ? (["HYPE", "USDC"] as LinkToken[]).filter((t) => bals[t] > 0n) : [];
  // the sender's stated amount, when the link holds at least that (the rest is the claim fee they covered)
  let meant: bigint | null = null;
  try {
    if (bals && link.amount && link.token && held.length === 1 && held[0] === link.token && (left ?? 1) > 0) {
      const m = parseUnits(link.amount, TOKEN_DECIMALS[link.token]);
      if (bals[link.token] >= m) meant = m;
    }
  } catch {}
  const show = (t: LinkToken) => (meant !== null && t === link.token ? meant : bals![t]);
  const covered = (t: LinkToken) => meant !== null && t === link.token && bals![t] - meant >= (fees[`${t}${dest}`] ?? 0n);
  const empty = bals && held.length === 0 && !done;

  return (
    <div className="claim-wrap">
      <div className="card claim-card">
        <div className="claim-badge"><Icon.lock size={14} />Private payment</div>
        <p className="mute" style={{ margin: "18px 0 4px" }}>{link.shares ? `${link.from ?? "Someone"} dropped a red envelope. One share is` : link.from ? `${link.from} sent you` : "Someone sent you"}</p>
        <div className="claim-amount">
          {done ? done.map((d) => <div key={d.t}>{fmt(d.t, d.amount)} <span>{d.t}</span></div>)
            : bals && held.length ? held.map((t) => <div key={t}>{fmt(t, show(t))} <span>{t}</span></div>)
            : <div>{link.amount ?? "?"} <span>{link.token ?? ""}</span></div>}
        </div>
        {link.shares && left !== null && !done && left > 0 && <p className="small" style={{ margin: "6px 0 0" }}><span className="pill ok">{left} of {link.shares} shares left</span></p>}
        {link.message && <blockquote className="claim-msg">“{link.message}”</blockquote>}

        {done ? (
          <div className="claim-done">
            <div className="okmsg" style={{ fontSize: 15 }}><Icon.check size={16} /> Claimed. It's yours now.</div>
            {done.map((d) => txLink(d.tx) && <a key={d.tx} className="link small" href={txLink(d.tx)} target="_blank" rel="noreferrer">View the {d.t} transaction ↗</a>)}
            <div className="row-flex" style={{ marginTop: 14, justifyContent: "center" }}>
              {dest === "private" ? <Link to="/app" className="btn btn-ink">Open my portfolio</Link> : <Link to="/app" className="btn btn-ghost">See what else Cloak does</Link>}
              <Link to="/app/links" className="btn btn-ghost">Send one back</Link>
            </div>
          </div>
        ) : link.locked && !acct ? (
          <div style={{ marginTop: 18, textAlign: "left" }}>
            {link.hint && <div className="claim-riddle"><span className="eyebrow">Riddle</span><b>{link.hint}</b></div>}
            <div className="field">
              <label><span>{link.hint ? "Your answer" : "Passcode"}</span><span>case doesn't matter</span></label>
              <input className="input" value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === "Enter" && open(link, code)} placeholder={link.hint ? "Type the answer" : "The code the sender gave you"} autoFocus />
            </div>
            <button className="btn btn-ink btn-lg btn-block" disabled={!!busy || !code.trim()} onClick={() => open(link, code)}>{busy || "Unlock the link"}</button>
          </div>
        ) : empty ? (
          <div style={{ marginTop: 18 }}>
            <p className="mute">{link.shares ? `All ${link.shares} shares are gone. Better luck on the next one.` : "This link is empty. Someone already claimed it, or the sender took it back."}</p>
            <Link to="/app/links" className="btn btn-ghost" style={{ marginTop: 8 }}>Make your own payment link</Link>
          </div>
        ) : !acct ? (
          <p className="mute" style={{ marginTop: 18 }}>{busy || "Opening…"}</p>
        ) : (
          <div style={{ marginTop: 20, textAlign: "left" }}>
            <div className="choice-list">
              <button className={`choice ${dest === "private" ? "on" : ""}`} onClick={() => setDest("private")}>
                <b>Claim to my private balance <span className="pill ok" style={{ marginLeft: 6 }}>stays private</span></b>
                <span className="xs mute">Nobody can see it arrive. Use it to trade, bid or send on Cloak. One free signature unlocks your private account.</span>
              </button>
              <button className={`choice ${dest === "wallet" ? "on" : ""}`} onClick={() => setDest("wallet")}>
                <b>Claim to a wallet</b>
                <span className="xs mute">Straight to any 0x address. No gas needed: the relayer pays it from the link. The arrival is public, like any transfer.</span>
              </button>
            </div>
            {dest === "wallet" && (
              <div className="field" style={{ marginTop: 12 }}>
                <label><span>Wallet address</span><span>a brand-new one keeps you unlinkable</span></label>
                <input className="input mono" value={to} onChange={(e) => setTo(e.target.value.trim())} placeholder="0x…" />
              </div>
            )}
            <div className="summary" style={{ marginTop: 12 }}>
              {held.map((t) => (
                <div key={t} className="row"><span className="mute">Relayer fee</span><span className="mono">{covered(t) ? "covered by the sender" : `${fmt(t, fees[`${t}${dest}`] ?? 0n)} ${t}`}</span></div>
              ))}
              {dest === "wallet" && <div className="row"><span className="mute">Cloak's withdrawal fee</span><span className="mono">applies</span></div>}
            </div>
            <button className="btn btn-ink btn-lg btn-block" disabled={!!busy || unlocking} onClick={claim}>
              {busy || (dest === "private" ? (priv ? "Claim it" : wallet ? "Unlock and claim" : "Connect wallet and claim") : "Claim to this wallet")}
            </button>
            <p className="note">Anyone who has this link can claim it, so claim it now. The proof is made on this device and a relayer submits it, so nobody sees who sent it to you.</p>
          </div>
        )}
        {err && <div className="err">{err}</div>}
      </div>
      <p className="xs mute" style={{ textAlign: "center", marginTop: 14 }}>Cloak on Elysium testnet. Play money only.</p>
    </div>
  );
}
