// Deploys CloakReceive (private receive addresses) next to the v4 vaults and registers it as "receive", so the keeper,
// SDK and site pick it up. It holds nothing and has no owner; it only deposits into the existing vaults.
//   DEPLOYER_PK=0x… [RPC_URL=…] node e2e/deploy-receive.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { cloakReceiveAbi, elysiumTestnet, readRegistry, receiveAddressOf } from "@cloakely/sdk";
import { bytecode } from "@cloakely/sdk/bytecode";
import { clients, register } from "./lib.mjs";

const file = new URL("../deployments/elysium-testnet-v4.json", import.meta.url);
const v4 = JSON.parse(readFileSync(file, "utf8"));
const RPC = process.env.RPC_URL || elysiumTestnet.rpcUrls.default.http[0];
const d = clients(elysiumTestnet, RPC, process.env.DEPLOYER_PK);
const pub = d.publicClient;
const reg = await readRegistry(pub, v4.config);
if (reg.receive) throw new Error(`already registered: ${reg.receive}`);
const r = await pub.waitForTransactionReceipt({ hash: await d.walletClient.deployContract({ abi: cloakReceiveAbi, bytecode: bytecode.CloakReceive, args: [reg.vaults, reg.shared ?? "0x0000000000000000000000000000000000000000", v4.whype] }) });
if (r.status !== "success") throw new Error("deploy reverted");
const receive = r.contractAddress;
// the SDK and the contract agree on addresses
const h = await pub.readContract({ address: receive, abi: cloakReceiveAbi, functionName: "boxCodeHash" });
const p = { pubKey: 7n, blinding: 9n, memo: "0xaabb", maxFeeBps: 100, rescuer: d.account.address };
const onChain = await pub.readContract({ address: receive, abi: cloakReceiveAbi, functionName: "addressOf", args: [p] });
if (onChain.toLowerCase() !== receiveAddressOf(receive, h, p).toLowerCase()) throw new Error("SDK and contract disagree on the receive address");
await register(pub, d.walletClient, v4.config, "receive", receive, reg.version, r.blockNumber);
writeFileSync(file, JSON.stringify({ ...v4, receive, receiveBlock: r.blockNumber.toString() }, null, 2) + "\n");
console.log(`CloakReceive ${receive} (block ${r.blockNumber}), registered; SDK and contract agree on addresses`);
