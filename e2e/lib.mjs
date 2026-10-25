import { createPublicClient, createWalletClient, http, parseEther, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Cloak, cloakFactoryAbi, drandRoundTime } from "@cloak/sdk";
import { bytecode } from "@cloak/sdk/bytecode";

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

import { cloakConfigAbi, cloakMigratorAbi, cloakVestingDeployerAbi, privateRouterAbi, privateBatcherAbi } from "@cloak/sdk";

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * Deploy the PrivateRouter (it deploys its HYPE pool, and WHYPE unless an existing one is passed). Hashers and the
 * verifier can be reused from an earlier deployment: they are stateless.
 */
export async function deployPrivacy(publicClient, walletClient, factory, { config, poseidon2, poseidon3, legacyFactory = ZERO, whype = ZERO } = {}) {
  const p2 = poseidon2 ?? (await deployRaw(publicClient, walletClient, bytecode.Poseidon2)).address;
  const p3 = poseidon3 ?? (await deployRaw(publicClient, walletClient, bytecode.Poseidon3)).address;
  const hash = await walletClient.deployContract({ abi: privateRouterAbi, bytecode: bytecode.PrivateRouter, args: [config, p2, p3, factory, legacyFactory, whype] });
  const r = await publicClient.waitForTransactionReceipt({ hash });
  return { router: r.contractAddress, poseidon2: p2, poseidon3: p3, block: r.blockNumber, txHash: hash };
}

export async function deployBatcher(publicClient, walletClient, router, { roundSecs, maxSlippageBps, refundAfter, minOrder = 10n ** 12n }) {
  const hash = await walletClient.deployContract({ abi: privateBatcherAbi, bytecode: bytecode.PrivateBatcher, args: [router, BigInt(roundSecs), maxSlippageBps, BigInt(refundAfter), minOrder] });
  const r = await publicClient.waitForTransactionReceipt({ hash });
  return { batcher: r.contractAddress, block: r.blockNumber, txHash: hash };
}

export async function deployMigrator(publicClient, walletClient, legacyRouter, router) {
  const hash = await walletClient.deployContract({ abi: cloakMigratorAbi, bytecode: bytecode.CloakMigrator, args: [legacyRouter, router] });
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
