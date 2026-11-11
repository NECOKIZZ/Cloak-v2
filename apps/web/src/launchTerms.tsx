import { useEffect, useState } from "react";
import { parseAbi } from "viem";
import { cloakTokenAbi, launchOutcome, LOCK_FOREVER_FEES, type AuctionState } from "@cloakely/sdk";
import { publicClient } from "./wallet";
import { hype, tokens } from "./format";

const HOOK_FEES = parseAbi(["function baseFee() view returns (uint24)", "function startFee() view returns (uint24)", "function decaySecs() view returns (uint32)"]);
const pct = (bps: number) => `${(bps / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
const pips = (p: number) => `${(p / 10_000).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
const when = (t: number) => new Date(t * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

/**
 * Every setting a bidder is bidding on, read from the auction contract itself, and what the launch does at its lowest,
 * middle and top price: the same arithmetic the contract runs when it settles.
 */
export function LaunchTerms({ s }: { s: AuctionState }) {
  const [supply, setSupply] = useState<bigint | null>(null);
  const [fees, setFees] = useState<{ base: number; start: number; decay: number } | null>(null);
  useEffect(() => {
    publicClient.readContract({ address: s.token, abi: cloakTokenAbi, functionName: "totalSupply" }).then(setSupply).catch(() => {});
    if (s.hook) {
      Promise.all(["baseFee", "startFee", "decaySecs"].map((functionName) => publicClient.readContract({ address: s.hook!, abi: HOOK_FEES, functionName: functionName as "baseFee" })))
        .then(([b, st, d]) => setFees({ base: Number(b), start: Number(st), decay: Number(d) }))
        .catch(() => {});
    }
  }, [s.token, s.hook]);

  const top = s.minPrice + BigInt(Math.max(s.numTicks - 1, 0)) * s.tickSize;
  const mid = s.minPrice + BigInt(Math.floor(Math.max(s.numTicks - 1, 0) / 2)) * s.tickSize;
  const creatorShare = supply !== null && supply > s.saleSupply + s.lpReserve ? supply - s.saleSupply - s.lpReserve : 0n;
  const lp = s.lpLockUntil === 0 ? "Burned forever: nobody can ever take it out" : BigInt(s.lpLockUntil) === LOCK_FOREVER_FEES ? "Locked forever; its trading fees go to the creator" : `Locked until ${when(s.lpLockUntil)}, then the creator's`;
  const rows: [string, string][] = [
    ["Tokens for sale", tokens(s.saleSupply)],
    ["Reserved for the pool", tokens(s.lpReserve)],
    ["Creator's own share", creatorShare > 0n ? `${tokens(creatorShare)}, unlocking over time` : "None"],
    ["Total supply", supply !== null ? tokens(supply) : "…"],
    ["Price levels", `${s.numTicks}, from ${hype(s.minPrice, 10)} to ${hype(top, 10)} HYPE per token, ${hype(s.tickSize, 10)} apart`],
    ["Minimum raise", s.minRaise > 0n ? `${hype(s.minRaise)} HYPE. Under it the launch fails and every deposit comes back in full` : "None (a launch from before minimum raises)"],
    ["Pool's share of the raise", `${pct(s.lpBps)}, after Cloak's fee`],
    ["Cloak's launch fee", `${pct(s.launchFeeBps)} of the raise, only if the launch succeeds`],
    ["The pool's liquidity", lp],
    ...(fees ? ([["Pool trading fee", `${pips(fees.start)} when it opens, falling to ${pips(fees.base)} over ${Math.round(fees.decay / 60)} minutes`]] as [string, string][]) : []),
    ["Unrevealed-bid penalty", `${pct(s.noRevealPenaltyBps)} of a bid that never opens (none if the launch fails)`],
    ["Bid limits", s.bidCap > 0n ? `${hype(s.bidCap)} HYPE per bid, ${hype(s.depositCap)} HYPE in all` : "None"],
    ["Bidding closes", when(s.commitEnd)],
    ["Bids open until", `${when(s.revealEnd)} (sealed with drand round ${s.tlockRound}, which nobody can open early)`],
  ];
  const outcomes = [
    ["Lowest price", s.minPrice],
    ...(s.numTicks > 2 ? [["Middle price", mid] as [string, bigint]] : []),
    ...(s.numTicks > 1 ? [["Top price", top] as [string, bigint]] : []),
  ] as [string, bigint][];
  const needAtMin = s.minRaise > 0n && s.minPrice > 0n ? (s.minRaise * 10n ** 18n + s.minPrice - 1n) / s.minPrice : 0n;

  return (
    <div className="card">
      <div className="card-head"><h3>What you're bidding on</h3><span className="xs mute">read from the auction contract</span></div>
      <div className="swap-facts">
        {rows.map(([k, v]) => (
          <div key={k} className="row"><span>{k}</span><span>{v}</span></div>
        ))}
      </div>

      <h4 style={{ margin: "18px 0 6px" }}>How the price is set</h4>
      <ul className="small soft" style={{ margin: 0, paddingLeft: 18 }}>
        <li>Each bid names a price level and how many tokens. Bids stay sealed until bidding closes.</li>
        <li>From the top level down, the launch finds the first level where bids cover every token for sale. Everyone at or above it pays that one price; bids exactly at it share what's left pro rata; bids below it are refunded.</li>
        <li>If bids never cover the sale, everyone who bid is filled at the lowest level anyone bid, and the unsold tokens are burned.</li>
        <li>Raise = price × tokens sold. Then Cloak's fee, then the pool's share; the creator gets the rest. Pool tokens = pool HYPE ÷ price, so the pool opens at exactly the clearing price. Reserve the pool doesn't use is burned.</li>
        {s.minRaise > 0n && <li>If the raise is under {hype(s.minRaise)} HYPE, nothing happens: no pool, no fee, every deposit back. At the lowest price that means at least {tokens(needAtMin)} tokens must sell.</li>}
      </ul>

      <h4 style={{ margin: "18px 0 6px" }}>If the whole sale sells</h4>
      <div className="table-wrap" style={{ overflowX: "auto" }}>
        <table className="small" style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr className="mute" style={{ textAlign: "left" }}><th>Clearing price</th><th>Raised</th><th>Cloak's fee</th><th>Into the pool</th><th>To the creator</th><th>Reserve burned</th></tr>
          </thead>
          <tbody>
            {outcomes.map(([label, p]) => {
              const o = launchOutcome(s, p, s.launchFeeBps);
              return (
                <tr key={label}>
                  <td><b>{label}</b><br /><span className="mono xs">{hype(p, 10)}</span></td>
                  <td className="mono">{hype(o.raised)}</td>
                  {o.opens ? (
                    <>
                      <td className="mono">{hype(o.fee)}</td>
                      <td className="mono">{hype(o.poolHype)} HYPE<br />+ {tokens(o.poolTokens)}</td>
                      <td className="mono">{hype(o.creatorHype)}</td>
                      <td className="mono">{tokens(o.unusedReserve)}</td>
                    </>
                  ) : (
                    <td colSpan={4} className="mute">Under the minimum raise: it fails and every deposit comes back</td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="xs mute" style={{ margin: "10px 0 0" }}>Amounts in HYPE unless marked. The contract runs this same arithmetic when it settles, less a few wei of rounding. A sale that doesn't sell out raises less, puts less in the pool, and burns its unsold tokens.</p>
    </div>
  );
}
