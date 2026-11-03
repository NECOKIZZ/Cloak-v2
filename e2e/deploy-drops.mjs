// Add sealed NFT drops to Cloak v4: one CloakDropFactory on the same CloakConfig (the launch fee, deposit caps and
// treasury drops use). Writes dropFactory + dropFactoryBlock into deployments/elysium-testnet-v4.json.
//   DEPLOYER_PK=0x… [RPC_URL=…] node e2e/deploy-drops.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { formatEther } from "viem";
import { cloakDropFactoryAbi, elysiumTestnet } from "@cloakely/sdk";
import { bytecode } from "@cloakely/sdk/bytecode";
import { clients } from "./lib.mjs";

const file = new URL("../deployments/elysium-testnet-v4.json", import.meta.url);
const v4 = JSON.parse(readFileSync(file, "utf8"));
const RPC = process.env.RPC_URL || elysiumTestnet.rpcUrls.default.http[0];
const d = clients(elysiumTestnet, RPC, process.env.DEPLOYER_PK);
console.log(`deployer ${d.account.address} · ${formatEther(await d.publicClient.getBalance({ address: d.account.address }))} HYPE`);
if (v4.dropFactory && !process.env.FORCE) throw new Error(`a drop factory is already recorded (${v4.dropFactory}); FORCE=1 to deploy another`);
const hash = await d.walletClient.deployContract({ abi: cloakDropFactoryAbi, bytecode: bytecode.CloakDropFactory, args: [v4.config, "https://cloak.boblabs.tech/api/nft/"] });
const r = await d.publicClient.waitForTransactionReceipt({ hash });
if (r.status !== "success") throw new Error(`reverted ${hash}`);
const cfg = await d.publicClient.readContract({ address: r.contractAddress, abi: cloakDropFactoryAbi, functionName: "config" });
if (cfg.toLowerCase() !== v4.config.toLowerCase()) throw new Error("factory points at the wrong config");
writeFileSync(file, JSON.stringify({ ...v4, dropFactory: r.contractAddress, dropFactoryBlock: Number(r.blockNumber) }, null, 2) + "\n");
console.log(`CloakDropFactory ${r.contractAddress} at block ${r.blockNumber} (tx ${hash})`);
