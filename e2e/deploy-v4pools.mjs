// Uniswap v4 launches for Cloak: the official Uniswap v4 PoolManager (built from Uniswap's source with Uniswap's
// settings, checked byte for byte against the one on Elysium mainnet), CloakV4Hook at its flagged address, and a launch
// factory that seeds every launch into a v4 pool through the hook. The new factory becomes the current one; every earlier
// factory keeps listing. Config, vaults, routers and batchers stay as they are (a v4 market has CloakPair's interface).
//   DEPLOYER_PK=0x… [RPC_URL=…] node e2e/deploy-v4pools.mjs
// Rehearse on a fork first: anvil --fork-url https://testnet-rpc.elysium.kinetiq.xyz --chain-id 31337, then RPC_URL=http://127.0.0.1:8545
// (writes deployments/elysium-testnet-v4-v4pools.fork.json and leaves the real record alone).
// On mainnet, pass POOL_MANAGER=0xe2e105d3f7209a9da11f83ccf3e7398a753823f1 to use Uniswap's own PoolManager instead.
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, defineChain, formatEther, http } from "viem";
import { cloakConfigAbi, cloakFactoryAbi, cloakV4HookAbi, elysiumTestnet, readRegistry } from "@cloakely/sdk";
import { bytecode } from "@cloakely/sdk/bytecode";
import { clients, deployV4, register } from "./lib.mjs";

const SOURCE = process.env.SOURCE_FILE || "../deployments/elysium-testnet-v4.json";
const v4 = JSON.parse(readFileSync(new URL(SOURCE, import.meta.url), "utf8"));
const RPC = process.env.RPC_URL || elysiumTestnet.rpcUrls.default.http[0];
const local = RPC.includes("127.0.0.1") || RPC.includes("localhost");
const chain = local ? defineChain({ ...elysiumTestnet, id: await createPublicClient({ transport: http(RPC) }).getChainId(), rpcUrls: { default: { http: [RPC] } } }) : elysiumTestnet;
const d = clients(chain, RPC, process.env.DEPLOYER_PK);
const pub = d.publicClient;
const start = await pub.getBalance({ address: d.account.address });
console.log(`deployer ${d.account.address} · ${formatEther(start)} HYPE`);
const same = (a, b) => a?.toLowerCase() === b?.toLowerCase();

const cfg = { address: v4.config, abi: cloakConfigAbi };
if (!(await pub.readContract({ ...cfg, functionName: "setupMode" }))) throw new Error("CloakConfig is out of setup: a new factory has to go through the 3-day queue");
const before = await readRegistry(pub, v4.config);
const vestingDeployer = await pub.readContract({ address: before.factory, abi: cloakFactoryAbi, functionName: "vestingDeployer" });

// 1. PoolManager + hook + factory
const r = await deployV4(pub, d.walletClient, { config: v4.config, vestingDeployer, poolManager: process.env.POOL_MANAGER });
console.log(`PoolManager ${r.poolManager} · hook ${r.hook} · factory ${r.factory} (block ${r.block})`);

// 2. the PoolManager is Uniswap's: identical runtime to mainnet's apart from its own address (skipped if we reused one)
if (!process.env.POOL_MANAGER) {
  const art = JSON.parse(readFileSync(new URL("../contracts-v4/out-uniswap/PoolManager.sol/PoolManager.json", import.meta.url), "utf8"));
  const imm = Object.values(art.deployedBytecode.immutableReferences ?? {}).flat();
  const mask = (hex) => {
    const b = Buffer.from(hex.replace(/^0x/, ""), "hex");
    for (const x of imm) b.fill(0, x.start, x.start + x.length);
    return b;
  };
  const live = await pub.getCode({ address: r.poolManager });
  if (!mask(live).equals(mask(art.deployedBytecode.object))) throw new Error("the deployed PoolManager isn't Uniswap's build");
  console.log("PoolManager runtime matches Uniswap's build (run e2e/check-v4-bytecode.mjs to compare with mainnet)");
}
const hk = { address: r.hook, abi: cloakV4HookAbi };
const [pm, fac, timed, base, startFee, decay] = await Promise.all(["poolManager", "factory", "timedLocks", "baseFee", "startFee", "decaySecs"].map((functionName) => pub.readContract({ ...hk, functionName })));
if (!same(pm, r.poolManager) || !same(fac, r.factory) || timed !== false) throw new Error("hook misconfigured");
if ((BigInt(r.hook) & 0x3fffn) !== 0x2a80n) throw new Error("hook address has the wrong permission bits");
const ft = await pub.readContract({ address: r.factory, abi: cloakFactoryAbi, functionName: "timedLocks" });
if (ft !== false) throw new Error("factory allows timed locks");

// 3. registry: the v4 factory becomes the current one; the V2 factory and the earlier ones keep listing
await register(pub, d.walletClient, v4.config, "factory", r.factory, before.version, r.block);
const h = await d.walletClient.writeContract({ ...cfg, functionName: "addLaunchFactory", args: [r.factory] });
await pub.waitForTransactionReceipt({ hash: h });
const reg = await readRegistry(pub, v4.config);
if (!same(reg.factory, r.factory) || !same(reg.earlierFactories[0], before.factory) || !same(reg.router, before.router) || !same(reg.vaults, before.vaults)) throw new Error("registry mismatch");
if (!(await pub.readContract({ ...cfg, functionName: "isLaunchFactory", args: [r.factory] }))) throw new Error("not a launch factory");

const spent = start - (await pub.getBalance({ address: d.account.address }));
const out = {
  ...v4,
  factory: r.factory,
  factoryBlock: r.block.toString(),
  earlierFactories: [before.factory, ...(v4.earlierFactories ?? [])].filter((x, i, a) => a.findIndex((y) => same(x, y)) === i),
  seeder: r.hook,
  uniswapV4: { poolManager: r.poolManager, hook: r.hook, baseFee: `${Number(base) / 1e4}%`, antiSnipe: `${Number(startFee) / 1e4}% falling to the base over ${decay}s`, poolManagerOwner: d.account.address },
  v4DeployCost: `${formatEther(spent)} HYPE`,
};
const outFile = local ? new URL("../deployments/elysium-testnet-v4-v4pools.fork.json", import.meta.url) : new URL(SOURCE, import.meta.url);
writeFileSync(outFile, JSON.stringify(out, null, 2) + "\n");
console.log(`\nwrote ${outFile.pathname.split("/").pop()} · current factory ${r.factory}, earlier ${out.earlierFactories.join(", ")} · spent ${formatEther(spent)} HYPE`);
