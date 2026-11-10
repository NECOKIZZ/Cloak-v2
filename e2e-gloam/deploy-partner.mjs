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
//   total }, graduationRoundSecs, batch: { roundSecs, maxSlippageBps, refundAfter } }. Amounts are wei strings.
// Key: DEPLOYER_PK, or GLOAM_TESTNET_PK from ../.env (a fresh key that holds nothing else). Never Cloak v1's keys.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatEther, parseAbi, zeroAddress } from "viem";
import { createGloamLoop } from "../services/keeper/gloamLoop.mjs";
import { LV_ABI, checkLaunchVault } from "./stack.mjs";
import { ANVIL_KEYS, ELYSIUM_TESTNET_RPC, REPO, clients, gloamArtifact, ourArtifact, sendAndLog, startAnvil } from "./lib.mjs";

const REHEARSE = process.argv.includes("--rehearse");
const cfgPath = process.argv[process.argv.indexOf("--config") + 1];
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
  };
}

const cfg = REHEARSE ? rehearsalConfig() : JSON.parse(readFileSync(cfgPath, "utf8"));
for (const k of ["gloamVault", "memoBoard", "poseidon", "verifier", "shieldVerifier", "factory", "poolManager", "v4Hook", "whype", "safe", "pauser", "feeRecipient"]) {
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
try {
  // checks before anything is sent
  if ((await pub.getChainId()) !== cfg.chainId) throw new Error(`the RPC is chain ${await pub.getChainId()}, the config says ${cfg.chainId}`);
  for (const k of ["gloamVault", "memoBoard", "poseidon", "verifier", "shieldVerifier", "factory", "poolManager", "v4Hook", "whype"]) {
    if (((await pub.getCode({ address: cfg[k] })) ?? "0x") === "0x") throw new Error(`config: ${k} (${cfg[k]}) has no code on this chain`);
  }
  const [gv, gsv, gp, gSetup] = await Promise.all(["verifier", "shieldVerifier", "poseidon2", "setupMode"].map((f) => pub.readContract({ address: cfg.gloamVault, abi: VAULT, functionName: f })));
  if (!same(gv, cfg.verifier) || !same(gsv, cfg.shieldVerifier)) throw new Error("the verifiers in the config aren't the ones Gloam's vault uses");
  if (!same(gp, cfg.poseidon)) throw new Error("the Poseidon in the config isn't the one Gloam's vault uses");
  if (gSetup) throw new Error("Gloam's vault is still in setup: wait until it's live");
  console.log(`Gloam's vault ${cfg.gloamVault} checked: live, on verifiers ${gv} / ${gsv}`);

  const start = await pub.getBalance({ address: addr });
  console.log(`Deploying Cloak v2 next to it on chain ${cfg.chainId}${REHEARSE ? " (a fork)" : ""} from ${addr} (${formatEther(start)} HYPE)`);
  const caps = [BigInt(cfg.launchCaps.perDeposit), BigInt(cfg.launchCaps.total)];
  const lv = await deploy("CloakLaunchVault", ourArtifact("CloakLaunchVault.sol", "CloakLaunchVault"), [cfg.poseidon, cfg.verifier, cfg.factory, ...caps, cfg.pauser]);
  await write(lv, LV_ABI, "setShieldVerifier", [cfg.shieldVerifier]);
  await write(lv, LV_ABI, "setWithdrawFee", [50, cfg.feeRecipient]);
  await write(lv, LV_ABI, "turnOnDepositLimits");
  await write(lv, LV_ABI, "setDepositLimit", [zeroAddress, BigInt(cfg.hype.perDeposit), BigInt(cfg.hype.total)]);
  await write(lv, LV_ABI, "endSetup");
  const guardArt = gloamArtifact("VaultOwnerGuard.sol", "VaultOwnerGuard");
  const guard = await deploy("VaultOwnerGuard (launch vault)", guardArt, [lv, addr]);
  await write(lv, LV_ABI, "transferOwnership", [guard]);
  await write(guard, guardArt.abi, "acceptVaultOwnership");
  const checks = await checkLaunchVault(pub, lv, { guard, dual: cfg.verifier, shieldVerifier: cfg.shieldVerifier, factory: cfg.factory, feeRecipient: cfg.feeRecipient, pauser: cfg.pauser, caps });
  console.log(`  launch vault read back: ${checks} checks passed`);

  const b = cfg.batch;
  const launchSwapV4 = await deploy("CloakLaunchSwapV4", ourArtifact("CloakLaunchSwapV4.sol", "CloakLaunchSwapV4"), [lv, cfg.poolManager, cfg.whype, cfg.v4Hook]);
  // buys and sells between HYPE in Gloam's vault and launch tokens in the launch vault (one private call either way)
  const router = await deploy("CloakRouterV4", ourArtifact("CloakLaunchSwapV4.sol", "CloakRouterV4"), [lv, cfg.gloamVault, cfg.poolManager, cfg.whype, cfg.v4Hook]);
  const batcherV4 = await deploy("CloakGloamBatcherV4", ourArtifact("CloakGloamBatcherV4.sol", "CloakGloamBatcherV4"), [lv, cfg.factory, BigInt(b.roundSecs), BigInt(b.maxSlippageBps), BigInt(b.refundAfter)]);
  const receive = await deploy("CloakGloamReceive", ourArtifact("CloakGloamReceive.sol", "CloakGloamReceive"), [cfg.gloamVault, lv]);
  const bids = await deploy("CloakGloamBids", ourArtifact("CloakGloamBids.sol", "CloakGloamBids"), [lv]);
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
  if (!REHEARSE) writeFileSync(join(REPO, `deployments/${cfg.name}.json`), JSON.stringify(rec, null, 2) + "\n");
  console.log(`\ndeployed for ${formatEther(start - end)} HYPE${REHEARSE ? " (rehearsal on a fork, nothing written)" : ""}`);
} finally {
  anvil?.stop();
}
process.exit(0);
