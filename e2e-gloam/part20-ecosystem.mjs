// Part 20: Cloak's ecosystem vault (CloakEcosystemVault) on a fork of Elysium testnet, with real proofs. A KNTQ stand-in
// with a plain native-HYPE Uniswap v4 pool is proposed by the approver, refused before the delay, admitted after it
// (every rule checked again), then traded privately through CloakRouterV4: HYPE from Gloam's vault buys KNTQ into the
// ecosystem vault, and KNTQ sells back into Gloam's vault. A wallet's KNTQ shields straight into the ecosystem vault.
//
//   node e2e-gloam/part20-ecosystem.mjs
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatEther, parseAbi, parseEther, zeroAddress } from "viem";
import { GloamPrivate, deployments } from "@cloakely/sdk";
import { createGloamRelay } from "../services/keeper/gloam.mjs";
import { LV_ABI } from "./stack.mjs";
import { ANVIL_KEYS, ELYSIUM_TESTNET_ID, ELYSIUM_TESTNET_RPC, ELYSIUM_TESTNET_USDC, REPO, assert, clients, deployGloamStack, deployPoseidon, finalProver, ourArtifact, rpc, sendAndLog, startAnvil, writeMeasurements } from "./lib.mjs";

const D = deployments[ELYSIUM_TESTNET_ID];
const t0 = performance.now();
const anvil = await startAnvil({ port: 8574, forkUrl: process.env.RPC_URL ?? ELYSIUM_TESTNET_RPC });
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
  "function propose(address token, (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, uint128 perDeposit, uint128 total)",
  "function admit(address token)",
  "function isEcosystemToken(address) view returns (bool)",
  "function marketOf(address token, (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key) view returns (uint256 hypeLiquidity, uint256 mcapHype)",
  "function depositLimit(address) view returns (uint128 perDeposit, uint128 total)",
]);
const out = {};

try {
  console.log("Part 20 on a fork of Elysium testnet: the ecosystem vault, KNTQ admitted under the rules and traded privately");
  const addr = dep.account.address;
  const poseidon = await deployPoseidon(dep);
  // Gloam's vault holds HYPE (mainnet's model); the launch vault takes no HYPE
  const stack = await deployGloamStack({ rpcUrl, pk: ANVIL_KEYS[0], poseidon, assets: [{ address: ELYSIUM_TESTNET_USDC, perDeposit: 500n * 10n ** 6n, total: 25_000n * 10n ** 6n }, { address: zeroAddress, perDeposit: parseEther("10"), total: parseEther("100") }], feeBps: 50, feeRecipient: addr, controller: addr });
  const caps = [parseEther("1000000000"), parseEther("100000000000")];
  const lv = await deploy("CloakLaunchVault", ourArtifact("CloakLaunchVault.sol", "CloakLaunchVault"), [poseidon, stack.dual, D.factory, ...caps, addr]);
  for (const [f, a] of [["setShieldVerifier", [stack.shieldVerifier]], ["setWithdrawFee", [50, addr]], ["turnOnDepositLimits", []], ["endSetup", []]]) await write(lv, LV_ABI, f, a);

  // KNTQ stand-in (1,000,000 supply) and its plain HYPE pool: 1 HYPE = 100 KNTQ, about 100 HYPE in range
  const tokenArt = ourArtifact("TestToken.sol", "TestToken");
  const kntq = await deploy("KNTQ (stand-in)", tokenArt, ["Kinetiq", "KNTQ", 18]);
  await write(kntq, tokenArt.abi, "mint", [addr, parseEther("1000000")]);
  const lpArt = v4Art("CloakEcosystemVault.t.sol", "PlainLp");
  const lp = await deploy("PlainLp", lpArt, [D.poolManager]);
  await write(kntq, tokenArt.abi, "transfer", [lp, parseEther("50000")]);
  await sendAndLog(pub, "fund the LP", dep.wallet.sendTransaction({ to: lp, value: parseEther("200") }));
  const v4Key = { currency0: zeroAddress, currency1: kntq, fee: 3000, tickSpacing: 60, hooks: zeroAddress };
  await write(lp, lpArt.abi, "open", [v4Key, 10n << 96n]);
  await write(lp, lpArt.abi, "liquidity", [v4Key, parseEther("1000")]);

  // the ecosystem vault: approver and pauser the deploy wallet here (the Safe on mainnet)
  const rules = { minHypeLiquidity: parseEther("50"), minMcapHype: parseEther("5000"), admitDelay: 3n * 86_400n, maxPerDepositBps: 10, maxTotalBps: 200 };
  const ev = await deploy("CloakEcosystemVault", ourArtifact("CloakEcosystemVault.sol", "CloakEcosystemVault"), [poseidon, stack.dual, D.poolManager, lv, addr, addr, rules]);
  for (const [f, a] of [["setShieldVerifier", [stack.shieldVerifier]], ["setWithdrawFee", [50, addr]], ["turnOnDepositLimits", []], ["endSetup", []]]) await write(ev, LV_ABI, f, a);
  const [liq, mcap] = await pub.readContract({ address: ev, abi: EV, functionName: "marketOf", args: [kntq, v4Key] });
  assert(liq >= rules.minHypeLiquidity && mcap >= rules.minMcapHype, `KNTQ's pool passes the rules: ${formatEther(liq)} HYPE in range, a market cap of ${formatEther(mcap)} HYPE`);
  await write(ev, EV, "propose", [kntq, v4Key, parseEther("1000"), parseEther("20000")]);
  let early = false;
  await pub.simulateContract({ address: ev, abi: EV, functionName: "admit", args: [kntq], account: alice.account }).catch(() => (early = true));
  assert(early, "admission is refused before the delay");
  await warp(3 * 86_400);
  await sendAndLog(pub, "admit (anyone)", alice.wallet.writeContract({ address: ev, abi: EV, functionName: "admit", args: [kntq] }));
  assert(await pub.readContract({ address: ev, abi: EV, functionName: "isEcosystemToken", args: [kntq] }), "after the delay anyone admits KNTQ, the rules checked again");

  // the router over all three vaults, and the relay serving them
  const router = await deploy("CloakRouterV4", ourArtifact("CloakLaunchSwapV4.sol", "CloakRouterV4"), [lv, stack.pool, ev, D.poolManager, D.whype, D.v4Hook]);
  const block = await pub.getBlockNumber();
  const relay = createGloamRelay({ publicClient: pub, walletClient: keeper.wallet, vault: stack.pool, launchVault: lv, ecosystemVault: ev, memoBoard: stack.payMemo, escrows: [router], hourlySpendWei: parseEther("5") });
  let saved = [];
  const provers = { shield: await finalProver("shield"), transfer: await finalProver("transfer"), unshield: await finalProver("unshield") };
  const A = await GloamPrivate.unlock(alice.wallet, { publicClient: pub, chainId: ELYSIUM_TESTNET_ID, gloamVault: { pool: stack.pool, poolBlock: block }, launchVault: { pool: lv, poolBlock: block }, ecosystemVault: { pool: ev, poolBlock: block }, payMemo: stack.payMemo, provers, submit: (call) => relay({ kind: call.kind, to: call.to, data: call.data }), whype: D.whype, router, records: { load: () => saved, save: (x) => (saved = x) } });
  const markets = await A.loadMarkets();
  const m = markets.find((x) => x.token.toLowerCase() === kntq.toLowerCase());
  assert(m && m.ecoKey && m.symbol === "KNTQ", "the app lists KNTQ as a private market");
  const [gCore, lCore, eCore] = [stack.pool, lv, ev].map((v) => A.cores.find((c) => c.config.pool.toLowerCase() === v.toLowerCase()));
  const held = async (c, asset) => (await c.sync(), c.ownNotes(asset).reduce((a, n) => a + n.amount, 0n));

  await A.shieldHype(alice.wallet, parseEther("1"));
  assert((await held(gCore, zeroAddress)) === parseEther("1") && (await held(lCore, zeroAddress)) === 0n, "Alice's HYPE went into Gloam's vault");
  const quoted = await A.quote(kntq, "buy", parseEther("0.0995"));
  const t1 = performance.now();
  const buy = await A.buy(kntq, parseEther("0.1"));
  const got = await held(eCore, kntq);
  assert(got === buy.amountOut && got > 0n, `bought ${formatEther(got)} KNTQ (quoted ${formatEther(quoted)}) with 0.1 HYPE from Gloam's vault, into the ecosystem vault, ${Math.round(performance.now() - t1)} ms`);
  const gAfterBuy = await held(gCore, zeroAddress);
  assert(gAfterBuy > parseEther("0.9") && gAfterBuy < parseEther("0.9") + parseEther("0.001"), `and the buy's leftover came back into Gloam's vault (${formatEther(gAfterBuy)} HYPE there)`);
  const t2 = performance.now();
  const sell = await A.sell(kntq, got / 2n);
  assert((await held(gCore, zeroAddress)) === gAfterBuy + sell.amountOut, `sold half back: ${formatEther(sell.amountOut)} HYPE landed in Gloam's vault, ${Math.round(performance.now() - t2)} ms`);
  assert((await held(lCore, zeroAddress)) === 0n && (await held(lCore, kntq)) === 0n, "the launch vault was never touched");

  // a wallet's KNTQ shields straight into the ecosystem vault (the only vault that lists it)
  await write(kntq, tokenArt.abi, "transfer", [alice.account.address, parseEther("10")]);
  const e0 = await held(eCore, kntq);
  await A.shieldToken(alice.wallet, kntq, parseEther("10"));
  assert((await held(eCore, kntq)) - e0 === parseEther("10"), "10 KNTQ from a wallet shielded into the ecosystem vault");

  out.ecosystem = { kntqLiquidityHype: formatEther(liq), kntqMcapHype: formatEther(mcap), bought: formatEther(got), soldForHype: formatEther(sell.amountOut) };
  writeMeasurements("part20-ecosystem", { ...out, seconds: Math.round((performance.now() - t0) / 1000) });
  console.log(`\nPart 20 passed in ${Math.round((performance.now() - t0) / 1000)} s`);
} finally {
  anvil.stop();
}
process.exit(0);
