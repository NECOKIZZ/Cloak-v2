// Deploys Cloak v2 next to an existing Gloam vault on any chain, from a config file. This is the mainnet path: Gloam
// deploys and owns the main vault, and Cloak deploys its launch vault and escrows around it.
//   - Checks first: the chain id, that every address in the config has code, and that the verifiers given are the
//     ones Gloam's own vault uses (so the launch vault proves on the same final keys).
//   - CloakLaunchVault on Cloak's v4 launch factory, on Gloam's verifiers and Poseidon. HYPE listed in setup, then setup
//     ends and ownership goes to its own VaultOwnerGuard (the deploy wallet is the controller only until it hands
//     control to the Safe), read back with 12 checks.
//   - Around it: CloakLaunchSwapV4, CloakRouterV4 (buys and sells between Gloam's vault and the launch vault),
//     CloakGloamBatcherV4, CloakGloamReceive, CloakGloamBids, CloakFundsGate and CloakReceiptCheck with their final-key
//     verifiers. CloakGraduation (into Gloam's vault) only with "graduation": true in the config.
//   - Every settled launch admitted and registered for batch rounds.
//   - The guard's control handed to the Safe: transferController(safe) now; the Safe then calls acceptController()
//     (the script prints the call). The pauser and the fee recipient are fixed to the config's addresses at deploy.
// Writes deployments/<name>.json (not on a rehearsal).
//
//   node e2e-gloam/deploy-partner.mjs --rehearse                 # a fork of Elysium testnet, Cloak's own instance of
//                                                                # Gloam's vault standing in for Gloam's, writes nothing
//   NODE_USE_ENV_PROXY=1 node e2e-gloam/deploy-partner.mjs --config deployments/elysium-mainnet-gloam.input.json
//
// The config (JSON): { name, chainId, rpcUrl, gloamVault, memoBoard, poseidon, verifier, shieldVerifier, factory,
//   poolManager, v4Hook, whype, safe, pauser, feeRecipient, hype: { perDeposit, total }, launchCaps: { perDeposit,
//   total }, graduationRoundSecs, batch: { roundSecs, maxSlippageBps, refundAfter }, assets: [{ symbol, token, decimals,
//   fee, tickSpacing }] (USDC and its plain HYPE pool), ecosystem: {...} }. Amounts are wei strings.
// Then `node scripts/sdk-entry.mjs deployments/<name>.json deployments/<factory>.json` prints the SDK's deployment entry.
// Key: DEPLOYER_PK, or GLOAM_TESTNET_PK from ../.env (a fresh key that holds nothing else). Never Cloak v1's keys.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeAbiParameters, encodeFunctionData, formatEther, keccak256, parseAbi, toHex, zeroAddress } from "viem";
import { createGloamLoop } from "../services/keeper/gloamLoop.mjs";
import { LV_ABI, checkLaunchVault } from "./stack.mjs";
import { ANVIL_KEYS, ELYSIUM_TESTNET_RPC, REPO, clients, gloamArtifact, ourArtifact, sendAndLog, startAnvil } from "./lib.mjs";

const REHEARSE = process.argv.includes("--rehearse");
const cfgPath = process.argv[process.argv.indexOf("--config") + 1];
// where the deployment record goes (default deployments/<name>.json): a rehearsal on a fork writes it elsewhere
const OUT = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : null;
const VAULT = parseAbi(["function verifier() view returns (address)", "function shieldVerifier() view returns (address)", "function poseidon2() view returns (address)", "function setupMode() view returns (bool)"]);
const GUARD = parseAbi(["function transferController(address)", "function controller() view returns (address)", "function pendingController() view returns (address)"]);

function envKey() {
  if (process.env.DEPLOYER_PK) return process.env.DEPLOYER_PK;
  const p = join(REPO, ".env");
  const m = existsSync(p) && readFileSync(p, "utf8").match(/^GLOAM_TESTNET_PK=(0x[0-9a-fA-F]{64})\s*$/m);
  return m ? m[1] : null;
}

/** The rehearsal: Cloak's testnet instance of Gloam's guarded vault stands in for Gloam's own. */
function rehearsalConfig() {
  const t = JSON.parse(readFileSync(join(REPO, "deployments/elysium-testnet-gloam.json"), "utf8"));
  return {
    name: "rehearsal",
    chainId: 99801,
    rpcUrl: process.env.RPC_URL ?? ELYSIUM_TESTNET_RPC,
    gloamVault: t.gloamVault,
    memoBoard: t.memoBoard,
    poseidon: t.poseidon,
    verifier: t.verifier,
    shieldVerifier: t.shieldVerifier,
    factory: t.launchFactory,
    poolManager: t.poolManager,
    v4Hook: t.v4Hook,
    whype: t.whype,
    safe: "0x000000000000000000000000000000000000cafe",
    pauser: "0x000000000000000000000000000000000000cafe",
    feeRecipient: "0x000000000000000000000000000000000000fee5",
    hype: { perDeposit: String(10n ** 19n), total: String(10n ** 21n) },
    launchCaps: { perDeposit: String(10n ** 27n), total: String(10n ** 29n) },
    graduationRoundSecs: 3600,
    batch: { roundSecs: 60, maxSlippageBps: 200, refundAfter: 600 },
    ecosystem: { minHypeLiquidity: String(250n * 10n ** 18n), minMcapHype: String(50_000n * 10n ** 18n), admitDelaySecs: 259200, maxPerDepositBps: 10, maxTotalBps: 100, tokens: [] },
  };
}

const cfg = REHEARSE ? rehearsalConfig() : JSON.parse(readFileSync(cfgPath, "utf8"));
// our vaults' withdrawal fee in bps (a swap out of them is a withdrawal): "withdrawFeeBps" in the config, 50 (0.5%) if unset
const FEE_BPS = Number(cfg.withdrawFeeBps ?? 50);
if (!Number.isInteger(FEE_BPS) || FEE_BPS < 0 || FEE_BPS > 100) throw new Error("config: withdrawFeeBps must be 0 to 100 (at most 1%)");
// "whype": "deploy" deploys Cloak's own fixed WHYPE (CloakWHYPE): Elysium's 0xbA87…5E81 is an upgradeable proxy
const DEPLOY_WHYPE = cfg.whype === "deploy";
for (const k of ["gloamVault", "memoBoard", "poseidon", "verifier", "shieldVerifier", "factory", "poolManager", "v4Hook", ...(DEPLOY_WHYPE ? [] : ["whype"]), "safe", "pauser", "feeRecipient"]) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(cfg[k] ?? "")) throw new Error(`config: ${k} must be an address`);
}
let anvil;
let rpcUrl = cfg.rpcUrl;
let pk = envKey();
if (REHEARSE) {
  anvil = await startAnvil({ port: 8571, forkUrl: rpcUrl });
  rpcUrl = anvil.rpcUrl;
  pk = ANVIL_KEYS[0];
}
if (!pk) throw new Error("set DEPLOYER_PK (or GLOAM_TESTNET_PK in .env): a fresh key that holds nothing else");
const me = clients(rpcUrl, pk, cfg.chainId);
const pub = me.pub;
const addr = me.account.address;
const write = (address, abi, functionName, args = []) => sendAndLog(pub, functionName, me.wallet.writeContract({ address, abi, functionName, args }));
const deploy = async (label, art, args = []) => (await sendAndLog(pub, `deploy ${label}`, me.wallet.deployContract({ ...art, args }))).contractAddress;
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/** A plain v4 pool's price and in-range liquidity, read from the PoolManager's storage (pools: slot 6). */
async function plainPool(pub, poolManager, key) {
  const EXT = parseAbi(["function extsload(bytes32) view returns (bytes32)"]);
  const id = keccak256(encodeAbiParameters([{ type: "tuple", components: [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }] }], [[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]]));
  const slot = BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [id, 6n])));
  const [s0, l] = await Promise.all([0n, 3n].map((o) => pub.readContract({ address: poolManager, abi: EXT, functionName: "extsload", args: [toHex(slot + o, { size: 32 })] })));
  return { sqrtPriceX96: BigInt(s0) & ((1n << 160n) - 1n), liquidity: BigInt(l) & ((1n << 128n) - 1n) };
}
try {
  // checks before anything is sent
  if ((await pub.getChainId()) !== cfg.chainId) throw new Error(`the RPC is chain ${await pub.getChainId()}, the config says ${cfg.chainId}`);
  for (const k of ["gloamVault", "memoBoard", "poseidon", "verifier", "shieldVerifier", "factory", "poolManager", "v4Hook", ...(DEPLOY_WHYPE ? [] : ["whype"])]) {
    if (((await pub.getCode({ address: cfg[k] })) ?? "0x") === "0x") throw new Error(`config: ${k} (${cfg[k]}) has no code on this chain`);
  }
  const [gv, gsv, gp, gSetup] = await Promise.all(["verifier", "shieldVerifier", "poseidon2", "setupMode"].map((f) => pub.readContract({ address: cfg.gloamVault, abi: VAULT, functionName: f })));
  if (!same(gv, cfg.verifier) || !same(gsv, cfg.shieldVerifier)) throw new Error("the verifiers in the config aren't the ones Gloam's vault uses");
  if (!same(gp, cfg.poseidon)) throw new Error("the Poseidon in the config isn't the one Gloam's vault uses");
  if (gSetup) throw new Error("Gloam's vault is still in setup: wait until it's live");
  console.log(`Gloam's vault ${cfg.gloamVault} checked: live, on verifiers ${gv} / ${gsv}`);
  // USDC and the other assets in Gloam's vault: each one's plain native-HYPE pool (no hook), which the router trades
  // it through against HYPE and, through HYPE, against every launch and outside token
  const assets = [];
  for (const a of cfg.assets ?? []) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(a.token)) throw new Error(`asset ${a.symbol}: not an address (${a.token})`);
    const { sqrtPriceX96, liquidity } = await plainPool(pub, cfg.poolManager, { currency0: zeroAddress, currency1: a.token, fee: a.fee, tickSpacing: a.tickSpacing, hooks: zeroAddress });
    if (sqrtPriceX96 === 0n || liquidity === 0n) throw new Error(`asset ${a.symbol}: no plain HYPE pool at ${a.fee} / ${a.tickSpacing} on this chain`);
    const hypeIn = (liquidity << 96n) / sqrtPriceX96;
    const perHype = Number((sqrtPriceX96 * sqrtPriceX96 * 10n ** 6n) >> 192n) / 1e6 / 10 ** (18 - a.decimals);
    console.log(`  ${a.symbol}: HYPE pool ${a.fee / 10_000}% / ${a.tickSpacing}, ${formatEther(hypeIn)} HYPE in range, ${perHype.toFixed(4)} ${a.symbol} per HYPE`);
    assets.push({ symbol: a.symbol, token: a.token, decimals: a.decimals, pool: { fee: a.fee, tickSpacing: a.tickSpacing } });
  }

  const start = await pub.getBalance({ address: addr });
  console.log(`Deploying Cloak v2 next to it on chain ${cfg.chainId}${REHEARSE ? " (a fork)" : ""} from ${addr} (${formatEther(start)} HYPE)`);
  const caps = [BigInt(cfg.launchCaps.perDeposit), BigInt(cfg.launchCaps.total)];
  const lv = await deploy("CloakLaunchVault", ourArtifact("CloakLaunchVault.sol", "CloakLaunchVault"), [cfg.poseidon, cfg.verifier, cfg.factory, ...caps, cfg.pauser]);
  await write(lv, LV_ABI, "setShieldVerifier", [cfg.shieldVerifier]);
  await write(lv, LV_ABI, "setWithdrawFee", [FEE_BPS, cfg.feeRecipient]);
  await write(lv, LV_ABI, "turnOnDepositLimits");
  // HYPE lives in Gloam's vault: the launch vault takes it only if the config gives it caps ("hype")
  if (cfg.hype) await write(lv, LV_ABI, "setDepositLimit", [zeroAddress, BigInt(cfg.hype.perDeposit), BigInt(cfg.hype.total)]);
  await write(lv, LV_ABI, "endSetup");
  const guardArt = gloamArtifact("VaultOwnerGuard.sol", "VaultOwnerGuard");
  const guard = await deploy("VaultOwnerGuard (launch vault)", guardArt, [lv, addr]);
  await write(lv, LV_ABI, "transferOwnership", [guard]);
  await write(guard, guardArt.abi, "acceptVaultOwnership");
  const checks = await checkLaunchVault(pub, lv, { guard, dual: cfg.verifier, shieldVerifier: cfg.shieldVerifier, factory: cfg.factory, feeRecipient: cfg.feeRecipient, pauser: cfg.pauser, caps, feeBps: FEE_BPS });
  console.log(`  launch vault read back: ${checks} checks passed`);

  // the ecosystem vault: outside tokens (KNTQ first), admitted only by the Safe's proposal under the preset rules
  const eco = cfg.ecosystem;
  let ev, evGuard;
  if (eco) {
    const rules = { minHypeLiquidity: BigInt(eco.minHypeLiquidity), minMcapHype: BigInt(eco.minMcapHype), admitDelay: BigInt(eco.admitDelaySecs), maxPerDepositBps: eco.maxPerDepositBps, maxTotalBps: eco.maxTotalBps };
    ev = await deploy("CloakEcosystemVault", ourArtifact("CloakEcosystemVault.sol", "CloakEcosystemVault"), [cfg.poseidon, cfg.verifier, cfg.poolManager, lv, cfg.safe, cfg.pauser, rules]);
    await write(ev, LV_ABI, "setShieldVerifier", [cfg.shieldVerifier]);
    await write(ev, LV_ABI, "setWithdrawFee", [FEE_BPS, cfg.feeRecipient]);
    await write(ev, LV_ABI, "turnOnDepositLimits");
    await write(ev, LV_ABI, "endSetup");
    evGuard = await deploy("VaultOwnerGuard (ecosystem vault)", guardArt, [ev, addr]);
    await write(ev, LV_ABI, "transferOwnership", [evGuard]);
    await write(evGuard, guardArt.abi, "acceptVaultOwnership");
    const EV = parseAbi([
      "function approver() view returns (address)",
      "function minHypeLiquidity() view returns (uint256)",
      "function minMcapHype() view returns (uint256)",
      "function setupMode() view returns (bool)",
      "function owner() view returns (address)",
      "function marketOf(address token, (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key) view returns (uint256 hypeLiquidity, uint256 mcapHype)",
      "function propose(address token, (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, uint128 perDeposit, uint128 total)",
    ]);
    const [ap, ml, mm, setup, own] = await Promise.all(["approver", "minHypeLiquidity", "minMcapHype", "setupMode", "owner"].map((f) => pub.readContract({ address: ev, abi: EV, functionName: f })));
    if (!same(ap, cfg.safe) || ml !== rules.minHypeLiquidity || mm !== rules.minMcapHype || setup || !same(own, evGuard)) throw new Error("the ecosystem vault didn't read back as configured");
    console.log(`  ecosystem vault ${ev}: approver the Safe, min ${formatEther(ml)} HYPE in range, min market cap ${formatEther(mm)} HYPE, ${eco.admitDelaySecs} s delay`);
    // the first tokens: checked against the rules now, proposed by the Safe (only it can), admitted by anyone after the delay
    const ERC20 = parseAbi(["function totalSupply() view returns (uint256)", "function symbol() view returns (string)"]);
    for (const t of eco.tokens ?? []) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(t.token)) throw new Error(`ecosystem token ${t.symbol}: not an address (${t.token})`);
      if (((await pub.getCode({ address: t.token })) ?? "0x") === "0x") {
        console.log(`  ${t.symbol} (${t.token}) has no code on this chain: not proposed. Check its Elysium address.`);
        continue;
      }
      const supply = await pub.readContract({ address: t.token, abi: ERC20, functionName: "totalSupply" });
      const key = { currency0: zeroAddress, currency1: t.token, fee: t.fee, tickSpacing: t.tickSpacing, hooks: zeroAddress };
      const per = (supply * BigInt(t.perDepositBps)) / 10_000n;
      const total = (supply * BigInt(t.totalBps)) / 10_000n;
      const [liq, mcap] = await pub.readContract({ address: ev, abi: EV, functionName: "marketOf", args: [t.token, key] });
      const ok = liq >= ml && mcap >= mm;
      console.log(`  ${t.symbol}: ${formatEther(liq)} HYPE in range, market cap ${formatEther(mcap)} HYPE: ${ok ? "passes the rules" : "does NOT pass the rules yet"}`);
      const data = encodeFunctionData({ abi: EV, functionName: "propose", args: [t.token, key, per, total] });
      console.log(`  From the Safe, to propose ${t.symbol}: a call to ${ev}, value 0, data ${data}`);
      console.log(`  Then after the delay anyone calls admit(${t.token}) on ${ev}.`);
    }
  }

  const b = cfg.batch;
  if (DEPLOY_WHYPE) cfg.whype = await deploy("CloakWHYPE", ourArtifact("CloakWHYPE.sol", "CloakWHYPE"));
  const launchSwapV4 = await deploy("CloakLaunchSwapV4", ourArtifact("CloakLaunchSwapV4.sol", "CloakLaunchSwapV4"), [lv, cfg.poolManager, cfg.whype, cfg.v4Hook]);
  // buys and sells between HYPE in Gloam's vault and launch tokens in the launch vault (one private call either way)
  const router = await deploy("CloakRouterV4", ourArtifact("CloakLaunchSwapV4.sol", "CloakRouterV4"), [lv, cfg.gloamVault, ev ?? zeroAddress, cfg.poolManager, cfg.whype, cfg.v4Hook]);
  const batcherV4 = await deploy("CloakGloamBatcherV4", ourArtifact("CloakGloamBatcherV4.sol", "CloakGloamBatcherV4"), [lv, cfg.gloamVault, cfg.factory, BigInt(b.roundSecs), BigInt(b.maxSlippageBps), BigInt(b.refundAfter)]);
  const receive = await deploy("CloakGloamReceive", ourArtifact("CloakGloamReceive.sol", "CloakGloamReceive"), [cfg.gloamVault, lv]);
  const bids = await deploy("CloakGloamBids", ourArtifact("CloakGloamBids.sol", "CloakGloamBids"), [lv, cfg.gloamVault]);
  // graduation into Gloam's vault is off unless asked for: launch tokens live in the launch vault (one home per asset)
  const graduation = cfg.graduation ? await deploy("CloakGraduation", ourArtifact("CloakGraduation.sol", "CloakGraduation"), [lv, cfg.gloamVault, BigInt(cfg.graduationRoundSecs)]) : undefined;
  const fv = await deploy("GloamFundsVerifierFinal", ourArtifact("GloamFundsVerifierFinal.sol", "GloamFundsVerifierFinal"));
  const rv = await deploy("GloamReceiptVerifierFinal", ourArtifact("GloamReceiptVerifierFinal.sol", "GloamReceiptVerifierFinal"));
  const fundsGate = await deploy("CloakFundsGate", ourArtifact("CloakFundsGate.sol", "CloakFundsGate"), [fv, cfg.gloamVault, lv]);
  const receiptCheck = await deploy("CloakReceiptCheck", ourArtifact("CloakReceiptCheck.sol", "CloakReceiptCheck"), [rv, cfg.gloamVault, lv]);
  const block = await pub.getBlockNumber();

  // every settled launch admitted and registered for batch rounds (the keeper loop does it from here on)
  const loop = createGloamLoop({ publicClient: pub, account: me.account, send: async (x) => (await sendAndLog(pub, x.functionName, me.wallet.writeContract(x))).transactionHash, launchVault: lv, batcherV4, batcherV4Block: block });
  const t = await loop.tick();
  if (t.errors.length) throw new Error(`the first keeper tick failed: ${t.errors.join("; ")}`);
  console.log(`  admitted ${t.admitted.length} settled launches, registered ${t.registered.length} for batch rounds`);

  // control to the Safe: the deploy wallet keeps nothing
  await write(guard, GUARD, "transferController", [cfg.safe]);
  if (evGuard) {
    await write(evGuard, GUARD, "transferController", [cfg.safe]);
    console.log(`  ecosystem vault guard control offered to the Safe too: from the Safe, a call to ${evGuard}, value 0, data 0x9bc21c0c`);
  }
  const pending = await pub.readContract({ address: guard, abi: GUARD, functionName: "pendingController" }).catch(() => null);
  if (pending !== null && !same(pending, cfg.safe)) throw new Error("the guard's pending controller isn't the Safe");
  console.log(`  guard control offered to the Safe ${cfg.safe}. From the Safe: a call to ${guard}, value 0, data 0x9bc21c0c (acceptController())`);

  const end = await pub.getBalance({ address: addr });
  const rec = {
    chainId: cfg.chainId,
    note: "Cloak v2 next to Gloam's vault: Cloak's launch vault under its own VaultOwnerGuard (controller: the Safe, once it accepts) and Cloak's escrows. Gloam's vault, memo board and verifiers are Gloam's.",
    block: Number(block),
    gloamVault: cfg.gloamVault,
    memoBoard: cfg.memoBoard,
    poseidon: cfg.poseidon,
    verifier: cfg.verifier,
    shieldVerifier: cfg.shieldVerifier,
    launchVault: lv,
    launchVaultGuard: guard,
    guardController: { now: addr, pending: cfg.safe },
    pauser: cfg.pauser,
    feeRecipient: cfg.feeRecipient,
    launchFactory: cfg.factory,
    launchSwapV4,
    router,
    assets,
    ecosystemVault: ev,
    ecosystemVaultGuard: evGuard,
    ecosystemRules: eco ? { minHypeLiquidity: eco.minHypeLiquidity, minMcapHype: eco.minMcapHype, admitDelaySecs: eco.admitDelaySecs, maxPerDepositBps: eco.maxPerDepositBps, maxTotalBps: eco.maxTotalBps } : undefined,
    batcherV4,
    batcherV4Rounds: b,
    receive,
    bids,
    graduation,
    fundsGate,
    receiptCheck,
    fundsVerifier: fv,
    receiptVerifier: rv,
    whype: cfg.whype,
    poolManager: cfg.poolManager,
    v4Hook: cfg.v4Hook,
    admittedAtDeploy: t.admitted.length,
    costHype: formatEther(start - end),
  };
  console.log(JSON.stringify(rec, null, 1));
  if (!REHEARSE || OUT) writeFileSync(OUT ?? join(REPO, `deployments/${cfg.name}.json`), JSON.stringify(rec, null, 2) + "\n");
  console.log(`\ndeployed for ${formatEther(start - end)} HYPE${REHEARSE ? " (rehearsal on a fork, nothing written)" : ""}`);
} finally {
  anvil?.stop();
}
process.exit(0);
