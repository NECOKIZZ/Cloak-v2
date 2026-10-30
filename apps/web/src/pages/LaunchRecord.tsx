import { useEffect, useState } from "react";
import type { Address, Hex } from "viem";
import { cloakAuctionAbi, cloakPairAbi, privateRouterAbi, type AuctionState } from "@cloakely/sdk";
import { addrLink, ROUTER, txLink } from "../config";
import { launchCreatedLogs } from "../tokenMeta";
import { friendly } from "../errors";
import { hype, short, tokens } from "../format";
import { publicClient } from "../wallet";

interface Step {
  key: string;
  label: string;
  seen: string;
  tx: Hex;
  block: bigint;
  group: "launch" | "bid" | "reveal" | "settle" | "claim" | "trade";
}
type Log = { args: Record<string, unknown>; blockNumber: bigint; transactionHash: Hex; logIndex: number };

const ZERO = "0x0000000000000000000000000000000000000000";
const ev = (address: Address, abi: readonly unknown[], eventName: string, args?: Record<string, unknown>) =>
  publicClient.getContractEvents({ address, abi: abi as never, eventName: eventName as never, args: args as never, fromBlock: 0n, toBlock: "latest", strict: true }) as unknown as Promise<Log[]>;

/** Every transaction of a launch, read from its public events, in order. */
async function loadRecord(s: AuctionState): Promise<Step[]> {
  const a = s.address;
  const [created, commits, reveals, settles, fails, claims, lp, pool, trades] = await Promise.all([
    launchCreatedLogs(a) as unknown as Promise<Log[]>,
    ev(a, cloakAuctionAbi, "Committed"),
    ev(a, cloakAuctionAbi, "Revealed"),
    ev(a, cloakAuctionAbi, "Settled"),
    ev(a, cloakAuctionAbi, "Failed"),
    ev(a, cloakAuctionAbi, "Claimed"),
    ev(a, cloakAuctionAbi, "LPReleased"),
    ROUTER && s.settled ? ev(ROUTER, privateRouterAbi, "PoolCreated", { token: s.token }) : Promise.resolve([]),
    s.pair && s.pair !== ZERO ? ev(s.pair, cloakPairAbi, "Swap") : Promise.resolve([]),
  ]);

  const byTx = (logs: Log[]) => {
    const m = new Map<Hex, Log[]>();
    for (const l of logs) m.set(l.transactionHash, [...(m.get(l.transactionHash) ?? []), l]);
    return [...m.values()];
  };
  const steps: Step[] = [];
  for (const l of created)
    steps.push({ key: l.transactionHash, group: "launch", label: "Launch created", seen: `${s.tokenName} ($${s.tokenSymbol}) with ${tokens(s.saleSupply)} tokens for sale, by ${short(l.args.creator as string)}`, tx: l.transactionHash, block: l.blockNumber });
  for (const l of commits)
    steps.push({ key: `${l.transactionHash}c`, group: "bid", label: `Sealed bid #${l.args.id}`, seen: `${short(l.args.bidder as string)} locked ${hype(l.args.deposit as bigint)} HYPE. Only a hash and a timelocked ciphertext are stored: no price, no size.`, tx: l.transactionHash, block: l.blockNumber });
  for (const g of byTx(reveals))
    steps.push({ key: `${g[0].transactionHash}r`, group: "reveal", label: g.length > 1 ? `${g.length} bids opened` : `Bid #${g[0].args.id} opened`, seen: "Decrypted with the public drand beacon and checked against each bid's hash. Anyone can do this, nobody can change a bid.", tx: g[0].transactionHash, block: g[0].blockNumber });
  for (const l of settles)
    steps.push({ key: `${l.transactionHash}s`, group: "settle", label: "Settled at one price", seen: `Cleared at ${hype(l.args.clearingPrice as bigint)} HYPE per token. ${tokens(l.args.sold as bigint)} sold for ${hype(l.args.raised as bigint)} HYPE. The pool was seeded at that price and the LP ${s.lpLockUntil === 0 ? "burned" : `locked until ${new Date(s.lpLockUntil * 1000).toLocaleDateString()}`}.`, tx: l.transactionHash, block: l.blockNumber });
  for (const l of fails)
    steps.push({ key: `${l.transactionHash}f`, group: "settle", label: "Launch failed", seen: "Demand didn't reach the minimum, so every deposit is refundable and the tokens went back to the creator.", tx: l.transactionHash, block: l.blockNumber });
  for (const g of byTx(claims)) {
    const toks = g.reduce((x, l) => x + (l.args.tokens as bigint), 0n);
    const refund = g.reduce((x, l) => x + (l.args.refund as bigint), 0n);
    steps.push({ key: `${g[0].transactionHash}p`, group: "claim", label: g.length > 1 ? `${g.length} bidders paid out` : `Bid #${g[0].args.id} paid out`, seen: `${tokens(toks)} ${s.tokenSymbol} and ${hype(refund)} HYPE in refunds, sent straight to the bidders.`, tx: g[0].transactionHash, block: g[0].blockNumber });
  }
  for (const l of lp)
    steps.push({ key: `${l.transactionHash}l`, group: "claim", label: "Liquidity released", seen: `The LP lock ended and ${tokens(l.args.shares as bigint)} LP shares went to the creator.`, tx: l.transactionHash, block: l.blockNumber });
  for (const l of pool)
    steps.push({ key: `${l.transactionHash}v`, group: "trade", label: "Private trading enabled", seen: `A shielded vault for $${s.tokenSymbol} was created, so holders can trade it privately.`, tx: l.transactionHash, block: l.blockNumber });
  if (trades.length) {
    const first = trades[0];
    steps.push({ key: `${first.transactionHash}t`, group: "trade", label: "First trade on the pool", seen: `A ${first.args.hypeIn ? "buy" : "sell"} on the public pool. ${trades.length} pool trade${trades.length > 1 ? "s" : ""} so far, private ones included (they come from the relayer, not the trader).`, tx: first.transactionHash, block: first.blockNumber });
  }
  return steps.sort((x, y) => (x.block === y.block ? 0 : x.block < y.block ? -1 : 1));
}

const GROUPS: Record<Step["group"], string> = { launch: "Created", bid: "Sealed", reveal: "Opened", settle: "Settled", claim: "Paid out", trade: "Trading" };

export function LaunchRecord({ s }: { s: AuctionState }) {
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [err, setErr] = useState("");
  const [all, setAll] = useState(false);
  const stage = `${s.phase}-${s.commits}-${s.reveals}-${s.settled}`;

  useEffect(() => {
    let alive = true;
    loadRecord(s).then((x) => alive && (setSteps(x), setErr(""))).catch((e) => alive && setErr(friendly(e)));
    return () => {
      alive = false;
    };
  }, [s.address, stage]);

  const contracts: [string, string][] = [
    ["Auction", s.address],
    ["Token", s.token],
    ...(s.pair && s.pair !== ZERO ? ([["Pool", s.pair]] as [string, string][]) : []),
  ];
  // collapsed: the first 3 sealed bids, a "+N more" row, and every other step
  const bids = steps?.filter((x) => x.group === "bid") ?? [];
  const hidden = all ? 0 : Math.max(0, bids.length - 3);
  const shown = steps?.flatMap((x) => {
    if (x.group !== "bid" || all) return [x];
    const i = bids.indexOf(x);
    if (i < 3) return [x];
    return i === 3 ? [{ ...x, key: "more", label: `+${hidden} more sealed bids`, seen: "Same as above: a deposit, a hash and a ciphertext each." }] : [];
  });

  return (
    <div className="card">
      <div className="card-head"><h3>On-chain record</h3><span className="xs mute">Every transaction of this launch</span></div>
      <div className="rec-contracts">
        {contracts.map(([k, a]) => (
          <a key={k} href={addrLink(a)} target="_blank" rel="noreferrer" className="p-contract"><span>{k}</span><span className="mono">{short(a)} ↗</span></a>
        ))}
      </div>
      {err && <div className="err">{err}</div>}
      {!steps && !err && <p className="small mute">Reading the launch's transactions…</p>}
      {steps && steps.length === 0 && <p className="small mute">No transactions yet.</p>}
      {shown && shown.length > 0 && (
        <ol className="rec">
          {shown.map((st) => (
            <li key={st.key} className={`rec-${st.group}`}>
              <span className="rec-dot" />
              <div className="rec-body">
                <div className="rec-top">
                  <span><span className="rec-tag">{GROUPS[st.group]}</span>{st.label}</span>
                  {st.key !== "more" && txLink(st.tx) && <a href={txLink(st.tx)} target="_blank" rel="noreferrer" className="xs link mono">{short(st.tx)} ↗</a>}
                </div>
                <p className="xs mute">{st.seen}</p>
              </div>
            </li>
          ))}
        </ol>
      )}
      {bids.length > 3 && (
        <button className="btn btn-text btn-sm" onClick={() => setAll(!all)}>{all ? "Collapse the bids" : `Show all ${steps!.length} transactions`}</button>
      )}
    </div>
  );
}
