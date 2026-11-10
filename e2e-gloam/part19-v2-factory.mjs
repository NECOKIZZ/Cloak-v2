// Part 19: Cloak v2's own launch factory, end to end on a fork of Elysium testnet.
//
//   NODE_USE_ENV_PROXY=1 NO_PROXY=127.0.0.1,localhost node e2e-gloam/part19-v2-factory.mjs
//
// Deploys v2's factory exactly as the live script does (v2factory.mjs), runs a launch through it (sealed bids, reveal,
// settlement into a Uniswap v4 pool behind v2's hook), puts a launch vault and the v4 escrows on the new factory, and
// buys the new token privately. Also: the factory carries the fixed auction (a short reveal window is refused on
// chain), and the new launch vault admits only the new factory's launches, not Cloak v1's.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeFunctionData, formatEther, parseAbi, parseEther, zeroAddress } from "viem";
import { Cloak, GloamPrivate, cloakFactoryAbi, deployments } from "@cloakely/sdk";
import { createGloamRelay } from "../services/keeper/gloam.mjs";
import { createGloamLoop } from "../services/keeper/gloamLoop.mjs";
import { LV_ABI } from "./stack.mjs";
import { deployV2Factory } from "./v2factory.mjs";
import { ANVIL_KEYS, ELYSIUM_TESTNET_ID, ELYSIUM_TESTNET_RPC, ELYSIUM_TESTNET_USDC, REPO, assert, clients, deployGloamStack, deployPoseidon, finalProver, gloamArtifact, ourArtifact, rpc, sendAndLog, startAnvil, writeMeasurements } from "./lib.mjs";

const D = deployments[ELYSIUM_TESTNET_ID];
const T = JSON.parse(readFileSync(join(REPO, "deployments/elysium-testnet-gloam.json"), "utf8"));
const t0 = performance.now();
const anvil = await startAnvil({ port: 8591, forkUrl: process.env.RPC_URL ?? ELYSIUM_TESTNET_RPC });
const rpcUrl = anvil.rpcUrl;
const who = (i) => clients(rpcUrl, ANVIL_KEYS[i], ELYSIUM_TESTNET_ID);
const [dep, alice, bidA, bidB, keeper] = [who(0), who(1), who(2), who(3), who(8)];
const pub = dep.pub;
const write = (address, abi, functionName, args = []) => sendAndLog(pub, functionName, dep.wallet.writeContract({ address, abi, functionName, args }));
const deploy = async (label, art, args = []) => (await sendAndLog(pub, `deploy ${label}`, dep.wallet.deployContract({ ...art, args }))).contractAddress;
const warpTo = async (t) => {
  const now = Number((await pub.getBlock()).timestamp);
  if (t > now) await rpc(rpcUrl, "evm_increaseTime", [t - now]);
  await rpc(rpcUrl, "evm_mine", []);
};
const out = {};
try {
  console.log("Part 19 on a fork of Elysium testnet: Cloak v2's own launch factory");
  const addr = dep.account.address;

  // 1. the factory, as the live script deploys it
  const f = await deployV2Factory({ pub, wallet: dep.wallet, treasury: addr, copyFrom: D.config, poolManager: D.poolManager, vaultVerifier: T.verifier });
  out.factory = f.factory;
  assert(f.factory && f.hook, `v2's config, hook and factory deployed and read back (factory ${f.factory.slice(0, 10)}…, hook ${f.hook.slice(0, 10)}…)`);

  // 2. the fixed auction: a reveal window under five minutes is refused on chain, not only by the SDK
  const now0 = Number((await pub.getBlock()).timestamp);
  const unit = 10n ** 11n; // a 1,000,000-token sale raises about 1 HYPE at 10 units
  const base = { creator: addr, saleSupply: 1_000_000n * 10n ** 18n, lpReserve: 1_000_000n * 10n ** 18n, minPrice: unit, tickSize: unit, numTicks: 50n, lpBps: 8000, noRevealPenaltyBps: 2000, lpLockUntil: 0n };
  const short = { ...base, commitEnd: BigInt(now0 + 90), revealEnd: BigInt(now0 + 150), tlockRound: 0n };
  const shortCall = pub.simulateContract({ account: dep.account, address: f.factory, abi: cloakFactoryAbi, functionName: "createLaunch", args: ["Short", "SHRT", 0n, 0n, short, ""] });
  assert(await shortCall.then(() => false, () => true), "the new factory's auctions refuse a 60-second reveal window on chain (the fixed auction)");

  // 3. a launch through it: two sealed bids, revealed by their bidders, settled into a v4 pool behind v2's hook
  const creator = new Cloak(pub, dep.wallet, f.factory);
  const l = await creator.createLaunch({ name: "Gloak Test", symbol: "GLOAK", metadataURI: "", saleSupply: base.saleSupply, minPrice: unit, tickSize: unit, numTicks: 50, commitEnd: now0 + 90, revealEnd: now0 + 90 + 400, lpBps: 8000 });
  const s0 = await creator.getAuction(l.auction);
  const qA = creator.quoteBid(s0, unit * 20n, 150_000n * 10n ** 18n);
  const qB = creator.quoteBid(s0, unit * 10n, 850_000n * 10n ** 18n);
  const secA = await new Cloak(pub, bidA.wallet).bid(l.auction, { maxPrice: unit * 20n, quantity: 150_000n * 10n ** 18n, deposit: qA.cost });
  const secB = await new Cloak(pub, bidB.wallet).bid(l.auction, { maxPrice: unit * 10n, quantity: 850_000n * 10n ** 18n, deposit: qB.cost });
  await warpTo(now0 + 95);
  await new Cloak(pub, bidA.wallet).reveal(secA);
  await new Cloak(pub, bidB.wallet).reveal(secB);
  await warpTo(now0 + 90 + 405);
  await creator.settle(l.auction);
  const s1 = await creator.getAuction(l.auction);
  const pair = await pub.readContract({ address: l.auction, abi: parseAbi(["function pair() view returns (address)"]), functionName: "pair" });
  out.launch = { auction: l.auction, token: l.token, phase: s1.phase, pair };
  assert(s1.settled && pair !== zeroAddress, `the launch settled into its v4 market (${pair.slice(0, 10)}…)`);
  const listed = await creator.listLaunches();
  assert(listed.length === 1 && listed[0].auction.toLowerCase() === l.auction.toLowerCase(), "the new factory lists only its own launch");

  // the app's bell: what each wallet can claim, then claimed by its owner (the keeper no longer pushes it)
  const waitA = await creator.waitingFor(bidA.account.address, l.block);
  const bidsA = waitA.find((x) => x.kind === "bids");
  assert(bidsA && bidsA.tokens > 0n && bidsA.ids.length === 1, `the bell shows bidder A's won tokens (${formatEther(bidsA?.tokens ?? 0n)} GLOAK) waiting`);
  await new Cloak(pub, bidA.wallet, f.factory).claim(l.auction, bidsA.ids);
  assert(!(await creator.waitingFor(bidA.account.address, l.block)).some((x) => x.kind === "bids"), "after bidder A claims, the bell is clear for A");
  const proceeds = (await creator.waitingFor(dep.account.address, l.block)).find((x) => x.kind === "proceeds");
  assert(proceeds && proceeds.amount > 0n, `the bell shows the creator's raise (${formatEther(proceeds?.amount ?? 0n)} HYPE) waiting`);
  const hypeBefore = await pub.getBalance({ address: dep.account.address });
  const pr = await pub.waitForTransactionReceipt({ hash: await creator.withdrawProceeds(l.auction) });
  const paid = (await pub.getBalance({ address: dep.account.address })) - hypeBefore + pr.gasUsed * pr.effectiveGasPrice;
  assert(paid === proceeds.amount, "the creator withdrew the raise whenever they liked, the exact amount");
  assert(!(await creator.waitingFor(dep.account.address, l.block)).some((x) => x.kind === "proceeds"), "and the bell no longer lists it");

  // 4. Gloam's vault (stand-in), a launch vault on the NEW factory, the v4 swap on the NEW hook, batch rounds
  const poseidon = await deployPoseidon(dep);
  const stack = await deployGloamStack({ rpcUrl, pk: ANVIL_KEYS[0], poseidon, assets: [{ address: ELYSIUM_TESTNET_USDC, perDeposit: 500n * 10n ** 6n, total: 25_000n * 10n ** 6n }, { address: zeroAddress, perDeposit: parseEther("10"), total: parseEther("100") }], feeBps: 50, feeRecipient: addr, controller: addr });
  const caps = [parseEther("1000000000"), parseEther("100000000000")];
  const lv = await deploy("CloakLaunchVault", ourArtifact("CloakLaunchVault.sol", "CloakLaunchVault"), [poseidon, stack.dual, f.factory, ...caps, addr]);
  await write(lv, LV_ABI, "setShieldVerifier", [stack.shieldVerifier]);
  await write(lv, LV_ABI, "setWithdrawFee", [50, addr]);
  await write(lv, LV_ABI, "turnOnDepositLimits");
  await write(lv, LV_ABI, "setDepositLimit", [zeroAddress, parseEther("10"), parseEther("100")]);
  await write(lv, LV_ABI, "endSetup");
  const guardArt = gloamArtifact("VaultOwnerGuard.sol", "VaultOwnerGuard");
  const guard = await deploy("VaultOwnerGuard", guardArt, [lv, addr]);
  await write(lv, LV_ABI, "transferOwnership", [guard]);
  await write(guard, guardArt.abi, "acceptVaultOwnership");
  const router = await deploy("CloakLaunchSwapV4", ourArtifact("CloakLaunchSwapV4.sol", "CloakLaunchSwapV4"), [lv, D.poolManager, D.whype, f.hook]);
  // the cross-vault router: the launch vault (home) and Gloam's vault
  const crossRouter = await deploy("CloakRouterV4", ourArtifact("CloakLaunchSwapV4.sol", "CloakRouterV4"), [lv, stack.pool, zeroAddress, D.poolManager, D.whype, f.hook, zeroAddress]);
  // and batch rounds with HYPE in Gloam's vault (mainnet's model)
  const batcherG = await deploy("CloakGloamBatcherV4 (HYPE in Gloam's vault)", ourArtifact("CloakGloamBatcherV4.sol", "CloakGloamBatcherV4"), [lv, stack.pool, f.factory, 60n, 200n, 600n, zeroAddress]);
  const batcherV4 = await deploy("CloakGloamBatcherV4", ourArtifact("CloakGloamBatcherV4.sol", "CloakGloamBatcherV4"), [lv, zeroAddress, f.factory, 60n, 200n, 600n, zeroAddress]);
  const block = await pub.getBlockNumber();
  const loop = createGloamLoop({ publicClient: pub, account: keeper.account, send: async (x) => (await sendAndLog(pub, x.functionName, keeper.wallet.writeContract(x))).transactionHash, launchVault: lv, batcherV4, batcherV4Block: block });
  const t = await loop.tick();
  assert(t.errors.length === 0 && t.admitted.length === 1 && t.registered.length === 1, `the keeper loop admitted the new launch and registered it for batch rounds, and nothing of Cloak v1's (${t.admitted.length} admitted, ${t.registered.length} registered)`);
  const v1Token = (await new Cloak(pub, undefined, D.factory).listLaunches())[0]?.token;
  if (v1Token) assert(!(await pub.readContract({ address: lv, abi: parseAbi(["function isLaunchToken(address) view returns (bool)"]), functionName: "isLaunchToken", args: [v1Token] })), "a Cloak v1 launch token isn't admitted to the v2 launch vault");

  // 5. a private buy and sell of the new token through its v4 pool
  const relay = createGloamRelay({ publicClient: pub, walletClient: keeper.wallet, vault: stack.pool, launchVault: lv, memoBoard: stack.payMemo, escrows: [router, batcherV4, crossRouter, batcherG], hourlySpendWei: parseEther("5") });
  let saved = [];
  let savedB = [];
  const provers = { shield: await finalProver("shield"), transfer: await finalProver("transfer"), unshield: await finalProver("unshield") };
  const A = await GloamPrivate.unlock(alice.wallet, { publicClient: pub, chainId: ELYSIUM_TESTNET_ID, gloamVault: { pool: stack.pool, poolBlock: block }, launchVault: { pool: lv, poolBlock: block }, payMemo: stack.payMemo, provers, submit: (call) => relay({ kind: call.kind, to: call.to, data: call.data }), whype: D.whype, launchSwapV4: router, batcherV4, records: { load: () => saved, save: (x) => (saved = x) } });
  const markets = await A.loadMarkets();
  const m = markets.find((x) => x.token.toLowerCase() === l.token.toLowerCase());
  assert(m && m.v4, `the new token is a private market through its v4 pool (${markets.length} market${markets.length === 1 ? "" : "s"})`);
  await A.shieldHype(alice.wallet, parseEther("1"));
  const buyIn = parseEther("0.02");
  const r = await A.buy(l.token, buyIn);
  const got = await A.balance(m.pool);
  out.buy = { hypeIn: formatEther(buyIn), tokensOut: formatEther(got) };
  assert(got === r.amountOut && got > 0n, `bought ${formatEther(got)} GLOAK privately for ${formatEther(buyIn)} HYPE through v2's hook`);
  const s = await A.sell(l.token, got / 2n);
  assert(s.amountOut > 0n, `sold half back for ${formatEther(s.amountOut)} HYPE as a note`);

  // 6. the router (CloakRouterV4): HYPE in Gloam's vault, the token in the launch vault. Bob's account trades that way
  const B = await GloamPrivate.unlock(bidB.wallet, { publicClient: pub, chainId: ELYSIUM_TESTNET_ID, gloamVault: { pool: stack.pool, poolBlock: block }, launchVault: { pool: lv, poolBlock: block }, payMemo: stack.payMemo, provers, submit: (call) => relay({ kind: call.kind, to: call.to, data: call.data }), whype: D.whype, launchSwapV4: router, router: crossRouter, batcherV4: batcherG, records: { load: () => savedB, save: (x) => (savedB = x) } });
  await B.loadMarkets();
  const gCore = B.cores.find((c) => c.config.pool.toLowerCase() === stack.pool.toLowerCase());
  const lCore = B.cores.find((c) => c.config.pool.toLowerCase() === lv.toLowerCase());
  const held = async (c, asset) => (await c.sync(), c.ownNotes(asset).reduce((a, n) => a + n.amount, 0n));
  await gCore.shield(bidB.wallet, zeroAddress, parseEther("0.5"));
  assert((await held(gCore, zeroAddress)) === parseEther("0.5") && (await held(lCore, zeroAddress)) === 0n, "Bob's HYPE is in Gloam's vault, none in the launch vault");
  const feesOf = () => pub.readContract({ address: stack.pool, abi: parseAbi(["function feesOwed(address) view returns (uint256)"]), functionName: "feesOwed", args: [zeroAddress] });
  const gFees0 = await feesOf();
  const buyB = parseEther("0.01");
  const t2 = performance.now();
  const rb = await B.buy(l.token, buyB);
  const tokB = await held(lCore, l.token);
  assert(tokB === rb.amountOut && tokB > 0n, `a buy spent ${formatEther(buyB)} HYPE from Gloam's vault and ${formatEther(tokB)} GLOAK landed in the launch vault, one call, ${Math.round(performance.now() - t2)} ms`);
  assert((await feesOf()) - gFees0 === (buyB * 50n) / 10_000n, "the fee on the HYPE went to Gloam's vault");
  const gAfterBuy = await held(gCore, zeroAddress);
  assert(gAfterBuy > parseEther("0.5") - buyB && gAfterBuy < parseEther("0.5"), `the buy's leftover came back into Gloam's vault (${formatEther(gAfterBuy)} HYPE there)`);
  const t3 = performance.now();
  const sb = await B.sell(l.token, tokB);
  const tokLeft = await held(lCore, l.token);
  assert(tokLeft < tokB / 50n && (await held(gCore, zeroAddress)) === gAfterBuy + sb.amountOut, `a sell spent the GLOAK in the launch vault and ${formatEther(sb.amountOut)} HYPE landed in Gloam's vault (its unused ${formatEther(tokLeft)} GLOAK back in the launch vault), ${Math.round(performance.now() - t3)} ms`);
  assert((await held(lCore, zeroAddress)) === 0n, "and the launch vault never held Bob's HYPE");
  // 7. a batch round with HYPE in Gloam's vault: buy orders spend HYPE there, the tokens come back into the launch vault
  const loopG = createGloamLoop({ publicClient: pub, account: keeper.account, send: async (x) => (await sendAndLog(pub, x.functionName, keeper.wallet.writeContract(x))).transactionHash, launchVault: lv, batcherV4: batcherG, batcherV4Block: block });
  await loopG.tick(); // registers the launch's market
  const room = await B.batchRoom(l.token, "buy");
  const g0 = await held(gCore, zeroAddress);
  const t0b = await held(lCore, l.token);
  const placedB = await B.batch(l.token, "buy", room);
  const ordered = placedB.orders.reduce((a, o) => a + o.size, 0n);
  assert(placedB.orders.length > 0 && g0 - (await held(gCore, zeroAddress)) === ordered, `${placedB.orders.length} batch buy orders (${formatEther(ordered)} HYPE) were spent from Gloam's vault`);
  const OPENS = parseAbi(["function settleOpens(address token, uint64 round) view returns (uint256)"]);
  const lastRound = placedB.orders.reduce((m, o) => (o.round > m ? o.round : m), 0n);
  await warpTo(Number(await pub.readContract({ address: batcherG, abi: OPENS, functionName: "settleOpens", args: [l.token, lastRound] })) + 1);
  let finB;
  for (let i = 0; i < 12; i++) {
    await loopG.tick();
    finB = await B.finishPending();
    assert(finB.errors.length === 0, `batch payouts came back cleanly${finB.errors.length ? `: ${finB.errors.map((e) => e.error).join("; ")}` : ""}`);
    if (finB.waiting.length === 0) break;
    await warpTo(Number((await pub.getBlock()).timestamp) + 30);
  }
  const tokFromBatch = (await held(lCore, l.token)) - t0b;
  assert(finB.waiting.length === 0 && tokFromBatch > 0n, `the round settled and ${formatEther(tokFromBatch)} GLOAK came back into the launch vault`);
  assert((await held(lCore, zeroAddress)) === 0n, "and the launch vault still holds none of Bob's HYPE");

  out.router = { buyHype: formatEther(buyB), tokensOut: formatEther(tokB), sellHypeOut: formatEther(sb.amountOut) };

  writeMeasurements("part19-v2-factory", { ...out, seconds: Math.round((performance.now() - t0) / 1000) });
  console.log(`\nPart 19 passed in ${Math.round((performance.now() - t0) / 1000)} s`);
} finally {
  anvil.stop();
}
process.exit(0);
