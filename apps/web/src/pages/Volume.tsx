import { useEffect, useState } from "react";
import { parseAbi, zeroAddress, type Address, type Hex } from "viem";
import { GLOAM, txLink } from "../config";
import { friendly } from "../errors";
import { hype, usd } from "../format";
import { readCloak, publicClient } from "../wallet";
import { TokenIcon } from "../ui";
import { save, saved } from "../snapshot";
import { every } from "../every";

interface Activity { kind: string; amount: bigint; block: bigint; tx: Hex }
interface Stats {
  total: bigint;
  vault: bigint;
  vaultHype: bigint;
  shielded: bigint;
  withdrawn: bigint;
  swapVolume: bigint;
  swaps: number;
  batchVolume: bigint;
  batchRounds: number;
  batchOrders: number;
  bidDeposits: bigint;
  bids: number;
  raised: bigint;
  launches: number;
  privateTxs: number;
  recent: Activity[];
  tokensLive?: number;
  drops?: number;
  revenue?: Revenue;
}
interface Fee { collected: bigint; owed: bigint }
interface Revenue { launches: Fee; drops: Fee; vaults: Fee; usdc: Fee; collected: bigint; owed: bigint }

let cache: { at: number; data: Stats } | null = null;

type Ev = { args: Record<string, unknown>; blockNumber: bigint; transactionHash: Hex };
const VAULT_EVENTS = parseAbi([
  "event Shielded(bytes32 indexed commitment, address indexed asset, uint256 amount, uint256 leafIndex, address indexed from)",
  "event Unshielded(bytes32 indexed nullifier, address indexed asset, address indexed to, uint256 amount)",
  "event Transferred(bytes32 indexed nullifier, bytes32[2] newCommitments)",
  "function launchTokensCount() view returns (uint256)",
]);
const SWAP_EVENTS = parseAbi(["event LaunchSwap(bytes32 indexed id, address indexed assetIn, address indexed assetOut, uint256 amountIn, uint256 amountOut, uint256 leftover)"]);
const BATCH_EVENTS = parseAbi([
  "event OrderPlaced(bytes32 indexed id, address indexed token, uint64 indexed round, bool buy, uint256 size, uint256 net)",
  "event BatchSettled(address indexed token, uint64 indexed round, uint256 tokensForBuyers, uint256 hypeForSellers, int256 netHype)",
]);

/**
 * Cloak v2's public totals, counted from on-chain events: deposits into and withdrawals out of both vaults (Gloam's
 * and Cloak's launch vault), private swaps and batch rounds through the v4 escrows, and the v2 factory's sealed-bid
 * launches. HYPE amounts only (address 0); USDC moves count as transactions.
 */
async function loadStats(): Promise<Stats> {
  if (cache && Date.now() - cache.at < 20_000) return cache.data;
  const g = GLOAM;
  if (!g) throw new Error("Cloak v2 isn't deployed on this network.");
  // Gloam's vault from its deploy block; the launch vault and its escrows came later, so they're read from theirs
  const ev = (address: Address | undefined, abi: readonly unknown[], eventName: string): Promise<Ev[]> =>
    address
      ? (publicClient.getContractEvents({ address, abi: abi as never, eventName: eventName as never, fromBlock: address === g.gloamVault ? g.block : (g.launchVaultBlock ?? g.block), toBlock: "latest", strict: true }) as Promise<Ev[]>)
      : Promise.resolve([]);
  const vaults = [g.gloamVault, g.launchVault];
  const [shields, unshields, transfers, swaps, orders, settles, launches, vaultHype, tokensLive] = await Promise.all([
    Promise.all(vaults.map((v) => ev(v, VAULT_EVENTS, "Shielded"))).then((x) => x.flat()),
    Promise.all(vaults.map((v) => ev(v, VAULT_EVENTS, "Unshielded"))).then((x) => x.flat()),
    Promise.all(vaults.map((v) => ev(v, VAULT_EVENTS, "Transferred"))).then((x) => x.flat()),
    ev(g.launchSwapV4, SWAP_EVENTS, "LaunchSwap"),
    ev(g.batcherV4, BATCH_EVENTS, "OrderPlaced"),
    ev(g.batcherV4, BATCH_EVENTS, "BatchSettled"),
    readCloak.listLaunches(),
    Promise.all(vaults.map((v) => publicClient.getBalance({ address: v }))).then((x) => x.reduce((a, b) => a + b, 0n)),
    publicClient.readContract({ address: g.launchVault, abi: VAULT_EVENTS, functionName: "launchTokensCount" }).then(Number).catch(() => undefined),
  ]);
  const auctions = await Promise.all(launches.map((l) => readCloak.getAuction(l.auction)));
  const isHype = (a: unknown) => String(a).toLowerCase() === zeroAddress;
  const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);
  const hypeShields = shields.filter((e) => isHype(e.args.asset));
  const hypeUnshields = unshields.filter((e) => isHype(e.args.asset));
  const shielded = sum(hypeShields.map((e) => e.args.amount as bigint));
  const withdrawn = sum(hypeUnshields.map((e) => e.args.amount as bigint));
  // the HYPE side of each private swap: amount in for buys, amount out for sells
  const swapHype = swaps.map((e) => (isHype(e.args.assetIn) ? (e.args.amountIn as bigint) : (e.args.amountOut as bigint)));
  const batchHype = settles.map((e) => {
    const n = e.args.netHype as bigint;
    return (e.args.hypeForSellers as bigint) + (n > 0n ? n : 0n);
  });
  const swapVolume = sum(swapHype);
  const batchVolume = sum(batchHype);
  const bidDeposits = sum(auctions.map((a) => a.totalDeposits));
  const recent: Activity[] = [
    ...hypeShields.map((e) => ({ kind: "Shielded", amount: e.args.amount as bigint, block: e.blockNumber, tx: e.transactionHash })),
    ...swaps.map((e, i) => ({ kind: isHype(e.args.assetIn) ? "Private buy" : "Private sell", amount: swapHype[i], block: e.blockNumber, tx: e.transactionHash })),
    ...settles.map((e, i) => ({ kind: "Batch round", amount: batchHype[i], block: e.blockNumber, tx: e.transactionHash })),
    ...hypeUnshields.map((e) => ({ kind: "Withdrawn", amount: e.args.amount as bigint, block: e.blockNumber, tx: e.transactionHash })),
  ].sort((a, b) => Number(b.block - a.block)).slice(0, 12);
  const data: Stats = {
    total: shielded + swapVolume + batchVolume + bidDeposits,
    vault: vaultHype,
    vaultHype,
    shielded,
    withdrawn,
    swapVolume,
    swaps: swaps.length,
    batchVolume,
    batchRounds: settles.length,
    batchOrders: orders.length,
    bidDeposits,
    bids: auctions.reduce((a, s) => a + s.commits, 0),
    raised: sum(auctions.filter((a) => a.settled && !a.failed).map((a) => a.raised)),
    launches: launches.length,
    privateTxs: shields.length + unshields.length + transfers.length,
    recent,
    tokensLive,
  };
  cache = { at: Date.now(), data };
  save("stats", data);
  return data;
}

function Card({ k, v, sub, unit = "HYPE" }: { k: string; v: string; sub?: string; unit?: string }) {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className="v">{v} {unit && <span className="small mute">{unit}</span>}</div>
      {sub && <div className="xs mute" style={{ marginTop: 6 }}>{sub}</div>}
    </div>
  );
}

export function Volume() {
  const [s, setS] = useState<Stats | null>(cache?.data ?? saved<Stats>("stats") ?? null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let alive = true;
    const go = () => loadStats().then((d) => alive && (setS(d), setErr(""))).catch((e) => alive && setErr(friendly(e)));
    go();
    const stop = every(go, 60_000);
    return () => {
      alive = false;
      stop();
    };
  }, []);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Volume</h1>
          <p>Counted from public on-chain events. Who did what stays private.</p>
        </div>
        <span className="pill"><span className="dot live" />Live · refreshes every minute</span>
      </div>
      {err && <div className="err" style={{ marginBottom: 16 }}>{err}</div>}
      {!s ? (
        <div className="empty">Counting events on Elysium…</div>
      ) : (
        <>
          <div className="vol-hero">
            <div>
              <div className="eyebrow">Total cloaked volume</div>
              <div className="vol-big"><TokenIcon symbol="HYPE" size={44} />{hype(s.total, 4)} <span>HYPE</span></div>
              <p className="small mute">Shielded deposits, private swap and batch volume, and sealed-bid deposits, added up.</p>
            </div>
            <div className="vol-side">
              <div>
                <span className="mute small">HYPE in the vaults</span>
                <b>{hype(s.vaultHype, 4)} HYPE</b>
                {s.vault > s.vaultHype && <span className="xs mute" title="Launch tokens held privately, valued at each pool's current price. Thin pools can't absorb that much selling, so this isn't cash.">+ launch tokens worth {hype(s.vault - s.vaultHype, 2)} HYPE at pool prices</span>}
              </div>
              <div><span className="mute small">Private transactions</span><b>{s.privateTxs.toLocaleString()}</b></div>
            </div>
          </div>
          <div className="stats" style={{ marginTop: 18 }}>
            <Card k="Shielded (all time)" v={hype(s.shielded, 4)} sub={`${hype(s.withdrawn, 4)} HYPE withdrawn`} />
            <Card k="Private swap volume" v={hype(s.swapVolume, 4)} sub={`${s.swaps} private swap${s.swaps === 1 ? "" : "s"}`} />
            <Card k="Batch volume" v={hype(s.batchVolume, 4)} sub={`${s.batchOrders} sealed order${s.batchOrders === 1 ? "" : "s"} in ${s.batchRounds} round${s.batchRounds === 1 ? "" : "s"}`} />
            <Card k="Sealed-bid deposits" v={hype(s.bidDeposits, 4)} sub={`${s.bids} sealed bid${s.bids === 1 ? "" : "s"} across ${s.launches} launch${s.launches === 1 ? "" : "es"} · ${hype(s.raised, 4)} HYPE raised`} />
          </div>
          {(s.tokensLive !== undefined || s.drops !== undefined) && (
            <div className="stats" style={{ marginTop: 18, gridTemplateColumns: "repeat(2, 1fr)" }}>
              <Card k="Tokens trading privately" v={(s.tokensLive ?? 0).toLocaleString()} unit="" sub="Admitted to the launch vault" />
              <Card k="Launches" v={s.launches.toLocaleString()} unit="" sub={`${hype(s.raised, 4)} HYPE raised`} />
            </div>
          )}
          {s.revenue && (
            <div className="card" style={{ marginTop: 18 }}>
              <div className="card-head"><h3>Protocol revenue</h3><span className="xs mute">Fees go to the Cloak treasury. Testnet figures are play money.</span></div>
              <div className="stats" style={{ marginTop: 4 }}>
                <Card k="Fees earned" v={hype(s.revenue.collected + s.revenue.owed, 4)} sub={`${hype(s.revenue.collected, 4)} HYPE collected and ${hype(s.revenue.owed, 4)} HYPE waiting`} />
                <Card k="From launches" v={hype(s.revenue.launches.collected + s.revenue.launches.owed, 4)} sub="A share of each successful raise" />
                <Card k="From NFT drops" v={hype(s.revenue.drops.collected + s.revenue.drops.owed, 4)} sub="A share of each drop's sales" />
                <Card k="From withdrawals" v={hype(s.revenue.vaults.collected + s.revenue.vaults.owed, 4)} sub={s.revenue.usdc.collected + s.revenue.usdc.owed > 0n ? `A small fee on each withdrawal, plus ${usd(s.revenue.usdc.collected + s.revenue.usdc.owed)} USDC` : "A small fee on each withdrawal"} />
              </div>
            </div>
          )}
          <div className="card" style={{ marginTop: 18 }}>
            <div className="card-head"><h3>Recent activity</h3><span className="xs mute">Amounts the chain already shows. Senders are hidden.</span></div>
            {s.recent.length === 0 ? (
              <p className="small mute">No private activity yet.</p>
            ) : (
              <div className="fl" style={{ gridTemplateColumns: "1fr" }}>
                {s.recent.map((a) => (
                  <div key={a.tx + a.kind} className="row">
                    <span>{a.kind}</span>
                    <span className="row-flex" style={{ gap: 14 }}>
                      <span className="mono">{hype(a.amount, 6)} HYPE</span>
                      {txLink(a.tx) && <a className="xs link" href={txLink(a.tx)} target="_blank" rel="noreferrer">block {a.block.toString()} ↗</a>}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
