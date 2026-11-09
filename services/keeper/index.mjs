// Cloak v2 keeper. With a gas wallet and no user secret, it:
//   1. watches every launch of Cloak v2's factory: decrypts sealed bids once their drand round is out and reveals them
//      (bidders never come back), settles when the reveal window closes and collects Cloak's launch fee. Bidders claim
//      and creators withdraw their proceeds themselves, whenever they like (PUSH_CLAIMS=1 makes the keeper push them);
//   2. relays private actions on Gloam's vaults (POST /gloam/relay): the relay pays gas and is the on-chain sender, so
//      the user's wallet never appears. It can't alter a call: the proof binds every field;
//   3. runs the Gloam loop (gloamLoop.mjs): admits settled launches to the launch vault, registers them for batch
//      rounds, settles rounds, confirms allocation gates and collects the launch vault's fee for the relay;
//   4. holds split withdrawals until their time (POST/GET /schedule), serves the vaults' public leaf lists (GET /leaves)
//      and the sealed bids the beacon couldn't open (GET /unopenable);
//   5. sealed NFT drops too, when DROP_FACTORY is set (or the SDK's record has one).
// Anyone can run one; several keepers racing is harmless (reveal, settle and claim are idempotent on chain).
//
//   KEEPER_PK=0x… FACTORY=0x… [START_BLOCK=…] GLOAM_VAULT=… GLOAM_LAUNCH_VAULT=… GLOAM_MEMO=… [RPC_URL=…] [PORT=3001]
//   node services/keeper/index.mjs        (every setting: render.yaml)
import { createServer } from "node:http";
import { startLeaves } from "./leaves.mjs";
import { startSchedule } from "./schedule.mjs";
import { createGloamRelay } from "./gloam.mjs";
import { createGloamLoop } from "./gloamLoop.mjs";
import { createPublicClient, createWalletClient, encodeFunctionData, http, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Cloak, CloakDrops, anvilLocal, deploymentFor, elysiumTestnet, drandRoundTime, cloakAuctionAbi, cloakDropFactoryAbi, cloakFactoryAbi } from "@cloakely/sdk";

const RPC = process.env.RPC_URL ?? elysiumTestnet.rpcUrls.default.http[0];
const chain = RPC.includes("127.0.0.1") || RPC.includes("localhost") ? anvilLocal : elysiumTestnet;
const PK = process.env.KEEPER_PK;
const POLL_MS = Number(process.env.POLL_MS ?? 3000);
const CLAIM_DELAY = Number(process.env.CLAIM_DELAY ?? 3600); // seconds after the reveal window before public claims
// off by default: bidders and creators pull their own money (the site's bell shows what's waiting)
const PUSH_CLAIMS = process.env.PUSH_CLAIMS === "1";
// the SDK's record for this chain (factory, drop factories), or undefined on a chain it doesn't know (a local test chain)
const KNOWN = (() => {
  try {
    return deploymentFor(chain.id);
  } catch {
    return undefined;
  }
})();
const FACTORY = process.env.FACTORY ?? KNOWN?.factory;
const START_BLOCK = BigInt(process.env.START_BLOCK ?? KNOWN?.factoryBlock ?? 0);
if (!PK || !FACTORY) {
  console.error("set KEEPER_PK (and FACTORY on a chain the SDK doesn't know)");
  process.exit(1);
}
const transport = http(RPC, { retryCount: 5, retryDelay: 500, timeout: 20_000 });
// Elysium's public RPC rate-limits busy callers, so reads made together go out as one multicall and receipts are polled
// once a second: a relay must never fail because the keeper's own polling used up the limit.
const publicClient = createPublicClient({ chain, transport, pollingInterval: 1000, batch: { multicall: { wait: 16 } } });

/** Per auction: sealed bids whose drand ciphertext didn't open to their commitment (from the last reveal pass). */
const unopenable = new Map();

// each vault's public leaf list, for an app's fast first sync (GET /leaves), from GLOAM_VAULT_BLOCK / GLOAM_LAUNCH_VAULT_BLOCK
const leafVaults = [
  [process.env.GLOAM_VAULT, process.env.GLOAM_VAULT_BLOCK],
  [process.env.GLOAM_LAUNCH_VAULT, process.env.GLOAM_LAUNCH_VAULT_BLOCK ?? process.env.GLOAM_VAULT_BLOCK],
].filter(([a, b]) => a && b).map(([address, block]) => ({ address, block }));
const leaves = leafVaults.length ? startLeaves(publicClient, { vaults: leafVaults }) : null;

const account = privateKeyToAccount(PK);
const walletClient = createWalletClient({ chain, transport, account });

// POST /gloam/relay, on when GLOAM_MEMO and a vault (GLOAM_VAULT, Gloam's, and or GLOAM_LAUNCH_VAULT,
// Cloak's) are set. GLOAM_ESCROWS: Cloak's escrows, GLOAM_ROUTERS: Gloam's own routers (comma separated).
const list = (v) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const gloamRelay = process.env.GLOAM_MEMO && (process.env.GLOAM_VAULT || process.env.GLOAM_LAUNCH_VAULT)
  ? createGloamRelay({
      publicClient,
      walletClient,
      vault: process.env.GLOAM_VAULT,
      launchVault: process.env.GLOAM_LAUNCH_VAULT,
      memoBoard: process.env.GLOAM_MEMO,
      escrows: list(process.env.GLOAM_ESCROWS),
      gloamEscrows: list(process.env.GLOAM_ROUTERS),
      log: console.log,
    })
  : null;

/** The chain's clock (pieces are timed by it), kept fresh every 20 s and run forward in between. Review O-15. */
let chainAt = { chain: Math.floor(Date.now() / 1000), local: Date.now() };
const refreshChainClock = () => publicClient.getBlock().then((b) => (chainAt = { chain: Number(b.timestamp), local: Date.now() })).catch(() => {});
refreshChainClock();
setInterval(refreshChainClock, 20_000).unref();
const chainClock = () => chainAt.chain + Math.floor((Date.now() - chainAt.local) / 1000);

// split withdrawals: proved Gloam vault cash outs held until their time, then sent through the Gloam relay, counted
// against whoever handed them in (review O-10)
const gloamPiece = (call) => ({ to: call.to, data: call.data });
const schedule = startSchedule({
  gloam: gloamRelay ? { check: (call, who) => gloamRelay(gloamPiece(call), { dryRun: true, sender: who }), send: (call, who) => gloamRelay(gloamPiece(call), { sender: who }) } : undefined,
  now: () => chainClock(),
  log: (m) => console.log(`[schedule] ${m}`),
});

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
const cloak = new Cloak(publicClient, walletClient, FACTORY);

// The Gloam loop: follow-ups that need no user secret (gloamLoop.mjs). On when GLOAM_LAUNCH_VAULT or
// GLOAM_BATCHER or GLOAM_FUNDS_GATE is set. Every GLOAM_LOOP_SECS (default 60): admit settled launches, settle batch
// rounds, confirm wallets in closed allocation gates, collect fees.
const gloamLoop = process.env.GLOAM_LAUNCH_VAULT || process.env.GLOAM_BATCHER || process.env.GLOAM_BATCHER_V4 || process.env.GLOAM_FUNDS_GATE
  ? createGloamLoop({
      publicClient,
      account,
      send: (call) => walletClient.writeContract(call),
      launchVault: process.env.GLOAM_LAUNCH_VAULT,
      launchFactory: process.env.GLOAM_LAUNCH_FACTORY ?? FACTORY,
      batcher: process.env.GLOAM_BATCHER,
      batcherBlock: BigInt(process.env.GLOAM_BATCHER_BLOCK ?? "0"),
      batcherV4: process.env.GLOAM_BATCHER_V4,
      batcherV4Block: BigInt(process.env.GLOAM_BATCHER_V4_BLOCK ?? process.env.GLOAM_BATCHER_BLOCK ?? "0"),
      fundsGate: process.env.GLOAM_FUNDS_GATE,
      relay: gloamRelay,
      log: console.log,
    })
  : null;
if (gloamLoop) {
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await gloamLoop.tick();
    } finally {
      running = false;
    }
  }, 1000 * Number(process.env.GLOAM_LOOP_SECS ?? 60)).unref();
}

const status = { keeper: account.address, commit: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? null, chain: chain.id, factory: FACTORY, launches: {}, lastTick: 0 };
const done = new Set(); // auctions fully claimed
const waitUntil = new Map(); // auctions with nothing to do until a later time (bidding closes, public claims start)
const log = (a, m) => console.log(`[${new Date().toISOString()}] ${a.slice(0, 10)} ${m}`);

// the launch list only grows, so it is read again only when a factory's count changes (or every 5 minutes, to be safe),
// not every tick: re-reading every launch every 3 s was the keeper's biggest steady RPC cost (OPTIMIZATION.md K1)
const listCache = { key: "", at: 0, list: [] };
async function launchList() {
  // a count that can't be read forces a full read, as before this cache existed
  const counts = await Promise.all([FACTORY].map((f) => publicClient.readContract({ address: f, abi: cloakFactoryAbi, functionName: "launchesCount" }).catch(() => `?${Date.now()}`)));
  const key = counts.join(",");
  if (key !== listCache.key || Date.now() - listCache.at > 300_000) {
    listCache.list = await cloak.listLaunches();
    listCache.key = key;
    listCache.at = Date.now();
  }
  return listCache.list;
}

// when nothing is in progress (no launch past bidding, no drop to open or pay, no relay in the last two minutes) the loop waits IDLE_MS instead of POLL_MS between rounds (OPTIMIZATION.md K1)
const IDLE_MS = Number(process.env.IDLE_MS ?? POLL_MS * 5); // 15 s at the default 3 s poll
const work = { busy: false, relayAt: 0 };

async function tick() {
  const launches = await launchList();
  status.launchCount = launches.length;
  const now = Number((await publicClient.getBlock()).timestamp);
  for (const { auction } of launches) {
    if (done.has(auction) || now < (waitUntil.get(auction) ?? 0)) continue;
    try {
      const s = await cloak.getAuction(auction);
      status.launches[auction] = { symbol: s.tokenSymbol, phase: s.phase, commits: s.commits, reveals: s.reveals };
      // nothing to do while bids are sealed: look again when bidding closes (at most a minute from now)
      if (s.phase === "commit") {
        waitUntil.set(auction, Math.min(s.commitEnd, now + 60));
        continue;
      }
      work.busy = true;
      if (s.phase === "reveal" && s.reveals < s.commits && Date.now() / 1000 >= drandRoundTime(s.tlockRound)) {
        const r = await cloak.revealAll(auction, { fromBlock: START_BLOCK, log: (m) => log(auction, m) });
        if (r.revealed) log(auction, `auto-revealed ${r.revealed} bids`);
        // sealed bids the beacon can't open: only their bidder can still reveal them, after seeing every other reveal.
        // Published (GET /unopenable?auction=) so the launch page can show them while the reveal window is open.
        unopenable.set(auction.toLowerCase(), r.unopenable.map((b) => ({ id: String(b.id), bidder: b.bidder, deposit: String(b.deposit), why: b.why })));
      } else if (s.phase === "settle" && now >= s.revealEnd) {
        // the Gloam loop then admits it to the launch vault (private trading) and registers it for batch rounds
        const h = await cloak.settle(auction);
        log(auction, `settled ${h}`);
      } else if (s.phase === "settled") {
        // Bidders claim their tokens and refunds, and creators withdraw their proceeds, whenever they like: nothing
        // expires, and the site's bell lists what's waiting. The keeper only collects Cloak's launch fee. With
        // PUSH_CLAIMS=1 it also pushes unclaimed bids and the creator's proceeds after CLAIM_DELAY, as it used to.
        if (PUSH_CLAIMS) {
          if (now < s.revealEnd + CLAIM_DELAY) {
            waitUntil.set(auction, s.revealEnd + CLAIM_DELAY); // winners' window to claim privately
            continue;
          }
          const r = await cloak.claimAll(auction, { fromBlock: START_BLOCK });
          if (r.claimed) log(auction, `delivered ${r.claimed} claims`);
          if (s.creatorOwed > 0n) {
            const c = { address: auction, abi: cloakAuctionAbi };
            await publicClient.waitForTransactionReceipt({ hash: await walletClient.writeContract({ ...c, functionName: "withdrawProceeds" }) }).catch((e) => log(auction, `proceeds skipped: ${e.shortMessage ?? e.message}`));
          }
          try {
            const c = { address: auction, abi: cloakAuctionAbi };
            await publicClient.simulateContract({ ...c, functionName: "sweepDust", account });
            await publicClient.waitForTransactionReceipt({ hash: await walletClient.writeContract({ ...c, functionName: "sweepDust" }) });
          } catch {}
        }
        if (s.feesOwed > 0n) {
          const c = { address: auction, abi: cloakAuctionAbi };
          await publicClient
            .waitForTransactionReceipt({ hash: await walletClient.writeContract({ ...c, functionName: "collectFees" }) })
            .then((r) => log(auction, `launch fee collected ${r.transactionHash}`))
            .catch((e) => log(auction, `launch fee skipped: ${e.shortMessage ?? e.message}`));
        }
        done.add(auction);
        delete status.launches[auction];
      }
    } catch (e) {
      log(auction, `error: ${e.shortMessage ?? e.message}`);
    }
  }
  status.lastTick = Date.now();
}

// ───────────── sealed NFT drops: open the bids, settle, number ties, deliver and pay out, as for launches ─────────────
const knownDeployment = KNOWN;
const DROP_FACTORY = process.env.DROP_FACTORY || knownDeployment?.dropFactory;
const ESCROW_DROP_FACTORY = process.env.ESCROW_DROP_FACTORY || knownDeployment?.escrowDropFactory;
const drops = DROP_FACTORY ? new CloakDrops(publicClient, walletClient, DROP_FACTORY, BigInt(process.env.DROP_FACTORY_BLOCK ?? knownDeployment?.dropFactoryBlock ?? 0), ESCROW_DROP_FACTORY) : null;
const dropsDone = new Set();
const dropWait = new Map();
const dropSettledAt = new Map();
// the drop list only grows: list it again only when a factory's count changes (or every 5 minutes), not every tick
const dropList = { key: "", at: 0, list: [] };
async function tickDrops() {
  if (!drops) return;
  const counts = await Promise.all([DROP_FACTORY, ESCROW_DROP_FACTORY].filter(Boolean).map((f) => publicClient.readContract({ address: f, abi: cloakDropFactoryAbi, functionName: "dropsCount" }).catch(() => `?${Date.now()}`)));
  const key = counts.join(",");
  if (key !== dropList.key || Date.now() - dropList.at > 300_000) Object.assign(dropList, { list: await drops.list(), key, at: Date.now() });
  const list = dropList.list;
  status.drops = { factory: DROP_FACTORY, count: list.length, live: {} };
  const now = Number((await publicClient.getBlock()).timestamp);
  for (const d of list) {
    if (dropsDone.has(d) || now < (dropWait.get(d) ?? 0)) continue;
    try {
      const s = await drops.get(d);
      status.drops.live[d] = { symbol: s.symbol, phase: s.phase, bids: s.bids, reveals: s.reveals };
      if (s.phase !== "gtd" && s.phase !== "bidding") work.busy = true;
      if (s.phase === "reveal" && s.reveals < s.bids && Date.now() / 1000 >= drandRoundTime(s.tlockRound)) {
        const r = await drops.revealAll(d, { log: (m) => log(d, m) });
        if (r.revealed) log(d, `drop: opened ${r.revealed} bids`);
      } else if (s.phase === "settle" || s.phase === "numbering") {
        // "settle" comes as soon as every bid is open, or when the reveal window ends
        for (const h of await drops.settle(d)) log(d, `drop: settled ${h}`);
      } else if (s.phase === "settled") {
        // winners get the same window as a launch to take their NFTs to another wallet themselves
        // drops can settle before the reveal window ends, so the hour counts from when we first saw it settled
        if (!dropSettledAt.has(d)) dropSettledAt.set(d, Math.min(now, s.revealEnd));
        const due = dropSettledAt.get(d) + CLAIM_DELAY;
        if (now < due) {
          dropWait.set(d, due);
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
    await tick().catch((e) => console.error("tick failed:", e.shortMessage ?? e.message));
    await tickDrops().catch((e) => console.error("drops tick failed:", e.shortMessage ?? e.message));
    const idle = !work.busy && Date.now() - work.relayAt > 120_000;
    work.busy = false;
    await new Promise((r) => setTimeout(r, idle ? Math.max(IDLE_MS, POLL_MS) : POLL_MS));
  }
})();

// ───────────── staying awake on a free host ─────────────
// Render's free plan stops a service after 15 minutes with no incoming request, and its loops stop with it. While the
// keeper has work that can't wait for a visitor (a launch or drop not finished, an open batch round, a withdrawal piece
// queued, a relay in the last 15 minutes) it requests its own public address every
// 10 minutes, which counts as incoming. With nothing pending it lets the host stop it: the next visitor's request starts
// it again (about a minute on Render), and the site then re-sends anything the keeper forgot. KEEP_AWAKE=0 turns it off;
// KEEP_AWAKE_URL overrides the address (Render sets RENDER_EXTERNAL_URL itself). OPTIMIZATION.md H1.
const SELF_URL = (process.env.KEEP_AWAKE_URL ?? process.env.RENDER_EXTERNAL_URL ?? "").replace(/\/+$/, "");
function pendingWork() {
  const why = [];
  // launches it could read and hasn't finished (one it can't read, like a broken contract, doesn't hold it awake)
  if (Object.keys(status.launches).some((a) => !done.has(a))) why.push("launches");
  if (Object.keys(status.drops?.live ?? {}).length) why.push("drops");
  if (gloamLoop?.pendingRounds().length) why.push("gloam rounds");
  if (schedule?.waiting?.()) why.push("scheduled pieces");
  if (Date.now() - work.relayAt < 15 * 60_000) why.push("recent relay");
  return why;
}
status.awake = { selfUrl: !!SELF_URL, why: [] };
if (SELF_URL && process.env.KEEP_AWAKE !== "0") {
  setInterval(() => {
    const why = pendingWork();
    status.awake.why = why;
    if (why.length) fetch(`${SELF_URL}/health`, { signal: AbortSignal.timeout(30_000) }).catch(() => {});
  }, Number(process.env.KEEP_AWAKE_MS ?? 10 * 60_000)).unref();
}

// a contract that reverted answered fine: its reason must reach the user, never "the network didn't answer"
const isNetworkError = (e) =>
  !/reverted|execution reverted|revert reason/i.test(`${e?.shortMessage ?? ""}`) &&
  /HTTP request failed|fetch failed|timed? ?out|ECONNRESET|socket hang up|429|502|503|504/i.test(`${e?.shortMessage ?? ""} ${e?.message ?? ""} ${e?.name ?? ""}`);


/**
 * Public JSON that many browsers ask for (leaves): gzipped when asked, and a bodiless 304 when the browser
 * already holds this version (If-None-Match), so an unchanged poll costs a few hundred bytes instead of the body.
 * `no-cache` lets the browser keep it but makes it ask each time.
 */
function sendCached(req, res, { json, gz, etag }, extra = {}) {
  const origin = req.headers.origin;
  const allow = ORIGINS.includes("*") ? "*" : origin && ORIGINS.includes(origin) ? origin : ORIGINS[0];
  const head = { "access-control-allow-origin": allow, vary: "origin, accept-encoding", "cache-control": "public, no-cache", "x-content-type-options": "nosniff", ...(etag ? { etag } : {}), ...extra };
  if (Object.keys(extra).length) head["access-control-expose-headers"] = Object.keys(extra).join(", ");
  const inm = req.headers["if-none-match"];
  // a proxy may drop the weak W/ prefix: match either form
  if (etag && inm && inm.split(",").some((t) => t.trim() === etag || t.trim() === etag.slice(2))) {
    res.writeHead(304, head);
    return res.end();
  }
  const zip = /\bgzip\b/.test(req.headers["accept-encoding"] ?? "");
  res.writeHead(200, { "content-type": "application/json", ...head, ...(zip ? { "content-encoding": "gzip" } : {}) });
  return res.end(zip ? gz : json);
}

const ORIGINS = (process.env.CORS_ORIGINS ?? "https://gloak.boblabs.tech,http://localhost:5173,http://localhost:4173").split(",").map((s) => s.trim());
const MAX_BODY = 64 * 1024;
const LIMIT = Number(process.env.RELAY_PER_MIN ?? 20); // relay requests per IP per minute
const hits = new Map();
setInterval(() => hits.clear(), 60_000).unref();
/**
 * The caller's address for rate limits and relay shares. A caller can put anything in X-Forwarded-For, and each proxy
 * in front of us appends the address it saw, so the trustworthy entry is the one our own proxy added: the
 * TRUSTED_PROXY_HOPS-th from the right (default 1, Render's one proxy; 0 when nothing sits in front). Review O-03.
 */
const PROXY_HOPS = Number(process.env.TRUSTED_PROXY_HOPS ?? 1);
const clientIp = (req) => {
  const hops = String(req.headers["x-forwarded-for"] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (PROXY_HOPS > 0 && hops.length >= PROXY_HOPS) return hops[hops.length - PROXY_HOPS];
  return String(req.socket.remoteAddress ?? "");
};
const limited = (req) => {
  const ip = clientIp(req);
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
  if (req.method === "GET" && path === "/gloam/relay/stats") {
    if (!gloamRelay) return send(req, res, 503, { error: "Gloam relay is off on this keeper" });
    const st = gloamRelay.stats();
    return send(req, res, 200, Object.fromEntries(Object.entries(st).map(([k, v]) => [k, String(v)])));
  }
  if (req.method === "POST" && path === "/gloam/relay") {
    if (!gloamRelay) return send(req, res, 503, { error: "Gloam relay is off on this keeper" });
    if (limited(req)) return send(req, res, 429, { error: "too many requests, try again in a minute" });
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > MAX_BODY) req.destroy();
    });
    req.on("end", async () => {
      try {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          return send(req, res, 400, { error: "malformed request" });
        }
        work.relayAt = Date.now();
        send(req, res, 200, { txHash: await gloamRelay(parsed, { sender: clientIp(req) }) });
      } catch (e) {
        // an error with no status is ours (the node, a receipt wait): the call may still land, so say try again
        if (!e.status) console.error(`[gloam relay] ${e.shortMessage ?? e.message}`);
        send(req, res, e.status ?? 503, { error: e.status ? e.message : "the relay hit a problem sending this; check your balance before trying again" });
      }
    });
    return;
  }
  if (path === "/schedule" && (req.method === "POST" || req.method === "GET")) {
    if (limited(req)) return send(req, res, 429, { error: "too many requests, try again in a minute" });
    if (req.method === "GET") {
      const ids = (new URL(req.url, "http://x").searchParams.get("ids") ?? "").split(",").filter((x) => /^0x[0-9a-f]{64}$/.test(x)).slice(0, 20);
      return send(req, res, 200, { pieces: schedule.status(ids) });
    }
    let body = "";
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY * 4) {
        send(req, res, 413, { error: "request too large" });
        req.destroy();
        return;
      }
      body += c;
    });
    req.on("end", async () => {
      if (size > MAX_BODY * 4) return;
      try {
        const ids = await schedule.add(JSON.parse(body), clientIp(req));
        send(req, res, 200, { ids });
      } catch (e) {
        send(req, res, e.status ?? 400, { error: e.status || e.shortMessage ? e.shortMessage ?? e.message : "malformed request" });
      }
    });
    return;
  }
  if (req.method === "GET" && path === "/unopenable") {
    const a = (new URL(req.url, "http://x").searchParams.get("auction") ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(a)) return send(req, res, 400, { error: "pass ?auction=0x…" });
    return send(req, res, 200, { auction: a, checked: unopenable.has(a), bids: unopenable.get(a) ?? [] });
  }
  if (req.method === "GET" && path === "/leaves") {
    if (!leaves) return send(req, res, 404, { error: "not found" });
    if (limited(req)) return send(req, res, 429, { error: "too many requests, try again in a minute" });
    const pool = new URL(req.url, "http://x").searchParams.get("pool");
    if (pool && !/^0x[0-9a-fA-F]{40}$/.test(pool)) return send(req, res, 400, { error: "bad pool" });
    leaves
      .get(pool)
      .then((b) => {
        if (!b) return send(req, res, 404, { error: "unknown vault" });
        sendCached(req, res, b);
      })
      .catch((e) => (console.error(`[leaves] ${e.shortMessage ?? e.message}`), send(req, res, 503, { error: "The network didn't answer. Try again in a moment." })));
    return;
  }
  if (req.method === "GET" && (path === "/" || path === "/health")) {
    return send(req, res, 200, { ...status, relay: !!gloamRelay, schedule: !!gloamRelay, leaves: leafVaults.map((v) => v.address), claimDelay: CLAIM_DELAY, pushClaims: PUSH_CLAIMS });
  }
  send(req, res, 404, { error: "not found" });
}).listen(Number(process.env.PORT ?? 3001), () => console.log(`keeper ${account.address} on ${chain.name}, factory ${FACTORY}${gloamRelay ? ", relaying for Gloam's vaults" : ""}`));
