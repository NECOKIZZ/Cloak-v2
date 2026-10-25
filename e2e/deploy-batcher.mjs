// Replace the batcher of the v2 deployment (it holds no funds between rounds) and exempt it from caps.
//   DEPLOYER_PK=0x… node e2e/deploy-batcher.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { elysiumTestnet } from "@cloak/sdk";
import { clients, deployBatcher, exempt } from "./lib.mjs";

const file = new URL("../deployments/elysium-testnet-v2.json", import.meta.url);
const dep = JSON.parse(readFileSync(file, "utf8"));
const d = clients(elysiumTestnet, process.env.RPC_URL || elysiumTestnet.rpcUrls.default.http[0], process.env.DEPLOYER_PK);
const b = await deployBatcher(d.publicClient, d.walletClient, dep.router, { roundSecs: 30, maxSlippageBps: 200, refundAfter: 600, minOrder: 10n ** 12n });
await exempt(d.publicClient, d.walletClient, dep.config, [b.batcher]);
Object.assign(dep, { batcher: b.batcher, batcherBlock: b.block.toString() });
writeFileSync(file, JSON.stringify(dep, null, 2));
console.log(`batcher ${b.batcher} at block ${b.block}`);
