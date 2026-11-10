// Part 21: USDC as a market and two-pool routes, on a fork of Elysium testnet with real proofs. USDC (a 6-decimal
// stand-in) lives in Gloam's vault with a plain native-HYPE v4 pool, as on mainnet. Through CloakRouterV4 and the SDK's
// trade(): HYPE to USDC (one pool), USDC to KNTQ in the ecosystem vault (two pools through HYPE, one private swap),
// KNTQ back to USDC, and USDC to HYPE.
//
//   node e2e-gloam/part21-routes.mjs
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatEther, formatUnits, parseAbi, parseEther, zeroAddress } from "viem";
import { GloamPrivate, deployments } from "@cloakely/sdk";
import { createGloamRelay } from "../services/keeper/gloam.mjs";
import { LV_ABI } from "./stack.mjs";
import { ANVIL_KEYS, ELYSIUM_TESTNET_ID, ELYSIUM_TESTNET_RPC, ELYSIUM_TESTNET_USDC, REPO, assert, clients, deployGloamStack, deployPoseidon, finalProver, ourArtifact, rpc, sendAndLog, startAnvil, writeMeasurements } from "./lib.mjs";

const D = deployments[ELYSIUM_TESTNET_ID];
const t0 = performance.now();
const anvil = await startAnvil({ port: 8575, forkUrl: process.env.RPC_URL ?? ELYSIUM_TESTNET_RPC });
const rpcUrl = anvil.rpcUrl;
const who = (i) => clients(rpcUrl, ANVIL_KEYS[i], ELYSIUM_TESTNET_ID);
const [dep, alice, keeper] = [who(0), who(1), who(8)];
const pub = dep.pub;
const write = (address, abi, functionName, args = []) => sendAndLog(pub, functionName, dep.wallet.writeContract({ address, abi, functionName, args }));
const deploy = async (label, art, args = [], value) => (await sendAndLog(pub, `deploy ${label}`, dep.wallet.deployContract({ ...art, args, value }))).contractAddress;
const v4Art = (file, name) => {
  const j = JSON.parse(readFileSync(join(REPO, `contracts-v4/out/${file}/${name}.json`), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object };
};
const warp = async (secs) => {
  await rpc(rpcUrl, "evm_increaseTime", [secs]);
  await rpc(rpcUrl, "evm_mine", []);
};
const EV = parseAbi([
  "function list(address token, (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, uint128 perDeposit, uint128 total, address launchpad)",
  "function isEcosystemToken(address) view returns (bool)",
  "function marketOf(address token, (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key) view returns (uint256 hypeLiquidity, uint256 mcapHype)",
  "function depositLimit(address) view returns (uint128 perDeposit, uint128 total)",
]);
const out = {};

try {
  console.log("Part 21 on a fork of Elysium testnet: USDC as a market, and two-pool routes through HYPE in one private swap");
  const addr = dep.account.address;
  const poseidon = await deployPoseidon(dep);
  const tokenArt = ourArtifact("TestToken.sol", "TestToken");
  const usdc = await deploy("USDC (stand-in, 6 decimals)", tokenArt, ["USD Coin", "USDC", 6]);
  await write(usdc, tokenArt.abi, "mint", [addr, 1_000_000n * 10n ** 6n]);
  // Gloam's vault holds HYPE and USDC (mainnet's model); the launch vault takes no HYPE
  const stack = await deployGloamStack({ rpcUrl, pk: ANVIL_KEYS[0], poseidon, assets: [{ address: usdc, perDeposit: 500n * 10n ** 6n, total: 25_000n * 10n ** 6n }, { address: zeroAddress, perDeposit: parseEther("10"), total: parseEther("100") }], feeBps: 50, feeRecipient: addr, controller: addr });
  const caps = [parseEther("1000000000"), parseEther("100000000000")];
  const lv = await deploy("CloakLaunchVault", ourArtifact("CloakLaunchVault.sol", "CloakLaunchVault"), [poseidon, stack.dual, D.factory, ...caps, addr]);
  for (const [f, a] of [["setShieldVerifier", [stack.shieldVerifier]], ["setWithdrawFee", [50, addr]], ["turnOnDepositLimits", []], ["endSetup", []]]) await write(lv, LV_ABI, f, a);

  // plain native-HYPE pools: HYPE/USDC at 1 HYPE = 100 USDC (about 100 HYPE and 10,000 USDC in range), HYPE/KNTQ at 1 HYPE = 100 KNTQ
  const lpArt = v4Art("CloakEcosystemVault.t.sol", "PlainLp");
  const lp = await deploy("PlainLp", lpArt, [D.poolManager]);
  await sendAndLog(pub, "fund the LP", dep.wallet.sendTransaction({ to: lp, value: parseEther("400") }));
  const usdcKey = { currency0: zeroAddress, currency1: usdc, fee: 3000, tickSpacing: 60, hooks: zeroAddress };
  await write(usdc, tokenArt.abi, "transfer", [lp, 20_000n * 10n ** 6n]);
  await write(lp, lpArt.abi, "open", [usdcKey, (1n << 96n) / 100_000n]);
  await write(lp, lpArt.abi, "liquidity", [usdcKey, 10n ** 15n]);
  const kntq = await deploy("KNTQ (stand-in)", tokenArt, ["Kinetiq", "KNTQ", 18]);
  await write(kntq, tokenArt.abi, "mint", [addr, parseEther("1000000")]);
  await write(kntq, tokenArt.abi, "transfer", [lp, parseEther("50000")]);
  const kntqKey = { currency0: zeroAddress, currency1: kntq, fee: 3000, tickSpacing: 60, hooks: zeroAddress };
  await write(lp, lpArt.abi, "open", [kntqKey, 10n << 96n]);
  await write(lp, lpArt.abi, "liquidity", [kntqKey, parseEther("1000")]);

  // KNTQ admitted to the ecosystem vault (part 20 checks the rules in full)
  const rules = { minHypeLiquidity: parseEther("50"), minMcapHype: parseEther("5000"), liquidityFloor: parseEther("50"), mcapFloor: parseEther("5000"), maxPerDepositBps: 10, maxTotalBps: 200 };
  const ev = await deploy("CloakEcosystemVault", ourArtifact("CloakEcosystemVault.sol", "CloakEcosystemVault"), [poseidon, stack.dual, D.poolManager, lv, addr, addr, rules]);
  for (const [f, a] of [["setShieldVerifier", [stack.shieldVerifier]], ["setWithdrawFee", [50, addr]], ["turnOnDepositLimits", []], ["endSetup", []]]) await write(ev, LV_ABI, f, a);
  await write(ev, EV, "list", [kntq, kntqKey, parseEther("1000"), parseEther("20000"), zeroAddress]);

  const router = await deploy("CloakRouterV4", ourArtifact("CloakLaunchSwapV4.sol", "CloakRouterV4"), [lv, stack.pool, ev, D.poolManager, D.whype, D.v4Hook, zeroAddress]);
  const block = await pub.getBlockNumber();
  const relay = createGloamRelay({ publicClient: pub, walletClient: keeper.wallet, vault: stack.pool, launchVault: lv, ecosystemVault: ev, memoBoard: stack.payMemo, escrows: [router], hourlySpendWei: parseEther("5") });
  let saved = [];
  const provers = { shield: await finalProver("shield"), transfer: await finalProver("transfer"), unshield: await finalProver("unshield") };
  // the app's wiring: the deployment's router and PoolManager, and USDC with its HYPE pool (deployments.ts assets)
  const A = await GloamPrivate.unlock(alice.wallet, { publicClient: pub, chainId: ELYSIUM_TESTNET_ID, gloamVault: { pool: stack.pool, poolBlock: block }, launchVault: { pool: lv, poolBlock: block }, ecosystemVault: { pool: ev, poolBlock: block }, payMemo: stack.payMemo, provers, submit: (call) => relay({ kind: call.kind, to: call.to, data: call.data }), whype: D.whype, router, poolManager: D.poolManager, records: { load: () => saved, save: (x) => (saved = x) } });
  await A.loadMarkets();
  const um = A.addAsset({ symbol: "USDC", token: usdc, decimals: 6, pool: { fee: 3000, tickSpacing: 60 } });
  assert(um.hypeKey && A.markets.some((m) => m.ecoKey && m.symbol === "KNTQ"), "the app lists USDC (with its HYPE pool) and KNTQ as private markets");
  const [gCore, lCore, eCore] = [stack.pool, lv, ev].map((v) => A.cores.find((c) => c.config.pool.toLowerCase() === v.toLowerCase()));
  const held = async (c, asset) => (await c.sync(), c.ownNotes(asset).reduce((a, n) => a + n.amount, 0n));
  const U = (x) => formatUnits(x, 6);

  await A.shieldHype(alice.wallet, parseEther("1"));
  await write(usdc, tokenArt.abi, "transfer", [alice.account.address, 200n * 10n ** 6n]);
  await A.shieldToken(alice.wallet, usdc, 200n * 10n ** 6n);
  assert((await held(gCore, usdc)) === 200n * 10n ** 6n && (await held(gCore, zeroAddress)) === parseEther("1"), "Alice's HYPE and USDC went into Gloam's vault");

  // 1. HYPE to USDC: one pool, both sides in Gloam's vault
  let t = performance.now();
  const q1 = await A.quoteTrade(D.whype, usdc, parseEther("0.1995"));
  const r1 = await A.trade(D.whype, usdc, parseEther("0.2"));
  const u1 = await held(gCore, usdc);
  assert(u1 - 200n * 10n ** 6n === r1.amountOut && r1.amountOut > 19n * 10n ** 6n, `0.2 HYPE bought ${U(r1.amountOut)} USDC (quoted ${U(q1)}), ${Math.round(performance.now() - t)} ms`);

  // 2. USDC to KNTQ: two pools (USDC to HYPE to KNTQ), Gloam's vault into the ecosystem vault
  t = performance.now();
  const h2 = await held(gCore, zeroAddress);
  const q2 = await A.quoteTrade(usdc, kntq, 19_900_000n);
  const r2 = await A.trade(usdc, kntq, 20n * 10n ** 6n);
  const k2 = await held(eCore, kntq);
  assert(k2 === r2.amountOut && k2 > parseEther("18"), `20 USDC bought ${formatEther(k2)} KNTQ through HYPE in one swap (quoted ${formatEther(q2)}), ${Math.round(performance.now() - t)} ms`);
  assert((await held(gCore, zeroAddress)) === h2, "no HYPE note was made or spent: HYPE only passed through the pools");
  const u2 = await held(gCore, usdc);
  assert(u2 > u1 - 20n * 10n ** 6n && u2 < u1 - 19n * 10n ** 6n, `and the leftover came back as USDC in Gloam's vault (${U(u2)} USDC there)`);

  // 3. KNTQ to USDC: two pools back, the ecosystem vault into Gloam's vault
  t = performance.now();
  const r3 = await A.trade(kntq, usdc, k2 / 2n);
  assert((await held(gCore, usdc)) === u2 + r3.amountOut, `sold half the KNTQ for ${U(r3.amountOut)} USDC through HYPE, ${Math.round(performance.now() - t)} ms`);

  // 4. USDC to HYPE: one pool
  const h4 = await held(gCore, zeroAddress);
  const r4 = await A.trade(usdc, D.whype, 10n * 10n ** 6n);
  assert((await held(gCore, zeroAddress)) === h4 + r4.amountOut, `10 USDC sold for ${formatEther(r4.amountOut)} HYPE`);
  assert((await held(lCore, zeroAddress)) === 0n && (await held(lCore, usdc)) === 0n, "the launch vault was never touched");

  out.routes = { hypeToUsdc: U(r1.amountOut), usdcToKntq: formatEther(k2), kntqToUsdc: U(r3.amountOut), usdcToHype: formatEther(r4.amountOut) };
  writeMeasurements("part21-routes", { ...out, seconds: Math.round((performance.now() - t0) / 1000) });
  console.log(`\nPart 21 passed in ${Math.round((performance.now() - t0) / 1000)} s`);
} finally {
  anvil.stop();
}
process.exit(0);
