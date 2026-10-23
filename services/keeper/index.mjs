// Cloak keeper: watches every launch from a factory and, with no key material beyond a gas wallet,
//   1. decrypts sealed bids once their drand round is out and reveals them (bidders never come back),
//   2. settles when the reveal window closes,
//   3. pushes tokens + refunds to every bidder.
// Anyone can run one; several keepers racing is harmless (reveal/settle/claim are idempotent on-chain).
//
//   4. (with ROUTER set) relays private trades: POST /relay {kind, pool, proof, extData}. The relayer pays gas and is
//      the on-chain sender, so the trader's wallet never appears. It cannot alter a trade: the proof binds every field.
//
//   5. (with BATCHER set) settles every finished private batch round and pays orders out as private notes
//      (refunds a round whose price moved too far, once the refund delay passes).
//
//   KEEPER_PK=0x… FACTORY=0x… [ROUTER=0x…] [BATCHER=0x… BATCHER_BLOCK=…] [RPC_URL=…] [START_BLOCK=…] [PORT=3001] node services/keeper/index.mjs
import { createServer } from "node:http";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Cloak, anvilLocal, elysiumTestnet, drandRoundTime, privateBatcherAbi, privateRouterAbi, shieldedPoolAbi, walletSubmitter } from "@cloak/sdk";

const RPC = process.env.RPC_URL ?? elysiumTestnet.rpcUrls.default.http[0];
const chain = RPC.includes("127.0.0.1") || RPC.includes("localhost") ? anvilLocal : elysiumTestnet;
const FACTORY = process.env.FACTORY;
const PK = process.env.KEEPER_PK;
const START_BLOCK = BigInt(process.env.START_BLOCK ?? 0);
const POLL_MS = Number(process.env.POLL_MS ?? 3000);
const ROUTER = process.env.ROUTER; // enables POST /relay for private trades
const BATCHER = process.env.BATCHER; // enables batch-auction orders + settles/claims rounds
const BATCHER_BLOCK = BigInt(process.env.BATCHER_BLOCK ?? START_BLOCK);
if (!FACTORY || !PK) {
  console.error("set FACTORY and KEEPER_PK");
  process.exit(1);
}

const account = privateKeyToAccount(PK);
const transport = http(RPC);
const publicClient = createPublicClient({ chain, transport, pollingInterval: 250 });
const walletClient = createWalletClient({ chain, transport, account });
const cloak = new Cloak(publicClient, walletClient, FACTORY);

const status = { keeper: account.address, chain: chain.id, factory: FACTORY, launches: {}, lastTick: 0 };
const done = new Set(); // auctions fully claimed
const log = (a, m) => console.log(`[${new Date().toISOString()}] ${a.slice(0, 10)} ${m}`);

async function tick() {
  const launches = await cloak.listLaunches();
  const now = Number((await publicClient.getBlock()).timestamp);
  for (const { auction } of launches) {
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
      } else if (s.phase === "settled") {
        const r = await cloak.claimAll(auction, { fromBlock: START_BLOCK });
        if (r.claimed) log(auction, `delivered ${r.claimed} claims`);
        done.add(auction);
      }
    } catch (e) {
      log(auction, `error: ${e.shortMessage ?? e.message}`);
    }
  }
  status.lastTick = Date.now();
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
    const settled = b[6], cancelled = b[7];
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

(async function loop() {
  for (;;) {
    await tick().catch((e) => console.error("tick failed:", e.shortMessage ?? e.message));
    await tickBatches().catch((e) => console.error("batch tick failed:", e.shortMessage ?? e.message));
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
})();

// ───────────── private-trade relay ─────────────
const submit = ROUTER ? walletSubmitter(publicClient, walletClient, ROUTER, BATCHER) : null;
const big = (x) => (Array.isArray(x) ? x.map(big) : BigInt(x));
const isPool = (pool) => publicClient.readContract({ address: ROUTER, abi: privateRouterAbi, functionName: "isPool", args: [pool] });

async function relay(body) {
  if (!submit) throw Object.assign(new Error("relay disabled (set ROUTER)"), { status: 503 });
  const { kind, pool, proof: p, extData: e } = body;
  if (!["privateSwap", "unshieldHype", "transact", "placeOrder"].includes(kind)) throw Object.assign(new Error("bad kind"), { status: 400 });
  if (kind === "placeOrder" && !BATCHER) throw Object.assign(new Error("batching disabled (set BATCHER)"), { status: 503 });
  if (!(await isPool(pool))) throw Object.assign(new Error("unknown pool"), { status: 400 });
  const proof = {
    a: big(p.a), b: big(p.b), c: big(p.c), root: big(p.root), publicAmount: big(p.publicAmount),
    extDataHash: big(p.extDataHash), inputNullifiers: big(p.inputNullifiers), outputCommitments: big(p.outputCommitments),
  };
  const extData = { ...e, extAmount: BigInt(e.extAmount), fee: BigInt(e.fee) };
  // dry-run first so a bad proof costs the relayer nothing
  const sim = kind === "transact"
    ? { address: pool, abi: shieldedPoolAbi, functionName: "transact", args: [proof, extData] }
    : kind === "placeOrder"
      ? { address: BATCHER, abi: privateBatcherAbi, functionName: "placeOrder", args: [pool, proof, extData] }
      : { address: ROUTER, abi: privateRouterAbi, functionName: kind, args: kind === "privateSwap" ? [pool, proof, extData] : [proof, extData] };
  await publicClient.simulateContract({ ...sim, account });
  return submit({ kind, pool, proof, extData });
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
        send(req, res, e.status ?? 400, { error: e.status || e.shortMessage ? e.shortMessage ?? e.message : "malformed request" });
      }
    });
    return;
  }
  if (req.method === "GET" && (path === "/" || path === "/health")) {
    return send(req, res, 200, { ...status, relay: !!ROUTER, router: ROUTER ?? null, batcher: BATCHER ?? null });
  }
  send(req, res, 404, { error: "not found" });
}).listen(Number(process.env.PORT ?? 3001), () => console.log(`keeper ${account.address} on ${chain.name}, factory ${FACTORY}${ROUTER ? `, relaying for ${ROUTER}` : ""}`));
