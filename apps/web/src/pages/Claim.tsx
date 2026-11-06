import { useEffect, useRef, useState } from "react";
import { parseClaimLink, WrongPasscodeError, type CloakPrivate, type ClaimLink, type LinkToken } from "@cloakely/sdk";
import { formatUnits, isAddress, parseUnits, type Address, type Hex } from "viem";
import { friendly, Hint, linkProblem } from "../errors";
import { linkClaims, linkState, openLinkAccount, tokenOf, TOKEN_DECIMALS, type LinkClaim } from "../links";
import { txLink } from "../config";
import { Link } from "../router";
import { getProver, useApp } from "../state";
import { Icon } from "../ui";
import { publicClient } from "../wallet";
import { recipientNow } from "../names";
import { RecipientNote } from "../recipient";

const fmt = (t: LinkToken, v: bigint) => {
  const s = formatUnits(v, TOKEN_DECIMALS[t]);
  const [i, f = ""] = s.split(".");
  return f ? `${i}.${f.slice(0, t === "USDC" ? 2 : 6).replace(/0+$/, "")}`.replace(/\.$/, "") : i;
};

/** "3 minutes ago", "2 hours ago", "on 2 Nov". */
export function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} minute${s < 120 ? "" : "s"} ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hour${s < 7200 ? "" : "s"} ago`;
  return `on ${new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
}

/** Why a link holds nothing, when it holds nothing. */
type Empty =
  | { kind: "claimed"; last?: LinkClaim }
  | { kind: "unfunded" }
  /** an older locked link (no passcode check): an empty account is all a wrong code looks like */
  | { kind: "unknown" };

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
  const [empty, setEmpty] = useState<Empty | null>(null);
  /** the vault couldn't be read: offer a retry instead of guessing */
  const [netErr, setNetErr] = useState("");
  const [fees, setFees] = useState<Record<string, bigint>>({});
  const [dest, setDest] = useState<"private" | "wallet">("private");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState("");
  /** a quick second click must not pay or claim twice */
  const going = useRef(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState<{ t: LinkToken; amount: bigint; tx: Hex }[] | null>(null);
  const pass = useRef<string | undefined>(undefined);

  useEffect(() => {
    document.title = "Cloak · You've been sent money";
    // the proof that claims is made on this device: start the 14 MB download now, while the page reads the link
    getProver().catch(() => {});
    try {
      const l = parseClaimLink(location.hash);
      setLink(l);
      if (!l.locked) open(l);
    } catch (e) {
      setBad(linkProblem(e));
    }
  }, []);
  useEffect(() => { if (wallet && !to) setTo(wallet.account.address); }, [wallet]);
  // a link whose payment hasn't landed yet: look again every few seconds for two minutes
  useEffect(() => {
    if (empty?.kind !== "unfunded" || !link) return;
    let n = 0;
    const id = setInterval(() => (++n > 15 ? clearInterval(id) : read(link, acct!, true)), 8000);
    return () => clearInterval(id);
  }, [empty, acct]);

  async function open(l = link, passcode?: string) {
    if (!l) return;
    setErr("");
    setNetErr("");
    setBusy(l.locked ? (l.hint ? "Checking your answer…" : "Checking the passcode…") : "Opening the link…");
    let a: CloakPrivate;
    try {
      a = await openLinkAccount(l, passcode);
      pass.current = passcode;
    } catch (e) {
      setBusy("");
      if (e instanceof WrongPasscodeError) return setErr(e.message);
      if (l.locked && /passcode|answer/i.test(String((e as Error)?.message))) return setErr((e as Error).message);
      return setNetErr(`${friendly(e)}`);
    }
    setAcct(a);
    await read(l, a);
  }

  /** Reads what the link holds and why it might hold nothing. */
  async function read(l: ClaimLink, a: CloakPrivate, quiet = false) {
    if (!quiet) setBusy("Finding the money in the vault…");
    try {
      const st = await linkState(a, l.token);
      const b = { HYPE: st.HYPE.waiting, USDC: st.USDC.waiting };
      if (l.shares && l.token) setLeft(st[l.token].open);
      const any = b.HYPE > 0n || b.USDC > 0n;
      if (!any) {
        const spent = st.HYPE.spent + st.USDC.spent;
        if (spent > 0) {
          setEmpty({ kind: "claimed" });
          linkClaims(a, st).then((c) => setEmpty({ kind: "claimed", last: c[0] })).catch(() => {});
        } else setEmpty(l.locked && !l.check ? { kind: "unknown" } : { kind: "unfunded" });
      } else {
        setEmpty(null);
        const pool = (t: LinkToken) => a.market(tokenOf(a, t)).pool;
        const fee = (k: Parameters<typeof a.relayFee>[0], t: LinkToken) => a.relayFee(k, pool(t)).then((q) => q.fee).catch(() => undefined);
        Promise.all([fee("transact", "HYPE"), fee("unshieldHype", "HYPE"), fee("transact", "USDC")]).then(([tr, un, us]) => {
          const f: Record<string, bigint> = {};
          if (tr !== undefined) f.HYPEprivate = tr;
          if (un !== undefined) f.HYPEwallet = un;
          if (us !== undefined) f.USDCprivate = f.USDCwallet = us;
          setFees(f);
        });
      }
      setBals(b);
      setNetErr("");
    } catch (e) {
      if (!quiet) setNetErr(friendly(e));
    } finally {
      if (!quiet) setBusy("");
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
        // a .ely name is looked up now: names expire and change hands
        dst = (await recipientNow(to).catch((e) => {
          throw new Hint(e.message);
        })).address;
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
        ) : netErr ? (
          <div style={{ marginTop: 18 }}>
            <p className="mute">We couldn't read the vault just now, so we can't tell what this link holds yet. Nothing is lost: the money stays in the link until someone claims it.</p>
            <p className="xs mute">{netErr}</p>
            <button className="btn btn-ink btn-block" style={{ marginTop: 10 }} disabled={!!busy} onClick={() => (acct ? read(link, acct) : open(link, pass.current ?? (code || undefined)))}>{busy || "Try again"}</button>
          </div>
        ) : link.locked && (!acct || empty?.kind === "unknown") ? (
          <div style={{ marginTop: 18, textAlign: "left" }}>
            {link.hint && <div className="claim-riddle"><span className="eyebrow">Riddle</span><b>{link.hint}</b></div>}
            <div className="field">
              <label><span>{link.hint ? "Your answer" : "Passcode"}</span><span>case and spaces don't matter</span></label>
              <input className="input" value={code} onChange={(e) => { setCode(e.target.value); setErr(""); }} onKeyDown={(e) => e.key === "Enter" && code.trim() && !busy && open(link, code)} placeholder={link.hint ? "Type the answer" : "The code the sender gave you"} autoFocus autoCapitalize="off" autoCorrect="off" spellCheck={false} />
            </div>
            <button className="btn btn-ink btn-lg btn-block" disabled={!!busy || !code.trim()} onClick={() => open(link, code)}>{busy || "Unlock the link"}</button>
            {empty?.kind === "unknown" && !busy && (
              <div className="err">That {link.hint ? "answer" : "passcode"} opens an empty link. Either it's not quite what the sender typed (check the spelling with them), the link was already claimed, or the sender's payment hasn't landed yet.</div>
            )}
          </div>
        ) : empty?.kind === "claimed" ? (
          <div style={{ marginTop: 18 }}>
            <p><b>{link.shares ? `All ${link.shares} shares are gone.` : "This link was already claimed."}</b></p>
            <p className="mute small">{empty.last ? `The last claim was ${ago(empty.last.at)}${empty.last.to === "private" ? ", into a private balance" : ""}.` : "Someone claimed it, or the sender took it back."} {link.shares ? "Better luck on the next one." : "If that wasn't you, ask the sender."}</p>
            <Link to="/app/links" className="btn btn-ghost" style={{ marginTop: 8 }}>Make your own payment link</Link>
          </div>
        ) : empty?.kind === "unfunded" ? (
          <div style={{ marginTop: 18 }}>
            <p><b>The money hasn't arrived in this link yet.</b></p>
            <p className="mute small">{link.locked ? "Your answer is right. " : ""}The sender's payment usually lands within a minute. This page checks again by itself every few seconds.</p>
            <button className="btn btn-ghost btn-block" style={{ marginTop: 8 }} disabled={!!busy} onClick={() => acct && read(link, acct)}>{busy || "Check now"}</button>
          </div>
        ) : !acct || !bals ? (
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
                <input className="input mono" value={to} onChange={(e) => setTo(e.target.value.trim())} placeholder="0x… or name.ely" />
                <RecipientNote input={to} />
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
