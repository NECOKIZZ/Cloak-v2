// Add WL spot sales to Cloak v4: one CloakSpotBook over the live CloakDropFactory. Nothing already deployed changes.
// Writes spotBook into deployments/elysium-testnet-v4.json.
//   DEPLOYER_PK=0x… [RPC_URL=…] node e2e/deploy-spots.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { formatEther } from "viem";
import { cloakSpotBookAbi, elysiumTestnet } from "@cloakely/sdk";
import { bytecode } from "@cloakely/sdk/bytecode";
import { clients } from "./lib.mjs";

const file = new URL("../deployments/elysium-testnet-v4.json", import.meta.url);
const v4 = JSON.parse(readFileSync(file, "utf8"));
if (!v4.dropFactory) throw new Error("deploy the drop factory first");
const RPC = process.env.RPC_URL || elysiumTestnet.rpcUrls.default.http[0];
const d = clients(elysiumTestnet, RPC, process.env.DEPLOYER_PK);
console.log(`deployer ${d.account.address} · ${formatEther(await d.publicClient.getBalance({ address: d.account.address }))} HYPE`);
if (v4.spotBook && !process.env.FORCE) throw new Error(`a spot book is already recorded (${v4.spotBook}); FORCE=1 to deploy another`);
const hash = await d.walletClient.deployContract({ abi: cloakSpotBookAbi, bytecode: bytecode.CloakSpotBook, args: [v4.dropFactory] });
const r = await d.publicClient.waitForTransactionReceipt({ hash });
if (r.status !== "success") throw new Error(`reverted ${hash}`);
const f = await d.publicClient.readContract({ address: r.contractAddress, abi: cloakSpotBookAbi, functionName: "factory" });
if (f.toLowerCase() !== v4.dropFactory.toLowerCase()) throw new Error("book points at the wrong factory");
writeFileSync(file, JSON.stringify({ ...v4, spotBook: r.contractAddress }, null, 2) + "\n");
console.log(`CloakSpotBook ${r.contractAddress} at block ${r.blockNumber} (tx ${hash})`);
