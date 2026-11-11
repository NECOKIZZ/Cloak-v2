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

/** The hook's fees unless given: 0.3% base, 10% at listing falling to the base over 5 minutes (in pips, 1e6 = 100%). */
export const DEFAULT_HOOK_FEES = { baseFee: 3000, startFee: 100000, decaySecs: 300 };

/**
 * v2's CloakConfig (the launch fee and bid caps, the treasury, setup ended), CloakV4Hook at a flagged address on
 * `poolManager`, and the factory. Every setting is read back.
 *   - `rules`: { launchFeeBps, perBid, total, capsOn } given explicitly (mainnet), or copied from the CloakConfig at
 *     `copyFrom` (testnet: Cloak v1's).
 *   - `hookFees`: { baseFee, startFee, decaySecs }, fixed in the hook for good.
 *   - `owner`: when set and not the deploy wallet, the config's ownership is offered to it (it then calls
 *     acceptOwnership()); the deploy wallet keeps nothing that can change a rule.
 *   - `vaultVerifier`: CloakConfig wants a vault verifier (v1's private layer reads it); v2 has no Cloak vaults, so pass
 *     Gloam's (unused).
 */
export async function deployV2Factory({ pub, wallet, treasury, copyFrom, rules, hookFees = DEFAULT_HOOK_FEES, owner, poolManager, vaultVerifier }) {
  const addr = wallet.account.address;
  const deploy = async (label, a, args = []) => (await sendAndLog(pub, `deploy ${label}`, wallet.deployContract({ ...a, args }))).contractAddress;
  const write = (address, abi, functionName, args = []) => sendAndLog(pub, functionName, wallet.writeContract({ address, abi, functionName, args }));
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  const POOL_MANAGER = poolManager;
  if (((await pub.getCode({ address: POOL_MANAGER })) ?? "0x") === "0x") throw new Error(`no PoolManager at ${POOL_MANAGER}`);
  if (((await pub.getCode({ address: CREATE2_DEPLOYER })) ?? "0x") === "0x") throw new Error("no CREATE2 deployer on this chain");
  // 1. v2's CloakConfig: the launch fee and bid caps (given, or copied from another config), the treasury, then setup ends
  let launchFeeBps, perBid, total, capsOn;
  if (rules) ({ launchFeeBps, perBid, total, capsOn } = { launchFeeBps: Number(rules.launchFeeBps), perBid: BigInt(rules.perBid), total: BigInt(rules.total), capsOn: !!rules.capsOn });
  else {
    if (!copyFrom) throw new Error("pass rules, or copyFrom (a CloakConfig to copy them from)");
    const src = { address: copyFrom, abi: cloakConfigAbi };
    [launchFeeBps, [perBid, total], capsOn] = await Promise.all(["launchFeeBps", "auctionLimit", "depositLimitsOn"].map((functionName) => pub.readContract({ ...src, functionName })));
  }
  if (launchFeeBps > 300) throw new Error("the launch fee can be at most 3% (300 bps)");
  const { baseFee, startFee, decaySecs } = hookFees;
  if (!(baseFee > 0 && startFee >= baseFee && startFee <= 1_000_000 && decaySecs >= 0)) throw new Error("hook fees: 0 < baseFee <= startFee <= 1e6 pips");
  // CloakConfig wants a vault verifier (v1's private layer reads it); v2 has no Cloak vaults, so it names Gloam's, unused
  const config = await deploy("CloakConfig (v2)", art("contracts", "CloakConfig.sol", "CloakConfig"), [vaultVerifier, treasury]);
  await write(config, cloakConfigAbi, "setFees", [0, launchFeeBps, treasury]);
  if (capsOn) {
    await write(config, cloakConfigAbi, "turnOnDepositLimits");
    await write(config, cloakConfigAbi, "setAuctionLimit", [perBid, total]);
  }  // Cloak's launch floors: every launch names a minimum raise of at least this much HYPE (under it, the launch fails and
  // every deposit comes back) and gives its pool at least this share of the raise. Raising them later is instant;
  // lowering waits 3 days in public.
  const floors = rules?.launchFloors ? { minRaise: BigInt(rules.launchFloors.minRaise), minLpBps: Number(rules.launchFloors.minLpBps) } : null;
  if (floors) await write(config, cloakConfigAbi, "setLaunchFloors", [floors.minRaise, floors.minLpBps]);


  // 2. the hook at a flagged address, on Uniswap's PoolManager, with its fees fixed for good
  const hookArt = art("contracts-v4", "CloakV4Hook.sol", "CloakV4Hook");
  const initCode = concat([hookArt.bytecode, encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "uint24" }, { type: "uint32" }], [POOL_MANAGER, addr, baseFee, startFee, decaySecs])]);
  const { salt, address: hook } = mineHookSalt(initCode);
  await sendAndLog(pub, "deploy CloakV4Hook (CREATE2)", wallet.sendTransaction({ to: CREATE2_DEPLOYER, data: concat([salt, initCode]) }));
  if (((await pub.getCode({ address: hook })) ?? "0x") === "0x") throw new Error("hook not deployed");

  // 3. the factory, with its own vesting deployer and no fee locker (the hook pays creators itself)
  // its one-time door (the GLOAK experiment, docs/GLOAK-EXPERIMENT.md) belongs to the owner wallet
  const vd = await deploy("CloakVestingDeployer", art("contracts", "CloakVesting.sol", "CloakVestingDeployer"), [owner ?? addr]);
  const factory = await deploy("CloakFactory (v2)", art("contracts", "CloakFactory.sol", "CloakFactory"), [config, vd, hook, zeroAddress]);
  const factoryBlock = await pub.getBlockNumber();
  await write(hook, cloakV4HookAbi, "setFactory", [factory]);
  await write(config, cloakConfigAbi, "addLaunchFactory", [factory]);
  await write(config, cloakConfigAbi, "endSetup");
  // the rules' owner: tightening is instant and loosening waits 3 days in public, so it goes to the owner wallet
  if (owner && !same(owner, addr)) await write(config, cloakConfigAbi, "transferOwnership", [owner]);

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
  if (Number(fee) !== Number(launchFeeBps) || !same(rec, treasury) || setup !== false || lim[0] !== perBid || lim[1] !== total) throw new Error("config misconfigured");
  if (floors) {
    const [r, b] = await pub.readContract({ ...c, functionName: "launchFloors" });
    if (r !== floors.minRaise || Number(b) !== floors.minLpBps) throw new Error("launch floors misread");
  }
  const fees = await Promise.all(["baseFee", "startFee", "decaySecs"].map((functionName) => pub.readContract({ ...hk, functionName })));
  if (Number(fees[0]) !== baseFee || Number(fees[1]) !== startFee || Number(fees[2]) !== decaySecs) throw new Error("hook fees misread");
  if (owner && !same(owner, addr)) {
    const pending = await pub.readContract({ ...c, functionName: "pendingOwner" });
    if (!same(pending, owner)) throw new Error("config ownership wasn't offered to the owner wallet");
  }
  console.log("  read back: hook flags and fees, hook → factory, factory → config and hook, config fees, caps, setup ended" + (owner && !same(owner, addr) ? ", ownership offered to the owner wallet" : ""));

  return { config, factory, factoryBlock, hook, vestingDeployer: vd, launchFeeBps, perBid, total, capsOn, hookFees, owner: owner ?? addr, launchFloors: floors ? { minRaise: String(floors.minRaise), minLpBps: floors.minLpBps } : null };
}
