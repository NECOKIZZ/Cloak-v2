// Add creator fees to Cloak v4: a CloakFeeLocker and a launch factory that can lock a launch's Uniswap LP in it forever,
// paying the pool's trading fees to the creator. Same config, vaults, router, batcher and seeder; the earlier v4
// factories keep listing (earlierFactories in the registry).
//   DEPLOYER_PK=0x… [RPC_URL=…] node e2e/deploy-fees.mjs
// Rehearse on a fork first (RPC_URL=http://127.0.0.1:8545): writes deployments/elysium-testnet-v4-fees.fork.json.
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, defineChain, formatEther, http } from "viem";
import { cloakConfigAbi, cloakFactoryAbi, cloakFeeLockerAbi, elysiumTestnet, readRegistry } from "@cloakely/sdk";
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
console.log(`deployer ${d.account.address} · ${formatEther(start)} HYPE`);
const send = async (p) => {
  const r = await pub.waitForTransactionReceipt({ hash: await p });
  if (r.status !== "success") throw new Error(`reverted: ${r.transactionHash}`);
  return r;
};

const cfg = { address: v4.config, abi: cloakConfigAbi };
if (!(await pub.readContract({ ...cfg, functionName: "setupMode" }))) throw new Error("CloakConfig is out of setup: a new factory has to go through the 3-day queue");
const before = await readRegistry(pub, v4.config);
const prev = before.factory; // the Uniswap factory (Nov 2)
const f = { address: prev, abi: cloakFactoryAbi };
const [seeder, vestingDeployer] = await Promise.all([pub.readContract({ ...f, functionName: "seeder" }), pub.readContract({ ...f, functionName: "vestingDeployer" })]);

// 1. the locker (no owner, no settings), then the factory around it, reusing the seeder and vesting deployer
const lr = await send(d.walletClient.deployContract({ abi: cloakFeeLockerAbi, bytecode: bytecode.CloakFeeLocker, args: [] }));
const locker = lr.contractAddress;
const fr = await send(d.walletClient.deployContract({ abi: cloakFactoryAbi, bytecode: bytecode.CloakFactory, args: [v4.config, vestingDeployer, seeder, locker] }));
const factory = fr.contractAddress;
console.log(`locker ${locker} · factory ${factory} (block ${fr.blockNumber}) · seeder ${seeder}`);
const [fl, fs] = await Promise.all([pub.readContract({ address: factory, abi: cloakFactoryAbi, functionName: "feeLocker" }), pub.readContract({ address: factory, abi: cloakFactoryAbi, functionName: "seeder" })]);
if (fl.toLowerCase() !== locker.toLowerCase() || fs.toLowerCase() !== seeder.toLowerCase()) throw new Error("factory misconfigured");

// 2. registry: the new factory is current for v4; the two earlier v4 factories keep listing
await register(pub, d.walletClient, v4.config, "factory", factory, before.version, fr.blockNumber);
await send(d.walletClient.writeContract({ ...cfg, functionName: "addLaunchFactory", args: [factory] }));

const reg = await readRegistry(pub, v4.config);
const same = (a, b) => a?.toLowerCase() === b?.toLowerCase();
if (!same(reg.factory, factory) || !same(reg.earlierFactories[0], prev) || reg.earlierFactories.length !== before.earlierFactories.length + 1 || !same(reg.router, before.router)) throw new Error("registry mismatch");

const spent = start - (await pub.getBalance({ address: d.account.address }));
const out = {
  ...v4,
  factory,
  factoryBlock: fr.blockNumber.toString(),
  earlierFactories: reg.earlierFactories,
  feeLocker: locker,
  feesDeployCost: `${formatEther(spent)} HYPE`,
};
const outFile = local ? new URL("../deployments/elysium-testnet-v4-fees.fork.json", import.meta.url) : file;
writeFileSync(outFile, JSON.stringify(out, null, 2) + "\n");
console.log(`\nwrote ${outFile.pathname.split("/").pop()} · factory ${factory}, earlier ${reg.earlierFactories.join(", ")} · spent ${formatEther(spent)} HYPE`);
