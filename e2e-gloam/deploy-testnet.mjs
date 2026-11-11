// Deploys Cloak v2 on Gloam for real use on Elysium testnet, shaped as production would be:
//   - Cloak's instance of Gloam's guarded vault, as Gloam's Elysium vault will be (USDC only, Kinetiq's test USDC, at
//     500 per deposit and 25,000 in total), with its memo board, on Gloam's final-key verifiers;
//   - CloakLaunchVault on Cloak's live v4 launch factory, on the same verifiers, under its own VaultOwnerGuard, read
//     back; HYPE listed in setup; every settled launch admitted;
//   - CloakLaunchSwapV4 (Cloak launches' own v4 pools, behind CloakV4Hook), CloakGloamReceive, CloakGloamBids,
//     CloakFundsGate and CloakReceiptCheck with their final-key verifiers.
// Writes deployments/elysium-testnet-gloam.json. The testnet wallet stands in for Cloak's multisig (guard controller,
// pauser) and the relay (fee recipient).
//
//   node e2e-gloam/deploy-testnet.mjs --fork   # rehearsal on a local fork, writes nothing
//   NODE_USE_ENV_PROXY=1 node e2e-gloam/deploy-testnet.mjs           # live: GLOAM_TESTNET_PK from ../.env
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatEther, parseEther, zeroAddress } from "viem";
import { deployments } from "@cloakely/sdk";
import { createGloamLoop } from "../services/keeper/gloamLoop.mjs";
import { LV_ABI, checkLaunchVault } from "./stack.mjs";
import { ANVIL_KEYS, ELYSIUM_TESTNET_ID, ELYSIUM_TESTNET_RPC, ELYSIUM_TESTNET_USDC, REPO, clients, deployGloamStack, deployPoseidon, gloamArtifact, ourArtifact, sendAndLog, startAnvil } from "./lib.mjs";

const FORK = process.argv.includes("--fork");
const D = deployments[ELYSIUM_TESTNET_ID];
function envKey() {
  if (process.env.GLOAM_TESTNET_PK) return process.env.GLOAM_TESTNET_PK;
  const p = join(REPO, ".env");
  const m = existsSync(p) && readFileSync(p, "utf8").match(/^GLOAM_TESTNET_PK=(0x[0-9a-fA-F]{64})\s*$/m);
  return m ? m[1] : null;
}
let anvil;
let rpcUrl = process.env.RPC_URL ?? ELYSIUM_TESTNET_RPC;
let pk = envKey();
if (FORK) {
  anvil = await startAnvil({ port: 8567, forkUrl: rpcUrl });
  rpcUrl = anvil.rpcUrl;
  pk = ANVIL_KEYS[0];
}
if (!pk) throw new Error("set GLOAM_TESTNET_PK in .env (fresh testnet key only)");
const me = clients(rpcUrl, pk, ELYSIUM_TESTNET_ID);
const pub = me.pub;
const addr = me.account.address;
const write = (address, abi, functionName, args = []) => sendAndLog(pub, functionName, me.wallet.writeContract({ address, abi, functionName, args }));
const deploy = async (label, art, args = []) => (await sendAndLog(pub, `deploy ${label}`, me.wallet.deployContract({ ...art, args }))).contractAddress;
try {
  const start = await pub.getBalance({ address: addr });
  console.log(`Deploying Cloak v2 on Gloam to ${FORK ? "a fork of " : ""}Elysium testnet from ${addr} (${formatEther(start)} HYPE)`);
  const poseidon = await deployPoseidon(me);
  const stack = await deployGloamStack({ rpcUrl, pk, poseidon, assets: [{ address: ELYSIUM_TESTNET_USDC, perDeposit: 500n * 10n ** 6n, total: 25_000n * 10n ** 6n }], feeBps: 50, feeRecipient: addr, controller: addr });
  if (!stack.forgeLog.includes("All checks passed")) throw new Error("Gloam's key gate didn't pass");
  const caps = [parseEther("1000000000"), parseEther("100000000000")];
  const lv = await deploy("CloakLaunchVault", ourArtifact("CloakLaunchVault.sol", "CloakLaunchVault"), [poseidon, stack.dual, D.factory, ...caps, addr]);
  await write(lv, LV_ABI, "setShieldVerifier", [stack.shieldVerifier]);
  await write(lv, LV_ABI, "setWithdrawFee", [50, addr]);
  await write(lv, LV_ABI, "turnOnDepositLimits");
  await write(lv, LV_ABI, "setDepositLimit", [zeroAddress, parseEther("10"), parseEther("1000")]);
  await write(lv, LV_ABI, "endSetup");
  const guardArt = gloamArtifact("VaultOwnerGuard.sol", "VaultOwnerGuard");
  const lvGuard = await deploy("VaultOwnerGuard (launch vault)", guardArt, [lv, addr]);
  await write(lv, LV_ABI, "transferOwnership", [lvGuard]);
  await write(lvGuard, guardArt.abi, "acceptVaultOwnership");
  const checks = await checkLaunchVault(pub, lv, { guard: lvGuard, dual: stack.dual, shieldVerifier: stack.shieldVerifier, factory: D.factory, feeRecipient: addr, pauser: addr, caps });
  console.log(`  launch vault read back: ${checks} checks passed`);
  const launchSwapV4 = await deploy("CloakLaunchSwapV4", ourArtifact("CloakLaunchSwapV4.sol", "CloakLaunchSwapV4"), [lv, D.poolManager, D.whype, D.v4Hook]);
  const receive = await deploy("CloakGloamReceive", ourArtifact("CloakGloamReceive.sol", "CloakGloamReceive"), [stack.pool, lv]);
  const bids = await deploy("CloakGloamBids", ourArtifact("CloakGloamBids.sol", "CloakGloamBids"), [lv, zeroAddress]);
  const fv = await deploy("GloamFundsVerifierFinal", ourArtifact("GloamFundsVerifierFinal.sol", "GloamFundsVerifierFinal"));
  const rv = await deploy("GloamReceiptVerifierFinal", ourArtifact("GloamReceiptVerifierFinal.sol", "GloamReceiptVerifierFinal"));
  const fundsGate = await deploy("CloakFundsGate", ourArtifact("CloakFundsGate.sol", "CloakFundsGate"), [fv, stack.pool, lv]);
  const receiptCheck = await deploy("CloakReceiptCheck", ourArtifact("CloakReceiptCheck.sol", "CloakReceiptCheck"), [rv, stack.pool, lv]);
  const block = await pub.getBlockNumber();
  // every settled launch of Cloak's v4 factory, admitted now (the keeper loop does it from here on)
  const loop = createGloamLoop({ publicClient: pub, account: me.account, send: async (x) => (await sendAndLog(pub, x.functionName, me.wallet.writeContract(x))).transactionHash, launchVault: lv });
  const t = await loop.tick();
  console.log(`  admitted ${t.admitted.length} settled launches`);
  const end = await pub.getBalance({ address: addr });
  const rec = {
    chainId: ELYSIUM_TESTNET_ID,
    note: "Cloak v2 on Gloam, testnet, production-shaped: Cloak's instance of Gloam's guarded vault (USDC only, as Gloam's Elysium vault will be) and Cloak's launch vault on Cloak's live v4 launch factory under Gloam's VaultOwnerGuard. The deploy wallet stands in for Cloak's multisig.",
    block: Number(block),
    gloamVault: stack.pool,
    gloamGuard: stack.guard,
    memoBoard: stack.payMemo,
    poseidon,
    verifier: stack.dual,
    shieldVerifier: stack.shieldVerifier,
    launchVault: lv,
    launchVaultGuard: lvGuard,
    launchFactory: D.factory,
    launchSwapV4,
    receive,
    bids,
    fundsGate,
    receiptCheck,
    fundsVerifier: fv,
    receiptVerifier: rv,
    whype: D.whype,
    poolManager: D.poolManager,
    v4Hook: D.v4Hook,
    admittedAtDeploy: t.admitted.length,
    costHype: formatEther(start - end),
    previousRun: "Nov 8 live run (stand-in launch): see measurements/live-elysium.json",
  };
  console.log(JSON.stringify(rec, null, 1));
  if (!FORK) writeFileSync(join(REPO, "deployments/elysium-testnet-gloam.json"), JSON.stringify(rec, null, 2) + "\n");
  console.log(`\ndeployed for ${formatEther(start - end)} HYPE${FORK ? " (fork rehearsal, nothing written)" : ""}`);
} finally {
  anvil?.stop();
}
process.exit(0);
