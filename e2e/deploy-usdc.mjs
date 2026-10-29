// Deploy the shielded USDC pool next to Cloak v2 and set its beta caps (while CloakConfig is still in setup).
//   DEPLOYER_PK=0x… [USDC=0x…] [PER=1000] [TOTAL=50000] [DRY=1] node e2e/deploy-usdc.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { encodeDeployData, formatEther, parseUnits } from "viem";
import { elysiumTestnet, cloakConfigAbi, privateRouterAbi, shieldedPoolAbi } from "@cloakely/sdk";
import { bytecode } from "@cloakely/sdk/bytecode";
import { clients } from "./lib.mjs";

const file = new URL("../deployments/elysium-testnet-v2.json", import.meta.url);
const dep = JSON.parse(readFileSync(file, "utf8"));
const USDC = process.env.USDC ?? "0x7D29d8047B905000459c0E80c34a26CeedcB47b2"; // Elysium testnet USDC (bridged from Circle's USDC on HyperEVM)
const RPC = process.env.RPC_URL || elysiumTestnet.rpcUrls.default.http[0];
const d = clients(elysiumTestnet, RPC, process.env.DEPLOYER_PK);
const send = async (p) => d.publicClient.waitForTransactionReceipt({ hash: await p });

const [p2, p3] = await Promise.all(["hasher2", "hasher3"].map((fn) => d.publicClient.readContract({ address: dep.router, abi: privateRouterAbi, functionName: fn })));
const args = [dep.config, p2, p3, USDC];
const data = encodeDeployData({ abi: shieldedPoolAbi, bytecode: bytecode.ShieldedPool, args });
const gas = await d.publicClient.estimateGas({ account: d.account, data });
const gasPrice = await d.publicClient.getGasPrice();
const bal = await d.publicClient.getBalance({ address: d.account.address });
console.log(`deployer ${d.account.address} has ${formatEther(bal)} HYPE · pool deploy ≈ ${gas} gas ≈ ${formatEther(gas * gasPrice)} HYPE`);
if (process.env.DRY) process.exit(0);

const rc = await send(d.walletClient.deployContract({ abi: shieldedPoolAbi, bytecode: bytecode.ShieldedPool, args }));
console.log(`USDC pool ${rc.contractAddress} (block ${rc.blockNumber}) ${rc.transactionHash}`);
const per = parseUnits(process.env.PER ?? "1000", 6);
const total = parseUnits(process.env.TOTAL ?? "50000", 6);
const setup = await d.publicClient.readContract({ address: dep.config, abi: cloakConfigAbi, functionName: "setupMode" });
if (setup) {
  const h = await send(d.walletClient.writeContract({ address: dep.config, abi: cloakConfigAbi, functionName: "setLimit", args: [USDC, per, total] }));
  console.log(`caps: ${process.env.PER ?? 1000} USDC per deposit, ${process.env.TOTAL ?? 50000} in the pool ${h.transactionHash}`);
} else console.log("setup has ended: queue setLimit through the 3-day timelock");

dep.assets = [{ symbol: "USDC", token: USDC, pool: rc.contractAddress, decimals: 6, fromBlock: rc.blockNumber.toString(), caps: `${process.env.PER ?? 1000}/${process.env.TOTAL ?? 50000} USDC` }];
writeFileSync(file, JSON.stringify(dep, null, 2) + "\n");
console.log("wrote deployments/elysium-testnet-v2.json");
