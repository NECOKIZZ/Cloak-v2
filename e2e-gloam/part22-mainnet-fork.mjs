// Part 22: the mainnet deploy, rehearsed on a fork of Elysium MAINNET (99901), with real proofs and real pools.
//   1. A stand-in for Gloam's mainnet vault (Gloam's guarded deploy, HYPE and real Elysium USDC listed), until theirs
//      exists.
//   2. Cloak v2's launch factory and hook on Uniswap's official v4 PoolManager, from the mainnet factory config
//      (explicit values, nothing copied from Cloak v1), ownership offered to the owner wallet, which accepts.
//   3. The real partner deploy script (deploy-partner.mjs) from the mainnet config: Cloak's own fixed WHYPE, the launch
//      vault, the ecosystem vault with the mainnet rules, the router and every escrow; it checks USDC's real HYPE pool
//      and real KNTQ against the rules.
//   4. The owner wallet proposes real KNTQ (the calldata the script prints), 3 days pass, anyone admits it: the rules
//      checked again on KNTQ's real 0.3% pool.
//   5. Private trades through the router on real Uniswap pools: HYPE to USDC, USDC to KNTQ (two pools), KNTQ to USDC,
//      USDC to HYPE.
//
//   NODE_USE_ENV_PROXY=1 node e2e-gloam/part22-mainnet-fork.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatEther, formatUnits, parseAbi, parseEther, zeroAddress } from "viem";
import { GloamPrivate } from "@cloakely/sdk";
import { createGloamRelay } from "../services/keeper/gloam.mjs";
import { deployV2Factory } from "./v2factory.mjs";
import { ANVIL_KEYS, REPO, assert, clients, deployGloamStack, deployPoseidon, finalProver, forkFund, rpc, sendAndLog, startAnvil, writeMeasurements } from "./lib.mjs";

const MAINNET = 99901;
const MAINNET_RPC = process.env.MAINNET_RPC ?? "https://rpc.elysium.kinetiq.xyz";
const USDC = "0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65";
const KNTQ = "0xe45a355d9e9cAd2aD85F2d03E3eE3102A036acF0";
const POOL_MANAGER = "0xe2e105d3f7209a9da11f83ccf3e7398a753823f1";
const t0 = performance.now();
const anvil = await startAnvil({ port: 8576, forkUrl: MAINNET_RPC, chainId: MAINNET });
const rpcUrl = anvil.rpcUrl;
const who = (i) => clients(rpcUrl, ANVIL_KEYS[i], MAINNET);
const [dep, alice, keeper, owner] = [who(0), who(1), who(8), who(5)];
const pub = dep.pub;
const tmp = mkdtempSync(join(tmpdir(), "cloak-mainnet-"));
const U = (x) => formatUnits(x, 6);
const out = {};

const EV = parseAbi([
  "function propose(address token, (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, uint128 perDeposit, uint128 total)",
  "function admit(address token)",
  "function isEcosystemToken(address) view returns (bool)",
  "function approver() view returns (address)",
]);
const CONFIG = parseAbi(["function acceptOwnership()", "function owner() view returns (address)"]);
const GUARD = parseAbi(["function acceptController()", "function controller() view returns (address)"]);

try {
  console.log("Part 22 on a fork of Elysium MAINNET: the mainnet deploy rehearsed, then private trades on real Uniswap pools");
  assert((await pub.getChainId()) === MAINNET, "the fork is chain 99901");
  const block = await pub.getBlockNumber();

  // 1. Gloam's vault stand-in, listing HYPE and the real USDC (mainnet's model)
  const poseidon = await deployPoseidon(dep);
  const gloam = await deployGloamStack({ rpcUrl, pk: ANVIL_KEYS[0], poseidon, assets: [{ address: USDC, perDeposit: 10_000n * 10n ** 6n, total: 1_000_000n * 10n ** 6n }, { address: zeroAddress, perDeposit: parseEther("100"), total: parseEther("10000") }], feeBps: 50, feeRecipient: dep.account.address, controller: dep.account.address, standinOnMainnetFork: true });

  // 2. the launch factory from the mainnet factory config (its example, with the owner and treasury filled in)
  const fx = JSON.parse(readFileSync(join(REPO, "deployments/elysium-mainnet-v2-factory.input.example.json"), "utf8"));
  const f = await deployV2Factory({ pub, wallet: dep.wallet, treasury: owner.account.address, owner: owner.account.address, poolManager: POOL_MANAGER, rules: fx, hookFees: fx.hook, vaultVerifier: gloam.dual });
  await sendAndLog(pub, "owner accepts the config", owner.wallet.writeContract({ address: f.config, abi: CONFIG, functionName: "acceptOwnership" }));
  assert((await pub.readContract({ address: f.config, abi: CONFIG, functionName: "owner" })).toLowerCase() === owner.account.address.toLowerCase(), "the launch factory deployed on Uniswap's official PoolManager, and the owner wallet owns its rules");

  // 3. the real partner deploy script, from the mainnet config with the stand-in's addresses filled in
  const mc = JSON.parse(readFileSync(join(REPO, "deployments/elysium-mainnet-gloam.input.example.json"), "utf8"));
  const cfg = { ...mc, name: "rehearsal-mainnet-fork", rpcUrl, gloamVault: gloam.pool, memoBoard: gloam.payMemo, poseidon, verifier: gloam.dual, shieldVerifier: gloam.shieldVerifier, factory: f.factory, v4Hook: f.hook, safe: owner.account.address, pauser: owner.account.address, feeRecipient: keeper.account.address };
  const cfgPath = join(tmp, "partner.json");
  const recPath = join(tmp, "record.json");
  writeFileSync(cfgPath, JSON.stringify(cfg));
  const t1 = performance.now();
  const log = execFileSync("node", [join(REPO, "e2e-gloam/deploy-partner.mjs"), "--config", cfgPath, "--out", recPath], { env: { ...process.env, DEPLOYER_PK: ANVIL_KEYS[0] }, encoding: "utf8", maxBuffer: 64 << 20 });
  const rec = JSON.parse(readFileSync(recPath, "utf8"));
  assert(rec.router && rec.ecosystemVault && rec.whype && rec.whype.toLowerCase() !== "0xba876237b0f021a6c6d852d6c26e107997cc5e81", `deploy-partner.mjs ran on the mainnet config in ${Math.round((performance.now() - t1) / 1000)} s: router, ecosystem vault and Cloak's own fixed WHYPE, for ${rec.costHype} HYPE`);
  assert(/USDC: HYPE pool 0\.3% \/ 60/.test(log) && rec.assets?.[0]?.pool?.fee === 3000, "it checked USDC's real HYPE pool and wrote it into the record");
  const kntqLine = log.split("\n").find((l) => l.includes("KNTQ:") && l.includes("market cap"));
  assert(kntqLine && kntqLine.includes("passes the rules"), `it checked real KNTQ against the mainnet rules (${kntqLine?.trim()})`);
  out.deploy = { factoryCostHype: undefined, partnerCostHype: rec.costHype, kntq: kntqLine?.trim() };

  // the owner wallet takes control of both guards (the call the script prints)
  for (const g of [rec.launchVaultGuard, rec.ecosystemVaultGuard]) await sendAndLog(pub, "owner accepts a guard", owner.wallet.writeContract({ address: g, abi: GUARD, functionName: "acceptController" }));
  for (const g of [rec.launchVaultGuard, rec.ecosystemVaultGuard]) assert((await pub.readContract({ address: g, abi: GUARD, functionName: "controller" })).toLowerCase() === owner.account.address.toLowerCase(), "the owner wallet controls a vault guard");

  // 4. KNTQ in: the owner proposes it with the script's calldata, 3 days pass, anyone admits it
  const proposeLine = log.split("\n").find((l) => l.includes("to propose KNTQ"));
  const data = proposeLine.match(/data (0x[0-9a-fA-F]+)/)[1];
  await sendAndLog(pub, "owner proposes KNTQ", owner.wallet.sendTransaction({ to: rec.ecosystemVault, data }));
  await rpc(rpcUrl, "evm_increaseTime", [3 * 86_400]);
  await rpc(rpcUrl, "evm_mine", []);
  await sendAndLog(pub, "admit KNTQ (anyone)", alice.wallet.writeContract({ address: rec.ecosystemVault, abi: EV, functionName: "admit", args: [KNTQ] }));
  assert(await pub.readContract({ address: rec.ecosystemVault, abi: EV, functionName: "isEcosystemToken", args: [KNTQ] }), "real KNTQ admitted after the delay, every rule checked again on its real pool");

  // 5. the app on this record: router, PoolManager, USDC with its pool (what scripts/sdk-entry.mjs prints)
  const relay = createGloamRelay({ publicClient: pub, walletClient: keeper.wallet, vault: rec.gloamVault, launchVault: rec.launchVault, ecosystemVault: rec.ecosystemVault, memoBoard: rec.memoBoard, escrows: [rec.router], hourlySpendWei: parseEther("5") });
  let saved = [];
  const provers = { shield: await finalProver("shield"), transfer: await finalProver("transfer"), unshield: await finalProver("unshield") };
  const startBlock = BigInt(rec.block) - 200n > block ? BigInt(rec.block) - 200n : block;
  const A = await GloamPrivate.unlock(alice.wallet, { publicClient: pub, chainId: MAINNET, gloamVault: { pool: rec.gloamVault, poolBlock: startBlock }, launchVault: { pool: rec.launchVault, poolBlock: startBlock }, ecosystemVault: { pool: rec.ecosystemVault, poolBlock: startBlock }, payMemo: rec.memoBoard, provers, submit: (call) => relay({ kind: call.kind, to: call.to, data: call.data }), whype: rec.whype, router: rec.router, poolManager: POOL_MANAGER, logChunk: 100_000n, records: { load: () => saved, save: (x) => (saved = x) } });
  await A.loadMarkets();
  for (const a of rec.assets) A.addAsset(a);
  assert(A.markets.some((m) => m.ecoKey && m.token.toLowerCase() === KNTQ.toLowerCase()) && A.market(USDC).hypeKey, "the app lists real USDC and real KNTQ as private markets");
  const gCore = A.cores.find((c) => c.config.pool.toLowerCase() === rec.gloamVault.toLowerCase());
  const eCore = A.cores.find((c) => c.config.pool.toLowerCase() === rec.ecosystemVault.toLowerCase());
  const held = async (c, asset) => (await c.sync(), c.ownNotes(asset).reduce((a, n) => a + n.amount, 0n));

  await A.shieldHype(alice.wallet, parseEther("2"));
  await forkFund(rpcUrl, USDC, POOL_MANAGER, alice.account.address, 500n * 10n ** 6n);
  await A.shieldToken(alice.wallet, USDC, 500n * 10n ** 6n);
  assert((await held(gCore, USDC)) === 500n * 10n ** 6n && (await held(gCore, zeroAddress)) === parseEther("2"), "500 real USDC and 2 HYPE shielded into the Gloam vault stand-in");

  let t = performance.now();
  const r1 = await A.trade(rec.whype, USDC, parseEther("1"));
  const u1 = await held(gCore, USDC);
  assert(u1 - 500n * 10n ** 6n === r1.amountOut && r1.amountOut > 60n * 10n ** 6n, `1 HYPE bought ${U(r1.amountOut)} USDC on the real 0.3% pool, ${Math.round(performance.now() - t)} ms`);
  t = performance.now();
  const r2 = await A.trade(USDC, KNTQ, 100n * 10n ** 6n);
  const k2 = await held(eCore, KNTQ);
  assert(k2 === r2.amountOut && k2 > parseEther("100"), `100 USDC bought ${formatEther(k2)} KNTQ through HYPE on two real pools, ${Math.round(performance.now() - t)} ms`);
  t = performance.now();
  const u2 = await held(gCore, USDC);
  const r3 = await A.trade(KNTQ, USDC, k2 / 2n);
  assert((await held(gCore, USDC)) === u2 + r3.amountOut, `half the KNTQ sold for ${U(r3.amountOut)} USDC, ${Math.round(performance.now() - t)} ms`);
  const h4 = await held(gCore, zeroAddress);
  const r4 = await A.trade(USDC, rec.whype, 50n * 10n ** 6n);
  assert((await held(gCore, zeroAddress)) === h4 + r4.amountOut, `50 USDC sold for ${formatEther(r4.amountOut)} HYPE`);

  out.trades = { hypeToUsdc: U(r1.amountOut), usdcToKntq: formatEther(k2), kntqToUsdc: U(r3.amountOut), usdcToHype: formatEther(r4.amountOut) };
  writeMeasurements("part22-mainnet-fork", { ...out, forkBlock: Number(block), seconds: Math.round((performance.now() - t0) / 1000) });
  console.log(`\nPart 22 passed in ${Math.round((performance.now() - t0) / 1000)} s`);
} finally {
  anvil.stop();
}
process.exit(0);
