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
export async function deployFactory(publicClient, walletClient, { verifier, treasury, rules, config } = {}) {
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
  const vd = await deploy(cloakVestingDeployerAbi, bytecode.CloakVestingDeployer, []);
  const f = await deploy(cloakFactoryAbi, bytecode.CloakFactory, [config, vd.address]);
  return { factory: f.address, config, verifier, txHash: f.txHash, block: f.block };
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

import { cloakConfigAbi, cloakMigratorAbi, cloakVaultsAbi, cloakVestingDeployerAbi, privateRouterAbi, privateBatcherAbi, whypeAbi } from "@cloakely/sdk";
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
