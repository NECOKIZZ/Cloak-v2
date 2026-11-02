// Add the shared launch-token vault to Cloak v4 (testnet experiment): one private vault for every Uniswap launch token
// from now on, next to the single-token vaults. Deploys the Poseidon(4) hasher, its Groth16 verifier, the SharedVault and
// the SharedRouter, makes the router cap-exempt (it moves money already inside Cloak) and registers both. Nothing that
// exists changes: HYPE, USDC and every earlier launch keep their vaults.
//   DEPLOYER_PK=0x… [RPC_URL=…] node e2e/deploy-shared.mjs
// Rehearse on a fork first (RPC_URL=http://127.0.0.1:8545): writes deployments/elysium-testnet-v4-shared.fork.json.
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, defineChain, formatEther, http } from "viem";
import { cloakConfigAbi, elysiumTestnet, readRegistry, sharedRouterAbi, sharedVaultAbi } from "@cloakely/sdk";
import { bytecode } from "@cloakely/sdk/bytecode";
import { clients, deployRaw, register } from "./lib.mjs";

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
if (!(await pub.readContract({ ...cfg, functionName: "setupMode" }))) throw new Error("CloakConfig is out of setup: registering goes through the 3-day queue");
const before = await readRegistry(pub, v4.config);
if (before.shared) throw new Error(`a shared vault is already registered: ${before.shared}`);

// 1. hasher and verifier (stateless), then the vault and its router
const p4 = (await deployRaw(pub, d.walletClient, bytecode.Poseidon4)).address;
const vr = await send(d.walletClient.deployContract({ abi: [], bytecode: bytecode.Groth16VerifierMA, args: [] }));
const verifier = vr.contractAddress;
const sv = await send(d.walletClient.deployContract({ abi: sharedVaultAbi, bytecode: bytecode.SharedVault, args: [v4.config, v4.poseidon2, p4, verifier, v4.vaults] }));
const shared = sv.contractAddress;
const sr = await send(d.walletClient.deployContract({ abi: sharedRouterAbi, bytecode: bytecode.SharedRouter, args: [shared, v4.hypePool, v4.whype] }));
const router = sr.contractAddress;
console.log(`poseidon4 ${p4} · verifier ${verifier} · shared vault ${shared} (block ${sv.blockNumber}) · router ${router}`);

// 2. the router moves money already inside Cloak (swap outputs), so deposit caps don't apply to it; register both
await send(d.walletClient.writeContract({ ...cfg, functionName: "setCapExempt", args: [router, true] }));
await register(pub, d.walletClient, v4.config, "shared", shared, before.version, sv.blockNumber);
await register(pub, d.walletClient, v4.config, "sharedRouter", router, before.version, sr.blockNumber);

const reg = await readRegistry(pub, v4.config);
const same = (a, b) => a?.toLowerCase() === b?.toLowerCase();
if (!same(reg.shared, shared) || !same(reg.sharedRouter, router) || !same(reg.router, before.router) || !same(reg.factory, before.factory) || !same(reg.vaults, before.vaults)) throw new Error("registry mismatch");
const checks = await Promise.all([
  pub.readContract({ address: shared, abi: sharedVaultAbi, functionName: "verifier" }),
  pub.readContract({ address: shared, abi: sharedVaultAbi, functionName: "hasher4" }),
  pub.readContract({ address: router, abi: sharedRouterAbi, functionName: "hypePool" }),
  pub.readContract({ ...cfg, functionName: "capExempt", args: [router] }),
]);
if (!same(checks[0], verifier) || !same(checks[1], p4) || !same(checks[2], v4.hypePool) || !checks[3]) throw new Error("shared vault misconfigured");

const spent = start - (await pub.getBalance({ address: d.account.address }));
const out = { ...v4, poseidon4: p4, verifierMA: verifier, shared, sharedBlock: sv.blockNumber.toString(), sharedRouter: router, sharedDeployCost: `${formatEther(spent)} HYPE` };
const outFile = local ? new URL("../deployments/elysium-testnet-v4-shared.fork.json", import.meta.url) : file;
writeFileSync(outFile, JSON.stringify(out, null, 2) + "\n");
console.log(`\nwrote ${outFile.pathname.split("/").pop()} · spent ${formatEther(spent)} HYPE; the current factory, router and vaults are unchanged`);
