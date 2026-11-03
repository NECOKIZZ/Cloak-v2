// Cloak keeper: watches every launch from a factory and, with no key material beyond a gas wallet,
//   1. decrypts sealed bids once their drand round is out and reveals them (bidders never come back),
//   2. settles when the reveal window closes, and opens the launch's permanent private vault,
//   3. after CLAIM_DELAY (so winners can claim privately first), pushes tokens + refunds to every bidder still unclaimed.
// Anyone can run one; several keepers racing is harmless (reveal/settle/claim are idempotent on-chain).
//
//   4. relays private trades: POST /relay {kind, pool, proof, extData}. The relayer pays gas and is the on-chain
//      sender, so the trader's wallet never appears. It cannot alter a trade: the proof binds every field.
//   5. settles every finished private batch round and pays orders out as private notes (refunds a round whose price
//      moved too far, once the refund delay passes).
//   6. relays moves of private balances from earlier deployments through the migrator.
//   7. relays private sends and withdrawals for asset vaults such as USDC (a vault with no launch pair), with the fee
//      priced from the live HYPE/USD price (HYPE_USD is the fallback when the price feed is down).
//
//   Relayed calls pay the relayer a fee inside the proof (GET /quote?kind=…&pool=… says how much), so relaying can't
//   be used to drain the relayer's gas.
//
//   KEEPER_PK=0x… CONFIG=0x… [RPC_URL=…] [CLAIM_DELAY=3600] [PORT=3001] node services/keeper/index.mjs
//   Every address comes from CloakConfig's registry. Without CONFIG (tests), FACTORY/START_BLOCK/ROUTER/BATCHER/
//   BATCHER_BLOCK/MIGRATOR give them directly; with CONFIG those are ignored.
import { createServer } from "node:http";
import { startSnapshots } from "./snapshot.mjs";
import { createPublicClient, createWalletClient, encodeFunctionData, http, keccak256, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Cloak, CloakDrops, anvilLocal, deploymentFor, elysiumTestnet, drandRoundTime, readRegistry, cloakAuctionAbi, cloakFactoryAbi, cloakMigratorAbi, cloakPairAbi, cloakVaultsAbi, privateBatcherAbi, privateRouterAbi, sharedBatcherAbi, sharedRouterAbi, sharedVaultAbi, shieldedPoolAbi, walletSubmitter } from "@cloakely/sdk";

const RPC = process.env.RPC_URL ?? elysiumTestnet.rpcUrls.default.http[0];
const chain = RPC.includes("127.0.0.1") || RPC.includes("localhost") ? anvilLocal : elysiumTestnet;
const PK = process.env.KEEPER_PK;
const POLL_MS = Number(process.env.POLL_MS ?? 3000);
const CLAIM_DELAY = Number(process.env.CLAIM_DELAY ?? 3600); // seconds after the reveal window before public claims
if (!PK || (!process.env.CONFIG && !process.env.FACTORY)) {
  console.error("set KEEPER_PK and CONFIG");
  process.exit(1);
}
const transport = http(RPC, { retryCount: 5, retryDelay: 500, timeout: 20_000 });
// Elysium's public RPC rate-limits busy callers, so reads made together go out as one multicall and receipts are polled
// once a second: a relay must never fail because the keeper's own polling used up the limit.
const publicClient = createPublicClient({ chain, transport, pollingInterval: 1000, batch: { multicall: { wait: 16 } } });
const reg = process.env.CONFIG ? await readRegistry(publicClient, process.env.CONFIG) : undefined;
// With CONFIG, the registry is the only source of addresses: stale address variables can't point the keeper elsewhere.
const OVERRIDES = ["FACTORY", "START_BLOCK", "ROUTER", "BATCHER", "BATCHER_BLOCK", "MIGRATOR", "MIGRATIONS", "LEGACY_ROUTER", "ASSET_POOLS"];
const ignored = reg ? OVERRIDES.filter((k) => process.env[k]) : [];
if (ignored.length) console.error(`CONFIG is set, so these are ignored (addresses come from the registry): ${ignored.join(", ")}`);
const env = (k) => (reg ? undefined : process.env[k]);
const FACTORY = env("FACTORY") ?? reg?.factory;
// every factory of this deployment still has launches to reveal, settle and claim: scan from the earliest one
const EARLIER = reg?.earlierFactories ?? [];
const firstFactoryBlock = reg ? reg.entries.filter((e) => e.kind === "factory" && e.version === reg.version).reduce((m, e) => (e.startBlock < m ? e.startBlock : m), reg.factoryBlock) : undefined;
const START_BLOCK = BigInt(env("START_BLOCK") ?? firstFactoryBlock ?? 0);
const ROUTER = env("ROUTER") ?? reg?.router; // enables POST /relay for private trades
const BATCHER = env("BATCHER") ?? reg?.batcher; // enables batch-auction orders + settles/claims rounds
const BATCHER_BLOCK = BigInt(env("BATCHER_BLOCK") ?? reg?.batcherBlock ?? START_BLOCK);
const MIGRATOR = env("MIGRATOR") ?? reg?.migrator; // enables relayed moves from earlier deployments
// the shared launch-token vault (testnet experiment): launches created after it opens go in it instead of a vault each
const SHARED = reg?.shared;
const SHARED_ROUTER = reg?.sharedRouter;
const SHARED_BLOCK = reg?.sharedBlock;
const SHARED_BATCHER = reg?.sharedBatcher;
const SHARED_BATCHER_BLOCK = reg?.entries.findLast((e) => e.kind === "sharedBatcher")?.startBlock ?? SHARED_BLOCK ?? 0n;
// v4 routers read their vaults from CloakVaults; an older router has none (the keeper then just doesn't open vaults)
const VAULTS = ROUTER ? await publicClient.readContract({ address: ROUTER, abi: privateRouterAbi, functionName: "vaults" }).catch(() => undefined) : undefined;

// public data for the site in one request (launches, markets, images, Volume); off with SNAPSHOT=0
const snapshot = reg && process.env.SNAPSHOT !== "0"
  ? startSnapshots(publicClient, { router: ROUTER, routerBlock: reg.routerBlock, batcher: BATCHER, factory: FACTORY, earlierFactories: EARLIER, shared: reg.shared, sharedBlock: reg.sharedBlock, sharedRouter: reg.sharedRouter, sharedBatcher: reg.sharedBatcher, previous: reg.previous })
  : null;

const account = privateKeyToAccount(PK);
const walletClient = createWalletClient({ chain, transport, account });

// One wallet sends everything (reveals, settles, payouts and relays, which arrive at any time), so its transactions go
// out one at a time, each mined before the next: two sends can never pick the same nonce.
let queue = Promise.resolve();
const serial = (fn) => {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
};
/**
 * A contract call, signed here first so its hash is known before it goes out. If the node drops the reply, the same
 * signed bytes are looked up and, if missing, sent again: identical bytes carry the same nonce, so they can land once
 * at most. Without this, a node that timed out mid-send left the caller with no hash for a transaction that landed.
 */
async function broadcast(args) {
  const gas = args.gas ?? (await publicClient.estimateContractGas({ ...args, account: account.address }));
  const prepared = await walletClient.prepareTransactionRequest({ account, chain, to: args.address, data: encodeFunctionData(args), value: args.value, gas });
  const raw = await walletClient.signTransaction(prepared);
  const hash = keccak256(raw);
  const seen = () => publicClient.getTransaction({ hash }).then(() => true, () => false);
  for (let i = 0; ; i++) {
    try {
      await publicClient.sendRawTransaction({ serializedTransaction: raw });
      return hash;
    } catch (e) {
      const m = `${e?.shortMessage ?? ""} ${e?.details ?? ""} ${e?.message ?? ""}`;
      if (/already known|known transaction|already imported/i.test(m)) return hash;
      if (!isNetworkError(e) && !/nonce too low/i.test(m)) throw e;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
      if (await seen()) return hash;
      if (/nonce too low/i.test(m) || i >= 3) throw e;
      console.error(`[tx] ${hash} no answer from the node, sending the same bytes again`);
    }
  }
}
for (const m of ["writeContract", "sendTransaction"]) {
  const send = m === "writeContract" ? broadcast : walletClient[m].bind(walletClient);
  walletClient[m] = (args) =>
    serial(async () => {
      const hash = await send(args);
      // once it's sent, the hash is the answer: a node that stops answering while we wait doesn't unsend it
      await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 }).catch((e) => console.error(`[tx] ${hash} not confirmed yet: ${e.shortMessage ?? e.message}`));
      return hash;
    });
}
const cloak = new Cloak(publicClient, walletClient, FACTORY, EARLIER);

const status = { keeper: account.address, commit: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? null, chain: chain.id, config: process.env.CONFIG ?? null, version: reg?.version ?? null, factory: FACTORY, ignoredEnv: ignored, launches: {}, lastTick: 0 };
const done = new Set(); // auctions fully claimed
const waitUntil = new Map(); // settled auctions with their vault open: nothing to do until public claims start
const log = (a, m) => console.log(`[${new Date().toISOString()}] ${a.slice(0, 10)} ${m}`);

async function tick() {
  const launches = await cloak.listLaunches();
  status.launchCount = launches.length;
  const now = Number((await publicClient.getBlock()).timestamp);
  for (const { auction, token, factory, index } of launches) {
    if (done.has(auction) || now < (waitUntil.get(auction) ?? 0)) continue;
    try {
      const s = await cloak.getAuction(auction);
      status.launches[auction] = { symbol: s.tokenSymbol, phase: s.phase, commits: s.commits, reveals: s.reveals };
      if (s.phase === "reveal" && s.reveals < s.commits && Date.now() / 1000 >= drandRoundTime(s.tlockRound)) {
        const r = await cloak.revealAll(auction, { fromBlock: START_BLOCK, log: (m) => log(auction, m) });
        if (r.revealed) log(auction, `auto-revealed ${r.revealed} bids`);
      } else if (s.phase === "settle" && now >= s.revealEnd) {
        const h = await cloak.settle(auction);
        log(auction, `settled ${h}`);
        if (!(await cloak.getAuction(auction)).failed) await openVault(auction, token, factory, index);
      } else if (s.phase === "settled") {
        if (!s.failed) await openVault(auction, token, factory, index);
        if (now < s.revealEnd + CLAIM_DELAY) {
          waitUntil.set(auction, s.revealEnd + CLAIM_DELAY); // winners' window to claim privately
          continue;
        }
        const r = await cloak.claimAll(auction, { fromBlock: START_BLOCK });
        if (r.claimed) log(auction, `delivered ${r.claimed} claims`);
        // pull payments: the creator's proceeds and the launch fee (a recipient that can't take HYPE only blocks itself)
        for (const h of await cloak.payOut(auction).catch((e) => (log(auction, `payout skipped: ${e.shortMessage ?? e.message}`), []))) log(auction, `paid out ${h}`);
        try {
          const c = { address: auction, abi: cloakAuctionAbi };
          await publicClient.simulateContract({ ...c, functionName: "sweepDust", account });
          await publicClient.waitForTransactionReceipt({ hash: await walletClient.writeContract({ ...c, functionName: "sweepDust" }) });
        } catch {}
        done.add(auction);
      }
    } catch (e) {
      log(auction, `error: ${e.shortMessage ?? e.message}`);
    }
  }
  status.lastTick = Date.now();
}

/** Launches created before the shared vault opened: they keep a vault of their own. Read once. */
let preShared = null;
async function createdBeforeShared(auction) {
  if (!preShared) {
    const logs = await publicClient.getContractEvents({ address: [FACTORY, ...EARLIER], abi: cloakFactoryAbi, eventName: "LaunchCreated", fromBlock: START_BLOCK, toBlock: SHARED_BLOCK - 1n, strict: true });
    preShared = new Set(logs.map((l) => l.args.auction.toLowerCase()));
  }
  return preShared.has(auction.toLowerCase());
}

/** The launch's permanent private vault, so winners can claim privately and the token trades privately at once. */
async function openVault(auction, token, factory, index) {
  // a Uniswap launch created after the shared vault opened goes in the shared vault
  if (SHARED && !(await createdBeforeShared(auction))) {
    const s = await cloak.getAuction(auction);
    if (BigInt(s.uniPair ?? 0) !== 0n) {
      const own = VAULTS ? await publicClient.readContract({ address: VAULTS, abi: cloakVaultsAbi, functionName: "poolOf", args: [token] }) : zeroAddress;
      if (own !== zeroAddress) return;
      if (await publicClient.readContract({ address: SHARED, abi: sharedVaultAbi, functionName: "admitted", args: [token] })) return;
      const c = { address: SHARED, abi: sharedVaultAbi, functionName: "admit", args: [factory, index] };
      await publicClient.simulateContract({ ...c, account });
      log(auction, `admitted to the shared vault ${await walletClient.writeContract(c)}`);
      return;
    }
  }
  if (!VAULTS) return;
  // never a second vault for a token someone already let into the shared vault
  if (SHARED && (await publicClient.readContract({ address: SHARED, abi: sharedVaultAbi, functionName: "admitted", args: [token] }))) return;
  const pool = await publicClient.readContract({ address: VAULTS, abi: cloakVaultsAbi, functionName: "poolOf", args: [token] });
  if (pool !== zeroAddress) return;
  const c = { address: VAULTS, abi: cloakVaultsAbi, functionName: "createPool", args: [factory, index] };
  await publicClient.simulateContract({ ...c, account });
  log(auction, `opened private vault ${await walletClient.writeContract(c)}`);
}

// ───────────── private batch rounds ─────────────
const batchCursors = new Map(); // batcher → { block, open: "token:round" → [order ids] }
// the main batcher, then the shared vault's (same rounds, same storage layout and events)
async function tickBatches() {
  if (BATCHER) await tickBatcher(BATCHER, BATCHER_BLOCK);
  if (SHARED_BATCHER) await tickBatcher(SHARED_BATCHER, SHARED_BATCHER_BLOCK);
}
async function tickBatcher(addr, fromBlock) {
  if (!batchCursors.has(addr)) batchCursors.set(addr, { block: fromBlock, open: new Map() });
  const batchCursor = batchCursors.get(addr);
  const c = { address: addr, abi: privateBatcherAbi };
  const latest = await publicClient.getBlockNumber({ cacheTime: 0 });
  if (latest >= batchCursor.block) {
    const logs = await publicClient.getContractEvents({ ...c, eventName: "OrderPlaced", fromBlock: batchCursor.block, toBlock: latest, strict: true });
    for (const l of logs) {
      const k = `${l.args.token}:${l.args.round}`;
      if (!batchCursor.open.has(k)) batchCursor.open.set(k, []);
      batchCursor.open.get(k).push(l.args.id);
    }
    batchCursor.block = latest + 1n;
  }
  if (batchCursor.open.size === 0) return;
  const [current, refundAfter] = await Promise.all([
    publicClient.readContract({ ...c, functionName: "currentRound" }),
    publicClient.readContract({ ...c, functionName: "refundAfter" }),
  ]);
  const now = BigInt(Math.floor(Date.now() / 1000));
  for (const [k, ids] of batchCursor.open) {
    const [token, r] = k.split(":");
    const round = BigInt(r);
    if (round >= current) continue;
    const b = await publicClient.readContract({ ...c, functionName: "batches", args: [token, round] });
    const settled = b[7], cancelled = b[8];
    try {
      if (!settled && !cancelled) {
        try {
          await publicClient.simulateContract({ ...c, functionName: "settle", args: [token, round], account });
          const h = await walletClient.writeContract({ ...c, functionName: "settle", args: [token, round] });
          await publicClient.waitForTransactionReceipt({ hash: h });
          log(token, `settled private round ${round} (${ids.length} orders) ${h}`);
        } catch (e) {
          const end = (round + 1n) * (await publicClient.readContract({ ...c, functionName: "roundSecs" }));
          if (now < end + refundAfter) {
            log(token, `round ${round} not settleable yet: ${e.shortMessage ?? e.message}`);
            continue;
          }
          const h = await walletClient.writeContract({ ...c, functionName: "refund", args: [ids] });
          await publicClient.waitForTransactionReceipt({ hash: h });
          log(token, `refunded private round ${round} ${h}`);
          batchCursor.open.delete(k);
          continue;
        }
      }
      if (cancelled) {
        batchCursor.open.delete(k);
        continue;
      }
      // only orders not yet paid (after a restart the keeper re-scans old rounds)
      const done = await Promise.all(ids.map((id) => publicClient.readContract({ ...c, functionName: "orders", args: [id] }).then((o) => o[3])));
      const unpaid = ids.filter((_, i) => !done[i]);
      if (unpaid.length > 0) {
        const h = await walletClient.writeContract({ ...c, functionName: "claim", args: [unpaid] });
        await publicClient.waitForTransactionReceipt({ hash: h });
        log(token, `paid out ${unpaid.length} private orders of round ${round} ${h}`);
      }
      batchCursor.open.delete(k);
    } catch (e) {
      log(token, `batch error: ${e.shortMessage ?? e.message}`);
    }
  }
}

// relay fees arrive as WHYPE (from the HYPE pool); unwrap them so they pay for gas
async function unwrapFees() {
  if (!ROUTER) return;
  const whype = await publicClient.readContract({ address: ROUTER, abi: privateRouterAbi, functionName: "whype" });
  const abi = [
    { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
    { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
  ];
  const bal = await publicClient.readContract({ address: whype, abi, functionName: "balanceOf", args: [account.address] });
  if (bal < 10n ** 16n) return;
  const h = await walletClient.writeContract({ address: whype, abi, functionName: "withdraw", args: [bal] });
  await publicClient.waitForTransactionReceipt({ hash: h });
  console.log(`[fees] unwrapped ${bal} WHYPE ${h}`);
}

let ticks = 0;
// ───────────── sealed NFT drops: open the bids, settle, number ties, deliver and pay out, as for launches ─────────────
const knownDeployment = (() => {
  try {
    return deploymentFor(chain.id);
  } catch {
    return undefined;
  }
})();
const DROP_FACTORY = process.env.DROP_FACTORY || knownDeployment?.dropFactory;
const drops = DROP_FACTORY ? new CloakDrops(publicClient, walletClient, DROP_FACTORY, BigInt(process.env.DROP_FACTORY_BLOCK ?? knownDeployment?.dropFactoryBlock ?? 0)) : null;
const dropsDone = new Set();
const dropWait = new Map();
async function tickDrops() {
  if (!drops) return;
  const list = await drops.list();
  status.drops = { factory: DROP_FACTORY, count: list.length, live: {} };
  const now = Number((await publicClient.getBlock()).timestamp);
  for (const d of list) {
    if (dropsDone.has(d) || now < (dropWait.get(d) ?? 0)) continue;
    try {
      const s = await drops.get(d);
      status.drops.live[d] = { symbol: s.symbol, phase: s.phase, bids: s.bids, reveals: s.reveals };
      if (s.phase === "reveal" && s.reveals < s.bids && Date.now() / 1000 >= drandRoundTime(s.tlockRound)) {
        const r = await drops.revealAll(d, { log: (m) => log(d, m) });
        if (r.revealed) log(d, `drop: opened ${r.revealed} bids`);
      } else if ((s.phase === "settle" && now >= s.revealEnd) || s.phase === "numbering") {
        for (const h of await drops.settle(d)) log(d, `drop: settled ${h}`);
      } else if (s.phase === "settled") {
        // winners get the same window as a launch to take their NFTs to another wallet themselves
        if (now < s.revealEnd + CLAIM_DELAY) {
          dropWait.set(d, s.revealEnd + CLAIM_DELAY);
          continue;
        }
        const r = await drops.claimAll(d);
        if (r.claimed) log(d, `drop: delivered ${r.claimed} bids`);
        for (const h of await drops.payOut(d).catch(() => [])) log(d, `drop: paid out ${h}`);
        dropsDone.add(d);
        delete status.drops.live[d];
      } else if (s.phase === "gtd" || s.phase === "bidding") {
        dropWait.set(d, Math.min(s.phase === "gtd" ? s.gtdEnd : s.commitEnd, now + 60));
      }
    } catch (e) {
      log(d, `drop error: ${e.shortMessage ?? e.message}`);
    }
  }
}

(async function loop() {
  for (;;) {
    if (ticks++ % 100 === 0) await unwrapFees().catch((e) => console.error("unwrap failed:", e.shortMessage ?? e.message));
    await tick().catch((e) => console.error("tick failed:", e.shortMessage ?? e.message));
    await tickDrops().catch((e) => console.error("drops tick failed:", e.shortMessage ?? e.message));
    await tickBatches().catch((e) => console.error("batch tick failed:", e.shortMessage ?? e.message));
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
})();

// ───────────── private-trade relay ─────────────
const submit = ROUTER ? walletSubmitter(publicClient, walletClient, ROUTER, BATCHER, MIGRATOR) : null;
const readRouter = (functionName, args = []) => publicClient.readContract({ address: ROUTER, abi: privateRouterAbi, functionName, args });
const big = (x) => (Array.isArray(x) ? x.map(big) : BigInt(x));
const err = (msg, status) => Object.assign(new Error(msg), { status });
const KINDS = ["privateSwap", "unshieldHype", "transact", "placeOrder", "migrate"];
const isPool = (pool) => readRouter("isPool", [pool]);
/** Whether the migrator moves `pool` (a vault of an earlier deployment) into the permanent vaults. */
const isOldPool = (pool) => (MIGRATOR ? publicClient.readContract({ address: MIGRATOR, abi: cloakMigratorAbi, functionName: "isOldPool", args: [pool] }).catch(() => false) : false);
const tokenOf = (pool) => publicClient.readContract({ address: pool, abi: shieldedPoolAbi, functionName: "token" });
/** How a vault's token is priced: "hype", "launch" (its pair) or "asset" (a dollar stablecoin such as USDC). */
async function priceKind(token) {
  if (token.toLowerCase() === (await readRouter("whype")).toLowerCase()) return "hype";
  return (await readRouter("pairOf", [token])) === zeroAddress ? "asset" : "launch";
}
const decimalsAbi = [{ type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }];
let hypeUsdCache = { at: 0, price: 0 };
async function hypeUsd() {
  if (Date.now() - hypeUsdCache.at < 60_000 && hypeUsdCache.price > 0) return hypeUsdCache.price;
  try {
    const r = await fetch(process.env.HYPE_PRICE_URL ?? "https://api.hyperliquid.xyz/info", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "allMids" }), signal: AbortSignal.timeout(5000),
    });
    const price = Number((await r.json()).HYPE);
    if (!(price > 0)) throw new Error("no HYPE price");
    hypeUsdCache = { at: Date.now(), price };
    return price;
  } catch (e) {
    const fallback = Number(process.env.HYPE_USD ?? 0);
    if (fallback > 0) return fallback;
    if (hypeUsdCache.price > 0) return hypeUsdCache.price; // stale beats none
    throw err("No HYPE price right now, so the relayer can't quote a fee in this token. Try again in a minute.", 503);
  }
}

// ── fee quotes: gas for the call × gas price × margin, in the pool's own token ──
const GAS = { transact: 1_900_000n, unshieldHype: 2_000_000n, privateSwap: 2_500_000n, placeOrder: 2_200_000n, migrate: 2_700_000n };
const MARGIN_BPS = BigInt(process.env.RELAY_FEE_MARGIN_BPS ?? 12_500); // 1.25× the gas cost
const MIN_GAS_PRICE = BigInt(process.env.RELAY_MIN_GAS_PRICE ?? 100_000_000); // 0.1 gwei floor
async function quote(kind, pool) {
  if (!KINDS.includes(kind)) throw err("bad kind", 400);
  if (!ROUTER) throw err("relay disabled", 503);
  if (kind === "migrate" ? !(await isOldPool(pool)) : !(await isPool(pool))) throw err("unknown pool", 400);
  const token = await tokenOf(pool);
  const pk = await priceKind(token);
  const asset = pk === "asset";
  if (asset && kind !== "transact" && kind !== "migrate") throw err("this vault supports private sends and withdrawals only", 400);
  const gasPrice = await publicClient.getGasPrice();
  const hype = (GAS[kind] * (gasPrice > MIN_GAS_PRICE ? gasPrice : MIN_GAS_PRICE) * MARGIN_BPS) / 10_000n;
  if (asset) {
    // a dollar stablecoin pays the HYPE cost at the HYPE/USD price, rounded up to the token's smallest unit
    const dec = await publicClient.readContract({ address: token, abi: decimalsAbi, functionName: "decimals" });
    const micro = BigInt(Math.round((await hypeUsd()) * 1e6)); // USD per HYPE, ×1e6
    return (hype * micro * 10n ** BigInt(dec)) / (10n ** 18n * 1_000_000n) + 1n;
  }
  if (pk === "hype") return hype;
  // a launch token pays the HYPE cost at the pair's spot price
  const pair = await readRouter("pairOf", [token]);
  const [rH, rT] = await Promise.all([
    publicClient.readContract({ address: pair, abi: cloakPairAbi, functionName: "reserveHype" }),
    publicClient.readContract({ address: pair, abi: cloakPairAbi, functionName: "reserveToken" }),
  ]);
  if (rH === 0n) throw err("no market for this token", 400);
  return (hype * rT) / rH + 1n;
}

const isNetworkError = (e) => /HTTP request failed|fetch failed|timed? ?out|ECONNRESET|socket hang up|429|502|503|504/i.test(`${e?.shortMessage ?? ""} ${e?.message ?? ""} ${e?.name ?? ""}`);

// one relayed spend per nullifier at a time: a second copy is refused before it costs gas
const inflight = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, t] of inflight) if (now > t) inflight.delete(k);
}, 30_000).unref();

async function relay(body) {
  if (!submit) throw err("relay disabled (set ROUTER)", 503);
  const { kind, pool, proof: p, extData: e } = body;
  if (!KINDS.includes(kind)) throw err("bad kind", 400);
  if (kind === "placeOrder" && !BATCHER) throw err("batching disabled (set BATCHER)", 503);
  if (kind === "migrate" && !MIGRATOR) throw err("migration disabled", 503);
  if (kind === "migrate" ? !(await isOldPool(pool)) : !(await isPool(pool))) throw err("unknown pool", 400);
  if (kind !== "transact" && kind !== "migrate" && (await priceKind(await tokenOf(pool))) === "asset") throw err("this vault supports private sends and withdrawals only", 400);
  const proof = {
    a: big(p.a), b: big(p.b), c: big(p.c), root: big(p.root), publicAmount: big(p.publicAmount),
    extDataHash: big(p.extDataHash), inputNullifiers: big(p.inputNullifiers), outputCommitments: big(p.outputCommitments),
  };
  const extData = { ...e, extAmount: BigInt(e.extAmount), fee: BigInt(e.fee) };

  // the call must pay this relayer at least 80% of the current quote (gas can move between quote and submit)
  if (String(extData.relayer).toLowerCase() !== account.address.toLowerCase()) throw err("fee must be paid to this relayer: GET /quote first", 402);
  const want = await quote(kind, pool);
  if (extData.fee * 10n < want * 8n) throw err(`relayer fee too low: GET /quote first (need ${want})`, 402);

  const keys = proof.inputNullifiers.map((n) => `${chain.id}:${pool.toLowerCase()}:${n}`);
  if (keys.some((k) => inflight.has(k))) throw err("this spend is already being relayed", 409);
  for (const n of proof.inputNullifiers) {
    if (await publicClient.readContract({ address: pool, abi: shieldedPoolAbi, functionName: "isSpent", args: [n] })) throw err("already spent", 409);
  }
  keys.forEach((k) => inflight.set(k, Date.now() + 180_000));
  try {
    const sim = kind === "transact"
      ? { address: pool, abi: shieldedPoolAbi, functionName: "transact", args: [proof, extData] }
      : kind === "placeOrder"
        ? { address: BATCHER, abi: privateBatcherAbi, functionName: "placeOrder", args: [pool, proof, extData] }
        : kind === "migrate"
          ? { address: MIGRATOR, abi: cloakMigratorAbi, functionName: "migrate", args: [pool, proof, extData] }
          : { address: ROUTER, abi: privateRouterAbi, functionName: kind, args: kind === "privateSwap" ? [pool, proof, extData] : [proof, extData] };
    // dry-run first so a bad proof costs the relayer nothing; a node that drops the call gets one more try
    await publicClient.simulateContract({ ...sim, account }).catch(async (e) => {
      if (!isNetworkError(e)) throw e;
      await new Promise((r) => setTimeout(r, 1500));
      return publicClient.simulateContract({ ...sim, account });
    });
  } catch (e) {
    keys.forEach((k) => inflight.delete(k)); // nothing went out: the spend may be retried
    throw isNetworkError(e) ? err("The network didn't answer. Nothing was sent, so try again in a moment.", 503) : e;
  }
  // From here the transaction may be out, so the spend stays locked until it lands (or the lock expires).
  try {
    return await submit({ kind, pool, proof, extData, migrator: MIGRATOR });
  } catch (e) {
    if (isNetworkError(e)) throw err("The network didn't answer while sending. Check your balance in a minute before trying again.", 503);
    keys.forEach((k) => inflight.delete(k)); // the node refused it outright: nothing went out
    throw e;
  }
}

// ───────────── shared launch-token vault relay ─────────────
// sharedTransact (a withdrawal or note merge, fee in the token), sharedSell (fee in the token), sharedBuy (fee in HYPE)
// and sharedSend (a send that hides its token; a second proof pays the fee from the sender's HYPE vault).
const SHARED_KINDS = ["sharedTransact", "sharedBuy", "sharedSell", "sharedSend", "sharedOrderBuy", "sharedOrderSell"];
const SHARED_GAS = { sharedTransact: 2_000_000n, sharedSell: 2_700_000n, sharedBuy: 2_700_000n, sharedSend: 3_800_000n, sharedOrderBuy: 2_300_000n, sharedOrderSell: 2_300_000n };
const readShared = (functionName, args = []) => publicClient.readContract({ address: SHARED, abi: sharedVaultAbi, functionName, args });
async function quoteShared(kind, token) {
  if (!SHARED_KINDS.includes(kind)) throw err("bad kind", 400);
  if (!SHARED || !SHARED_ROUTER || !ROUTER) throw err("the shared vault isn't enabled on this relayer", 503);
  const gasPrice = await publicClient.getGasPrice();
  const hype = (SHARED_GAS[kind] * (gasPrice > MIN_GAS_PRICE ? gasPrice : MIN_GAS_PRICE) * MARGIN_BPS) / 10_000n;
  if ((kind === "sharedOrderBuy" || kind === "sharedOrderSell") && !SHARED_BATCHER) throw err("batch rounds for the shared vault aren't enabled on this relayer", 503);
  if (kind === "sharedBuy" || kind === "sharedOrderBuy") return hype;
  // a hidden send never tells the relayer its token: its fee comes out of the HYPE vault, which keeps its withdrawal fee
  if (kind === "sharedSend") return (hype * 10_000n) / (10_000n - BigInt(await publicClient.readContract({ address: await readRouter("config"), abi: [{ type: "function", name: "withdrawFeeBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] }], functionName: "withdrawFeeBps" }))) + 1n;
  if (!/^0x[0-9a-fA-F]{40}$/.test(token ?? "") || !(await readShared("admitted", [token]))) throw err("this token isn't in the shared vault", 400);
  const market = await readShared("marketOf", [token]);
  const [rH, rT] = await Promise.all([
    publicClient.readContract({ address: market, abi: cloakPairAbi, functionName: "reserveHype" }),
    publicClient.readContract({ address: market, abi: cloakPairAbi, functionName: "reserveToken" }),
  ]);
  if (rH === 0n) throw err("no market for this token", 400);
  return (hype * rT) / rH + 1n;
}

const parseProof = (p) => ({
  a: big(p.a), b: big(p.b), c: big(p.c), root: big(p.root), publicAmount: big(p.publicAmount), extDataHash: big(p.extDataHash),
  ...(p.publicAsset !== undefined ? { publicAsset: big(p.publicAsset) } : {}),
  inputNullifiers: big(p.inputNullifiers), outputCommitments: big(p.outputCommitments),
});
const parseExt = (e) => ({ ...e, extAmount: BigInt(e.extAmount), fee: BigInt(e.fee) });
const me = (a) => String(a).toLowerCase() === account.address.toLowerCase();

async function relayShared(body) {
  if (!SHARED || !SHARED_ROUTER || !ROUTER) throw err("the shared vault isn't enabled on this relayer", 503);
  const { kind } = body;
  if (!SHARED_KINDS.includes(kind)) throw err("bad kind", 400);
  const proof = parseProof(body.proof);
  const extData = parseExt(body.extData);
  const hypePool = await readRouter("hypePool");
  let call, spends;
  if (kind === "sharedBuy" || kind === "sharedOrderBuy") {
    if (!me(extData.relayer) || extData.fee * 10n < (await quoteShared(kind)) * 8n) throw err("relayer fee too low: GET /quote-shared first", 402);
    call = kind === "sharedBuy"
      ? { address: SHARED_ROUTER, abi: sharedRouterAbi, functionName: "buy", args: [proof, extData] }
      : { address: SHARED_BATCHER, abi: sharedBatcherAbi, functionName: "placeBuy", args: [proof, extData] };
    spends = [[hypePool, shieldedPoolAbi, proof.inputNullifiers]];
  } else if (kind === "sharedSend") {
    if (!body.feeProof || !body.feeExtData) throw err("malformed request", 400);
    const feeProof = parseProof(body.feeProof);
    const feeExt = parseExt(body.feeExtData);
    if (proof.publicAsset !== 0n || extData.extAmount !== 0n || extData.fee !== 0n) throw err("a hidden send moves no tokens and pays no fee in the vault", 400);
    if (feeExt.recipient.toLowerCase() !== SHARED_ROUTER.toLowerCase() || -feeExt.extAmount * 10n < (await quoteShared(kind)) * 8n) throw err("relayer fee too low: GET /quote-shared first", 402);
    call = { address: SHARED_ROUTER, abi: sharedRouterAbi, functionName: "send", args: [proof, extData, feeProof, feeExt] };
    spends = [[SHARED, sharedVaultAbi, proof.inputNullifiers], [hypePool, shieldedPoolAbi, feeProof.inputNullifiers]];
  } else {
    const token = `0x${(proof.publicAsset ?? 0n).toString(16).padStart(40, "0")}`;
    if (!me(extData.relayer) || extData.fee * 10n < (await quoteShared(kind, token)) * 8n) throw err("relayer fee too low: GET /quote-shared first", 402);
    if (kind === "sharedOrderSell" && !SHARED_BATCHER) throw err("batch rounds for the shared vault aren't enabled on this relayer", 503);
    call = kind === "sharedSell"
      ? { address: SHARED_ROUTER, abi: sharedRouterAbi, functionName: "sell", args: [proof, extData] }
      : kind === "sharedOrderSell"
        ? { address: SHARED_BATCHER, abi: sharedBatcherAbi, functionName: "placeSell", args: [proof, extData] }
        : { address: SHARED, abi: sharedVaultAbi, functionName: "transact", args: [proof, extData] };
    spends = [[SHARED, sharedVaultAbi, proof.inputNullifiers]];
  }
  const keys = spends.flatMap(([pool, , ns]) => ns.map((n) => `${chain.id}:${pool.toLowerCase()}:${n}`));
  if (keys.some((k) => inflight.has(k))) throw err("this spend is already being relayed", 409);
  for (const [pool, abi, ns] of spends) for (const n of ns) if (await publicClient.readContract({ address: pool, abi, functionName: "isSpent", args: [n] })) throw err("already spent", 409);
  keys.forEach((k) => inflight.set(k, Date.now() + 180_000));
  let gas;
  try {
    await publicClient.simulateContract({ ...call, account });
    gas = await publicClient.estimateContractGas({ ...call, account: account.address });
  } catch (e) {
    keys.forEach((k) => inflight.delete(k));
    throw isNetworkError(e) ? err("The network didn't answer. Nothing was sent, so try again in a moment.", 503) : e;
  }
  try {
    return await walletClient.writeContract({ ...call, gas: (gas * 13n) / 10n + 100_000n });
  } catch (e) {
    if (isNetworkError(e)) throw err("The network didn't answer while sending. Check your balance in a minute before trying again.", 503);
    keys.forEach((k) => inflight.delete(k));
    throw e;
  }
}

// Browsers may only call the relayer from these sites. Other apps run their own keeper or set CORS_ORIGINS.
const ORIGINS = (process.env.CORS_ORIGINS ?? "https://cloak.boblabs.tech,http://localhost:5173,http://localhost:4173").split(",").map((s) => s.trim());
const MAX_BODY = 64 * 1024;
const LIMIT = Number(process.env.RELAY_PER_MIN ?? 20); // relay requests per IP per minute
const hits = new Map();
setInterval(() => hits.clear(), 60_000).unref();
const limited = (req) => {
  const ip = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "").split(",")[0].trim();
  const n = (hits.get(ip) ?? 0) + 1;
  hits.set(ip, n);
  return n > LIMIT;
};

const send = (req, res, code, obj) => {
  const origin = req.headers.origin;
  const allow = ORIGINS.includes("*") ? "*" : origin && ORIGINS.includes(origin) ? origin : ORIGINS[0];
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": allow, "access-control-allow-headers": "content-type", vary: "origin", "x-content-type-options": "nosniff" });
  res.end(code === 204 ? undefined : JSON.stringify(obj));
};

createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  if (req.method === "OPTIONS") return send(req, res, 204, {});
  if (req.method === "POST" && (path === "/relay" || path === "/relay-shared")) {
    if (limited(req)) return send(req, res, 429, { error: "too many requests, try again in a minute" });
    let body = "";
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        send(req, res, 413, { error: "request too large" });
        req.destroy();
        return;
      }
      body += c;
    });
    req.on("end", async () => {
      if (size > MAX_BODY) return;
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        return send(req, res, 400, { error: "malformed request" });
      }
      if (!parsed || typeof parsed !== "object" || typeof parsed.proof !== "object" || typeof parsed.extData !== "object" || !parsed.proof || !parsed.extData) {
        return send(req, res, 400, { error: "malformed request" });
      }
      try {
        const txHash = await (path === "/relay-shared" ? relayShared(parsed) : relay(parsed));
        console.log(`[relay] ${txHash}`);
        send(req, res, 200, { txHash });
      } catch (e) {
        // contract reverts carry a short message the app translates; anything else is a bad payload
        if (!e.status && isNetworkError(e)) return send(req, res, 503, { error: "The network didn't answer. Nothing was sent, so try again in a moment." });
        send(req, res, e.status ?? 400, { error: e.status || e.shortMessage ? e.shortMessage ?? e.message : "malformed request" });
      }
    });
    return;
  }
  if (req.method === "GET" && path === "/quote") {
    if (limited(req)) return send(req, res, 429, { error: "too many requests, try again in a minute" });
    const q = new URL(req.url, "http://x").searchParams;
    const pool = q.get("pool") ?? "";
    if (!/^0x[0-9a-fA-F]{40}$/.test(pool)) return send(req, res, 400, { error: "bad pool" });
    quote(q.get("kind"), pool)
      .then((fee) => send(req, res, 200, { relayer: account.address, fee: fee.toString() }))
      .catch((e) => send(req, res, e.status ?? 400, { error: e.status ? e.message : "quote failed" }));
    return;
  }
  if (req.method === "GET" && path === "/quote-shared") {
    if (limited(req)) return send(req, res, 429, { error: "too many requests, try again in a minute" });
    const q = new URL(req.url, "http://x").searchParams;
    quoteShared(q.get("kind"), q.get("token") ?? undefined)
      .then((fee) => send(req, res, 200, { relayer: account.address, fee: fee.toString() }))
      .catch((e) => send(req, res, e.status ?? 400, { error: e.status ? e.message : "quote failed" }));
    return;
  }
  if (req.method === "GET" && path === "/snapshot") {
    const body = snapshot?.get();
    if (!body) return send(req, res, 503, { error: "no snapshot yet" });
    const origin = req.headers.origin;
    const allow = ORIGINS.includes("*") ? "*" : origin && ORIGINS.includes(origin) ? origin : ORIGINS[0];
    const gz = /\bgzip\b/.test(req.headers["accept-encoding"] ?? "");
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": allow, vary: "origin, accept-encoding", "cache-control": "public, max-age=10", "x-content-type-options": "nosniff", ...(gz ? { "content-encoding": "gzip" } : {}) });
    return res.end(gz ? snapshot.gz() : body);
  }
  if (req.method === "GET" && (path === "/" || path === "/health")) {
    return send(req, res, 200, { ...status, relay: !!ROUTER, router: ROUTER ?? null, batcher: BATCHER ?? null, migrator: MIGRATOR ?? null, vaults: VAULTS ?? null, shared: SHARED ?? null, sharedRouter: SHARED_ROUTER ?? null, sharedBatcher: SHARED_BATCHER ?? null, claimDelay: CLAIM_DELAY });
  }
  send(req, res, 404, { error: "not found" });
}).listen(Number(process.env.PORT ?? 3001), () => console.log(`keeper ${account.address} on ${chain.name}, factory ${FACTORY}${ROUTER ? `, relaying for ${ROUTER}` : ""}`));
