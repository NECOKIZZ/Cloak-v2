import { useEffect, useMemo, useState } from "react";
import { formatUnits, numberToHex, parseUnits, type Address, type Hex } from "viem";
import { RELAY_DESTINATIONS, RELAY_SOURCES, relayQuote, relayServes, relayStatus, validRefundAddress, type RelayQuote, type RelayStage } from "@cloakely/sdk";
import { CHAIN_ID } from "./config";
import { ensureElysium, type Eip1193 } from "./wallet";
import { useApp } from "./state";
import { QR } from "./qr";
import { Icon } from "./ui";
import { every } from "./every";
import { friendly } from "./errors";

/** Shown on Elysium mainnet (Relay doesn't serve the testnet), or anywhere with VITE_BRIDGE_PREVIEW=1 to review it. */
const PREVIEW = import.meta.env.VITE_BRIDGE_PREVIEW === "1";
/** Where a preview quotes into (Relay prices it, nothing is sent from here). */
const DEST = relayServes(CHAIN_ID) ? CHAIN_ID : 99901;
const LIVE = relayServes(CHAIN_ID);

/** A bridge on its way, kept on this device so a reload keeps following it. */
interface Pending {
  requestId: string;
  to: Address;
  line: string;
  at: number;
  stage: RelayStage;
}
const KEY = "cloak.bridges";
const loadPending = (): Pending[] => {
  try {
    return (JSON.parse(localStorage.getItem(KEY) ?? "[]") as Pending[]).filter((p) => Date.now() - p.at < 3 * 86_400_000);
  } catch {
    return [];
  }
};
const savePending = (x: Pending[]) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(x.slice(-20)));
  } catch {}
};

const STAGE: Record<RelayStage, string> = {
  waiting: "Waiting for your deposit",
  moving: "On its way to Elysium",
  done: "Arrived. Moving into your private balance",
  failed: "Failed. Relay refunds it to your refund address",
  refunded: "Refunded to your refund address",
};

/** Wait for a transaction on whatever chain the wallet is on, asking the wallet's own node. */
async function mined(eth: Eip1193, hash: string) {
  for (let i = 0; i < 120; i++) {
    const r = (await eth.request({ method: "eth_getTransactionReceipt", params: [hash] }).catch(() => null)) as { status?: string } | null;
    if (r?.status) {
      if (r.status !== "0x1") throw new Error("The transaction failed on the source chain.");
      return;
    }
    await new Promise((s) => setTimeout(s, 2000));
  }
  throw new Error("The transaction is taking long to confirm. Check your wallet.");
}

/**
 * Money in from another chain or an exchange, through Relay, landing at `to` (one of the account's receive addresses).
 * The Receive page moves what arrives there into the private balance; `onArrived` asks it to do so at once.
 */
export function BridgeIn({ to, onArrived }: { to: Address | undefined; onArrived: () => void }) {
  const { wallet, provider } = useApp();
  const [chainId, setChainId] = useState(999);
  const src = RELAY_SOURCES.find((c) => c.id === chainId)!;
  const [symbol, setSymbol] = useState(src.tokens[0].symbol);
  const token = src.tokens.find((t) => t.symbol === symbol) ?? src.tokens[0];
  const dests = RELAY_DESTINATIONS[DEST];
  const [dest, setDest] = useState(dests[0].symbol);
  const [amt, setAmt] = useState("");
  const [refund, setRefund] = useState("");
  const [q, setQ] = useState<RelayQuote | null>(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [pending, setPending] = useState<Pending[]>(loadPending);
  const [copied, setCopied] = useState(false);

  // refunds go back to the connected wallet on EVM chains unless another address is given
  const refundTo = refund.trim() || (src.kind === "evm" && wallet?.account ? wallet.account.address : "");
  const amount = useMemo(() => {
    try {
      return parseUnits(amt || "0", token.decimals);
    } catch {
      return 0n;
    }
  }, [amt, token]);
  useEffect(() => setQ(null), [chainId, symbol, dest, amt, refund, to]);

  // follow every bridge on its way; when one arrives, collect at once
  useEffect(() => {
    const open = pending.filter((p) => p.stage === "waiting" || p.stage === "moving");
    if (!open.length) return;
    const go = async () => {
      let arrived = false;
      const next = await Promise.all(
        pending.map(async (p) => {
          if (p.stage !== "waiting" && p.stage !== "moving") return p;
          const s = await relayStatus(p.requestId).catch(() => null);
          if (s?.stage === "done") arrived = true;
          return s ? { ...p, stage: s.stage } : p;
        }),
      );
      setPending(next);
      savePending(next);
      if (arrived) onArrived();
    };
    go();
    return every(go, 6_000);
  }, [pending.map((p) => p.stage).join()]);

  const track = (x: RelayQuote) => {
    const p: Pending = { requestId: x.requestId, to: x.recipient, line: `${x.send.formatted} ${x.send.token.symbol} on ${x.send.chain} to about ${Number(x.receive.formatted).toPrecision(4)} ${x.receive.token.symbol}`, at: Date.now(), stage: "waiting" };
    const next = [...pending.filter((y) => y.requestId !== p.requestId), p];
    setPending(next);
    savePending(next);
  };

  async function quote(fromWallet: boolean) {
    if (!to) return;
    setErr("");
    setQ(null);
    setBusy(fromWallet ? "Pricing the route" : "Making a deposit address");
    try {
      const x = await relayQuote({ from: { chainId, symbol: token.symbol }, to: { chainId: DEST, symbol: dest }, amount, recipient: to, refundTo, wallet: fromWallet ? wallet?.account?.address : undefined });
      setQ(x);
      if (!fromWallet && LIVE) track(x);
      if (fromWallet) await pay(x);
    } catch (e) {
      setErr(friendly(e));
    } finally {
      setBusy("");
    }
  }

  /** The wallet signs Relay's transactions on the source chain, then goes back to Elysium. */
  async function pay(x: RelayQuote) {
    if (!provider || !wallet?.account || !x.txs) return;
    if (!LIVE) throw new Error("Bridging opens on Elysium mainnet. This preview only prices the route.");
    setBusy(`Switch your wallet to ${x.send.chain}`);
    try {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: numberToHex(x.send.chainId) }] });
    } catch {
      throw new Error(`Add ${x.send.chain} to your wallet and switch to it, then try again.`);
    }
    try {
      for (const [i, t] of x.txs.entries()) {
        setBusy(x.txs.length > 1 ? `Confirm ${i + 1} of ${x.txs.length} in your wallet` : "Confirm in your wallet");
        const h = (await provider.request({ method: "eth_sendTransaction", params: [{ from: wallet.account.address, to: t.to, data: t.data, value: numberToHex(t.value) }] })) as Hex;
        setBusy("Waiting for it to confirm");
        await mined(provider, h);
      }
      track(x);
    } finally {
      await ensureElysium(provider).catch(() => {});
    }
  }

  const copy = (s: string) => {
    navigator.clipboard?.writeText(s).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (!LIVE && !PREVIEW) {
    return (
      <div className="card flat">
        <h3>From another chain or an exchange</h3>
        <p className="small soft" style={{ margin: "8px 0 0" }}>Opens on Elysium mainnet. Send from 20 chains or straight from an exchange through Relay, and it lands in your private balance.</p>
      </div>
    );
  }

  const refundOk = validRefundAddress(src.kind, refundTo);
  const canWallet = src.kind === "evm" && !!wallet?.account && !!provider;
  const ready = !!to && amount > 0n && refundOk && !busy;
  return (
    <div className="card">
      <div className="card-head"><h3>From another chain or an exchange</h3><span className="xs mute">via Relay</span></div>
      {!LIVE && <div className="summary small" style={{ margin: "0 0 10px" }}>Preview. Quotes are live from Relay into Elysium mainnet, and nothing is sent from this network.</div>}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <div className="field"><label><span>From</span></label>
          <select className="input" value={chainId} onChange={(e) => { const c = RELAY_SOURCES.find((x) => x.id === Number(e.target.value))!; setChainId(c.id); setSymbol(c.tokens[0].symbol); }}>
            {RELAY_SOURCES.filter((c) => !c.needsKey).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="field"><label><span>Token</span></label>
          <select className="input" value={token.symbol} onChange={(e) => setSymbol(e.target.value)}>
            {src.tokens.map((t) => <option key={t.symbol} value={t.symbol}>{t.symbol}</option>)}
          </select>
        </div>
        <div className="field"><label><span>Amount</span></label>
          <input className="input" value={amt} onChange={(e) => setAmt(e.target.value)} inputMode="decimal" placeholder={token.stable ? "20" : "0.1"} aria-label="Amount" />
        </div>
        <div className="field"><label><span>Receive privately as</span></label>
          <select className="input" value={dest} onChange={(e) => setDest(e.target.value)}>
            {dests.map((t) => <option key={t.symbol} value={t.symbol}>{t.symbol}</option>)}
          </select>
        </div>
      </div>
      <div className="field"><label><span>Refund address on {src.name}{src.kind === "evm" && wallet?.account ? ", your wallet unless you change it" : ""}</span></label>
        <input className="input mono" value={refund} onChange={(e) => setRefund(e.target.value)} placeholder={src.kind === "evm" ? wallet?.account?.address ?? "0x…" : src.kind === "tvm" ? "T…" : "bc1…"} aria-label="Refund address" />
      </div>
      {refundTo && !refundOk && <div className="err">That isn't a {src.name} address.</div>}
      <div className="row-flex" style={{ gap: 8, marginTop: 12, flexWrap: "wrap" }}>
        <button className="btn btn-ink" disabled={!ready} onClick={() => quote(false)}>{busy && !q ? busy : "Get a deposit address"}</button>
        {canWallet && <button className="btn btn-ghost" disabled={!ready} onClick={() => quote(true)}>Pay from my wallet</button>}
      </div>
      {busy && q && <div className="summary small" style={{ marginTop: 10 }}><span className="dot live" style={{ marginRight: 8 }} />{busy}</div>}
      {err && <div className="err">{err}</div>}
      {q && q.depositAddress && (
        <div style={{ display: "grid", gap: 10, justifyItems: "center", textAlign: "center", marginTop: 14 }}>
          <div className="small">Send exactly <b>{q.send.formatted} {q.send.token.symbol}</b> on <b>{q.send.chain}</b> to</div>
          <QR text={q.depositAddress} size={168} label="Deposit address" />
          <div className="mono" style={{ wordBreak: "break-all" }}>{q.depositAddress}</div>
          <button className="btn btn-ghost" onClick={() => copy(q.depositAddress!)}><Icon.copy size={16} />{copied ? "Copied" : "Copy deposit address"}</button>
          <p className="note" style={{ margin: 0 }}>From an exchange, withdraw on the {q.send.chain} network to this address. It's for this one transfer only.</p>
        </div>
      )}
      {q && (
        <div className="summary" style={{ marginTop: 12 }}>
          <div className="row"><span className="mute">You get privately</span><span className="mono">about {Number(q.receive.formatted).toPrecision(5)} {q.receive.token.symbol}</span></div>
          <div className="row"><span className="mute">At least</span><span className="mono">{Number(formatUnits(q.receive.minimum, q.receive.token.decimals)).toPrecision(5)} {q.receive.token.symbol}</span></div>
          <div className="row"><span className="mute">Relay's fee</span><span className="mono">${q.feeUsd.toFixed(2)}</span></div>
          <div className="row"><span className="mute">Time</span><span>{q.timeSec <= 60 ? "Under a minute" : `About ${Math.ceil(q.timeSec / 60)} min`}{q.send.chainId === 8253038 ? " plus Bitcoin confirmations" : ""}</span></div>
        </div>
      )}
      {pending.length > 0 && (
        <div className="asset-list" style={{ marginTop: 12 }}>
          {[...pending].reverse().slice(0, 5).map((p) => (
            <div key={p.requestId} className="asset-row">
              <div className="nm"><b className="small">{p.line}</b><span className="xs mute">to {p.to.slice(0, 8)}…{p.to.slice(-6)} · {new Date(p.at).toLocaleString()}</span></div>
              <div className="amt"><span className={p.stage === "done" ? "pill ok" : p.stage === "failed" || p.stage === "refunded" ? "pill" : "pill"}>{STAGE[p.stage]}</span></div>
            </div>
          ))}
        </div>
      )}
      <p className="note">Relay delivers to your receive address on Elysium, never to your wallet, and Cloak moves it into your private balance. Like any deposit, what was sent and from where is public. A deposit address from an exchange keeps your wallet out of it. Paying from your wallet links that wallet to this receive address, so use a new address afterwards.</p>
    </div>
  );
}
