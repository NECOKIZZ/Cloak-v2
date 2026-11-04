// Add auctions of existing NFTs to Cloak v4: one CloakEscrowDropFactory on the same CloakConfig (launch fee, deposit
// caps, treasury). Nothing already deployed changes. Writes escrowDropFactory into deployments/elysium-testnet-v4.json.
//   DEPLOYER_PK=0x… [RPC_URL=…] node e2e/deploy-escrow.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { formatEther } from "viem";
import { cloakEscrowDropFactoryAbi, elysiumTestnet } from "@cloakely/sdk";
import { bytecode } from "@cloakely/sdk/bytecode";
import { clients } from "./lib.mjs";

const file = new URL("../deployments/elysium-testnet-v4.json", import.meta.url);
const v4 = JSON.parse(readFileSync(file, "utf8"));
const RPC = process.env.RPC_URL || elysiumTestnet.rpcUrls.default.http[0];
const d = clients(elysiumTestnet, RPC, process.env.DEPLOYER_PK);
console.log(`deployer ${d.account.address} · ${formatEther(await d.publicClient.getBalance({ address: d.account.address }))} HYPE`);
if (v4.escrowDropFactory && !process.env.FORCE) throw new Error(`an escrow factory is already recorded (${v4.escrowDropFactory}); FORCE=1 to deploy another`);
const hash = await d.walletClient.deployContract({ abi: cloakEscrowDropFactoryAbi, bytecode: bytecode.CloakEscrowDropFactory, args: [v4.config] });
const r = await d.publicClient.waitForTransactionReceipt({ hash });
if (r.status !== "success") throw new Error(`reverted ${hash}`);
const cfg = await d.publicClient.readContract({ address: r.contractAddress, abi: cloakEscrowDropFactoryAbi, functionName: "config" });
if (cfg.toLowerCase() !== v4.config.toLowerCase()) throw new Error("factory points at the wrong config");
writeFileSync(file, JSON.stringify({ ...v4, escrowDropFactory: r.contractAddress }, null, 2) + "\n");
console.log(`CloakEscrowDropFactory ${r.contractAddress} at block ${r.blockNumber} (tx ${hash})`);
