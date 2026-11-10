// Part 14: batch rounds on Cloak's real Uniswap v4 launches, on a local fork of Elysium testnet. CloakGloamBatcherV4
// on a CloakLaunchVault pointed at Cloak's live v4 factory: the keeper loop admits and registers every settled launch,
// GloamPrivate places standard-size orders (one note each, sent by the relay), the keeper loop settles the round
// through the launch's real CloakV4Market (Uniswap's PoolManager behind CloakV4Hook), and the next open
// (finishPending) brings each order's payout back into the private balance as a note. Then the same in reverse (a sell).
// Gloam's final keys throughout. Nothing here touches the live chain.
//
//   node e2e-gloam/part14-batch-v4.mjs
import { formatEther, parseAbi, parseEther, zeroAddress } from "viem";
import { GloamPrivate, deployments } from "@cloakely/sdk";
import { createGloamRelay } from "../services/keeper/gloam.mjs";
import { createGloamLoop } from "../services/keeper/gloamLoop.mjs";
import { LV_ABI, checkLaunchVault } from "./stack.mjs";
import { ANVIL_KEYS, ELYSIUM_TESTNET_ID, ELYSIUM_TESTNET_RPC, ELYSIUM_TESTNET_USDC, assert, clients, deployGloamStack, deployPoseidon, finalProver, gloamArtifact, ourArtifact, rpc, sendAndLog, startAnvil, writeMeasurements } from "./lib.mjs";

const D = deployments[ELYSIUM_TESTNET_ID];
const ROUND = 60n;
const t0 = performance.now();
const anvil = await startAnvil({ port: 8566, forkUrl: process.env.RPC_URL ?? ELYSIUM_TESTNET_RPC });
const rpcUrl = anvil.rpcUrl;
const who = (i) => clients(rpcUrl, ANVIL_KEYS[i], ELYSIUM_TESTNET_ID);
const [dep, alice, keeper] = [who(0), who(1), who(8)];
const pub = dep.pub;
const write = (address, abi, functionName, args = []) => sendAndLog(pub, functionName, dep.wallet.writeContract({ address, abi, functionName, args }));
const deploy = async (label, art, args = []) => (await sendAndLog(pub, `deploy ${label}`, dep.wallet.deployContract({ ...art, args }))).contractAddress;
const warp = async (s) => (await rpc(rpcUrl, "evm_increaseTime", [Number(s)]), await rpc(rpcUrl, "evm_mine"));
const out = {};
try {
  console.log("Part 14 on a fork of Elysium testnet: batch rounds on Cloak's real v4 launches");
  const addr = dep.account.address;
  const poseidon = await deployPoseidon(dep);
  const stack = await deployGloamStack({ rpcUrl, pk: ANVIL_KEYS[0], poseidon, assets: [{ address: ELYSIUM_TESTNET_USDC, perDeposit: 500n * 10n ** 6n, total: 25_000n * 10n ** 6n }], feeBps: 50, feeRecipient: addr, controller: addr });
  const caps = [parseEther("1000000000"), parseEther("100000000000")];
  const lv = await deploy("CloakLaunchVault", ourArtifact("CloakLaunchVault.sol", "CloakLaunchVault"), [poseidon, stack.dual, D.factory, ...caps, addr]);
  await write(lv, LV_ABI, "setShieldVerifier", [stack.shieldVerifier]);
  await write(lv, LV_ABI, "setWithdrawFee", [50, addr]);
  await write(lv, LV_ABI, "turnOnDepositLimits");
  await write(lv, LV_ABI, "setDepositLimit", [zeroAddress, parseEther("10"), parseEther("100")]);
  await write(lv, LV_ABI, "endSetup");
  const guardArt = gloamArtifact("VaultOwnerGuard.sol", "VaultOwnerGuard");
  const guard = await deploy("VaultOwnerGuard", guardArt, [lv, addr]);
  await write(lv, LV_ABI, "transferOwnership", [guard]);
  await write(guard, guardArt.abi, "acceptVaultOwnership");
  await checkLaunchVault(pub, lv, { guard, dual: stack.dual, shieldVerifier: stack.shieldVerifier, factory: D.factory, feeRecipient: addr, pauser: addr, caps });
  const batcherV4 = await deploy("CloakGloamBatcherV4", ourArtifact("CloakGloamBatcherV4.sol", "CloakGloamBatcherV4"), [lv, zeroAddress, D.factory, ROUND, 200n, 600n]);
  const block = await pub.getBlockNumber();

  // the keeper loop admits every settled launch and registers its v4 market for batch rounds
  const send = async (x) => (await sendAndLog(pub, x.functionName, keeper.wallet.writeContract(x))).transactionHash;
  const loop = createGloamLoop({ publicClient: pub, account: keeper.account, send, launchVault: lv, batcherV4, batcherV4Block: block });
  const t = await loop.tick();
  out.admitted = t.admitted.length;
  out.registered = t.registered.length;
  assert(t.errors.length === 0, `the loop ran clean${t.errors.length ? `: ${t.errors.join("; ")}` : ""}`);
  assert(t.registered.length > 0, `the keeper loop registered ${t.registered.length} settled launches' v4 markets for batch rounds`);
  const again = await loop.tick();
  assert(again.registered.length === 0, "a second tick registers nothing new");

  const relay = createGloamRelay({ publicClient: pub, walletClient: keeper.wallet, vault: stack.pool, launchVault: lv, memoBoard: stack.payMemo, escrows: [batcherV4], hourlySpendWei: parseEther("5") });
  let saved = [];
  const provers = { shield: await finalProver("shield"), transfer: await finalProver("transfer"), unshield: await finalProver("unshield") };
  const cfg = { publicClient: pub, chainId: ELYSIUM_TESTNET_ID, gloamVault: { pool: stack.pool, poolBlock: block }, launchVault: { pool: lv, poolBlock: block }, payMemo: stack.payMemo, provers, submit: (call) => relay({ kind: call.kind, to: call.to, data: call.data }), whype: D.whype, batcherV4, logChunk: 5_000n, records: { load: () => saved, save: (x) => (saved = x) } };
  const A = await GloamPrivate.unlock(alice.wallet, cfg);

  // the deepest registered launch
  const MKT = parseAbi(["function marketOf(address) view returns (address)", "function reserveHype() view returns (uint256)"]);
  let best = null;
  let bestR = 0n;
  for (const r of t.registered) {
    const res = await pub.readContract({ address: r.market, abi: MKT, functionName: "reserveHype" }).catch(() => 0n);
    if (res > bestR) [best, bestR] = [r, res];
  }
  const token = best.token;
  assert((await A.batcherFor(token)).toLowerCase() === batcherV4.toLowerCase(), "the SDK picks the v4 batcher for a registered launch");
  out.poolHype = formatEther(bestR);
  console.log(`  batching ${token}, pool holds ${formatEther(bestR)} HYPE`);

  await A.shieldHype(alice.wallet, parseEther("1"));
  // to when the current round can settle: it has ended and its average covers a whole round
  const OPENS = parseAbi(["function settleOpens(address token, uint64 round) view returns (uint256)"]);
  // orders placed over several seconds can land in two rounds: wait for the last round's
  const roundEnd = async (orders) => {
    const round = orders ? orders.reduce((m, o) => (o.round > m ? o.round : m), 0n) : (await A.roundInfo(token)).round;
    const opens = await pub.readContract({ address: batcherV4, abi: OPENS, functionName: "settleOpens", args: [token, round] });
    const now = (await pub.getBlock()).timestamp;
    if (opens >= now) await warp(opens - now + 1n);
  };

  // the keeper ticks (every minute in production) and the app opens, until every order is paid. A round that lands
  // after another round's net trade moved the pool waits until its own average catches up (it can't cross at a price
  // the pool no longer offers), so it can take a few ticks.
  const settleAll = async (orders) => {
    await roundEnd(orders);
    const settled = [];
    const done = [];
    let fin;
    for (let i = 0; i < 12; i++) {
      settled.push(...(await loop.tick()).rounds.filter((r) => r.action === "settled"));
      fin = await A.finishPending();
      assert(fin.errors.length === 0, `payouts came back cleanly${fin.errors.length ? `: ${fin.errors.map((e) => e.error).join("; ")}` : ""}`);
      done.push(...fin.done);
      if (fin.waiting.length === 0) break;
      await warp(30n);
    }
    return { settled, done, waiting: fin.waiting.length };
  };
  const rounds = (orders) => [...new Set(orders.map((o) => String(o.round)))];

  // 1. too big for the pool: a round's side holds at most 4% of the pool's HYPE (review CL-06), so a 0.3 HYPE buy
  //    is cut to what fits, the rest stays in the balance, and the round still settles for everyone in it
  const room = await A.batchRoom(token, "buy");
  assert(room <= (bestR * 4n) / 100n, `the round takes at most 4% of the pool's HYPE (${formatEther(room)})`);
  const big = await A.batch(token, "buy", parseEther("0.3"));
  const bigIn = big.orders.reduce((x, o) => x + o.size, 0n);
  assert(bigIn <= room && big.rest >= parseEther("0.3") - room, `0.3 HYPE went in as ${formatEther(bigIn)} (${big.orders.length} orders), ${formatEther(big.rest)} stayed in the balance`);
  assert(saved.filter((r) => r.kind === "batchOrder").length === big.orders.length, "each order is recorded for the next open");
  const early = await A.finishPending();
  assert(early.waiting.length === big.orders.length && early.done.length === 0, "before the round settles, the orders wait");
  const s0 = await settleAll(big.orders);
  out.cappedBuy = { asked: "0.3", in: formatEther(bigIn), orders: big.orders.length };
  assert(s0.settled.length >= 1 && s0.waiting === 0 && s0.done.length === big.orders.length, "the capped round settled and every payout came back");

  // 2. sized for the pool: about 1.5% of its HYPE, in standard sizes
  const buyIn = bestR / 66n;
  const placed = await A.batch(token, "buy", buyIn);
  assert(placed.orders.length > 0, `${formatEther(buyIn)} HYPE went in as ${placed.orders.length} orders (${formatEther(placed.rest)} held back as not a standard size)`);
  const s1 = await settleAll(placed.orders);
  out.settleBuy = s1.settled.map((r) => ({ round: String(r.round), action: r.action }));
  assert(s1.settled.length === rounds(placed.orders).length, `the keeper loop settled ${s1.settled.length} round(s) through the real CloakV4Market`);
  assert(s1.done.length === placed.orders.length && s1.waiting === 0, `the next open brought every payout back (${s1.done.length} orders)`);
  const got = await A.balance(token);
  out.buy = { hypeIn: formatEther(buyIn - placed.rest), tokensOut: formatEther(got) };
  assert(got > 0n, `${formatEther(got)} tokens arrived in the private balance as notes`);

  // a sell: standard sizes of what came back
  const sold = await A.batch(token, "sell", got);
  assert(sold.orders.length > 0, `${sold.orders.length} sell orders placed`);
  const hypeBefore = await A.balance(A.hypeMarket.pool);
  const s2 = await settleAll(sold.orders);
  out.sellRounds = rounds(sold.orders).length;
  assert(s2.settled.length === rounds(sold.orders).length, `the keeper loop settled the sell round(s) (${s2.settled.length})`);
  assert(s2.done.length === sold.orders.length && s2.waiting === 0, `every sell payout came back (${s2.done.length} orders)`);
  const hypeAfter = await A.balance(A.hypeMarket.pool);
  out.sell = { orders: sold.orders.length, hypeOut: formatEther(hypeAfter - hypeBefore) };
  assert(hypeAfter > hypeBefore, `${formatEther(hypeAfter - hypeBefore)} HYPE came back privately from the sell round`);
  assert((await A.finishPending()).done.length === 0, "nothing left to finish");

  writeMeasurements("part14-batch-v4", { ...out, seconds: Math.round((performance.now() - t0) / 1000) });
  console.log(`\nPart 14 passed in ${Math.round((performance.now() - t0) / 1000)} s`);
} finally {
  anvil.stop();
}
process.exit(0);
