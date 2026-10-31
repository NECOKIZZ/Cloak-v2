// Deploy Cloak v4, the permanent layout (docs/VAULT.md), next to v1, v2 and v3:
//   a new CloakConfig with v3's rules and verifier → the registry, listing v1, v2 and v3 with their real start blocks →
//   a factory (auctions with claimPrivate) → CloakVaults with a HYPE vault (v1's WHYPE), a USDC vault and a vault for
//   every earlier launch that settled with a pool → a router and batcher around them → one migrator from every earlier
//   router and v2's USDC vault → cap exemptions. Hashers, WHYPE and the verifier are reused: they hold no state.
//   DEPLOYER_PK=0x… [RPC_URL=…] [OUT=deployments/elysium-testnet-v4.json] node e2e/deploy-v4.mjs
// Rehearse on a fork first: anvil --fork-url https://testnet-rpc.elysium.kinetiq.xyz --chain-id 31337, then RPC_URL=http://127.0.0.1:8545.
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, defineChain, formatEther, http } from "viem";
import { cloakConfigAbi, cloakFactoryAbi, cloakVaultsAbi, elysiumTestnet, readRegistry } from "@cloakely/sdk";
import { assetVault, clients, deployBatcher, deployFactory, deployMigrator, deployPrivacy, exempt, register } from "./lib.mjs";

const v3 = JSON.parse(readFileSync(new URL("../deployments/elysium-testnet-v3.json", import.meta.url), "utf8"));
const RPC = process.env.RPC_URL || elysiumTestnet.rpcUrls.default.http[0];
const local = RPC.includes("127.0.0.1") || RPC.includes("localhost");
const chain = local ? defineChain({ ...elysiumTestnet, id: await createPublicClient({ transport: http(RPC) }).getChainId(), rpcUrls: { default: { http: [RPC] } } }) : elysiumTestnet;
const d = clients(chain, RPC, process.env.DEPLOYER_PK);
const pub = d.publicClient;
const send = async (p) => {
  const r = await pub.waitForTransactionReceipt({ hash: await p });
  if (r.status !== "success") throw new Error(`reverted: ${r.transactionHash}`);
  return r;
};
const start = await pub.getBalance({ address: d.account.address });
console.log(`deployer ${d.account.address} · ${formatEther(start)} HYPE`);

// Earlier deployments, oldest first, with the blocks they started at (deployments/*.json)
const USDC = v3.assets[0];
const history = [
  { version: 1, factory: ["0x1dc1ea9837ecbd31ec74f0d558e1db1c303a7e1c", 10958927n], router: ["0xfa2574cfc3afb8f7d3a0651fa2111ff4e3d2fc41", 10973723n], batcher: ["0xf6582cc5a84fccf74e571e652fb7b603a2c25812", 10980614n], pools: [] },
  // the USDC vault served v2 and then v3, so its notes may be under either version's keys
  { version: 2, factory: ["0xc1fc14e84cbbd10f75dad9d91bf50f47c48757fc", 15855986n], router: ["0xd51e731467c49991496329c2b7979cb1aa220ee2", 15856031n], batcher: ["0xa13ffd763a8cccfea1b868c616291723579ddb77", 15860063n], pools: [[USDC.pool, BigInt(USDC.fromBlock)]] },
  { version: 3, factory: [v3.factory, BigInt(v3.factoryBlock)], router: [v3.router, BigInt(v3.routerBlock)], batcher: [v3.batcher, BigInt(v3.batcherBlock)], pools: [[USDC.pool, BigInt(USDC.fromBlock)]] },
];

// 1. config with v3's rules (fees, caps) and verifier, still in setup
const old = { address: v3.config, abi: cloakConfigAbi };
const [wf, lf, treasury, [, whypePer, whypeTotal], [, usdcPer, usdcTotal], defaultBps, auction] = await Promise.all([
  pub.readContract({ ...old, functionName: "withdrawFeeBps" }),
  pub.readContract({ ...old, functionName: "launchFeeBps" }),
  pub.readContract({ ...old, functionName: "feeRecipient" }),
  pub.readContract({ ...old, functionName: "limitOf", args: [v3.whype] }),
  pub.readContract({ ...old, functionName: "limitOf", args: [USDC.token] }),
  pub.readContract({ ...old, functionName: "defaultLimitBps" }),
  pub.readContract({ ...old, functionName: "auctionLimit" }),
]);
const f = await deployFactory(pub, d.walletClient, {
  verifier: v3.verifier,
  treasury,
  rules: { withdrawFeeBps: wf, launchFeeBps: lf, treasury, caps: { assets: [[v3.whype, whypePer, whypeTotal], [USDC.token, usdcPer, usdcTotal]], defaultBps: defaultBps, auction: auction } },
});
const config = f.config;
console.log(`config ${config} · factory ${f.factory} (block ${f.block})`);

// 2. the registry: earlier deployments first, so the newest router (v4's, registered next) is the current one
const cfg = (functionName, args) => send(d.walletClient.writeContract({ address: config, abi: cloakConfigAbi, functionName, args }));
for (const h of history) {
  for (const kind of ["factory", "router", "batcher"]) await register(pub, d.walletClient, config, kind, h[kind][0], h.version, h[kind][1]);
  for (const [pool, block] of h.pools) await register(pub, d.walletClient, config, "pool", pool, h.version, block);
  await cfg("addLaunchFactory", [h.factory[0]]);
}

// 3. permanent vaults (v1's WHYPE, so moved HYPE needs no unwrapping), router, USDC vault
const p = await deployPrivacy(pub, d.walletClient, f.factory, { config, poseidon2: v3.poseidon2, poseidon3: v3.poseidon3, whype: v3.whype, factoryBlock: f.block });
console.log(`vaults ${p.vaults} (block ${p.vaultsBlock}) · router ${p.router} (block ${p.block})`);
const usdcVault = await assetVault(pub, d.walletClient, config, p.vaults, USDC.token);
console.log(`USDC vault ${usdcVault}`);

// 4. a permanent vault for every earlier launch that settled with a pool
const opened = [];
for (const h of history) {
  const n = await pub.readContract({ address: h.factory[0], abi: cloakFactoryAbi, functionName: "launchesCount" });
  for (let i = 0n; i < n; i++) {
    const c = { address: p.vaults, abi: cloakVaultsAbi, functionName: "createPool", args: [h.factory[0], i] };
    if (!(await pub.simulateContract({ ...c, account: d.account }).then(() => true, () => false))) continue;
    const r = await send(d.walletClient.writeContract(c));
    opened.push({ version: h.version, index: Number(i), tx: r.transactionHash });
  }
}
console.log(`opened ${opened.length} vaults for earlier launches`);

// 5. batcher (30 s rounds) and one migrator from every earlier router and v2's USDC vault
const b = await deployBatcher(pub, d.walletClient, p.router, { roundSecs: 30, maxSlippageBps: 200, refundAfter: 600, minOrder: 10n ** 12n });
const m = await deployMigrator(pub, d.walletClient, history.map((h) => h.router[0]), p.router, [USDC.pool]);
await register(pub, d.walletClient, config, "batcher", b.batcher, 4, b.block);
await register(pub, d.walletClient, config, "migrator", m.migrator, 4, m.block);
await exempt(pub, d.walletClient, config, [p.router, b.batcher, m.migrator]);
console.log(`batcher ${b.batcher} · migrator ${m.migrator}`);

// 6. read it all back through the registry, as apps will
const reg = await readRegistry(pub, config);
const same = (a, b) => a?.toLowerCase() === b?.toLowerCase();
if (!same(reg.router, p.router) || !same(reg.vaults, p.vaults) || !same(reg.migrator, m.migrator) || reg.previous.length !== 3) throw new Error("registry mismatch");
const tokens = await pub.readContract({ address: p.vaults, abi: cloakVaultsAbi, functionName: "tokensCount" });
const spent = start - (await pub.getBalance({ address: d.account.address }));
const out = {
  chainId: chain.id,
  version: 4,
  config,
  verifier: v3.verifier,
  poseidon2: v3.poseidon2,
  poseidon3: v3.poseidon3,
  vaults: p.vaults,
  vaultsBlock: p.vaultsBlock.toString(),
  factory: f.factory,
  factoryBlock: f.block.toString(),
  router: p.router,
  routerBlock: p.block.toString(),
  whype: p.whype,
  hypePool: await pub.readContract({ address: p.vaults, abi: cloakVaultsAbi, functionName: "poolOf", args: [p.whype] }),
  batcher: b.batcher,
  batcherBlock: b.block.toString(),
  migrator: m.migrator,
  treasury,
  rules: { withdrawFeeBps: wf, launchFeeBps: lf, caps: `WHYPE ${formatEther(whypePer)}/${formatEther(whypeTotal)} HYPE; USDC ${Number(usdcPer) / 1e6}/${Number(usdcTotal) / 1e6}; tokens ${defaultBps[0]}/${defaultBps[1]} bps of supply` },
  vaultCount: Number(tokens),
  assets: [{ symbol: "USDC", token: USDC.token, pool: usdcVault, decimals: 6, fromBlock: p.vaultsBlock.toString() }],
  previous: history
    .slice()
    .reverse()
    .map((h) => ({ version: h.version, factory: h.factory[0], factoryBlock: h.factory[1].toString(), router: h.router[0], routerBlock: h.router[1].toString(), batcher: h.batcher[0], pools: h.pools.map(([pool, block]) => ({ pool, fromBlock: block.toString() })) })),
  earlierLaunchVaults: opened,
  deployCost: `${formatEther(spent)} HYPE`,
};
const file = process.env.OUT ?? (local ? "deployments/elysium-testnet-v4.fork.json" : "deployments/elysium-testnet-v4.json");
writeFileSync(new URL(`../${file}`, import.meta.url), JSON.stringify(out, null, 2) + "\n");
console.log(`\nwrote ${file} · ${out.vaultCount} vaults · spent ${formatEther(spent)} HYPE`);
