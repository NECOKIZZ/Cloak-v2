// Deploy Cloak v2 next to the first deployment and wire it the way mainnet will be:
//   CloakConfig (fees + caps) → factory → router (v1 WHYPE, pools for v1 launches) → batcher → migrator → cap exemptions.
// Setup stays open (owner can still set rules directly) until END_SETUP=1; after that every loosening change waits 3 days.
//   DEPLOYER_PK=0x… [TREASURY=0x…] [END_SETUP=1] node e2e/deploy-v2.mjs
import { writeFileSync } from "node:fs";
import { elysiumTestnet, cloakConfigAbi, privateRouterAbi } from "@cloakely/sdk";
import * as v1 from "./v1/abis.mjs";
import { clients, deployBatcher, deployFactory, deployMigrator, deployPrivacy, exempt, parseEther } from "./lib.mjs";

const v1Dep = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(new URL("../deployments/elysium-testnet-private.json", import.meta.url), "utf8")));
const RPC = process.env.RPC_URL || elysiumTestnet.rpcUrls.default.http[0];
const d = clients(elysiumTestnet, RPC, process.env.DEPLOYER_PK);
const treasury = process.env.TREASURY ?? d.account.address;
const send = async (p) => d.publicClient.waitForTransactionReceipt({ hash: await p });

// stateless pieces of the first deployment are reused: Poseidon hashers, the Groth16 verifier, WHYPE
const LEGACY = {
  factory: v1Dep.factory,
  router: v1Dep.router,
  routerBlock: v1Dep.routerBlock,
  batcher: v1Dep.batcher,
  poseidon2: "0x80d9d0b2bdd42a77d083235662925f2907392723",
  poseidon3: "0xc36ae84e30a13c9463e00f350ee5e507f5f45564",
  verifier: "0xA554AC0150E853DEAC5214cFf9F5001Ad2f441ED",
};
const whype = await d.publicClient.readContract({ address: LEGACY.router, abi: v1.privateRouterAbi, functionName: "whype" });
console.log(`deployer ${d.account.address} · treasury ${treasury} · v1 WHYPE ${whype}`);

// Beta rules: 0.25% on withdrawals (cash outs, private swaps, batch orders), 1.5% of a successful raise.
// Caps: 100 HYPE per deposit and 10,000 HYPE in the HYPE vault; launch tokens 1% of supply per deposit and 10% in
// total; auctions 100 HYPE per bid and 10,000 HYPE in total.
const rules = {
  withdrawFeeBps: 25,
  launchFeeBps: 150,
  treasury,
  caps: { assets: [[whype, parseEther("100"), parseEther("10000")]], defaultBps: [100n, 1000n], auction: [parseEther("100"), parseEther("10000")] },
};
const f = await deployFactory(d.publicClient, d.walletClient, { verifier: LEGACY.verifier, treasury, rules });
console.log(`config ${f.config} · factory ${f.factory}`);
const r = await deployPrivacy(d.publicClient, d.walletClient, f.factory, { config: f.config, poseidon2: LEGACY.poseidon2, poseidon3: LEGACY.poseidon3, legacyFactory: LEGACY.factory, whype });
console.log(`router ${r.router}`);

// pools for every v1 launch that had private trading, so its balances can move and keep trading
const n = await d.publicClient.readContract({ address: LEGACY.router, abi: v1.privateRouterAbi, functionName: "tokensCount" });
const legacyTokens = [];
for (let i = 1n; i < n; i++) legacyTokens.push((await d.publicClient.readContract({ address: LEGACY.router, abi: v1.privateRouterAbi, functionName: "tokens", args: [i] })).toLowerCase());
const launches = Number(await d.publicClient.readContract({ address: LEGACY.factory, abi: v1.cloakFactoryAbi, functionName: "launchesCount" }));
for (let i = 0; i < launches; i++) {
  const [, token] = await d.publicClient.readContract({ address: LEGACY.factory, abi: v1.cloakFactoryAbi, functionName: "launches", args: [BigInt(i)] });
  if (!legacyTokens.includes(token.toLowerCase())) continue;
  await send(d.walletClient.writeContract({ address: r.router, abi: privateRouterAbi, functionName: "createLegacyPool", args: [BigInt(i)] }));
  console.log(`  pool for v1 launch ${i} (${token})`);
}

const b = await deployBatcher(d.publicClient, d.walletClient, r.router, { roundSecs: 30, maxSlippageBps: 200, refundAfter: 600, minOrder: 10n ** 12n });
const m = await deployMigrator(d.publicClient, d.walletClient, LEGACY.router, r.router);
await exempt(d.publicClient, d.walletClient, f.config, [r.router, b.batcher, m.migrator]);
console.log(`batcher ${b.batcher} · migrator ${m.migrator}`);

if (process.env.END_SETUP === "1") {
  await send(d.walletClient.writeContract({ address: f.config, abi: cloakConfigAbi, functionName: "endSetup" }));
  console.log("setup ended: every loosening change now waits 3 days");
}

const [hypePool] = await Promise.all([d.publicClient.readContract({ address: r.router, abi: privateRouterAbi, functionName: "hypePool" })]);
const out = {
  chainId: elysiumTestnet.id,
  version: 2,
  config: f.config,
  verifier: LEGACY.verifier,
  poseidon2: LEGACY.poseidon2,
  poseidon3: LEGACY.poseidon3,
  factory: f.factory,
  factoryBlock: f.block.toString(),
  router: r.router,
  routerBlock: r.block.toString(),
  whype,
  hypePool,
  batcher: b.batcher,
  batcherBlock: b.block.toString(),
  migrator: m.migrator,
  treasury,
  rules: { withdrawFeeBps: 25, launchFeeBps: 150, caps: "WHYPE 100/10,000 HYPE; tokens 1%/10% of supply; auctions 100/10,000 HYPE" },
  legacy: LEGACY,
};
writeFileSync(new URL("../deployments/elysium-testnet-v2.json", import.meta.url), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
