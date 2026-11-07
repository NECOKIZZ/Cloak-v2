// Deploy Cloak from scratch, the way Elysium mainnet (chain 99901) needs it: nothing from testnet carries over.
//   verifier → CloakConfig (fees + caps, still in setup) → vesting deployer → CloakV4Hook at its flagged address
//   (CREATE2) on Uniswap's own PoolManager → the v4 launch factory → hashers, WHYPE, CloakVaults with the HYPE vault, the
//   router and batcher → the shared launch-token vault, its router and batcher → the NFT drop factory and WL spot book.
//   Everything is registered in CloakConfig, so apps and the keeper find it from the config address alone.
// Setup stays open (owner can still set rules directly) until the trusted-setup ceremony, the multisig and endSetup.
//   DEPLOYER_PK=0x… [RPC_URL=…] [TREASURY=0x…] [WHYPE=0x…] [USDC=0x…] [POOL_MANAGER=0x…] node e2e/deploy-mainnet.mjs
// Rehearse on a fork of mainnet first (spends nothing):
//   anvil --fork-url https://rpc-live.elysp.com --chain-id 31337 & ; DEPLOYER_PK=0x… RPC_URL=http://127.0.0.1:8545 node e2e/deploy-mainnet.mjs
//   (writes deployments/elysium-mainnet.fork.json)
import { writeFileSync } from "node:fs";
import { createPublicClient, defineChain, formatEther, http, parseEther } from "viem";
import { cloakConfigAbi, cloakReceiveAbi, cloakDropFactoryAbi, cloakFactoryAbi, cloakSpotBookAbi, cloakV4HookAbi, cloakVaultsAbi, cloakVestingDeployerAbi, elysiumTestnet, readRegistry, sharedBatcherAbi, sharedRouterAbi, sharedVaultAbi } from "@cloakely/sdk";
import { bytecode } from "@cloakely/sdk/bytecode";
import { applyRules, assetVault, clients, deployBatcher, deployPrivacy, deployRaw, deployV4, exempt, register } from "./lib.mjs";

const MAINNET_PM = "0xe2e105d3f7209a9da11f83ccf3e7398a753823f1";
const RPC = process.env.RPC_URL || "https://rpc-live.elysp.com";
const local = RPC.includes("127.0.0.1") || RPC.includes("localhost");
const id = await createPublicClient({ transport: http(RPC) }).getChainId();
if (!local && id !== 99901) throw new Error(`chain ${id} isn't Elysium mainnet`);
const chain = defineChain({ ...elysiumTestnet, id, name: "Elysium", rpcUrls: { default: { http: [RPC] } } });
const d = clients(chain, RPC, process.env.DEPLOYER_PK);
const pub = d.publicClient;
const send = async (p) => {
  const r = await pub.waitForTransactionReceipt({ hash: await p });
  if (r.status !== "success") throw new Error(`reverted: ${r.transactionHash}`);
  return r;
};
const same = (a, b) => a?.toLowerCase() === b?.toLowerCase();
const start = await pub.getBalance({ address: d.account.address });
console.log(`chain ${id} · deployer ${d.account.address} · ${formatEther(start)} HYPE`);

const poolManager = process.env.POOL_MANAGER || MAINNET_PM;
if (!(await pub.getCode({ address: poolManager }))) throw new Error(`no PoolManager at ${poolManager}`);
const treasury = process.env.TREASURY || d.account.address;

// 1. verifier and config, with testnet's rules: 0.25% withdraw fee, 1.5% launch fee, beta deposit caps
const verifier = (await deployRaw(pub, d.walletClient, bytecode.Groth16Verifier)).address;
const config = (await send(d.walletClient.deployContract({ abi: cloakConfigAbi, bytecode: bytecode.CloakConfig, args: [verifier, treasury] }))).contractAddress;
const vestingDeployer = (await send(d.walletClient.deployContract({ abi: cloakVestingDeployerAbi, bytecode: bytecode.CloakVestingDeployer, args: [] }))).contractAddress;
console.log(`verifier ${verifier} · config ${config} · vesting deployer ${vestingDeployer}`);

// 2. the v4 hook on Uniswap's PoolManager, and the launch factory whose seeder it is
const v4 = await deployV4(pub, d.walletClient, { config, vestingDeployer, poolManager });
if ((BigInt(v4.hook) & 0x3fffn) !== 0x2a80n) throw new Error("hook address has the wrong permission bits");
console.log(`hook ${v4.hook} · factory ${v4.factory} (block ${v4.block})`);

// 3. privacy: hashers, WHYPE, vaults, HYPE vault, router; then caps. Leave WHYPE unset on mainnet: mainnet's WHYPE
//    is an upgradeable proxy, and the HYPE vault must not hold a token someone else can change (docs/MAINNET.md).
const p = await deployPrivacy(pub, d.walletClient, v4.factory, { config, whype: process.env.WHYPE, factoryBlock: v4.block });
await applyRules(pub, d.walletClient, config, { withdrawFeeBps: 25, launchFeeBps: 150, treasury, caps: { assets: [[p.whype, parseEther("100"), parseEther("10000")]], defaultBps: [1000n, 5000n], auction: [parseEther("100"), parseEther("10000")] } });
const assets = [];
if (process.env.USDC) {
  const pool = await assetVault(pub, d.walletClient, config, p.vaults, process.env.USDC);
  await send(d.walletClient.writeContract({ address: config, abi: cloakConfigAbi, functionName: "setLimit", args: [process.env.USDC, 1000n * 10n ** 6n, 50000n * 10n ** 6n] }));
  assets.push({ symbol: "USDC", token: process.env.USDC, pool, decimals: 6, fromBlock: p.vaultsBlock.toString() });
}
const b = await deployBatcher(pub, d.walletClient, p.router, { roundSecs: 30, maxSlippageBps: 200, refundAfter: 600, minOrder: 10n ** 12n });
await register(pub, d.walletClient, config, "batcher", b.batcher, 4, b.block);
console.log(`vaults ${p.vaults} · router ${p.router} · batcher ${b.batcher} · WHYPE ${p.whype}`);

// 4. the shared launch-token vault (every v4 launch is admitted to it), its router and batcher
const hypePool = await pub.readContract({ address: p.vaults, abi: cloakVaultsAbi, functionName: "poolOf", args: [p.whype] });
const p4 = (await deployRaw(pub, d.walletClient, bytecode.Poseidon4)).address;
const verifierMA = (await send(d.walletClient.deployContract({ abi: [], bytecode: bytecode.Groth16VerifierMA, args: [] }))).contractAddress;
const sv = await send(d.walletClient.deployContract({ abi: sharedVaultAbi, bytecode: bytecode.SharedVault, args: [config, p.poseidon2, p4, verifierMA, p.vaults] }));
const sr = await send(d.walletClient.deployContract({ abi: sharedRouterAbi, bytecode: bytecode.SharedRouter, args: [sv.contractAddress, hypePool, p.whype] }));
const sb = await send(d.walletClient.deployContract({ abi: sharedBatcherAbi, bytecode: bytecode.SharedBatcher, args: [sv.contractAddress, hypePool, p.whype, 30n, 200, 600n, 10n ** 12n] }));
await register(pub, d.walletClient, config, "shared", sv.contractAddress, 4, sv.blockNumber);
await register(pub, d.walletClient, config, "sharedRouter", sr.contractAddress, 4, sr.blockNumber);
await register(pub, d.walletClient, config, "sharedBatcher", sb.contractAddress, 4, sb.blockNumber);
await exempt(pub, d.walletClient, config, [p.router, b.batcher, sr.contractAddress, sb.contractAddress]);
console.log(`shared vault ${sv.contractAddress} · router ${sr.contractAddress} · batcher ${sb.contractAddress}`);
// private receive addresses: a plain transfer becomes a note (not cap-exempt: deposits through it count against the caps)
const rx = await send(d.walletClient.deployContract({ abi: cloakReceiveAbi, bytecode: bytecode.CloakReceive, args: [p.vaults, sv.contractAddress, p.whype] }));
await register(pub, d.walletClient, config, "receive", rx.contractAddress, 4, rx.blockNumber);
console.log(`receive ${rx.contractAddress}`);

// 5. NFT drops and WL spot sales on the same config
const df = await send(d.walletClient.deployContract({ abi: cloakDropFactoryAbi, bytecode: bytecode.CloakDropFactory, args: [config, "https://cloak.boblabs.tech/api/nft/"] }));
const book = await send(d.walletClient.deployContract({ abi: cloakSpotBookAbi, bytecode: bytecode.CloakSpotBook, args: [df.contractAddress] }));
console.log(`drop factory ${df.contractAddress} · spot book ${book.contractAddress}`);

// 6. read it all back, as apps and the keeper will
const reg = await readRegistry(pub, config);
const hk = { address: v4.hook, abi: cloakV4HookAbi };
const checks = {
  "registry: factory, vaults, router, batcher": same(reg.factory, v4.factory) && same(reg.vaults, p.vaults) && same(reg.router, p.router) && same(reg.batcher, b.batcher),
  "registry: shared vault, router, batcher": same(reg.shared, sv.contractAddress) && same(reg.sharedRouter, sr.contractAddress) && same(reg.sharedBatcher, sb.contractAddress),
  "the factory is a launch factory": await pub.readContract({ address: config, abi: cloakConfigAbi, functionName: "isLaunchFactory", args: [v4.factory] }),
  "the hook uses Uniswap's PoolManager and serves this factory": same(await pub.readContract({ ...hk, functionName: "poolManager" }), poolManager) && same(await pub.readContract({ ...hk, functionName: "factory" }), v4.factory),
  "the factory's seeder is the hook, with no timed locks": same(await pub.readContract({ address: v4.factory, abi: cloakFactoryAbi, functionName: "seeder" }), v4.hook) && (await pub.readContract({ address: v4.factory, abi: cloakFactoryAbi, functionName: "timedLocks" })) === false,
  "the shared vault verifies with the MA verifier": same(await pub.readContract({ address: sv.contractAddress, abi: sharedVaultAbi, functionName: "verifier" }), verifierMA),
  "config is still in setup (ceremony, multisig and endSetup come next)": await pub.readContract({ address: config, abi: cloakConfigAbi, functionName: "setupMode" }),
};
for (const [m, c] of Object.entries(checks)) {
  if (!c) throw new Error(`✗ ${m}`);
  console.log(`  ✓ ${m}`);
}

const spent = start - (await pub.getBalance({ address: d.account.address }));
const out = {
  chainId: id,
  version: 4,
  config,
  verifier,
  poseidon2: p.poseidon2,
  poseidon3: p.poseidon3,
  poseidon4: p4,
  verifierMA,
  vaults: p.vaults,
  vaultsBlock: p.vaultsBlock.toString(),
  factory: v4.factory,
  factoryBlock: v4.block.toString(),
  earlierFactories: [],
  seeder: v4.hook,
  router: p.router,
  routerBlock: p.block.toString(),
  whype: p.whype,
  hypePool,
  batcher: b.batcher,
  batcherBlock: b.block.toString(),
  shared: sv.contractAddress,
  sharedBlock: sv.blockNumber.toString(),
  sharedRouter: sr.contractAddress,
  sharedBatcher: sb.contractAddress,
  receive: rx.contractAddress,
  sharedBatcherBlock: sb.blockNumber.toString(),
  dropFactory: df.contractAddress,
  dropFactoryBlock: Number(df.blockNumber),
  spotBook: book.contractAddress,
  treasury,
  assets,
  uniswapV4: { poolManager, hook: v4.hook, baseFee: "0.3%", antiSnipe: "10% falling to the base over 300s" },
  rules: { withdrawFeeBps: 25, launchFeeBps: 150, caps: "WHYPE 100/10000 HYPE; tokens 1000/5000 bps of supply; bids 100/10000 HYPE" },
  deployCost: `${formatEther(spent)} HYPE`,
};
const file = process.env.OUT ?? (local ? "deployments/elysium-mainnet.fork.json" : "deployments/elysium-mainnet.json");
writeFileSync(new URL(`../${file}`, import.meta.url), JSON.stringify(out, null, 2) + "\n");
console.log(`\nwrote ${file} · spent ${formatEther(spent)} HYPE`);
