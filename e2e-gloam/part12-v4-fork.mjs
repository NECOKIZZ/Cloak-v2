// Part 12: private swaps on Cloak's real Uniswap v4 launches, on a local fork of Elysium testnet. A CloakLaunchVault
// pointed at Cloak's live v4 factory admits every settled launch (the keeper loop), and GloamPrivate buys and sells a
// real launch token through its real pool (Uniswap's PoolManager, behind CloakV4Hook) via CloakLaunchSwapV4, with
// Gloam's final keys and the relay. Nothing here touches the live chain: it all happens on the fork.
//
//   node e2e-gloam/part12-v4-fork.mjs
import { formatEther, parseAbi, parseEther, zeroAddress } from "viem";
import { GloamPrivate, deployments } from "@cloakely/sdk";
import { createGloamRelay } from "../services/keeper/gloam.mjs";
import { createGloamLoop } from "../services/keeper/gloamLoop.mjs";
import { LV_ABI, checkLaunchVault } from "./stack.mjs";
import { ANVIL_KEYS, ELYSIUM_TESTNET_ID, ELYSIUM_TESTNET_RPC, ELYSIUM_TESTNET_USDC, assert, clients, deployGloamStack, deployPoseidon, finalProver, gloamArtifact, ourArtifact, sendAndLog, startAnvil, writeMeasurements } from "./lib.mjs";

const D = deployments[ELYSIUM_TESTNET_ID];
const t0 = performance.now();
const anvil = await startAnvil({ port: 8565, forkUrl: process.env.RPC_URL ?? ELYSIUM_TESTNET_RPC });
const rpcUrl = anvil.rpcUrl;
const who = (i) => clients(rpcUrl, ANVIL_KEYS[i], ELYSIUM_TESTNET_ID);
const [dep, alice, keeper] = [who(0), who(1), who(8)];
const pub = dep.pub;
const write = (address, abi, functionName, args = []) => sendAndLog(pub, functionName, dep.wallet.writeContract({ address, abi, functionName, args }));
const deploy = async (label, art, args = []) => (await sendAndLog(pub, `deploy ${label}`, dep.wallet.deployContract({ ...art, args }))).contractAddress;
const out = {};
try {
  console.log("Part 12 on a fork of Elysium testnet: private swaps on Cloak's real v4 launches");
  const addr = dep.account.address;
  const poseidon = await deployPoseidon(dep);
  // Gloam's vault as it will be: USDC only (Kinetiq's real test USDC), at their caps
  const stack = await deployGloamStack({ rpcUrl, pk: ANVIL_KEYS[0], poseidon, assets: [{ address: ELYSIUM_TESTNET_USDC, perDeposit: 500n * 10n ** 6n, total: 25_000n * 10n ** 6n }], feeBps: 50, feeRecipient: addr, controller: addr });
  // Cloak's launch vault on Cloak's live v4 factory, under Gloam's guard
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
  const router = await deploy("CloakLaunchSwapV4", ourArtifact("CloakLaunchSwapV4.sol", "CloakLaunchSwapV4"), [lv, D.poolManager, D.whype, D.v4Hook]);
  const block = await pub.getBlockNumber();

  // the keeper loop admits every settled launch of the live factory
  const loop = createGloamLoop({ publicClient: pub, account: keeper.account, send: async (x) => (await sendAndLog(pub, x.functionName, keeper.wallet.writeContract(x))).transactionHash, launchVault: lv });
  const t = await loop.tick();
  out.admitted = t.admitted.length;
  assert(t.admitted.length > 0, `the keeper loop admitted ${t.admitted.length} settled launches of Cloak's live v4 factory`);

  const relay = createGloamRelay({ publicClient: pub, walletClient: keeper.wallet, vault: stack.pool, launchVault: lv, memoBoard: stack.payMemo, escrows: [router], hourlySpendWei: parseEther("5") });
  let saved = [];
  const provers = { shield: await finalProver("shield"), transfer: await finalProver("transfer"), unshield: await finalProver("unshield") };
  const A = await GloamPrivate.unlock(alice.wallet, { publicClient: pub, chainId: ELYSIUM_TESTNET_ID, gloamVault: { pool: stack.pool, poolBlock: block }, launchVault: { pool: lv, poolBlock: block }, payMemo: stack.payMemo, provers, submit: (call) => relay({ kind: call.kind, to: call.to, data: call.data }), whype: D.whype, launchSwapV4: router, logChunk: 5_000n, records: { load: () => saved, save: (x) => (saved = x) } });
  const markets = (await A.loadMarkets()).filter((m) => m.v4);
  assert(markets.length > 0, `${markets.length} real launches tradable privately through their v4 pools`);
  // the deepest pool
  const RES = parseAbi(["function reserveHype() view returns (uint256)"]);
  let best = markets[0];
  let bestR = 0n;
  for (const m of markets) {
    const r = await pub.readContract({ address: m.pair, abi: RES, functionName: "reserveHype" }).catch(() => 0n);
    if (r > bestR) [best, bestR] = [m, r];
  }
  out.token = best.symbol;
  out.poolHype = formatEther(bestR);
  console.log(`  trading ${best.symbol} (${best.token}), pool holds ${formatEther(bestR)} HYPE`);

  await A.shieldHype(alice.wallet, parseEther("1"));
  const buyIn = bestR / 50n < parseEther("0.2") ? bestR / 50n : parseEther("0.2"); // at most 2% of the pool
  const q = await A.quote(best.token, "buy", buyIn);
  const r = await A.buy(best.token, buyIn);
  const tokens = await A.balance(best.pool);
  out.buy = { hypeIn: formatEther(buyIn), tokensOut: formatEther(tokens), quote: formatEther(q) };
  assert(tokens === r.amountOut && tokens > 0n, `bought ${formatEther(tokens)} ${best.symbol} privately for ${formatEther(buyIn)} HYPE through its v4 pool (CloakV4Hook)`);
  const hypeLeft = await A.balance(A.hypeMarket.pool);
  assert(hypeLeft > parseEther("1") - buyIn, `and the buffer came back: ${formatEther(hypeLeft)} HYPE private after spending ${formatEther(buyIn)}`);
  const s = await A.sell(best.token, tokens / 2n);
  out.sell = { tokensIn: formatEther(tokens / 2n), hypeOut: formatEther(s.amountOut) };
  assert(s.amountOut > 0n, `sold half back for ${formatEther(s.amountOut)} HYPE as a note`);

  writeMeasurements("part12-v4-fork", { ...out, seconds: Math.round((performance.now() - t0) / 1000) });
  console.log(`\nPart 12 passed in ${Math.round((performance.now() - t0) / 1000)} s`);
} finally {
  anvil.stop();
}
process.exit(0);
