import { useEffect, useState } from "react";
import { Cloak, cloakAuctionAbi, type WaitingItem } from "@cloakely/sdk";
import { FACTORY, FACTORY_BLOCK } from "./config";
import { every } from "./every";
import { friendly } from "./errors";
import { hype, tokens } from "./format";
import { Link } from "./router";
import { useApp } from "./state";
import { publicClient, readCloak } from "./wallet";

/**
 * The bell: everything the connected wallet can claim from Cloak launches. Won tokens and refunds, refunds held for it,
 * and for a creator the launch's proceeds and trading fees. Nothing expires, so a bid you forgot is still here, and
 * nobody (the keeper included) has to push it to you. Checked every two minutes while the tab is open.
 */
const CHECK_MS = 120_000;

let last: { owner: string; at: number; items: WaitingItem[] } | null = null;

export function useWaiting() {
  const { wallet } = useApp();
  const owner = wallet?.account.address;
  const [items, setItems] = useState<WaitingItem[]>(() => (last && last.owner === owner ? last.items : []));
  const load = () => {
    if (!owner) return;
    readCloak
      .waitingFor(owner, FACTORY_BLOCK)
      .then((x) => {
        last = { owner, at: Date.now(), items: x };
        setItems(x);
      })
      .catch(() => {});
  };
  useEffect(() => {
    if (!owner) return setItems([]);
    if (!last || last.owner !== owner || Date.now() - last.at > CHECK_MS) load();
    return every(load, CHECK_MS);
  }, [owner]);
  return { items, reload: load };
}

function describe(x: WaitingItem): { title: string; amount: string; button: string } {
  switch (x.kind) {
    case "bids":
      return {
        title: `Your ${x.symbol} bid${x.ids.length > 1 ? "s" : ""}`,
        amount: [x.tokens > 0n && `${tokens(x.tokens)} ${x.symbol}`, x.refund > 0n && `${hype(x.refund)} HYPE back`].filter(Boolean).join(" and "),
        button: "Claim",
      };
    case "refund":
      return { title: `A refund from ${x.symbol}`, amount: `${hype(x.amount)} HYPE`, button: "Withdraw" };
    case "proceeds":
      return { title: `Your ${x.symbol} raise`, amount: `${hype(x.amount)} HYPE`, button: "Withdraw" };
    case "fees":
      return {
        title: `${x.symbol} trading fees`,
        amount: [x.hype > 0n && `${hype(x.hype)} HYPE`, x.tokens > 0n && `${tokens(x.tokens)} ${x.symbol}`].filter(Boolean).join(" and "),
        button: "Collect",
      };
  }
}

export function Bell() {
  const { wallet, toast } = useApp();
  const { items, reload } = useWaiting();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  if (!wallet) return null;

  async function act(x: WaitingItem) {
    if (!wallet) return;
    const key = `${x.kind}${x.auction}`;
    setBusy(key);
    setErr("");
    try {
      const c = new Cloak(publicClient, wallet, FACTORY);
      if (x.kind === "bids") await c.claim(x.auction, x.ids);
      else if (x.kind === "proceeds") await c.withdrawProceeds(x.auction);
      else if (x.kind === "fees") await c.claimCreatorFees(x.auction);
      else {
        const h = await wallet.writeContract({ address: x.auction, abi: cloakAuctionAbi, functionName: "withdrawRefund", args: [wallet.account.address] });
        await publicClient.waitForTransactionReceipt({ hash: h });
      }
      toast(`${describe(x).title} is in your wallet`);
      reload();
    } catch (e) {
      setErr(friendly(e));
    } finally {
      setBusy("");
    }
  }

  return (
    <>
      <button className="icon-btn bell" title="Waiting for you" aria-label={items.length ? `${items.length} things to claim` : "Nothing to claim"} onClick={() => setOpen(true)}>
        <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M6 9a6 6 0 0 1 12 0c0 5 2 6.5 2 6.5H4S6 14 6 9zM10 19a2 2 0 0 0 4 0" />
        </svg>
        {items.length > 0 && <span className="bell-n">{items.length}</span>}
      </button>
      {open && (
        <div className="modal-bg" onClick={() => !busy && setOpen(false)}>
          <div className="modal" role="dialog" aria-label="Waiting for you" onClick={(e) => e.stopPropagation()}>
            <div className="eyebrow">Waiting for you</div>
            <h2>{items.length ? "Ready to claim" : "All claimed"}</h2>
            <p className="mute small">
              {items.length
                ? "Nothing here expires. Claim it whenever you like, from any device with this wallet."
                : "Won tokens, refunds and a creator's raise show up here once a launch settles."}
            </p>
            {items.map((x) => {
              const d = describe(x);
              const key = `${x.kind}${x.auction}`;
              return (
                <div key={key} className="summary bell-row">
                  <div>
                    <Link to={`/app/launch/${x.auction}`} className="link" onClick={() => setOpen(false)}>{d.title}</Link>
                    <div className="small mono">{d.amount}</div>
                  </div>
                  <button className="btn btn-ink btn-sm" disabled={!!busy} onClick={() => act(x)}>{busy === key ? "Working…" : d.button}</button>
                </div>
              );
            })}
            {err && <div className="err">{err}</div>}
            <button className="btn btn-ghost btn-block" style={{ marginTop: 8 }} onClick={() => setOpen(false)} disabled={!!busy}>Close</button>
          </div>
        </div>
      )}
    </>
  );
}
