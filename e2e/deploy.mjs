// Deploy CloakFactory. Defaults to Elysium testnet.
//   DEPLOYER_PK=0x… node e2e/deploy.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { anvilLocal, elysiumTestnet } from "@cloakely/sdk";
import { clients, deployFactory } from "./lib.mjs";

const RPC = process.env.RPC_URL ?? elysiumTestnet.rpcUrls.default.http[0];
const local = RPC.includes("127.0.0.1") || RPC.includes("localhost");
const chain = local ? anvilLocal : elysiumTestnet;
if (!process.env.DEPLOYER_PK && !local) throw new Error("set DEPLOYER_PK (a key with testnet HYPE on Elysium)");
const d = clients(chain, RPC, process.env.DEPLOYER_PK ?? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const bal = await d.publicClient.getBalance({ address: d.account.address });
console.log(`deployer ${d.account.address} · ${Number(bal) / 1e18} HYPE`);
const { factory, txHash } = await deployFactory(d.publicClient, d.walletClient);
const block = (await d.publicClient.getTransactionReceipt({ hash: txHash })).blockNumber;
const out = { chainId: chain.id, factory, deployTx: txHash, block: block.toString() };
mkdirSync(new URL("../deployments", import.meta.url), { recursive: true });
writeFileSync(new URL(`../deployments/${local ? "local" : "elysium-testnet"}-factory.json`, import.meta.url), JSON.stringify(out, null, 2));
console.log(out);
