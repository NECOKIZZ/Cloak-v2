// Deploys Cloak v2's own launch factory (see deploy-v2-factory.mjs). Shared by the deploy script and part 19.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { concat, encodeAbiParameters, getContractAddress, keccak256, pad, toHex, zeroAddress } from "viem";
import { cloakConfigAbi, cloakFactoryAbi, cloakV4HookAbi } from "@cloakely/sdk";
import { REPO, sendAndLog } from "./lib.mjs";

export const CREATE2_DEPLOYER = "0x4e59b44847b379578588920ca78fbf26c0b4956c";
// CloakV4Hook's permissions, as the low bits of its address: beforeInitialize, beforeAdd/RemoveLiquidity, beforeSwap
const HOOK_FLAGS = (1n << 13n) | (1n << 11n) | (1n << 9n) | (1n << 7n);

const art = (dir, file, name) => {
  const j = JSON.parse(readFileSync(join(REPO, dir, "out", file, `${name}.json`), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object };
};
function mineHookSalt(initCode) {
  const bytecodeHash = keccak256(initCode);
  for (let i = 0n; i < 5_000_000n; i++) {
    const salt = pad(toHex(i), { size: 32 });
    const a = getContractAddress({ from: CREATE2_DEPLOYER, salt, bytecodeHash, opcode: "CREATE2" });
    if ((BigInt(a) & 0x3fffn) === HOOK_FLAGS) return { salt, address: a };
  }
  throw new Error("no salt found");
}

/**
 * v2's CloakConfig (launch fee and bid caps copied from `copyFrom`, the treasury, setup ended), CloakV4Hook at a
 * flagged address on `poolManager`, and the factory. Every setting is read back. `vaultVerifier`: CloakConfig wants a
 * vault verifier (v1's private layer reads it); v2 has no Cloak vaults, so pass Gloam's (unused).
 */
export async function deployV2Factory({ pub, wallet, treasury, copyFrom, poolManager, vaultVerifier }) {
  const addr = wallet.account.address;
  const deploy = async (label, a, args = []) => (await sendAndLog(pub, `deploy ${label}`, wallet.deployContract({ ...a, args }))).contractAddress;
  const write = (address, abi, functionName, args = []) => sendAndLog(pub, functionName, wallet.writeContract({ address, abi, functionName, args }));
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  const POOL_MANAGER = poolManager;
  if (((await pub.getCode({ address: POOL_MANAGER })) ?? "0x") === "0x") throw new Error(`no PoolManager at ${POOL_MANAGER}`);
  if (((await pub.getCode({ address: CREATE2_DEPLOYER })) ?? "0x") === "0x") throw new Error("no CREATE2 deployer on this chain");
  // 1. v2's CloakConfig: the launch fee and bid caps copied from v1's, the treasury, then setup ends
  const src = { address: copyFrom, abi: cloakConfigAbi };
  const [launchFeeBps, [perBid, total], capsOn] = await Promise.all(["launchFeeBps", "auctionLimit", "depositLimitsOn"].map((functionName) => pub.readContract({ ...src, functionName })));
  // CloakConfig wants a vault verifier (v1's private layer reads it); v2 has no Cloak vaults, so it names Gloam's, unused
  const config = await deploy("CloakConfig (v2)", art("contracts", "CloakConfig.sol", "CloakConfig"), [vaultVerifier, treasury]);
  await write(config, cloakConfigAbi, "setFees", [0, launchFeeBps, treasury]);
  if (capsOn) {
    await write(config, cloakConfigAbi, "turnOnDepositLimits");
    await write(config, cloakConfigAbi, "setAuctionLimit", [perBid, total]);
  }

  // 2. the hook at a flagged address, on Uniswap's PoolManager (0.3% base fee, 10% at listing falling over 5 minutes)
  const hookArt = art("contracts-v4", "CloakV4Hook.sol", "CloakV4Hook");
  const initCode = concat([hookArt.bytecode, encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "uint24" }, { type: "uint32" }], [POOL_MANAGER, addr, 3000, 100000, 300])]);
  const { salt, address: hook } = mineHookSalt(initCode);
  await sendAndLog(pub, "deploy CloakV4Hook (CREATE2)", wallet.sendTransaction({ to: CREATE2_DEPLOYER, data: concat([salt, initCode]) }));
  if (((await pub.getCode({ address: hook })) ?? "0x") === "0x") throw new Error("hook not deployed");

  // 3. the factory, with its own vesting deployer and no fee locker (the hook pays creators itself)
  const vd = await deploy("CloakVestingDeployer", art("contracts", "CloakVesting.sol", "CloakVestingDeployer"));
  const factory = await deploy("CloakFactory (v2)", art("contracts", "CloakFactory.sol", "CloakFactory"), [config, vd, hook, zeroAddress]);
  const factoryBlock = await pub.getBlockNumber();
  await write(hook, cloakV4HookAbi, "setFactory", [factory]);
  await write(config, cloakConfigAbi, "addLaunchFactory", [factory]);
  await write(config, cloakConfigAbi, "endSetup");

  // read back
  const hk = { address: hook, abi: cloakV4HookAbi };
  const [pm, fac, timed] = await Promise.all(["poolManager", "factory", "timedLocks"].map((functionName) => pub.readContract({ ...hk, functionName })));
  if (!same(pm, POOL_MANAGER) || !same(fac, factory) || timed !== false) throw new Error("hook misconfigured");
  if ((BigInt(hook) & 0x3fffn) !== HOOK_FLAGS) throw new Error("hook address has the wrong permission bits");
  const f = { address: factory, abi: cloakFactoryAbi };
  const [fConfig, fSeeder, fTimed] = await Promise.all(["config", "seeder", "timedLocks"].map((functionName) => pub.readContract({ ...f, functionName })));
  if (!same(fConfig, config) || !same(fSeeder, hook) || fTimed !== false) throw new Error("factory misconfigured");
  const c = { address: config, abi: cloakConfigAbi };
  const [fee, rec, setup, lim] = await Promise.all(["launchFeeBps", "feeRecipient", "setupMode", "auctionLimit"].map((functionName) => pub.readContract({ ...c, functionName })));
  if (fee !== launchFeeBps || !same(rec, treasury) || setup !== false || lim[0] !== perBid || lim[1] !== total) throw new Error("config misconfigured");
  console.log("  read back: hook flags, hook → factory, factory → config and hook, config fees, caps and setup ended");

  return { config, factory, factoryBlock, hook, vestingDeployer: vd, launchFeeBps, perBid, total, capsOn };
}
