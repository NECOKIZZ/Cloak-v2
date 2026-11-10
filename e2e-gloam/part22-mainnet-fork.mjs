// Part 22: the mainnet deploy, rehearsed on a fork of Elysium MAINNET (99901) against GLOAM'S REAL VAULT, with real
// proofs on the final keys and real pools.
//   1. Gloam's real Elysium vault (0x89d3...2164). On the fork we act as Gloam's controller to open HYPE (12 per
//      deposit, 600 in total) and KNTQ (1,400 / 70,000) through the vault's own 3-day timelock, as Gloam has announced
//      for Thursday Nov 12. USDC is live already (500 / 25,000). Gloam's memo board isn't on Elysium yet, so we deploy
//      Gloam's own GloamPayMemo code here as a stand-in.
//   2. Cloak v2's launch factory and hook on Uniswap's official v4 PoolManager, from the mainnet factory config
//      (explicit values, nothing copied from Cloak v1), ownership offered to the owner wallet, which accepts.
//   3. The real partner deploy script (deploy-partner.mjs) from the mainnet config with Gloam's real addresses: it
//      checks our vaults prove on Gloam's real verifiers and Poseidon, deploys Cloak's own fixed WHYPE, the launch vault,
//      the ecosystem vault (empty: KNTQ lives in Gloam's vault), CloakTradeFee, the router and every escrow, and checks
//      USDC's and KNTQ's real HYPE pools.
//   4. Private trades through the router on real Uniswap pools, every asset in Gloam's real vault: HYPE to USDC,
//      USDC to KNTQ (two pools), KNTQ to USDC, USDC to HYPE. No Cloak trade fee on these (none leaves Cloak's vaults).
//
//   NODE_USE_ENV_PROXY=1 node e2e-gloam/part22-mainnet-fork.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFunctionData, formatEther, formatUnits, parseAbi, parseEther, zeroAddress } from "viem";
import { GloamPrivate } from "@cloakely/sdk";
import { createGloamRelay } from "../services/keeper/gloam.mjs";
import { deployV2Factory } from "./v2factory.mjs";
import { ANVIL_KEYS, GLOAM_CONTRACTS, REPO, assert, clients, finalProver, forgeGloam, forkFund, rpc, sendAndLog, startAnvil, writeMeasurements } from "./lib.mjs";

const MAINNET = 99901;
const MAINNET_RPC = process.env.MAINNET_RPC ?? "https://rpc.elysium.kinetiq.xyz";
const USDC = "0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65";
const KNTQ = "0xe45a355d9e9cAd2aD85F2d03E3eE3102A036acF0";
const POOL_MANAGER = "0xe2e105d3f7209a9da11f83ccf3e7398a753823f1";
// Gloam's Elysium mainnet vault (Gloam, Nov 10)
const G = {
  vault: "0x89d3042390204f57b8b4F8949D3c2203E4002164",
  block: 3248495n,
  guard: "0x268D7CAd645282D1e77461b5B2dd997bd54eFAf5",
  verifier: "0x29053A713E3a7D37053374446869a6f55858FcEf",
  shieldVerifier: "0xAEB8cb99B3BB43eB230F9fEB7293fB5E39080016",
  poseidon: "0x62c435CE6886fa91e3b0e91500c6dC9219723457",
};
const VAULT = parseAbi(["function setDepositLimit(address asset, uint128 perDeposit, uint128 total)", "function depositLimit(address) view returns (uint128, uint128)"]);
const GGUARD = parseAbi(["function controller() view returns (address)", "function queueChange(bytes call) returns (bytes32, uint256)", "function executeChange(bytes call)"]);
const t0 = performance.now();
const anvil = await startAnvil({ port: 8576, forkUrl: MAINNET_RPC, chainId: MAINNET });
const TREASURY = "0x000000000000000000000000000000000000c7ea";
const ERC20B = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const rpcUrl = anvil.rpcUrl;
const who = (i) => clients(rpcUrl, ANVIL_KEYS[i], MAINNET);
const [dep, alice, keeper, owner] = [who(0), who(1), who(8), who(5)];
const pub = dep.pub;
const tmp = mkdtempSync(join(tmpdir(), "cloak-mainnet-"));
const U = (x) => formatUnits(x, 6);
const out = {};

const EV = parseAbi([
  "function list(address token, (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, uint128 perDeposit, uint128 total, address launchpad)",
  "function isEcosystemToken(address) view returns (bool)",
  "function approver() view returns (address)",
]);
const CONFIG = parseAbi(["function acceptOwnership()", "function owner() view returns (address)"]);
const GUARD = parseAbi(["function acceptController()", "function controller() view returns (address)"]);

try {
  console.log("Part 22 on a fork of Elysium MAINNET: the mainnet deploy rehearsed, then private trades on real Uniswap pools");
  assert((await pub.getChainId()) === MAINNET, "the fork is chain 99901");
  const block = await pub.getBlockNumber();

  // 1. Gloam's real vault: HYPE and KNTQ opened as Gloam announced, through its own timelock, acting as its controller
  const ctl = await pub.readContract({ address: G.guard, abi: GGUARD, functionName: "controller" });
  await rpc(rpcUrl, "anvil_impersonateAccount", [ctl]);
  await rpc(rpcUrl, "anvil_setBalance", [ctl, "0x56BC75E2D63100000"]);
  const asGloam = (functionName, args) => sendAndLog(pub, `Gloam's controller: ${functionName}`, dep.wallet.writeContract({ account: ctl, address: G.guard, abi: GGUARD, functionName, args, chain: null }));
  const limits = [[zeroAddress, parseEther("12"), parseEther("600")], [KNTQ, parseEther("1400"), parseEther("70000")]];
  const calls = limits.map((l) => encodeFunctionData({ abi: VAULT, functionName: "setDepositLimit", args: l }));
  for (const c of calls) await asGloam("queueChange", [c]).catch(() => console.log("  (already queued by Gloam)"));
  await rpc(rpcUrl, "evm_increaseTime", [3 * 86_400 + 60]);
  await rpc(rpcUrl, "evm_mine", []);
  for (const c of calls) await asGloam("executeChange", [c]);
  await rpc(rpcUrl, "anvil_stopImpersonatingAccount", [ctl]);
  const [hl, kl, ul] = await Promise.all([zeroAddress, KNTQ, USDC].map((a) => pub.readContract({ address: G.vault, abi: VAULT, functionName: "depositLimit", args: [a] })));
  assert(hl[0] === parseEther("12") && kl[1] === parseEther("70000") && ul[0] === 500n * 10n ** 6n, `Gloam's real vault, as from Thursday: HYPE ${formatEther(hl[0])} / ${formatEther(hl[1])}, KNTQ ${formatEther(kl[0])} / ${formatEther(kl[1])}, USDC ${U(ul[0])} / ${U(ul[1])}`);
  // Gloam's memo board isn't on Elysium yet: Gloam's own GloamPayMemo code, deployed here as a stand-in
  const memoOut = forgeGloam(join(GLOAM_CONTRACTS, "script/DeployGloamPayMemo.s.sol"), "DeployGloamPayMemo", rpcUrl, { DEPLOYER_PK: ANVIL_KEYS[0] });
  const memoBoard = (memoOut.match(/(0x[0-9a-fA-F]{40})/g) ?? []).pop();

  // 2. the launch factory from the mainnet factory config (its example, with the owner and treasury filled in)
  const fx = JSON.parse(readFileSync(join(REPO, "deployments/elysium-mainnet-v2-factory.input.example.json"), "utf8"));
  const f = await deployV2Factory({ pub, wallet: dep.wallet, treasury: owner.account.address, owner: owner.account.address, poolManager: POOL_MANAGER, rules: fx, hookFees: fx.hook, vaultVerifier: G.verifier });
  await sendAndLog(pub, "owner accepts the config", owner.wallet.writeContract({ address: f.config, abi: CONFIG, functionName: "acceptOwnership" }));
  assert((await pub.readContract({ address: f.config, abi: CONFIG, functionName: "owner" })).toLowerCase() === owner.account.address.toLowerCase(), "the launch factory deployed on Uniswap's official PoolManager, and the owner wallet owns its rules");

  // 3. the real partner deploy script, from the mainnet config: Gloam's real addresses as given, ours filled in
  const mc = JSON.parse(readFileSync(join(REPO, "deployments/elysium-mainnet-gloam.input.example.json"), "utf8"));
  const cfg = { ...mc, name: "rehearsal-mainnet-fork", rpcUrl, memoBoard, factory: f.factory, v4Hook: f.hook, safe: owner.account.address, pauser: owner.account.address, feeRecipient: TREASURY, tradeFee: { bps: 50, treasury: TREASURY } };
  const cfgPath = join(tmp, "partner.json");
  const recPath = join(tmp, "record.json");
  writeFileSync(cfgPath, JSON.stringify(cfg));
  const t1 = performance.now();
  const log = execFileSync("node", [join(REPO, "e2e-gloam/deploy-partner.mjs"), "--config", cfgPath, "--out", recPath], { env: { ...process.env, DEPLOYER_PK: ANVIL_KEYS[0] }, encoding: "utf8", maxBuffer: 64 << 20 });
  const rec = JSON.parse(readFileSync(recPath, "utf8"));
  assert(rec.router && rec.ecosystemVault && rec.whype && rec.whype.toLowerCase() !== "0xba876237b0f021a6c6d852d6c26e107997cc5e81", `deploy-partner.mjs ran on the mainnet config in ${Math.round((performance.now() - t1) / 1000)} s: router, ecosystem vault and Cloak's own fixed WHYPE, for ${rec.costHype} HYPE`);
  assert(/USDC: HYPE pool 0\.3% \/ 60/.test(log) && rec.assets?.[0]?.pool?.fee === 3000, "it checked USDC's real HYPE pool and wrote it into the record");
  assert(rec.gloamVault.toLowerCase() === G.vault.toLowerCase(), "on Gloam's real vault: the script checked our vaults prove on its real verifiers and Poseidon");
  const kntqLine = log.split("\n").find((l) => l.includes("KNTQ: HYPE pool"));
  assert(kntqLine && rec.assets.some((x) => x.symbol === "KNTQ"), `it checked KNTQ's real HYPE pool, an asset in Gloam's vault (${kntqLine?.trim()})`);
  out.deploy = { partnerCostHype: rec.costHype, kntq: kntqLine?.trim() };

  // the owner wallet takes control of both guards (the call the script prints)
  for (const g of [rec.launchVaultGuard, rec.ecosystemVaultGuard]) await sendAndLog(pub, "owner accepts a guard", owner.wallet.writeContract({ address: g, abi: GUARD, functionName: "acceptController" }));
  for (const g of [rec.launchVaultGuard, rec.ecosystemVaultGuard]) assert((await pub.readContract({ address: g, abi: GUARD, functionName: "controller" })).toLowerCase() === owner.account.address.toLowerCase(), "the owner wallet controls a vault guard");

  // 4. the app on this record: router, PoolManager, USDC and KNTQ with their pools (what scripts/sdk-entry.mjs prints)
  const relay = createGloamRelay({ publicClient: pub, walletClient: keeper.wallet, vault: rec.gloamVault, launchVault: rec.launchVault, ecosystemVault: rec.ecosystemVault, memoBoard: rec.memoBoard, escrows: [rec.router], hourlySpendWei: parseEther("5") });
  let saved = [];
  const provers = { shield: await finalProver("shield"), transfer: await finalProver("transfer"), unshield: await finalProver("unshield") };
  const startBlock = BigInt(rec.block) - 200n > block ? BigInt(rec.block) - 200n : block;
  const A = await GloamPrivate.unlock(alice.wallet, { publicClient: pub, chainId: MAINNET, gloamVault: { pool: rec.gloamVault, poolBlock: G.block }, launchVault: { pool: rec.launchVault, poolBlock: startBlock }, ecosystemVault: { pool: rec.ecosystemVault, poolBlock: startBlock }, payMemo: rec.memoBoard, provers, submit: (call) => relay({ kind: call.kind, to: call.to, data: call.data }), whype: rec.whype, router: rec.router, poolManager: POOL_MANAGER, logChunk: 100_000n, records: { load: () => saved, save: (x) => (saved = x) } });
  await A.loadMarkets();
  for (const a of rec.assets) A.addAsset(a);
  assert(A.market(KNTQ).hypeKey && A.market(USDC).hypeKey, "the app lists real USDC and real KNTQ as private markets in Gloam's vault");
  const gCore = A.cores.find((c) => c.config.pool.toLowerCase() === rec.gloamVault.toLowerCase());
  const held = async (c, asset) => (await c.sync(), c.ownNotes(asset).reduce((a, n) => a + n.amount, 0n));

  await A.shieldHype(alice.wallet, parseEther("2"));
  await forkFund(rpcUrl, USDC, POOL_MANAGER, alice.account.address, 500n * 10n ** 6n);
  await A.shieldToken(alice.wallet, USDC, 500n * 10n ** 6n);
  assert((await held(gCore, USDC)) === 500n * 10n ** 6n && (await held(gCore, zeroAddress)) === parseEther("2"), "500 real USDC and 2 HYPE shielded into Gloam's real vault, within its limits");

  let t = performance.now();
  const r1 = await A.trade(rec.whype, USDC, parseEther("1"));
  const u1 = await held(gCore, USDC);
  assert(u1 - 500n * 10n ** 6n === r1.amountOut && r1.amountOut > 60n * 10n ** 6n, `1 HYPE bought ${U(r1.amountOut)} USDC on the real 0.3% pool, ${Math.round(performance.now() - t)} ms`);
  t = performance.now();
  const r2 = await A.trade(USDC, KNTQ, 100n * 10n ** 6n);
  const k2 = await held(gCore, KNTQ);
  assert(k2 === r2.amountOut && k2 > parseEther("100"), `100 USDC bought ${formatEther(k2)} KNTQ through HYPE on two real pools, into Gloam's vault, ${Math.round(performance.now() - t)} ms`);
  t = performance.now();
  const u2 = await held(gCore, USDC);
  const r3 = await A.trade(KNTQ, USDC, k2 / 2n);
  assert((await held(gCore, USDC)) === u2 + r3.amountOut, `half the KNTQ sold for ${U(r3.amountOut)} USDC, ${Math.round(performance.now() - t)} ms`);
  const feeUsdc = await pub.readContract({ address: USDC, abi: ERC20B, functionName: "balanceOf", args: [TREASURY] });
  assert(feeUsdc === 0n, "no Cloak trade fee: KNTQ and USDC both live in Gloam's vault (Gloam's fee, shared with Cloak, applies instead)");
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
