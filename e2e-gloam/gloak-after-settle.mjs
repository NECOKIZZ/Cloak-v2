// GLOAK's launch, step 2: once the launch settles, check its pool is the hook's private pool, that the keeper admitted
// it to the launch vault and registered it for batch rounds, and make the owner wallet's last setup calls: approve the
// pool's batch-round adapter (Swap) and, with --end-setup, end setup (new approvals then wait 3 days in public).
// With OWNER_PK set (a fork rehearsal) it sends them; otherwise it prints them for the owner wallet.
//
//   NODE_USE_ENV_PROXY=1 node e2e-gloam/gloak-after-settle.mjs --record deployments/elysium-mainnet-gloak.json [--end-setup]
// Options: --rpc <url>, --chain <id> (default: the record's).
import { readFileSync, writeFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { REPO, clients, sendAndLog } from "./lib.mjs";
import { afterSettle } from "./gloak.mjs";

const arg = (k) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : null);
const recPath = arg("--record");
if (!recPath) throw new Error("--record <file> is required (what deploy-gloak.mjs wrote)");
const file = isAbsolute(recPath) ? recPath : join(REPO, recPath);
const rec = JSON.parse(readFileSync(file, "utf8"));
if (!rec.token || !rec.auction) throw new Error("the record has no token yet: add token, auction and launchIndex once the owner wallet's door call lands");
const rpcUrl = arg("--rpc") ?? process.env.RPC_URL ?? "https://rpc.elysium.kinetiq.xyz";
const chainId = Number(arg("--chain") ?? rec.chainId);
const pub = clients(rpcUrl, "0x" + "11".repeat(32), chainId).pub;

const r = await afterSettle(pub, { token: rec.token, auction: rec.auction, index: BigInt(rec.launchIndex), hook: rec.v4Hook, launchVault: rec.launchVault, batcherV4: rec.batcherV4, endSetup: process.argv.includes("--end-setup") });
console.log(`GLOAK's pool is the hook's private pool: ${r.status.privatePool}`);
console.log(`admitted to the launch vault: ${r.status.admitted} | registered for batch rounds: ${r.status.registered}`);
for (const p of r.permissionless) console.log(`  still to do (anyone): ${p.what} -> to ${p.to}, data ${p.data}`);
if (!r.status.privatePool) throw new Error("GLOAK's pool isn't the hook's private pool: stop and investigate");

if (process.env.OWNER_PK) {
  const owner = clients(rpcUrl, process.env.OWNER_PK, chainId);
  for (const c of r.calls) await sendAndLog(pub, `owner: ${c.what}`, owner.wallet.sendTransaction({ to: c.to, data: c.data, value: 0n }));
  for (const c of r.calls) console.log(`sent: ${c.what}`);
} else if (r.calls.length) {
  console.log(`\nFrom the owner wallet ${rec.admin}, in this order:`);
  for (const c of r.calls) console.log(`  ${c.what}\n    to ${c.to}, value 0\n    data ${c.data}`);
} else console.log("Nothing left for the owner wallet.");
rec.adapter = r.status.adapter;
writeFileSync(file, JSON.stringify(rec, null, 2) + "\n");
