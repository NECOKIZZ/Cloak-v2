// Deploys the proof-of-funds verifier (circuits/src/fundsProof3, development keys until the public ceremony) and
// CloakFundsCheck, which other contracts call to gate on private holdings. Registered as "fundsCheck".
//   DEPLOYER_PK=0x… [RPC_URL=…] node e2e/deploy-funds.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { cloakFundsCheckAbi, elysiumTestnet, readRegistry } from "@cloakely/sdk";
import { bytecode } from "@cloakely/sdk/bytecode";
import { clients, register } from "./lib.mjs";

const file = new URL("../deployments/elysium-testnet-v4.json", import.meta.url);
const v4 = JSON.parse(readFileSync(file, "utf8"));
const d = clients(elysiumTestnet, process.env.RPC_URL || elysiumTestnet.rpcUrls.default.http[0], process.env.DEPLOYER_PK);
const pub = d.publicClient;
const reg = await readRegistry(pub, v4.config);
const send = async (p) => { const r = await pub.waitForTransactionReceipt({ hash: await p }); if (r.status !== "success") throw new Error("reverted"); return r; };
const vr = await send(d.walletClient.deployContract({ abi: [], bytecode: bytecode.Groth16VerifierFunds, args: [] }));
const fr = await send(d.walletClient.deployContract({ abi: cloakFundsCheckAbi, bytecode: bytecode.CloakFundsCheck, args: [vr.contractAddress, reg.vaults] }));
await register(pub, d.walletClient, v4.config, "fundsCheck", fr.contractAddress, reg.version, fr.blockNumber);
writeFileSync(file, JSON.stringify({ ...v4, fundsVerifier: vr.contractAddress, fundsCheck: fr.contractAddress }, null, 2) + "\n");
console.log(`verifier ${vr.contractAddress} · CloakFundsCheck ${fr.contractAddress}, registered`);
