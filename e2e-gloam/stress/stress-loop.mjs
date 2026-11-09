// The keeper loop (services/keeper/gloamLoop.mjs) with many open batch rounds, a restart (state lost), a flaky RPC,
// and a settle that reverts on chain after its simulation passed.
//
//   node e2e-gloam/stress/stress-loop.mjs
import { createPublicClient, encodeFunctionData, http, parseAbi } from "viem";
import { setup, record, summary, ms, createGloamLoop, GloamPrivate, rpc, parseEther } from "./common.mjs";
import { chainFor } from "../lib.mjs";

const ROUNDS = Number(process.env.ROUNDS ?? 12);
const FAIL = Number(process.env.FAIL ?? 0.1); // share of reads that fail, as a rate-limited public RPC answers 429
const S = await setup({ port: 8614 });
const { pub, c, block, keeper } = S;
const BATCH = parseAbi(["function batches(address, uint64) view returns (uint128 buyHype, uint128 sellTokens, uint128 tokensForBuyers, uint128 hypeForSellers, uint256 spotStart, uint64 settledAt, bool settled, bool cancelled, uint256 cumStart, uint64 tStart)"]);
// production-like send: the keeper's walletClient.writeContract returns the hash whether or not the call reverted
const send = async (call) => {
  const h = await keeper.wallet.writeContract(call);
  await pub.waitForTransactionReceipt({ hash: h });
  return h;
};
try {
  console.log(`stress-loop: ${ROUNDS} open rounds, restart, flaky RPC, a settle that reverts`);
  const alice = S.who(1);
  const A = await GloamPrivate.unlock(alice.wallet, S.cfgFor(S.viaRelay("alice"), S.memRecords()));
  await A.loadMarkets();
  for (let i = 0; i < 2; i++) await A.shieldHype(alice.wallet, parseEther("1"));
  const placed = [];
  let t = performance.now();
  for (let i = 0; i < ROUNDS; i++) {
    const r = await A.batch(c.launchToken, "buy", parseEther("0.01"));
    placed.push(r.orders[0].round);
    await S.warp(60);
  }
  console.log(`  ${ROUNDS} orders in ${ROUNDS} rounds placed in ${Math.round(ms(t) / 1000)} s`);
  await S.warp(61);

  // a restart: a fresh loop that reads every order from the batcher's start block, with a flaky RPC (1 in 5 reads fail)
  let n = 0;
  let calls = 0;
  const flakyTransport = http(S.rpcUrl, {
    onFetchRequest: () => {
      calls++;
    },
  });
  const base = createPublicClient({ chain: chainFor(S.rpcUrl), transport: flakyTransport, pollingInterval: 50 });
  const flaky = new Proxy(base, {
    get(target, prop) {
      const v = target[prop];
      if (prop === "readContract" || prop === "getLogs") return (...a) => (++n && Math.random() < FAIL ? Promise.reject(new Error("HTTP request failed. Status: 429")) : v.apply(target, a));
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const L2 = createGloamLoop({ publicClient: flaky, account: keeper.account, send, launchVault: c.launchVault, batcher: c.batcher, batcherBlock: block });
  let ticks = 0;
  const outcomes = [];
  const errors = [];
  t = performance.now();
  while (ticks < 40) {
    const o = await L2.tick();
    ticks++;
    outcomes.push(...o.rounds);
    errors.push(...o.errors);
    const left = await Promise.all(placed.map((r) => pub.readContract({ address: c.batcher, abi: BATCH, functionName: "batches", args: [c.launchToken, r] })));
    if (left.every((b) => b[6] || b[7])) break;
  }
  // read the outcome from the chain: a step that fails part-way loses its own report of what it already did
  const fin = await Promise.all(placed.map((r) => pub.readContract({ address: c.batcher, abi: BATCH, functionName: "batches", args: [c.launchToken, r] })));
  const settledN = fin.filter((b) => b[6]).length;
  const cancelledN = fin.filter((b) => b[7]).length;
  record("loop-restart-flaky", settledN + cancelledN === ROUNDS, `restarted loop, ${FAIL * 100}% of reads failing: ${ROUNDS} rounds -> ${settledN} settled, ${cancelledN} cancelled (past their settle window) in ${ticks} ticks, ${Math.round(ms(t) / 1000)} s, ${calls} RPC requests; ${errors.length} step errors, e.g. "${errors[0]?.slice(0, 70) ?? ""}"`);
  // payouts come back on the next open
  const fp = await A.finishPending();
  record("loop-payouts", fp.done.length === ROUNDS, `finishPending afterwards: ${fp.done.length} done, ${fp.waiting.length} waiting, ${fp.errors.length} errors`);

  // a settle that passes its simulation, then reverts on chain (the price moved in between)
  const B = await GloamPrivate.unlock(S.who(2).wallet, S.cfgFor(S.viaRelay("bob"), S.memRecords()));
  await B.loadMarkets();
  await B.shieldHype(S.who(2).wallet, parseEther("1"));
  const L3 = createGloamLoop({
    publicClient: pub,
    account: keeper.account,
    send: async (call) => {
      if (call.functionName === "settle") {
        // the keeper's settle passes its estimate and goes out; in the same block, someone else's transaction lands
        // first and moves the pool, so the settle reverts on chain
        await rpc(S.rpcUrl, "evm_setAutomine", [false]);
        const h = await keeper.wallet.writeContract(call);
        const tip = { maxPriorityFeePerGas: parseEther("0.00001"), maxFeePerGas: parseEther("0.0001") };
        await S.dep.wallet.writeContract({ address: c.launchToken, abi: parseAbi(["function mint(address,uint256)"]), functionName: "mint", args: [c.pair, parseEther("20000")], gas: 100000n, ...tip });
        await S.dep.wallet.writeContract({ address: c.pair, abi: parseAbi(["function sync()"]), functionName: "sync", gas: 100000n, ...tip });
        await rpc(S.rpcUrl, "evm_mine");
        await rpc(S.rpcUrl, "evm_setAutomine", [true]);
        const r = await pub.waitForTransactionReceipt({ hash: h });
        console.log(`    the keeper's settle: ${r.status}`);
        return h; // as the keeper's writeContract does: the hash, whatever happened
      }
      return send(call);
    },
    launchVault: c.launchVault,
    batcher: c.batcher,
    batcherBlock: await pub.getBlockNumber(),
  });
  const ob = await B.batch(c.launchToken, "buy", parseEther("0.01"));
  const round = ob.orders[0].round;
  await S.warp(130);
  const first = await L3.tick();
  const afterRevert = await pub.readContract({ address: c.batcher, abi: BATCH, functionName: "batches", args: [c.launchToken, round] });
  // put the price back, wait past the refund time, tick again
  await S.warp(700);
  const second = await L3.tick();
  const end = await pub.readContract({ address: c.batcher, abi: BATCH, functionName: "batches", args: [c.launchToken, round] });
  record(
    "loop-forgets-reverted-settle",
    end[6] || end[7],
    `first tick reported ${JSON.stringify(first.rounds.map((r) => r.action))} but the round is settled=${afterRevert[6]} (the settle reverted); the loop's open list then had ${L3.pendingRounds().length} rounds; past the refund time a tick did ${JSON.stringify(second.rounds.map((r) => r.action))} and the round ends settled=${end[6]} cancelled=${end[7]} (Bob's order stays in the batcher until the keeper restarts or the 30-day exit)`,
  );
} finally {
  S.stop();
  summary("stress-loop");
}
process.exit(0);
