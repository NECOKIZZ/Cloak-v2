import { useEffect, useRef, useState } from "react";
import { normalizeLinkAmount, parseRequestLink, type LinkToken, type PaymentRequest } from "@cloakely/sdk";
import { erc20Abi, formatUnits, parseUnits, type Address, type Hex } from "viem";
import { friendly, Hint, linkProblem } from "../errors";
import { tokenOf, TOKEN_DECIMALS } from "../links";
import { ASSETS, txLink } from "../config";
import { Link } from "../router";
import { useApp } from "../state";
import { Icon } from "../ui";
import { publicClient } from "../wallet";

/** Paying a request link: privately to a cloak: address, or from the private balance to a wallet. */
export function Pay() {
  const { wallet, priv, unlock, unlocking, connect } = useApp();
  const [req, setReq] = useState<PaymentRequest | null>(null);
  const [bad, setBad] = useState("");
  const [amt, setAmt] = useState("");
  const [have, setHave] = useState<bigint | null>(null);
  const [busy, setBusy] = useState("");
  /** a quick second click must not pay or claim twice */
  const going = useRef(false);
  const [err, setErr] = useState("");
  const [paid, setPaid] = useState<{ tx: Hex; how: string } | null>(null);

  useEffect(() => {
    document.title = "Cloak · Payment request";
    try {
      const r = parseRequestLink(location.href);
      setReq(r);
      setAmt(r.amount ?? "");
    } catch (e) {
      setBad(linkProblem(e));
    }
  }, []);
  useEffect(() => {
    if (!priv || !req) return;
    setHave(null);
    priv.balance(priv.market(tokenOf(priv, req.token)).pool).then(setHave).catch(() => setHave(null));
  }, [priv, req, paid]);

  if (bad) {
    return (
      <div className="claim-wrap"><div className="card claim-card">
        <h2>This request doesn't work</h2>
        <p className="mute">{bad}</p>
        <Link to="/app/links" className="btn btn-ghost">About payment links</Link>
      </div></div>
    );
  }
  if (!req) return null;
  const t: LinkToken = req.token;
  const dec = TOKEN_DECIMALS[t];
  const toCloak = req.to.startsWith("cloak:");

  /** Exact amount owed (in units) and what leaves the private balance for it, fees included. */
  async function plan() {
    const p = priv ?? (await unlock());
    if (!p) return null;
    const a = normalizeLinkAmount(amt, dec);
    if (!a) throw new Hint("Enter how much to pay.");
    const units = parseUnits(a, dec);
    const token = tokenOf(p, t);
    const pool = p.market(token).pool;
    let gross = units;
    if (!toCloak) {
      // a withdrawal keeps Cloak's fee: send a little more so they receive exactly what they asked for
      const one = 10n ** BigInt(dec);
      const after = await p.afterFee(pool, one);
      gross = after > 0n ? (units * one + after - 1n) / after : units;
    }
    const kind = !toCloak && t === "HYPE" ? "unshieldHype" : "transact";
    const fee = (await p.relayFee(kind, pool)).fee;
    return { p, token, pool, units, gross, need: gross + fee, a };
  }

  async function pay(shieldFirst = false) {
    if (going.current) return;
    setErr("");
    try {
      going.current = true;
      const x = await plan();
      if (!x) return;
      const { p, token, pool, gross, need, a } = x;
      let bal = await p.balance(pool);
      if (bal < need) {
        if (!shieldFirst) throw new Hint(`You have ${formatUnits(bal, dec)} ${t} private. Paying needs ${formatUnits(need, dec)} with fees.`);
        if (!wallet) return;
        const top = need - bal + need / 50n; // a 2% cushion for fees that move
        setBusy(`Shielding ${formatUnits(top, dec)} ${t} from your wallet…`);
        const sh = t === "HYPE" ? await p.shieldHype(wallet, top) : await p.shieldToken(wallet, token, top, setBusy);
        await publicClient.waitForTransactionReceipt({ hash: sh });
        bal = await p.balance(pool);
        if (bal < need) throw new Hint("The deposit landed but isn't in your balance yet. Try paying again in a moment.");
      }
      const tx = toCloak ? await p.send(token, req!.to, gross, setBusy) : t === "HYPE" ? await p.unshieldHype(req!.to as Address, gross, setBusy) : await p.unshieldToken(token, req!.to as Address, gross, setBusy);
      setBusy("Waiting for it to land…");
      await publicClient.waitForTransactionReceipt({ hash: tx });
      setPaid({ tx, how: `${a} ${t} paid ${toCloak ? "privately" : "from your private balance"}` });
    } catch (e) {
      setErr(friendly(e));
    } finally {
      going.current = false;
      setBusy("");
    }
  }

  /** A plain public transfer from the wallet, for payees with a 0x address. */
  async function payPublic() {
    if (going.current) return;
    setErr("");
    try {
      going.current = true;
      const w = wallet ?? (await connect());
      if (!w) return;
      const a = normalizeLinkAmount(amt, dec);
      if (!a) throw new Hint("Enter how much to pay.");
      const units = parseUnits(a, dec);
      setBusy("Confirm in your wallet…");
      let tx: Hex;
      if (t === "HYPE") tx = await w.sendTransaction({ account: w.account!, chain: w.chain, to: req!.to as Address, value: units });
      else {
        const usdc = ASSETS.find((x) => x.symbol.toUpperCase() === "USDC");
        if (!usdc) throw new Hint("USDC isn't available here.");
        tx = await w.writeContract({ account: w.account!, chain: w.chain, address: usdc.token, abi: erc20Abi, functionName: "transfer", args: [req!.to as Address, units] });
      }
      setBusy("Waiting for it to land…");
      await publicClient.waitForTransactionReceipt({ hash: tx });
      setPaid({ tx, how: `${a} ${t} paid from your wallet` });
    } catch (e) {
      setErr(friendly(e));
    } finally {
      going.current = false;
      setBusy("");
    }
  }

  let short = false;
  try {
    short = have !== null && !!amt && parseUnits(normalizeLinkAmount(amt, dec) || "0", dec) > have;
  } catch {}

  return (
    <div className="claim-wrap">
      <div className="card claim-card">
        <div className="claim-badge"><Icon.send size={14} />Payment request</div>
        <p className="mute" style={{ margin: "18px 0 4px" }}>{req.name ? `${req.name} asks you to pay` : "You're asked to pay"}</p>
        <div className="claim-amount"><div>{req.amount ?? "Any amount"} <span>{t}</span></div></div>
        {req.note && <blockquote className="claim-msg">{req.note}</blockquote>}
        <p className="xs mute mono" style={{ wordBreak: "break-all" }}>to {toCloak ? `${req.to.slice(0, 22)}… (a private cloak address)` : req.to}</p>

        {paid ? (
          <div className="claim-done">
            <div className="okmsg" style={{ fontSize: 15 }}><Icon.check size={16} /> Paid. {paid.how}.</div>
            {txLink(paid.tx) && <a className="link small" href={txLink(paid.tx)} target="_blank" rel="noreferrer">View the transaction ↗</a>}
            <div className="row-flex" style={{ marginTop: 14, justifyContent: "center" }}>
              <Link to="/app/links" className="btn btn-ghost">Make your own request</Link>
            </div>
          </div>
        ) : (
          <div style={{ marginTop: 18, textAlign: "left" }}>
            {!req.amount && (
              <div className="field">
                <label><span>Amount</span><span>you choose</span></label>
                <input className="input" value={amt} onChange={(e) => setAmt(e.target.value)} inputMode="decimal" placeholder={t === "HYPE" ? "0.05" : "5"} />
              </div>
            )}
            {priv && have !== null && <p className="xs mute">You have {formatUnits(have, dec)} {t} private.</p>}
            {!priv ? (
              <button className="btn btn-ink btn-lg btn-block" disabled={unlocking} onClick={() => (wallet ? unlock() : connect().then((w) => w && unlock(w)))}>{unlocking ? "Sign in your wallet…" : wallet ? "Unlock private account to pay" : "Connect wallet to pay"}</button>
            ) : short ? (
              <>
                <button className="btn btn-ink btn-lg btn-block" disabled={!!busy} onClick={() => pay(true)}>{busy || `Shield ${t} and pay`}</button>
                <p className="xs mute" style={{ marginTop: 8 }}>Shielding is public and lands right before the payment, so the two can be linked. For the most privacy, shield earlier and pay later.</p>
              </>
            ) : (
              <button className="btn btn-ink btn-lg btn-block" disabled={!!busy} onClick={() => pay(false)}>{busy || (toCloak ? "Pay privately" : "Pay from private balance")}</button>
            )}
            {!toCloak && (
              <button className="btn btn-ghost btn-block" style={{ marginTop: 8 }} disabled={!!busy} onClick={payPublic}>Pay from my wallet instead (public)</button>
            )}
            <p className="note">
              {toCloak
                ? "A private transfer inside the vault: nobody can see who paid whom, or how much. Your proof is made on this device and a relayer submits it."
                : "Paid from your private balance by a relayer, so your wallet never shows. The amount and the receiving wallet are public, like any transfer, and you cover Cloak's withdrawal fee so they get the exact amount."}
            </p>
          </div>
        )}
        {err && <div className="err">{err}</div>}
      </div>
      <p className="xs mute" style={{ textAlign: "center", marginTop: 14 }}>Cloak on Elysium testnet. Play money only.</p>
    </div>
  );
}
