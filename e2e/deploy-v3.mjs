// Deploy Cloak v3 next to v1 and v2, the way mainnet will be wired: a new factory (claim() never freezes a winner's
// tokens) → a router that opens vaults for every earlier launch (CloakFactoryList: v2, then v1) → its batcher → one
// migrator from each earlier router → cap exemptions. It reuses what holds no deployment state: CloakConfig (fees, caps
// and the verifier, still in setup), the Poseidon hashers, WHYPE and the USDC vault.
//   DEPLOYER_PK=0x… [RPC_URL=…] [OUT=deployments/elysium-testnet-v3.json] node e2e/deploy-v3.mjs
// Rehearse it first on a fork: anvil --fork-url https://testnet-rpc.elysium.kinetiq.xyz, then RPC_URL=http://127.0.0.1:8545.
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, defineChain, encodeDeployData, formatEther, http } from "viem";
import { elysiumTestnet, cloakConfigAbi, cloakFactoryListAbi, privateRouterAbi } from "@cloakely/sdk";
import { bytecode } from "@cloakely/sdk/bytecode";
import { clients, deployBatcher, deployFactory, deployMigrator, deployPrivacy, exempt } from "./lib.mjs";

const v2 = JSON.parse(readFileSync(new URL("../deployments/elysium-testnet-v2.json", import.meta.url), "utf8"));
const v1 = v2.legacy;
const RPC = process.env.RPC_URL || elysiumTestnet.rpcUrls.default.http[0];
const local = RPC.includes("127.0.0.1") || RPC.includes("localhost");
// a local fork takes its chain id from the node (anvil --fork-url … --chain-id 31337 lets local tools sign for it)
const chain = local ? defineChain({ ...elysiumTestnet, id: await createPublicClient({ transport: http(RPC) }).getChainId(), rpcUrls: { default: { http: [RPC] } } }) : elysiumTestnet;
const d = clients(chain, RPC, process.env.DEPLOYER_PK);
const send = async (p) => {
  const r = await d.publicClient.waitForTransactionReceipt({ hash: await p });
  if (r.status !== "success") throw new Error(`reverted: ${r.transactionHash}`);
  return r;
};
const start = await d.publicClient.getBalance({ address: d.account.address });
const config = v2.config;
const [owner, setup] = await Promise.all(["owner", "setupMode"].map((fn) => d.publicClient.readContract({ address: config, abi: cloakConfigAbi, functionName: fn })));
if (owner.toLowerCase() !== d.account.address.toLowerCase() || !setup) throw new Error("the deployer must own CloakConfig, still in setup, to exempt the new contracts from caps");
console.log(`deployer ${d.account.address} · ${formatEther(start)} HYPE · reusing config ${config}`);

// 1. factory (and its helper), on the same rule book
const f = await deployFactory(d.publicClient, d.walletClient, { config });
console.log(`factory ${f.factory} (block ${f.block})`);

// 2. earlier factories as one list, newest first (the order the SDK and site list them in)
const listRc = await send(d.walletClient.sendTransaction({ data: encodeDeployData({ abi: cloakFactoryListAbi, bytecode: bytecode.CloakFactoryList, args: [[v2.factory, v1.factory]] }) }));
const list = listRc.contractAddress;
console.log(`earlier factories ${list} (v2 ${v2.factory}, v1 ${v1.factory})`);

// 3. router: same hashers and WHYPE, pools for v3 launches and for every earlier one
const r = await deployPrivacy(d.publicClient, d.walletClient, f.factory, { config, poseidon2: v2.poseidon2, poseidon3: v2.poseidon3, legacyFactory: list, whype: v2.whype });
console.log(`router ${r.router} (block ${r.block})`);

// 4. a vault for every earlier launch that settled with a pool, so balances can move and keep trading
const n = await d.publicClient.readContract({ address: list, abi: cloakFactoryListAbi, functionName: "launchesCount" });
const opened = [];
for (let i = 0n; i < n; i++) {
  const [auction, token] = await d.publicClient.readContract({ address: list, abi: cloakFactoryListAbi, functionName: "launches", args: [i] });
  const ok = await d.publicClient.simulateContract({ address: r.router, abi: privateRouterAbi, functionName: "createLegacyPool", args: [i], account: d.account }).then(() => true, () => false);
  if (!ok) {
    console.log(`  #${i} ${token} (auction ${auction}): not settled with a pool, skipped`);
    continue;
  }
  await send(d.walletClient.writeContract({ address: r.router, abi: privateRouterAbi, functionName: "createLegacyPool", args: [i] }));
  opened.push(token);
  console.log(`  #${i} vault for ${token}`);
}

// 5. batcher (30 s rounds, as v2) and a migrator from each earlier router
const b = await deployBatcher(d.publicClient, d.walletClient, r.router, { roundSecs: 30, maxSlippageBps: 200, refundAfter: 600, minOrder: 10n ** 12n });
const m2 = await deployMigrator(d.publicClient, d.walletClient, v2.router, r.router);
const m1 = await deployMigrator(d.publicClient, d.walletClient, v1.router, r.router);
await exempt(d.publicClient, d.walletClient, config, [r.router, b.batcher, m2.migrator, m1.migrator]);
console.log(`batcher ${b.batcher} · migrator v2→v3 ${m2.migrator} · migrator v1→v3 ${m1.migrator}`);

const hypePool = await d.publicClient.readContract({ address: r.router, abi: privateRouterAbi, functionName: "hypePool" });
const spent = start - (await d.publicClient.getBalance({ address: d.account.address }));
const out = {
  chainId: chain.id,
  version: 3,
  config,
  verifier: v2.verifier,
  poseidon2: v2.poseidon2,
  poseidon3: v2.poseidon3,
  factory: f.factory,
  factoryBlock: f.block.toString(),
  factoryList: list,
  router: r.router,
  routerBlock: r.block.toString(),
  whype: v2.whype,
  hypePool,
  batcher: b.batcher,
  batcherBlock: b.block.toString(),
  treasury: v2.treasury,
  rules: v2.rules,
  legacyVaults: opened,
  previous: [
    { version: 2, factory: v2.factory, router: v2.router, routerBlock: v2.routerBlock, batcher: v2.batcher, migrator: m2.migrator },
    { version: 1, factory: v1.factory, router: v1.router, routerBlock: v1.routerBlock, batcher: v1.batcher, migrator: m1.migrator },
  ],
  assets: v2.assets,
  deployCost: `${formatEther(spent)} HYPE`,
};
const file = process.env.OUT ?? (local ? "deployments/elysium-testnet-v3.fork.json" : "deployments/elysium-testnet-v3.json");
writeFileSync(new URL(`../${file}`, import.meta.url), JSON.stringify(out, null, 2) + "\n");
console.log(`\nwrote ${file} · spent ${formatEther(spent)} HYPE`);
