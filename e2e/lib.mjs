import { createPublicClient, createWalletClient, http, parseEther, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Cloak, cloakFactoryAbi, drandRoundTime } from "@cloakely/sdk";
import { bytecode } from "@cloakely/sdk/bytecode";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const fmt = (wei, d = 6) => Number(formatEther(wei)).toFixed(d);

export function clients(chain, rpc, pk) {
  const account = privateKeyToAccount(pk);
  const transport = http(rpc);
  const publicClient = createPublicClient({ chain, transport, pollingInterval: 250 });
  const walletClient = createWalletClient({ chain, transport, account });
  return { account, publicClient, walletClient };
}

/**
 * Deploy CloakConfig (setup mode: rules set directly), the vesting deployer and the factory. `rules` turns fees and
 * caps on in the same run; `endSetup` locks every later change behind the 3-day timelock.
 */
/**
 * A launch factory (and a config, unless one is given). Each settled launch opens its market through a CloakSeeder: a
 * Uniswap V2 pool when `uniswap` = { factory, weth, feeNum? } is given (or `seeder` names one), else a CloakPair.
 */
export async function deployFactory(publicClient, walletClient, { verifier, treasury, rules, config, uniswap, seeder, vestingDeployer, feeLocker } = {}) {
  const deploy = async (abi, bytecode, args) => {
    const hash = await walletClient.deployContract({ abi, bytecode, args });
    const r = await publicClient.waitForTransactionReceipt({ hash });
    return { address: r.contractAddress, txHash: hash, block: r.blockNumber };
  };
  if (!config) {
    verifier ??= (await deployRaw(publicClient, walletClient, bytecode.Groth16Verifier)).address;
    config = (await deploy(cloakConfigAbi, bytecode.CloakConfig, [verifier, treasury ?? walletClient.account.address])).address;
    if (rules) await applyRules(publicClient, walletClient, config, rules);
  }
  const vd = vestingDeployer ?? (await deploy(cloakVestingDeployerAbi, bytecode.CloakVestingDeployer, [])).address;
  const zero = "0x0000000000000000000000000000000000000000";
  seeder ??= (await deploy(cloakSeederAbi, bytecode.CloakSeeder, [uniswap?.factory ?? zero, uniswap?.weth ?? zero, BigInt(uniswap?.feeNum ?? 997)])).address;
  // the creator-fee locker (no owner, no settings): launches can lock their Uniswap LP in it forever
  feeLocker ??= (await deploy(cloakFeeLockerAbi, bytecode.CloakFeeLocker, [])).address;
  const f = await deploy(cloakFactoryAbi, bytecode.CloakFactory, [config, vd, seeder, feeLocker]);
  return { factory: f.address, config, verifier, seeder, feeLocker, txHash: f.txHash, block: f.block };
}

export async function deployRaw(publicClient, walletClient, data) {
  const hash = await walletClient.sendTransaction({ data });
  const r = await publicClient.waitForTransactionReceipt({ hash });
  return { address: r.contractAddress, txHash: hash };
}

/** Set fees and caps on a config that is still in setup. */
export async function applyRules(publicClient, walletClient, config, rules) {
  const call = async (functionName, args = []) => {
    const hash = await walletClient.writeContract({ address: config, abi: cloakConfigAbi, functionName, args });
    await publicClient.waitForTransactionReceipt({ hash });
  };
  const treasury = rules.treasury ?? walletClient.account.address;
  await call("setFees", [rules.withdrawFeeBps ?? 25, rules.launchFeeBps ?? 150, treasury]);
  if (rules.caps) {
    await call("turnOnDepositLimits");
    for (const [asset, per, total] of rules.caps.assets ?? []) await call("setLimit", [asset, per, total]);
    if (rules.caps.defaultBps) await call("setDefaultLimit", rules.caps.defaultBps);
    if (rules.caps.auction) await call("setAuctionLimit", rules.caps.auction);
  }
}

/** Wait until chain time passes `t` (unix seconds), optionally mining empty blocks on a dev chain. */
export async function waitChainTime(publicClient, t, { mine } = {}) {
  for (;;) {
    const b = await publicClient.getBlock();
    if (Number(b.timestamp) >= t) return;
    if (mine) await mine();
    await sleep(1000);
  }
}

export async function waitDrand(round) {
  const t = drandRoundTime(round);
  while (Date.now() / 1000 < t + 1) await sleep(500);
}

export { Cloak, parseEther };

import { cloakConfigAbi, cloakFeeLockerAbi, cloakMigratorAbi, cloakSeederAbi, cloakVaultsAbi, cloakVestingDeployerAbi, privateRouterAbi, privateBatcherAbi, whypeAbi } from "@cloakely/sdk";
import { stringToHex } from "viem";

const send = async (publicClient, p) => {
  const r = await publicClient.waitForTransactionReceipt({ hash: await p });
  if (r.status !== "success") throw new Error(`reverted: ${r.transactionHash}`);
  return r;
};
const configCall = (publicClient, walletClient, config, functionName, args) =>
  send(publicClient, walletClient.writeContract({ address: config, abi: cloakConfigAbi, functionName, args }));

/** Record a contract in CloakConfig's registry (the config must be in setup). */
export async function register(publicClient, walletClient, config, kind, addr, version, startBlock) {
  await configCall(publicClient, walletClient, config, "register", [stringToHex(kind, { size: 32 }), addr, version, BigInt(startBlock)]);
}

/**
 * The privacy side of a v4 deployment, on a config still in setup: CloakVaults (the permanent vaults), its HYPE vault,
 * and a router around them. The factory is added to the config's launch factories, and vaults, router and factory are
 * registered. Hashers, WHYPE and the verifier are stateless and can be reused from an earlier deployment.
 */
export async function deployPrivacy(publicClient, walletClient, factory, { config, poseidon2, poseidon3, whype, factoryBlock = 0n, version = 4 } = {}) {
  const p2 = poseidon2 ?? (await deployRaw(publicClient, walletClient, bytecode.Poseidon2)).address;
  const p3 = poseidon3 ?? (await deployRaw(publicClient, walletClient, bytecode.Poseidon3)).address;
  const w = whype ?? (await send(publicClient, walletClient.deployContract({ abi: whypeAbi, bytecode: bytecode.WHYPE, args: [] }))).contractAddress;
  const c = { address: config, abi: cloakConfigAbi };
  if (!(await publicClient.readContract({ ...c, functionName: "isLaunchFactory", args: [factory] }))) await configCall(publicClient, walletClient, config, "addLaunchFactory", [factory]);
  if (!(await publicClient.readContract({ ...c, functionName: "approvedAsset", args: [w] }))) await configCall(publicClient, walletClient, config, "approveAsset", [w]);
  const vr = await send(publicClient, walletClient.deployContract({ abi: cloakVaultsAbi, bytecode: bytecode.CloakVaults, args: [config, p2, p3] }));
  const vaults = vr.contractAddress;
  await send(publicClient, walletClient.writeContract({ address: vaults, abi: cloakVaultsAbi, functionName: "createAssetPool", args: [w] }));
  const hash = await walletClient.deployContract({ abi: privateRouterAbi, bytecode: bytecode.PrivateRouter, args: [vaults, w] });
  const r = await send(publicClient, hash);
  await register(publicClient, walletClient, config, "vaults", vaults, version, vr.blockNumber);
  await register(publicClient, walletClient, config, "factory", factory, version, factoryBlock);
  await register(publicClient, walletClient, config, "router", r.contractAddress, version, r.blockNumber);
  return { router: r.contractAddress, vaults, whype: w, poseidon2: p2, poseidon3: p3, block: r.blockNumber, vaultsBlock: vr.blockNumber, txHash: hash };
}

/** Open the permanent vault for launch `index` of `factory` (anyone can, once it settled with a pool). */
export async function openVault(publicClient, walletClient, vaults, factory, index) {
  const r = await send(publicClient, walletClient.writeContract({ address: vaults, abi: cloakVaultsAbi, functionName: "createPool", args: [factory, BigInt(index)] }));
  return { txHash: r.transactionHash, pool: await publicClient.readContract({ address: vaults, abi: cloakVaultsAbi, functionName: "poolOf", args: [await launchToken(publicClient, factory, index)] }) };
}

// the first two fields of `launches` are the same in every factory (v1's returns five fields, later ones six)
const LAUNCH_HEAD_ABI = [{ type: "function", name: "launches", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }] }];
async function launchToken(publicClient, factory, index) {
  const [, token] = await publicClient.readContract({ address: factory, abi: LAUNCH_HEAD_ABI, functionName: "launches", args: [BigInt(index)] });
  return token;
}

/** Approve a non-launch token (USDC) in the config and open its permanent vault. */
export async function assetVault(publicClient, walletClient, config, vaults, token) {
  await configCall(publicClient, walletClient, config, "approveAsset", [token]);
  await send(publicClient, walletClient.writeContract({ address: vaults, abi: cloakVaultsAbi, functionName: "createAssetPool", args: [token] }));
  return publicClient.readContract({ address: vaults, abi: cloakVaultsAbi, functionName: "poolOf", args: [token] });
}

export async function deployBatcher(publicClient, walletClient, router, { roundSecs, maxSlippageBps, refundAfter, minOrder = 10n ** 12n }) {
  const hash = await walletClient.deployContract({ abi: privateBatcherAbi, bytecode: bytecode.PrivateBatcher, args: [router, BigInt(roundSecs), maxSlippageBps, BigInt(refundAfter), minOrder] });
  const r = await publicClient.waitForTransactionReceipt({ hash });
  return { batcher: r.contractAddress, block: r.blockNumber, txHash: hash };
}

/** One migrator from every earlier router (and standalone earlier vaults) into `router`'s vaults. */
export async function deployMigrator(publicClient, walletClient, legacyRouters, router, legacyPools = []) {
  const hash = await walletClient.deployContract({ abi: cloakMigratorAbi, bytecode: bytecode.CloakMigrator, args: [legacyRouters, legacyPools, router] });
  const r = await publicClient.waitForTransactionReceipt({ hash });
  return { migrator: r.contractAddress, block: r.blockNumber, txHash: hash };
}

/** Cloak's own contracts move money already inside Cloak, so caps don't apply to them. */
export async function exempt(publicClient, walletClient, config, addrs) {
  for (const a of addrs) {
    const hash = await walletClient.writeContract({ address: config, abi: cloakConfigAbi, functionName: "setCapExempt", args: [a, true] });
    await publicClient.waitForTransactionReceipt({ hash });
  }
}

// ───────────── Uniswap v4 ─────────────
import { concat, encodeAbiParameters, getContractAddress, keccak256 as k256, pad, toHex as hx } from "viem";
import { cloakV4HookAbi, poolManagerAbi } from "@cloakely/sdk";

/** The standard CREATE2 deployer (Arachnid's), on Elysium testnet and every anvil chain. */
export const CREATE2_DEPLOYER = "0x4e59b44847b379578588920ca78fbf26c0b4956c";
/** CloakV4Hook's permissions, as the low bits of its address: beforeInitialize, beforeAdd/RemoveLiquidity, beforeSwap. */
export const V4_HOOK_FLAGS = (1n << 13n) | (1n << 11n) | (1n << 9n) | (1n << 7n);

/** A CREATE2 salt that puts `initCode` at an address with exactly `flags` in its low 14 bits. */
export function mineHookSalt(initCode, flags = V4_HOOK_FLAGS, deployer = CREATE2_DEPLOYER) {
  const bytecodeHash = k256(initCode);
  for (let i = 0n; i < 5_000_000n; i++) {
    const salt = pad(hx(i), { size: 32 });
    const a = getContractAddress({ from: deployer, salt, bytecodeHash, opcode: "CREATE2" });
    if ((BigInt(a) & 0x3fffn) === flags) return { salt, address: a };
  }
  throw new Error("no salt found");
}

/**
 * Uniswap v4 launches: a PoolManager (unless `poolManager` names one, as on mainnet), the CloakV4Hook at a flagged
 * address, and a CloakFactory whose seeder is the hook (no fee locker: the hook pays creators itself).
 * Hook defaults: 0.3% base fee, 10% at listing falling to it over 5 minutes.
 */
export async function deployV4(publicClient, walletClient, { config, vestingDeployer, poolManager, baseFee = 3000, startFee = 100000, decaySecs = 300 } = {}) {
  const wait = async (hash) => {
    const r = await publicClient.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`reverted ${hash}`);
    return r;
  };
  if (!poolManager) {
    const r = await wait(await walletClient.deployContract({ abi: poolManagerAbi, bytecode: bytecode.PoolManager, args: [walletClient.account.address] }));
    poolManager = r.contractAddress;
  }
  const initCode = concat([bytecode.CloakV4Hook, encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "uint24" }, { type: "uint32" }], [poolManager, walletClient.account.address, baseFee, startFee, decaySecs])]);
  const { salt, address: hook } = mineHookSalt(initCode);
  if ((await publicClient.getCode({ address: hook })) === undefined) await wait(await walletClient.sendTransaction({ to: CREATE2_DEPLOYER, data: concat([salt, initCode]) }));
  if (!(await publicClient.getCode({ address: hook }))) throw new Error("hook not deployed");
  const f = await deployFactory(publicClient, walletClient, { config, vestingDeployer, seeder: hook, feeLocker: "0x0000000000000000000000000000000000000000" });
  await wait(await walletClient.writeContract({ address: hook, abi: cloakV4HookAbi, functionName: "setFactory", args: [f.factory] }));
  return { ...f, poolManager, hook };
}
