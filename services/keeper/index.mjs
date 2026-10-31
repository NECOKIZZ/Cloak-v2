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
//   Every address comes from CloakConfig's registry. FACTORY/START_BLOCK/ROUTER/BATCHER/BATCHER_BLOCK/MIGRATOR override it.
import { createServer } from "node:http";
import { createPublicClient, createWalletClient, http, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Cloak, anvilLocal, elysiumTestnet, drandRoundTime, readRegistry, cloakAuctionAbi, cloakMigratorAbi, cloakPairAbi, cloakVaultsAbi, privateBatcherAbi, privateRouterAbi, shieldedPoolAbi, walletSubmitter } from "@cloakely/sdk";

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
const publicClient = createPublicClient({ chain, transport, pollingInterval: 250 });
const reg = process.env.CONFIG ? await readRegistry(publicClient, process.env.CONFIG) : undefined;
const FACTORY = process.env.FACTORY ?? reg?.factory;
const START_BLOCK = BigInt(process.env.START_BLOCK ?? reg?.factoryBlock ?? 0);
const ROUTER = process.env.ROUTER ?? reg?.router; // enables POST /relay for private trades
const BATCHER = process.env.BATCHER ?? reg?.batcher; // enables batch-auction orders + settles/claims rounds
const BATCHER_BLOCK = BigInt(process.env.BATCHER_BLOCK ?? reg?.batcherBlock ?? START_BLOCK);
const MIGRATOR = process.env.MIGRATOR ?? reg?.migrator; // enables relayed moves from earlier deployments
// v4 routers read their vaults from CloakVaults; an older router has none (the keeper then just doesn't open vaults)
const VAULTS = ROUTER ? await publicClient.readContract({ address: ROUTER, abi: privateRouterAbi, functionName: "vaults" }).catch(() => undefined) : undefined;

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
for (const m of ["writeContract", "sendTransaction"]) {
  const send = walletClient[m].bind(walletClient);
  walletClient[m] = (args) =>
    serial(async () => {
      const hash = await send(args);
      // once it's sent, the hash is the answer: a node that stops answering while we wait doesn't unsend it
      await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 }).catch((e) => console.error(`[tx] ${hash} not confirmed yet: ${e.shortMessage ?? e.message}`));
      return hash;
    });
}
const cloak = new Cloak(publicClient, walletClient, FACTORY);

const status = { keeper: account.address, chain: chain.id, config: process.env.CONFIG ?? null, factory: FACTORY, launches: {}, lastTick: 0 };
const done = new Set(); // auctions fully claimed
const log = (a, m) => console.log(`[${new Date().toISOString()}] ${a.slice(0, 10)} ${m}`);

async function tick() {
  const launches = await cloak.listLaunches();
  status.launchCount = launches.length;
  const now = Number((await publicClient.getBlock()).timestamp);
  for (const { auction, token, factory, index } of launches) {
    if (done.has(auction)) continue;
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
        if (now < s.revealEnd + CLAIM_DELAY) continue; // winners' window to claim privately
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

/** The launch's permanent private vault, so winners can claim privately and the token trades privately at once. */
async function openVault(auction, token, factory, index) {
  if (!VAULTS) return;
  const pool = await publicClient.readContract({ address: VAULTS, abi: cloakVaultsAbi, functionName: "poolOf", args: [token] });
  if (pool !== zeroAddress) return;
  const c = { address: VAULTS, abi: cloakVaultsAbi, functionName: "createPool", args: [factory, index] };
  await publicClient.simulateContract({ ...c, account });
  log(auction, `opened private vault ${await walletClient.writeContract(c)}`);
}

// ───────────── private batch rounds ─────────────
const batchCursor = { block: BATCHER_BLOCK, open: new Map() }; // "token:round" → [order ids]
async function tickBatches() {
  if (!BATCHER) return;
  const c = { address: BATCHER, abi: privateBatcherAbi };
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
(async function loop() {
  for (;;) {
    if (ticks++ % 100 === 0) await unwrapFees().catch((e) => console.error("unwrap failed:", e.shortMessage ?? e.message));
    await tick().catch((e) => console.error("tick failed:", e.shortMessage ?? e.message));
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
  if (req.method === "POST" && path === "/relay") {
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
        const txHash = await relay(parsed);
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
  if (req.method === "GET" && (path === "/" || path === "/health")) {
    return send(req, res, 200, { ...status, relay: !!ROUTER, router: ROUTER ?? null, batcher: BATCHER ?? null, migrator: MIGRATOR ?? null, vaults: VAULTS ?? null, claimDelay: CLAIM_DELAY });
  }
  send(req, res, 404, { error: "not found" });
}).listen(Number(process.env.PORT ?? 3001), () => console.log(`keeper ${account.address} on ${chain.name}, factory ${FACTORY}${ROUTER ? `, relaying for ${ROUTER}` : ""}`));
