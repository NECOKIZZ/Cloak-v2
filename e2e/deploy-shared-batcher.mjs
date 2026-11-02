// Batch rounds for the shared launch-token vault: deploys a SharedBatcher with the main batcher's settings (30 s rounds,
// 2% price tolerance, refund after 10 minutes, smallest order 1e12), makes it cap-exempt (it moves money already inside
// Cloak) and registers it as "sharedBatcher". Nothing that exists changes.
//   DEPLOYER_PK=0x… [RPC_URL=…] node e2e/deploy-shared-batcher.mjs
// Rehearse on a fork first (RPC_URL=http://127.0.0.1:8545): writes deployments/elysium-testnet-v4-sharedbatch.fork.json.
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, defineChain, formatEther, http } from "viem";
import { cloakConfigAbi, elysiumTestnet, privateBatcherAbi, readRegistry, sharedBatcherAbi } from "@cloakely/sdk";
import { bytecode } from "@cloakely/sdk/bytecode";
import { clients, register } from "./lib.mjs";

const file = new URL("../deployments/elysium-testnet-v4.json", import.meta.url);
const v4 = JSON.parse(readFileSync(file, "utf8"));
const RPC = process.env.RPC_URL || elysiumTestnet.rpcUrls.default.http[0];
const local = RPC.includes("127.0.0.1") || RPC.includes("localhost");
const chain = local ? defineChain({ ...elysiumTestnet, id: await createPublicClient({ transport: http(RPC) }).getChainId(), rpcUrls: { default: { http: [RPC] } } }) : elysiumTestnet;
const d = clients(chain, RPC, process.env.DEPLOYER_PK);
const pub = d.publicClient;
const start = await pub.getBalance({ address: d.account.address });
const send = async (p) => {
  const r = await pub.waitForTransactionReceipt({ hash: await p });
  if (r.status !== "success") throw new Error(`reverted: ${r.transactionHash}`);
  return r;
};
const cfg = { address: v4.config, abi: cloakConfigAbi };
if (!(await pub.readContract({ ...cfg, functionName: "setupMode" }))) throw new Error("CloakConfig is out of setup");
const before = await readRegistry(pub, v4.config);
if (!before.shared) throw new Error("deploy the shared vault first (e2e/deploy-shared.mjs)");
if (before.sharedBatcher) throw new Error(`a shared batcher is already registered: ${before.sharedBatcher}`);

// the same settings as the main batcher
const main = { address: before.batcher, abi: privateBatcherAbi };
const [roundSecs, slip, refundAfter, minOrder] = await Promise.all(["roundSecs", "maxSlippageBps", "refundAfter", "minOrder"].map((f) => pub.readContract({ ...main, functionName: f })));
const r = await send(d.walletClient.deployContract({ abi: sharedBatcherAbi, bytecode: bytecode.SharedBatcher, args: [before.shared, v4.hypePool, v4.whype, roundSecs, slip, refundAfter, minOrder] }));
const batcher = r.contractAddress;
await send(d.walletClient.writeContract({ ...cfg, functionName: "setCapExempt", args: [batcher, true] }));
await register(pub, d.walletClient, v4.config, "sharedBatcher", batcher, before.version, r.blockNumber);

const reg = await readRegistry(pub, v4.config);
const same = (a, b) => a?.toLowerCase() === b?.toLowerCase();
if (!same(reg.sharedBatcher, batcher) || !same(reg.shared, before.shared) || !same(reg.batcher, before.batcher) || !same(reg.router, before.router)) throw new Error("registry mismatch");
const b = { address: batcher, abi: sharedBatcherAbi };
const [sv, hp] = await Promise.all([pub.readContract({ ...b, functionName: "shared" }), pub.readContract({ ...b, functionName: "hypePool" })]);
if (!same(sv, before.shared) || !same(hp, v4.hypePool) || !(await pub.readContract({ ...cfg, functionName: "capExempt", args: [batcher] }))) throw new Error("shared batcher misconfigured");

const spent = start - (await pub.getBalance({ address: d.account.address }));
const out = { ...v4, shared: before.shared, sharedRouter: before.sharedRouter, sharedBatcher: batcher, sharedBatcherBlock: r.blockNumber.toString() };
const outFile = local ? new URL("../deployments/elysium-testnet-v4-sharedbatch.fork.json", import.meta.url) : file;
writeFileSync(outFile, JSON.stringify(out, null, 2) + "\n");
console.log(`shared batcher ${batcher} (block ${r.blockNumber}, ${roundSecs}s rounds) · wrote ${outFile.pathname.split("/").pop()} · spent ${formatEther(spent)} HYPE`);
