import { useEffect, useRef, useState } from "react";
import { buildClaimLink, buildRequestLink, checkPayee, LINK_SHARES_MAX, LINK_TOKENS, linkAddress, linkCheck, linkKeys, newLinkSecret, normalizeLinkAmount, parseClaimLink, type LinkToken } from "@cloakely/sdk";
import { formatUnits, parseUnits, type Hex } from "viem";
import { friendly, Hint, checked } from "../errors";
import { addLink, linkBalances, linkClaims, linkState, loadLinks, newId, saveLinks, openLinkAccount, shareTargets, tokenOf, TOKEN_DECIMALS, updateLink, type LinkRecord, type SentLink } from "../links";
import { QR } from "../qr";
import { TokenPicker, type PickerOption } from "../tokenPicker";
import { publicClient } from "../wallet";
import { txLink } from "../config";
import { ago } from "./Claim";
import { useApp } from "../state";
import { Icon } from "../ui";

type Tab = "send" | "request";

/** One link, ready to share: copy, QR, share buttons, and the passcode to send separately. */
export function LinkResult({ url, title, passcode, shareText }: { url: string; title: string; passcode?: string; shareText: string }) {
  const { toast } = useApp();
  const [qr, setQr] = useState(false);
  const copy = (s: string, m: string) => { navigator.clipboard?.writeText(s).catch(() => {}); toast(m); };
  return (
    <div className="link-result">
      <div className="row-flex" style={{ justifyContent: "space-between" }}>
        <b>{title}</b>
        <span className="pill ok"><Icon.lock size={12} />details stay in the link</span>
      </div>
      <div className="linkbox mono" title={url}>{url}</div>
      <div className="row-flex" style={{ gap: 8 }}>
        <button className="btn btn-ink btn-sm" onClick={() => copy(url, "Link copied")}><Icon.copy size={14} />Copy link</button>
        <button className="btn btn-ghost btn-sm" onClick={() => setQr(!qr)}>{qr ? "Hide QR" : "Show QR"}</button>
        {shareTargets(url, shareText).map((s) => <a key={s.name} className="btn btn-ghost btn-sm" href={s.href} target="_blank" rel="noreferrer">{s.name}</a>)}
      </div>
      {qr && <div className="qr-wrap"><QR text={url} size={220} label={title} /><p className="xs mute">Scan with a phone camera to open it.</p></div>}
      {passcode && (
        <div className="hint" style={{ marginTop: 12 }}>
          Passcode: <b className="mono">{passcode}</b>{" "}
          <button className="btn btn-text btn-sm" onClick={() => copy(passcode, "Passcode copied")}>copy</button>
          <br />Send it a different way than the link (or let them solve your riddle). The link alone opens nothing.
        </div>
      )}
    </div>
  );
}

const IDEAS: { id: string; tab: Tab; title: string; text: string; preset: Partial<SendForm & ReqForm> }[] = [
  { id: "gift", tab: "send", title: "Gift a friend", text: "They don't need Cloak or even gas. One click claims it to any wallet.", preset: { token: "HYPE", amt: "0.05", message: "A little something for you" } },
  { id: "riddle", tab: "send", title: "Riddle drop", text: "Post a locked link in public with a riddle. The first person to answer it takes the prize.", preset: { token: "HYPE", amt: "0.02", lock: true, hint: "What chain does Cloak live on?", code: "elysium", message: "Solve it to claim it" } },
  { id: "envelope", tab: "send", title: "Red envelope", text: "Split one link into equal shares and drop it in a group chat. The first few people to open it each get one.", preset: { token: "HYPE", amt: "0.05", shares: "5", message: "Lucky envelope! First come, first served" } },
  { id: "gas", tab: "send", title: "Gas for a newcomer", text: "Fund someone's brand-new wallet without linking it to yours. The claim itself costs them nothing.", preset: { token: "HYPE", amt: "0.01", message: "Gas money. Claim it to your new wallet, no gas needed." } },
  { id: "invoice", tab: "request", title: "Invoice", text: "Ask for an exact amount with a reference. They pay from their private balance.", preset: { token: "USDC", amt: "25", note: "Invoice #001" } },
  { id: "tips", tab: "request", title: "Tip jar", text: "No amount, so the payer chooses. Print the QR on a stall, a stream or a slide.", preset: { token: "HYPE", amt: "", note: "Tips, thank you" } },
  { id: "split", tab: "request", title: "Split the bill", text: "Send everyone at the table the same request. Nobody sees what the others paid.", preset: { token: "USDC", amt: "12.5", note: "Dinner, your share" } },
];

interface SendForm { token: LinkToken; amt: string; message: string; from: string; cover: boolean; lock: boolean; code: string; hint: string; shares: string }
interface ReqForm { token: LinkToken; amt: string; note: string; name: string; payTo: "me" | "wallet"; wallet: string }

export function Links() {
  const { wallet, priv, unlock, unlocking, privAddress } = useApp();
  const [tab, setTab] = useState<Tab>("send");
  const [picked, setPicked] = useState("");
  const [sf, setSf] = useState<SendForm>({ token: "HYPE", amt: "", message: "", from: "", cover: true, lock: false, code: "", hint: "", shares: "1" });
  const [rf, setRf] = useState<ReqForm>({ token: "USDC", amt: "", note: "", name: "", payTo: "me", wallet: "" });
  const [busy, setBusy] = useState("");
  const making = useRef(false);
  const [err, setErr] = useState("");
  const [made, setMade] = useState<{ url: string; title: string; passcode?: string; share: string } | null>(null);
  const [list, setList] = useState<LinkRecord[]>([]);
  const [fee, setFee] = useState<bigint | null>(null);
  const [bals, setBals] = useState<Partial<Record<LinkToken, bigint>>>({});
  useEffect(() => {
    if (!priv) return setBals({});
    Promise.all(LINK_TOKENS.map(async (t) => [t, await priv.balance(priv.market(tokenOf(priv, t)).pool).catch(() => undefined)] as const))
      .then((r) => setBals(Object.fromEntries(r.filter(([, v]) => v !== undefined)) as Partial<Record<LinkToken, bigint>>));
  }, [priv, made]);

  useEffect(() => { document.title = "Cloak · Payment links"; }, []);
  useEffect(() => { if (priv) loadLinks(priv.keys).then(setList); }, [priv, made]);
  useEffect(() => { if (wallet && !rf.wallet) setRf((f) => ({ ...f, wallet: wallet.account.address })); }, [wallet]);
  // what the claim will cost the person who opens the link, so the sender can cover it
  useEffect(() => {
    setFee(null);
    if (!priv) return;
    const t = tokenOf(priv, sf.token);
    const pool = priv.market(t).pool;
    Promise.all([priv.relayFee("transact", pool), sf.token === "HYPE" ? priv.relayFee("unshieldHype", pool) : Promise.resolve({ fee: 0n })])
      .then(([a, b]) => setFee(a.fee > b.fee ? a.fee : b.fee)).catch(() => setFee(null));
  }, [priv, sf.token]);

  function pickIdea(i: (typeof IDEAS)[number]) {
    setPicked(i.id);
    setTab(i.tab);
    setMade(null);
    setErr("");
    if (i.tab === "send") setSf((f) => ({ ...f, cover: true, lock: false, code: "", hint: "", message: "", shares: "1", ...i.preset }) as SendForm);
    else setRf((f) => ({ ...f, note: "", ...i.preset }) as ReqForm);
    // on a phone the formats sit under the form: bring the filled form back into view
    if (innerWidth < 900) document.getElementById("link-form")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function createClaim() {
    // one link at a time: a quick second click must not start a second set of sends
    if (making.current) return;
    setErr("");
    setMade(null);
    try {
      making.current = true;
      // the first click only connects and unlocks, so the sender sees the fee and checks the form before money moves
      if (!priv) return void (await unlock());
      setBusy("Checking your balance…");
      const p = priv;
      const dec = TOKEN_DECIMALS[sf.token];
      const amtStr = checked(() => normalizeLinkAmount(sf.amt, dec));
      if (!amtStr) throw new Hint("Enter how much the link holds.");
      if (sf.lock && !sf.code.trim()) throw new Hint("Pick a passcode, or turn the lock off.");
      const token = tokenOf(p, sf.token);
      const pool = p.market(token).pool;
      // everything that needs no network first, so a typo never waits on (or trips over) a fee lookup
      const n = Math.floor(Number(sf.shares || "1"));
      if (!(n >= 1 && n <= LINK_SHARES_MAX)) throw new Hint(`Split into 1 to ${LINK_SHARES_MAX} shares.`);
      const whole = parseUnits(amtStr, dec);
      const share = whole / BigInt(n);
      if (share === 0n) throw new Hint("That's too little to split that many ways.");
      let claimFee = 0n;
      if (sf.cover) {
        const [a, b] = await Promise.all([p.relayFee("transact", pool), sf.token === "HYPE" ? p.relayFee("unshieldHype", pool) : Promise.resolve({ fee: 0n })]);
        claimFee = a.fee > b.fee ? a.fee : b.fee;
      }
      // every share is its own note, and each person claiming pays the relayer from theirs, so each share carries the fee
      const each = share + claimFee;
      const total = each * BigInt(n);
      const have = await p.balance(pool);
      const sendFee = (await p.relayFee("transact", pool)).fee;
      if (have < total + sendFee * BigInt(n)) throw new Hint(`You have ${formatUnits(have, dec)} ${sf.token} private. This link needs ${formatUnits(total + sendFee * BigInt(n), dec)} with fees. Shield more first.`);
      setBusy("Making the link's account…");
      const secret = newLinkSecret();
      const linkKeysNow = await linkKeys(secret, sf.lock ? sf.code : undefined);
      const addr = await linkAddress(linkKeysNow);
      // a locked link carries a short check, so a wrong passcode is caught on the claimer's phone straight away
      const check = sf.lock ? await linkCheck(linkKeysNow) : undefined;
      const shareStr = formatUnits(share, dec);
      const linkAt = (block: bigint) => buildClaimLink({ secret, block, token: sf.token, amount: n > 1 ? shareStr : amtStr, message: sf.message, from: sf.from, locked: sf.lock, hint: sf.hint, shares: n, check }, location.origin);
      // saved before any money moves: if a send fails or the tab closes halfway, the link (and whatever reached it)
      // is still under Your links, to share or take back
      const rec: SentLink = { id: newId(), kind: "claim", url: linkAt(await publicClient.getBlockNumber()), token: sf.token, amount: amtStr, message: sf.message || undefined, passcode: sf.lock ? sf.code.trim() : undefined, hint: sf.hint || undefined, created: Date.now(), status: "funding" };
      await addLink(p.keys, rec);
      let rc;
      for (let i = 0; i < n; i++) {
        const tag = n > 1 ? `Share ${i + 1} of ${n}: ` : "";
        let tx: Hex | undefined;
        try {
          tx = await p.send(token, addr, each, (s) => setBusy(tag + s));
          setBusy(`${tag}waiting for it to land…`);
          rc = await publicClient.waitForTransactionReceipt({ hash: tx });
        } catch (e) {
          // the very first send never went out: nothing reached the link, so forget it
          if (i === 0 && !tx) {
            await saveLinks(p.keys, (await loadLinks(p.keys)).filter((x) => x.id !== rec.id));
            throw e;
          }
          setList(await loadLinks(p.keys));
          throw new Hint(n > 1 ? `${friendly(e)} Up to ${tx ? i + 1 : i} of ${n} shares reached the link. It's saved under Your links, where you can check it, share it or take the money back.` : `${friendly(e)} The link is saved under Your links: check it there before sending again.`);
        }
      }
      if (!rc) return;
      const url = linkAt(rc.blockNumber);
      await updateLink(p.keys, rec.id, { url, status: "open" });
      setMade({ url, title: n > 1 ? `${amtStr} ${sf.token} in ${n} shares of ${shareStr}` : `${amtStr} ${sf.token} in a link`, passcode: rec.passcode, share: sf.lock ? (sf.hint ? `Solve this to claim ${amtStr} ${sf.token}: ${sf.hint}` : `A locked gift of ${amtStr} ${sf.token}`) : n > 1 ? `Red envelope: ${n} shares of ${shareStr} ${sf.token}. First ${n} to open it each get one` : `${amtStr} ${sf.token} for you, sent privately with Cloak` });
    } catch (e) {
      setErr(friendly(e));
    } finally {
      making.current = false;
      setBusy("");
    }
  }

  async function createRequest() {
    setErr("");
    setMade(null);
    try {
      let to = rf.wallet.trim();
      if (rf.payTo === "me") {
        const p = priv ?? (await unlock());
        if (!p) return;
        to = await p.address();
      } else checked(() => checkPayee(to));
      const amount = rf.amt.trim() ? checked(() => normalizeLinkAmount(rf.amt, TOKEN_DECIMALS[rf.token])) : undefined;
      const url = buildRequestLink({ to, token: rf.token, amount, note: rf.note, name: rf.name }, location.origin);
      if (priv) await addLink(priv.keys, { id: newId(), kind: "request", url, token: rf.token, amount, note: rf.note || undefined, to, created: Date.now() });
      setMade({ url, title: amount ? `Request for ${amount} ${rf.token}` : `${rf.token} tip jar`, share: `${rf.name ? rf.name + " requests" : "Pay me"} ${amount ? amount + " " : ""}${rf.token} privately${rf.note ? ` · ${rf.note}` : ""}` });
    } catch (e) {
      setErr(friendly(e));
    }
  }

  const setS = <K extends keyof SendForm>(k: K, v: SendForm[K]) => setSf((f) => ({ ...f, [k]: v }));
  const setR = <K extends keyof ReqForm>(k: K, v: ReqForm[K]) => setRf((f) => ({ ...f, [k]: v }));
  const dec = TOKEN_DECIMALS[sf.token];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Payment links</h1>
          <p>Send money as a link anyone can claim, or ask to be paid with one. Everything stays private, and the details live only in the link.</p>
        </div>
      </div>

      <div className="grid links-grid" id="link-form">
        <div className="card">
          <div className="tabs">
            <button className={`tab ${tab === "send" ? "on" : ""}`} onClick={() => { setTab("send"); setPicked(""); setMade(null); setErr(""); }}>Send money as a link</button>
            <button className={`tab ${tab === "request" ? "on" : ""}`} onClick={() => { setTab("request"); setPicked(""); setMade(null); setErr(""); }}>Request a payment</button>
          </div>

          {tab === "send" ? (
            <>
              <LinkTokenPicker value={sf.token} onChange={(t) => setS("token", t)} bals={bals} />
              <div className="field">
                <label><span>Amount the link holds</span><span>from your private balance</span></label>
                <input className="input" value={sf.amt} onChange={(e) => setS("amt", e.target.value)} inputMode="decimal" placeholder={sf.token === "HYPE" ? "0.05" : "10"} />
              </div>
              <div className="field">
                <label><span>Message</span><span>optional, only in the link</span></label>
                <input className="input" value={sf.message} onChange={(e) => setS("message", e.target.value)} maxLength={140} placeholder="Happy birthday!" />
              </div>
              <div className="field-row">
                <div className="field">
                  <label><span>From</span><span>optional</span></label>
                  <input className="input" value={sf.from} onChange={(e) => setS("from", e.target.value)} maxLength={40} placeholder="Your name, or leave it a mystery" />
                </div>
                <div className="field">
                  <label><span>Shares</span><span>{Number(sf.shares) > 1 ? "one each" : "1 = all to one"}</span></label>
                  <input className="input" value={sf.shares} onChange={(e) => setS("shares", e.target.value.replace(/\D/g, "").slice(0, 2))} inputMode="numeric" placeholder="1" />
                </div>
              </div>
              <label className="check"><input type="checkbox" checked={sf.cover} onChange={(e) => setS("cover", e.target.checked)} /> Cover the claim fee{fee !== null ? ` (${formatUnits(fee, dec)} ${sf.token})` : ""}, so they get the full amount</label>
              <label className="check"><input type="checkbox" checked={sf.lock} onChange={(e) => setS("lock", e.target.checked)} /> Lock it with a passcode</label>
              {sf.lock && (
                <div className="lockbox">
                  <div className="field">
                    <label><span>Passcode</span><span>case and spaces don't matter</span></label>
                    <input className="input" value={sf.code} onChange={(e) => setS("code", e.target.value)} placeholder="a word or phrase" />
                  </div>
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label><span>Riddle or hint</span><span>optional, shown on the claim page</span></label>
                    <input className="input" value={sf.hint} onChange={(e) => setS("hint", e.target.value)} maxLength={120} placeholder="What chain does Cloak live on?" />
                  </div>
                  <p className="xs mute" style={{ margin: "8px 0 0" }}>A short or guessable answer can be guessed by anyone who has the link. Use a phrase for real money.</p>
                </div>
              )}
              <button className="btn btn-ink btn-lg btn-block" style={{ marginTop: 14 }} disabled={!!busy || unlocking} onClick={createClaim}>
                {busy || (unlocking ? "Sign in your wallet…" : !wallet ? "Connect wallet" : !priv ? "Unlock private account" : "Create link")}
              </button>
              <p className="note">The link holds its own private account. Anyone who opens it can claim the money into their private balance, or straight to any wallet with no gas. Until someone does, you can take it back below. Treat it like cash.</p>
            </>
          ) : (
            <>
              <LinkTokenPicker value={rf.token} onChange={(t) => setR("token", t)} bals={bals} />
              <div className="field">
                <label><span>Amount</span><span>leave empty to let them choose</span></label>
                <input className="input" value={rf.amt} onChange={(e) => setR("amt", e.target.value)} inputMode="decimal" placeholder="25" />
              </div>
              <div className="field">
                <label><span>What it's for</span><span>optional</span></label>
                <input className="input" value={rf.note} onChange={(e) => setR("note", e.target.value)} maxLength={140} placeholder="Invoice #001" />
              </div>
              <div className="field">
                <label><span>Your name</span><span>optional</span></label>
                <input className="input" value={rf.name} onChange={(e) => setR("name", e.target.value)} maxLength={40} placeholder="Robin" />
              </div>
              <div className="field">
                <label><span>Pay to</span></label>
                <div className="tabs" style={{ marginBottom: 0 }}>
                  <button className={`tab ${rf.payTo === "me" ? "on" : ""}`} onClick={() => setR("payTo", "me")}>My private balance</button>
                  <button className={`tab ${rf.payTo === "wallet" ? "on" : ""}`} onClick={() => setR("payTo", "wallet")}>A wallet address</button>
                </div>
              </div>
              {rf.payTo === "me" ? (
                <p className="xs mute" style={{ margin: "-4px 0 12px" }}>{privAddress ? `Paid to your cloak address ${privAddress.slice(0, 14)}…, privately.` : "Paid to your cloak address. You'll unlock your private account to get it."}</p>
              ) : (
                <div className="field">
                  <input className="input mono" value={rf.wallet} onChange={(e) => setR("wallet", e.target.value.trim())} placeholder="0x…" />
                  <span className="field-help">They pay from their private balance, so their wallet never shows. The amount and your wallet are public, like any transfer.</span>
                </div>
              )}
              <button className="btn btn-ink btn-lg btn-block" disabled={unlocking} onClick={createRequest}>
                {rf.payTo === "me" && !priv ? (wallet ? "Unlock and create request" : "Connect wallet") : "Create request link"}
              </button>
              <p className="note">Nothing about a request goes on chain. The payer opens the link, checks the details and pays from their private balance.</p>
            </>
          )}
          {err && <div className="err">{err}</div>}
          {made && <LinkResult url={made.url} title={made.title} passcode={made.passcode} shareText={made.share} />}
        </div>

        <div className="col">
          <div className="card">
            <div className="card-head"><h3>Formats</h3><span className="xs mute">one click fills the form</span></div>
            {(["send", "request"] as Tab[]).map((g) => (
              <div key={g} className="ideas-group">
                <div className="eyebrow">{g === "send" ? "Send as a link" : "Request a payment"}</div>
                {IDEAS.filter((i) => i.tab === g).map((i) => (
                  <button key={i.id} className={`idea ${picked === i.id ? "on" : ""}`} onClick={() => pickIdea(i)} title={i.text}>
                    <b>{i.title}</b>
                    <span>{i.text}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
          <YourLinks list={list} onChange={() => priv && loadLinks(priv.keys).then(setList)} />
        </div>
      </div>
    </>
  );
}

/** The tokens a link can carry, as a dropdown with logos. Shows the private balance of each once unlocked. */
function LinkTokenPicker({ value, onChange, bals }: { value: LinkToken; onChange: (t: LinkToken) => void; bals: Partial<Record<LinkToken, bigint>> }) {
  const options: PickerOption<LinkToken>[] = LINK_TOKENS.map((t) => ({
    a: { key: t, symbol: t, name: TOKEN_NAMES[t] },
    sub: bals[t] === undefined ? "" : `${trim(formatUnits(bals[t]!, TOKEN_DECIMALS[t]))} private`,
  }));
  return (
    <div className="field">
      <label><span>Token</span></label>
      <TokenPicker options={options} value={value} onChange={onChange} />
    </div>
  );
}

const TOKEN_NAMES: Record<LinkToken, string> = { HYPE: "Hyperliquid", USDC: "USD Coin" };
const trim = (s: string) => (s.includes(".") ? s.replace(/(\.\d{0,6})\d*$/, "$1").replace(/\.?0+$/, "") : s);

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function linkPill(l: SentLink, shares: number) {
  const n = l.claims?.length ?? 0;
  switch (l.status) {
    case "funding": return <span className="pill">Funding…</span>;
    case "unfunded": return <span className="pill warn">Not funded</span>;
    case "back": return <span className="pill">Taken back</span>;
    case "claimed": return <span className="pill">{shares > 1 ? `All ${shares} claimed` : "Claimed"}</span>;
    case "partly": return <span className="pill ok">{n} of {shares} claimed</span>;
    default: return <span className="pill ok">Waiting</span>;
  }
}

function YourLinks({ list, onChange }: { list: LinkRecord[]; onChange: () => void }) {
  const { priv, toast } = useApp();
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<Record<string, string>>({});
  const auto = useRef(new Set<string>());

  /** Reads a link from the chain: what's still waiting, and every claim so far. */
  async function refresh(l: SentLink, quiet = false) {
    if (!priv) return;
    if (!quiet) setBusy((b) => ({ ...b, [l.id]: "Checking…" }));
    setMsg((m) => ({ ...m, [l.id]: "" }));
    try {
      const parsed = parseClaimLink(l.url);
      const acct = await openLinkAccount(parsed, l.passcode);
      const st = await linkState(acct);
      const notes = st.HYPE.notes.length + st.USDC.notes.length;
      const waiting = st.HYPE.waiting > 0n || st.USDC.waiting > 0n;
      const all = await linkClaims(acct, st);
      const back = new Set((l.backTx ?? []).map((h) => h.toLowerCase()));
      const claims = all.filter((c) => !back.has(c.tx.toLowerCase()));
      const status: SentLink["status"] =
        notes === 0 ? (l.status === "funding" && Date.now() - l.created < 5 * 60_000 ? "funding" : "unfunded")
        : waiting ? (claims.length ? "partly" : "open")
        : claims.length ? "claimed" : "back";
      await updateLink(priv.keys, l.id, { status, claims, checked: Date.now() });
      onChange();
    } catch (e) {
      if (!quiet) setMsg((m) => ({ ...m, [l.id]: friendly(e) }));
    } finally {
      if (!quiet) setBusy((b) => ({ ...b, [l.id]: "" }));
    }
  }

  async function takeBack(l: SentLink) {
    if (!priv) return;
    setBusy((b) => ({ ...b, [l.id]: "Taking it back…" }));
    setMsg((m) => ({ ...m, [l.id]: "" }));
    try {
      const acct = await openLinkAccount(parseClaimLink(l.url), l.passcode);
      const bals = await linkBalances(acct);
      if (bals.HYPE === 0n && bals.USDC === 0n) throw new Hint("This link is already empty.");
      const me = await priv.address();
      const txs: Hex[] = [...(l.backTx ?? [])];
      for (const t of ["HYPE", "USDC"] as LinkToken[]) {
        if (bals[t] === 0n) continue;
        for (let round = 0; round < 12; round++) {
          const r = await acct.sweep(tokenOf(acct, t), me, (s) => setBusy((b) => ({ ...b, [l.id]: s })));
          txs.push(r.txHash);
          await updateLink(priv.keys, l.id, { backTx: txs });
          await publicClient.waitForTransactionReceipt({ hash: r.txHash });
          if (r.left === 0n) break;
        }
      }
      await updateLink(priv.keys, l.id, { status: "back", backTx: txs });
      toast("Taken back into your private balance");
      onChange();
    } catch (e) {
      setMsg((m) => ({ ...m, [l.id]: friendly(e) }));
    } finally {
      setBusy((b) => ({ ...b, [l.id]: "" }));
    }
  }

  // links that may have changed are checked by themselves, one at a time, newest first
  useEffect(() => {
    if (!priv) return;
    let stop = false;
    (async () => {
      const due = list.filter((l): l is SentLink => l.kind === "claim" && ["funding", "open", "partly", undefined].includes(l.status) && !auto.current.has(l.id)).slice(0, 6);
      for (const l of due) {
        if (stop) return;
        auto.current.add(l.id);
        setBusy((b) => ({ ...b, [l.id]: "Checking…" }));
        await refresh(l, true);
        setBusy((b) => ({ ...b, [l.id]: "" }));
      }
    })();
    return () => { stop = true; };
  }, [priv, list]);

  const copy = (s: string) => { navigator.clipboard?.writeText(s).catch(() => {}); toast("Link copied"); };
  return (
    <div className="card">
      <div className="card-head"><h3>Your links</h3><span className="pill"><Icon.lock size={12} />this browser only</span></div>
      {!priv ? (
        <p className="small mute">Unlock your private account to see the links you made here. They're stored encrypted in this browser.</p>
      ) : list.length === 0 ? (
        <p className="small mute">Links you make show up here, so you can copy them again, see who claimed them, or take back one nobody claimed.</p>
      ) : (
        <div className="link-list">
          {list.map((l) => {
            const shares = l.kind === "claim" ? (() => { try { return parseClaimLink(l.url).shares ?? 1; } catch { return 1; } })() : 1;
            const live = l.kind === "claim" && !["back", "claimed"].includes(l.status ?? "");
            return (
              <div key={l.id} className="link-row">
                <div className="row-flex" style={{ justifyContent: "space-between", gap: 8 }}>
                  <b>{l.kind === "claim" ? `${l.amount} ${l.token} ${shares > 1 ? `envelope · ${shares} shares` : "link"}` : l.amount ? `Request · ${l.amount} ${l.token}` : `Tip jar · ${l.token}`}</b>
                  {l.kind === "claim" && linkPill(l, shares)}
                </div>
                <span className="xs mute">{new Date(l.created).toLocaleString()}{l.kind === "claim" && l.passcode ? ` · passcode “${l.passcode}”` : ""}{l.kind === "claim" && l.message ? ` · “${l.message}”` : l.kind === "request" && l.note ? ` · ${l.note}` : ""}</span>
                {l.kind === "claim" && !!l.claims?.length && (
                  <ul className="claims">
                    {l.claims.slice(0, 6).map((c) => (
                      <li key={c.tx} className="xs">
                        <span className="mono">{c.amount} {c.token}</span>
                        <span className="mute"> {c.to === "private" ? "into a private balance" : <>to <span className="mono">{short(c.to)}</span></>} · {ago(c.at)}</span>
                        {txLink(c.tx) && <a className="link" href={txLink(c.tx)} target="_blank" rel="noreferrer"> ↗</a>}
                      </li>
                    ))}
                    {l.claims.length > 6 && <li className="xs mute">and {l.claims.length - 6} more</li>}
                  </ul>
                )}
                {l.kind === "claim" && l.status === "unfunded" && <span className="xs mute">No money reached this link (the send didn't go through). Nothing to take back.</span>}
                <div className="row-flex" style={{ gap: 6 }}>
                  <button className="btn btn-text btn-sm" onClick={() => copy(l.url)}>Copy</button>
                  {l.kind === "claim" && (
                    <button className="btn btn-text btn-sm" disabled={!!busy[l.id]} onClick={() => refresh(l)}>Refresh</button>
                  )}
                  {l.kind === "claim" && live && l.status !== "unfunded" && (
                    <button className="btn btn-text btn-sm" disabled={!!busy[l.id]} onClick={() => takeBack(l)}>Take back</button>
                  )}
                  {busy[l.id] && <span className="xs mute">{busy[l.id]}</span>}
                </div>
                {msg[l.id] && <div className="err" style={{ marginTop: 2 }}>{msg[l.id]}</div>}
              </div>
            );
          })}
        </div>
      )}
      <p className="note">Claims into a private balance show only when they happened. Claims to a wallet show the wallet, like any withdrawal.</p>
    </div>
  );
}

