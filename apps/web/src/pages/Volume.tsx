import { useEffect, useState } from "react";
import type { Address, Hex } from "viem";
import { cloakTokenAbi, privateBatcherAbi, privateRouterAbi, shieldedPoolAbi, whypeAbi } from "@cloak/sdk";
import { BATCHER, ROUTER, ROUTER_BLOCK, txLink } from "../config";
import { friendly } from "../errors";
import { hype } from "../format";
import { readCloak, publicClient } from "../wallet";
import { TokenIcon } from "../ui";
import { loadMarkets } from "./markets";

const WAD = 10n ** 18n;

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
}

let cache: { at: number; data: Stats } | null = null;

/** Everything here is read from public events and balances; no amounts of private notes are knowable. */
async function loadStats(): Promise<Stats> {
  if (cache && Date.now() - cache.at < 20_000) return cache.data;
  if (!ROUTER) throw new Error("no router");
  const fromBlock = ROUTER_BLOCK;
  const ev = <N extends string>(address: Address, abi: readonly unknown[], eventName: N) =>
    publicClient.getContractEvents({ address, abi: abi as never, eventName: eventName as never, fromBlock, toBlock: "latest", strict: true }) as Promise<{ args: Record<string, unknown>; blockNumber: bigint; transactionHash: Hex }[]>;

  const [hypePool, whype, markets, launches] = await Promise.all([
    publicClient.readContract({ address: ROUTER, abi: privateRouterAbi, functionName: "hypePool" }),
    publicClient.readContract({ address: ROUTER, abi: privateRouterAbi, functionName: "whype" }),
    loadMarkets(true),
    readCloak.listLaunches(),
  ]);
  const [shields, unshields, swaps, settles, orders, nullifiers, vaultHype, tokenVaults, auctions] = await Promise.all([
    ev(ROUTER, privateRouterAbi, "Shielded"),
    ev(ROUTER, privateRouterAbi, "Unshielded"),
    ev(ROUTER, privateRouterAbi, "PrivateSwap"),
    BATCHER ? ev(BATCHER, privateBatcherAbi, "BatchSettled") : Promise.resolve([]),
    BATCHER ? ev(BATCHER, privateBatcherAbi, "OrderPlaced") : Promise.resolve([]),
    publicClient.getContractEvents({ address: [hypePool, ...markets.map((m) => m.pool)], abi: shieldedPoolAbi, eventName: "NewNullifier", fromBlock, toBlock: "latest" }),
    publicClient.readContract({ address: whype, abi: whypeAbi, functionName: "balanceOf", args: [hypePool] }),
    Promise.all(markets.map((m) => publicClient.readContract({ address: m.token, abi: cloakTokenAbi, functionName: "balanceOf", args: [m.pool] }).then((b) => (b * m.price) / WAD))),
    Promise.all(launches.map((l) => readCloak.getAuction(l.auction))),
  ]);

  const hp = hypePool.toLowerCase();
  const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);
  const shielded = sum(shields.map((e) => e.args.amount as bigint));
  const withdrawn = sum(unshields.map((e) => e.args.amount as bigint));
  // the HYPE side of each private swap: amount in for buys, amount out for sells
  const swapHype = swaps.map((e) => ((e.args.poolIn as string).toLowerCase() === hp ? (e.args.amountIn as bigint) : (e.args.amountOut as bigint)));
  const batchHype = settles.map((e) => (e.args.buyHype as bigint) + (e.args.hypeForSellers as bigint));
  const swapVolume = sum(swapHype);
  const batchVolume = sum(batchHype);
  const bidDeposits = sum(auctions.map((a) => a.totalDeposits));
  const vault = vaultHype + sum(tokenVaults);

  const recent: Activity[] = [
    ...shields.map((e) => ({ kind: "Shielded", amount: e.args.amount as bigint, block: e.blockNumber, tx: e.transactionHash })),
    ...swaps.map((e, i) => ({ kind: (e.args.poolIn as string).toLowerCase() === hp ? "Private buy" : "Private sell", amount: swapHype[i], block: e.blockNumber, tx: e.transactionHash })),
    ...settles.map((e, i) => ({ kind: "Batch round", amount: batchHype[i], block: e.blockNumber, tx: e.transactionHash })),
    ...unshields.map((e) => ({ kind: "Withdrawn", amount: e.args.amount as bigint, block: e.blockNumber, tx: e.transactionHash })),
  ].sort((a, b) => Number(b.block - a.block)).slice(0, 12);

  const data: Stats = {
    total: shielded + swapVolume + batchVolume + bidDeposits,
    vault,
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
    privateTxs: Math.floor(nullifiers.length / 2),
    recent,
  };
  cache = { at: Date.now(), data };
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
  const [s, setS] = useState<Stats | null>(cache?.data ?? null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let alive = true;
    const go = () => loadStats().then((d) => alive && (setS(d), setErr(""))).catch((e) => alive && setErr(friendly(e)));
    go();
    const t = setInterval(go, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Volume</h1>
          <p>Everything that has moved through Cloak on Elysium testnet, counted from public on-chain events. Who did what stays private.</p>
        </div>
        <span className="pill"><span className="dot live" />Live · refreshes every 30 s</span>
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
              <div><span className="mute small">In the vault right now</span><b>{hype(s.vault, 4)} HYPE</b></div>
              <div><span className="mute small">Private transactions</span><b>{s.privateTxs.toLocaleString()}</b></div>
            </div>
          </div>
          <div className="stats" style={{ marginTop: 18 }}>
            <Card k="Shielded (all time)" v={hype(s.shielded, 4)} sub={`${hype(s.withdrawn, 4)} HYPE withdrawn`} />
            <Card k="Private swap volume" v={hype(s.swapVolume, 4)} sub={`${s.swaps} private swaps`} />
            <Card k="Batch volume" v={hype(s.batchVolume, 4)} sub={`${s.batchOrders} sealed orders in ${s.batchRounds} rounds`} />
            <Card k="Sealed-bid deposits" v={hype(s.bidDeposits, 4)} sub={`${s.bids} sealed bids across ${s.launches} launches · ${hype(s.raised, 4)} HYPE raised`} />
          </div>
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
