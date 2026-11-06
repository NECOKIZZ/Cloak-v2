// Replaces both batchers with the current build (the crossing price stays within the slippage bound of the price when
// a round opened, the average covers at least one round from its first order, and the net pool swap fills no worse
// than that bound). Same settings as the batchers they replace; each is made cap-exempt (it moves money already inside
// Cloak) and registered, so the keeper, SDK and site pick it up. The old batchers stay on chain: the script refuses to
// switch while either has an order not yet paid out or refunded, since the keeper only follows the newest batcher.
//   DEPLOYER_PK=0x… [RPC_URL=…] node e2e/deploy-batchers.mjs
// Rehearse on a fork first (RPC_URL=http://127.0.0.1:8545): writes deployments/elysium-testnet-v4-batchers.fork.json.
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
const same = (a, b) => a?.toLowerCase() === b?.toLowerCase();
const cfg = { address: v4.config, abi: cloakConfigAbi };
if (!(await pub.readContract({ ...cfg, functionName: "setupMode" }))) throw new Error("CloakConfig is out of setup");
const before = await readRegistry(pub, v4.config);
if (!before.batcher || !before.sharedBatcher) throw new Error("expected a batcher and a shared batcher in the registry");

// every order on the old batchers must be finished (paid or refunded)
for (const [name, address, abi] of [["batcher", before.batcher, privateBatcherAbi], ["shared batcher", before.sharedBatcher, sharedBatcherAbi]]) {
  const n = await pub.readContract({ address, abi, functionName: "ordersCount" });
  const open = [];
  for (let i = 0n; i < n; i++) if (!(await pub.readContract({ address, abi, functionName: "orders", args: [i] }))[3]) open.push(i);
  if (open.length) throw new Error(`the old ${name} ${address} still has open orders ${open.join(", ")}: let the keeper finish (or refund) them first`);
  console.log(`old ${name} ${address}: all ${n} orders finished`);
}

const settingsOf = (address, abi) => Promise.all(["roundSecs", "maxSlippageBps", "refundAfter", "minOrder"].map((f) => pub.readContract({ address, abi, functionName: f })));
const [roundSecs, slip, refundAfter, minOrder] = await settingsOf(before.batcher, privateBatcherAbi);
const shSettings = await settingsOf(before.sharedBatcher, sharedBatcherAbi);

const pr = await send(d.walletClient.deployContract({ abi: privateBatcherAbi, bytecode: bytecode.PrivateBatcher, args: [before.router, roundSecs, slip, refundAfter, minOrder] }));
const sr = await send(d.walletClient.deployContract({ abi: sharedBatcherAbi, bytecode: bytecode.SharedBatcher, args: [before.shared, v4.hypePool, v4.whype, ...shSettings] }));
const batcher = pr.contractAddress;
const sharedBatcher = sr.contractAddress;
for (const a of [batcher, sharedBatcher]) await send(d.walletClient.writeContract({ ...cfg, functionName: "setCapExempt", args: [a, true] }));
await register(pub, d.walletClient, v4.config, "batcher", batcher, before.version, pr.blockNumber);
await register(pub, d.walletClient, v4.config, "sharedBatcher", sharedBatcher, before.version, sr.blockNumber);

const reg = await readRegistry(pub, v4.config);
if (!same(reg.batcher, batcher) || !same(reg.sharedBatcher, sharedBatcher) || !same(reg.router, before.router) || !same(reg.shared, before.shared)) throw new Error("registry mismatch");
for (const a of [batcher, sharedBatcher]) if (!(await pub.readContract({ ...cfg, functionName: "capExempt", args: [a] }))) throw new Error(`${a} is not cap-exempt`);
const [pRouter, sShared, sPool] = await Promise.all([
  pub.readContract({ address: batcher, abi: privateBatcherAbi, functionName: "router" }),
  pub.readContract({ address: sharedBatcher, abi: sharedBatcherAbi, functionName: "shared" }),
  pub.readContract({ address: sharedBatcher, abi: sharedBatcherAbi, functionName: "hypePool" }),
]);
if (!same(pRouter, before.router) || !same(sShared, before.shared) || !same(sPool, v4.hypePool)) throw new Error("a new batcher is misconfigured");

const spent = start - (await pub.getBalance({ address: d.account.address }));
const retired = [...(v4.retiredBatchers ?? []), { batcher: before.batcher, sharedBatcher: before.sharedBatcher, until: pr.blockNumber.toString() }];
const out = { ...v4, batcher, batcherBlock: pr.blockNumber.toString(), sharedBatcher, sharedBatcherBlock: sr.blockNumber.toString(), retiredBatchers: retired };
const outFile = local ? new URL("../deployments/elysium-testnet-v4-batchers.fork.json", import.meta.url) : file;
writeFileSync(outFile, JSON.stringify(out, null, 2) + "\n");
console.log(`batcher ${batcher} · shared batcher ${sharedBatcher} (${roundSecs}s rounds) · wrote ${outFile.pathname.split("/").pop()} · spent ${formatEther(spent)} HYPE`);
