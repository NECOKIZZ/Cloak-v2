// Add the Uniswap launch factory to Cloak v4, next to v4's first factory (nothing else changes: same config, vaults,
// router and batcher). Each launch from it opens a standard Uniswap V2 pool (token / WHYPE) at the clearing price, with
// the LP burned or locked, behind a CloakV2Market so private swaps and sealed batches trade it like any Cloak market.
//   DEPLOYER_PK=0x… [RPC_URL=…] node e2e/deploy-uniswap.mjs
// Rehearse on a fork first: anvil --fork-url https://testnet-rpc.elysium.kinetiq.xyz --chain-id 31337, then RPC_URL=http://127.0.0.1:8545
// (writes deployments/elysium-testnet-v4-uniswap.fork.json and leaves the real record alone).
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, defineChain, formatEther, http } from "viem";
import { cloakConfigAbi, cloakFactoryAbi, cloakSeederAbi, elysiumTestnet, readRegistry } from "@cloakely/sdk";
import { clients, deployFactory, register } from "./lib.mjs";

// Elysium testnet's Uniswap V2 (1,245 pairs, "Uniswap V2" LP tokens, 0.3% fee) and the WHYPE its pools pair with
const UNISWAP = { factory: "0xb2f8ad730e9d05d333c7861184aad0bff1785dd0", weth: "0xcd57f65c2b0e5881cfc2e609f7cd53b746e1f234", feeNum: 997 };

const file = new URL("../deployments/elysium-testnet-v4.json", import.meta.url);
const v4 = JSON.parse(readFileSync(file, "utf8"));
const RPC = process.env.RPC_URL || elysiumTestnet.rpcUrls.default.http[0];
const local = RPC.includes("127.0.0.1") || RPC.includes("localhost");
const chain = local ? defineChain({ ...elysiumTestnet, id: await createPublicClient({ transport: http(RPC) }).getChainId(), rpcUrls: { default: { http: [RPC] } } }) : elysiumTestnet;
const d = clients(chain, RPC, process.env.DEPLOYER_PK);
const pub = d.publicClient;
const start = await pub.getBalance({ address: d.account.address });
console.log(`deployer ${d.account.address} · ${formatEther(start)} HYPE`);

const cfg = { address: v4.config, abi: cloakConfigAbi };
if (!(await pub.readContract({ ...cfg, functionName: "setupMode" }))) throw new Error("CloakConfig is out of setup: a new factory has to go through the 3-day queue");
const before = await readRegistry(pub, v4.config);
const first = before.factory; // v4's first factory
const vestingDeployer = await pub.readContract({ address: first, abi: cloakFactoryAbi, functionName: "vestingDeployer" });

// 1. seeder + factory (the vesting deployer is reused: it holds no state)
const f = await deployFactory(pub, d.walletClient, { config: v4.config, uniswap: UNISWAP, vestingDeployer });
console.log(`seeder ${f.seeder} · factory ${f.factory} (block ${f.block})`);
const s = { address: f.seeder, abi: cloakSeederAbi };
const [uf, w, fee] = await Promise.all(["uniFactory", "weth", "feeNum"].map((functionName) => pub.readContract({ ...s, functionName })));
if (uf.toLowerCase() !== UNISWAP.factory || w.toLowerCase() !== UNISWAP.weth || fee !== 997n) throw new Error("seeder misconfigured");

// 2. registry: the new factory becomes the current one for v4; the first keeps listing (earlierFactories)
await register(pub, d.walletClient, v4.config, "factory", f.factory, before.version, f.block);
const h = await d.walletClient.writeContract({ ...cfg, functionName: "addLaunchFactory", args: [f.factory] });
await pub.waitForTransactionReceipt({ hash: h });

// 3. read it back as apps will
const reg = await readRegistry(pub, v4.config);
const same = (a, b) => a?.toLowerCase() === b?.toLowerCase();
if (!same(reg.factory, f.factory) || !same(reg.earlierFactories[0], first) || !same(reg.router, before.router) || !same(reg.vaults, before.vaults)) throw new Error("registry mismatch");
if (!(await pub.readContract({ ...cfg, functionName: "isLaunchFactory", args: [f.factory] }))) throw new Error("not a launch factory");

const spent = start - (await pub.getBalance({ address: d.account.address }));
const out = {
  ...v4,
  factory: f.factory,
  factoryBlock: f.block.toString(),
  earlierFactories: [first],
  firstFactoryBlock: v4.firstFactoryBlock ?? v4.factoryBlock,
  seeder: f.seeder,
  uniswap: { v2Factory: UNISWAP.factory, whype: UNISWAP.weth, fee: "0.3%" },
  uniswapDeployCost: `${formatEther(spent)} HYPE`,
};
const outFile = local ? new URL("../deployments/elysium-testnet-v4-uniswap.fork.json", import.meta.url) : file;
writeFileSync(outFile, JSON.stringify(out, null, 2) + "\n");
console.log(`\nwrote ${outFile.pathname.split("/").pop()} · current factory ${f.factory}, earlier ${first} · spent ${formatEther(spent)} HYPE`);
