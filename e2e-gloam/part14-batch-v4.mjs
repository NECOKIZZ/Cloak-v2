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
  const batcherV4 = await deploy("CloakGloamBatcherV4", ourArtifact("CloakGloamBatcherV4.sol", "CloakGloamBatcherV4"), [lv, D.factory, ROUND, 200n, 600n]);
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
  const roundEnd = async () => {
    const { endsAt } = await A.roundInfo(token);
    await warp(BigInt(endsAt) - (await pub.getBlock()).timestamp + 1n);
  };

  // 1. too big for the pool: 0.3 HYPE (0.2 + 0.1) can't settle within the batcher's 5% impact cap, so after the
  //    refund time the keeper cancels the round and the next open brings the input back
  const big = await A.batch(token, "buy", parseEther("0.3"));
  assert(big.orders.length === 2 && big.rest === 0n, `0.3 HYPE went in as ${big.orders.length} standard-size orders (0.2 + 0.1)`);
  assert(saved.filter((r) => r.kind === "batchOrder").length === 2, "each order is recorded for the next open");
  const early = await A.finishPending();
  assert(early.waiting.length === 2 && early.done.length === 0, "before the round ends, the orders wait");
  await roundEnd();
  const held = await loop.tick();
  assert(!held.rounds.length, "the keeper can't settle a round that would move the pool too far");
  await warp(600n);
  const c = await loop.tick();
  assert(c.rounds.some((r) => r.action === "cancelled" && r.round === big.orders[0].round), "past its refund time the keeper cancelled it");
  const hypeBeforeRefund = await A.balance(A.hypeMarket.pool);
  const back = await A.finishPending();
  assert(back.errors.length === 0 && back.done.length === 2 && back.waiting.length === 0, `the next open took both inputs back (${back.done.map((d) => d.outcome).join(", ")})`);
  const refunded = (await A.balance(A.hypeMarket.pool)) - hypeBeforeRefund;
  out.cancelled = { in: "0.3", back: formatEther(refunded) };
  assert(refunded >= (parseEther("0.3") * 990n) / 1000n, `${formatEther(refunded)} HYPE came back (the input less the vault's 0.5% fee on the way in)`);

  // 2. sized for the pool: about 1.5% of its HYPE, in standard sizes
  const buyIn = bestR / 66n;
  const placed = await A.batch(token, "buy", buyIn);
  assert(placed.orders.length > 0, `${formatEther(buyIn)} HYPE went in as ${placed.orders.length} orders (${formatEther(placed.rest)} held back as not a standard size)`);
  const round = placed.orders[0].round;
  await roundEnd();
  const s1 = await loop.tick();
  out.settleBuy = s1.rounds.map((r) => ({ round: String(r.round), action: r.action }));
  assert(s1.rounds.some((r) => r.action === "settled" && r.round === round), `the keeper loop settled round ${round} through the real CloakV4Market`);
  const fin = await A.finishPending();
  assert(fin.errors.length === 0, `the payouts came back cleanly${fin.errors.length ? `: ${fin.errors.map((e) => e.error).join("; ")}` : ""}`);
  assert(fin.done.length === placed.orders.length && fin.waiting.length === 0, `the next open brought every payout back (${fin.done.map((d) => d.outcome).join(", ")})`);
  const got = await A.balance(token);
  out.buy = { hypeIn: formatEther(buyIn - placed.rest), tokensOut: formatEther(got) };
  assert(got > 0n, `${formatEther(got)} tokens arrived in the private balance as notes`);

  // a sell: standard sizes of what came back
  const sold = await A.batch(token, "sell", got);
  assert(sold.orders.length > 0, `${sold.orders.length} sell orders placed`);
  await roundEnd();
  const s2 = await loop.tick();
  assert(s2.rounds.some((r) => r.action === "settled"), "the keeper loop settled the sell round");
  const hypeBefore = await A.balance(A.hypeMarket.pool);
  const fin2 = await A.finishPending();
  assert(fin2.errors.length === 0 && fin2.waiting.length === 0, `every sell payout came back (${fin2.done.length} orders)`);
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
