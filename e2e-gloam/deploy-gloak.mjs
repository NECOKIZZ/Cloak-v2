// GLOAK's launch, step 1 (docs/GLOAK-EXPERIMENT.md, "Running it"): check everything the one-time door depends on,
// print the launch plan, deploy GloakMaker with GLOAK's private zone, and prepare the owner wallet's one call,
// useDoor(maker, factory, createLaunch(GLOAK)). With OWNER_PK set (a fork rehearsal) it sends that call too and reads
// the launch back. Without it, it prints the call for the owner wallet to sign.
//
//   node e2e-gloam/deploy-gloak.mjs --config deployments/elysium-mainnet-gloak.input.json --plan   # checks and plan only
//   NODE_USE_ENV_PROXY=1 DEPLOYER_PK=… node e2e-gloam/deploy-gloak.mjs --config deployments/elysium-mainnet-gloak.input.json
//
// The config: { name, chainId, rpcUrl, factoryRecord, partnerRecord, admin, launch: { saleSupply, lpReserve, minPrice,
//   maxPrice, numTicks, lpBps, noRevealPenaltyBps, commitEnd (ISO date or unix seconds), revealMinutes, metadataURI } }.
//   factoryRecord / partnerRecord are the records deploy-v2-factory.mjs and deploy-partner.mjs wrote. Amounts are wei.
// Options: --rpc <url> (overrides the config's), --out <file> (the record; default deployments/<name>.json),
//   --maker <address> (reuse a maker deployed earlier, checked), --plan (no transactions).
// Keys: DEPLOYER_PK pays for the maker (it gets no role). OWNER_PK only on a fork rehearsal: never the real owner key.
import { readFileSync, writeFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { formatEther } from "viem";
import { REPO, clients, sendAndLog } from "./lib.mjs";
import { checkMaker, deployMaker, doorCall, planGloak, preflight, printPlan, readLaunch, zoneOf } from "./gloak.mjs";

const arg = (k) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : null);
const path = (p) => (isAbsolute(p) ? p : join(REPO, p));
const cfgPath = arg("--config");
if (!cfgPath) throw new Error("--config <file> is required");
const cfg = JSON.parse(readFileSync(path(cfgPath), "utf8"));
const PLAN_ONLY = process.argv.includes("--plan");
const fac = JSON.parse(readFileSync(path(cfg.factoryRecord), "utf8"));
const partner = JSON.parse(readFileSync(path(cfg.partnerRecord), "utf8"));
const isAddr = (v) => /^0x[0-9a-fA-F]{40}$/.test(v ?? "");
if (!isAddr(cfg.admin)) throw new Error("config: admin must be the owner wallet's address");

const rpcUrl = arg("--rpc") ?? cfg.rpcUrl;
const pk = process.env.DEPLOYER_PK;
if (!pk && !PLAN_ONLY) throw new Error("set DEPLOYER_PK (a fresh key that pays for the maker; it gets no role)");
const me = clients(rpcUrl, pk ?? "0x" + "11".repeat(32), cfg.chainId);
const pub = me.pub;
if ((await pub.getChainId()) !== cfg.chainId) throw new Error(`the RPC is chain ${await pub.getChainId()}, the config says ${cfg.chainId}`);

const zone = zoneOf(partner);
const treasury = fac.treasury;
const pre = await preflight(pub, { factory: fac.factory, hook: fac.v4Hook, deployer: fac.vestingDeployer, config: fac.config, admin: cfg.admin, treasury, zone });
console.log("Checks: the factory's door belongs to the owner wallet and is unused, the hook has no private pool, the zone has code");
if (pre.fails.length) {
  for (const f of pre.fails) console.log(`  ✗ ${f}`);
  throw new Error("preflight failed: nothing was sent");
}

const now = Number((await pub.getBlock()).timestamp);
const l = cfg.launch;
const commitEnd = typeof l.commitEnd === "string" && !/^\d+$/.test(l.commitEnd) ? Math.floor(Date.parse(l.commitEnd) / 1000) : Number(l.commitEnd);
const plan = planGloak({ ...l, commitEnd }, { treasury, launchFeeBps: pre.launchFeeBps, perBid: pre.perBid, totalCap: pre.totalCap, capsOn: pre.capsOn, now, floors: pre.floors });
printPlan(plan, l);
console.log("GLOAK's private zone (born approved):");
for (const z of zone) console.log(`  ${z.what.padEnd(36)} ${z.address}  roles ${z.roles}`);
if (plan.problems.length) throw new Error("the plan has problems: nothing was sent");
if (PLAN_ONLY) process.exit(0);

const makerArgs = { door: pre.vestingDeployer, admin: cfg.admin, poolManager: fac.poolManager, hook: fac.v4Hook, zone };
let maker = arg("--maker");
if (maker) await checkMaker(pub, maker, makerArgs);
else maker = await deployMaker(pub, me.wallet, makerArgs);
console.log(`GloakMaker ${maker}: read back (door, admin, PoolManager, hook, zone)`);

const call = doorCall({ deployer: pre.vestingDeployer, maker, factory: fac.factory, params: plan.params, metadataURI: l.metadataURI ?? "" });
const record = {
  chainId: cfg.chainId,
  note: "GLOAK, the one private-only token (docs/GLOAK.md). The owner wallet's door call creates its launch.",
  factory: fac.factory,
  vestingDeployer: pre.vestingDeployer,
  v4Hook: fac.v4Hook,
  poolManager: fac.poolManager,
  admin: cfg.admin,
  treasury,
  maker,
  zone: zone.map((z) => ({ what: z.what, address: z.address, roles: z.roles })),
  launch: { ...Object.fromEntries(Object.entries(plan.params).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])), metadataURI: l.metadataURI ?? "" },
  launchVault: partner.launchVault,
  batcherV4: partner.batcherV4,
  ownerCall: { to: call.to, value: "0", data: call.data, call: "useDoor(maker, factory, createLaunch(GLOAK))" },
};

if (process.env.OWNER_PK) {
  const owner = clients(rpcUrl, process.env.OWNER_PK, cfg.chainId);
  if (owner.account.address.toLowerCase() !== cfg.admin.toLowerCase()) throw new Error("OWNER_PK isn't the config's admin");
  await sendAndLog(pub, "owner: useDoor", owner.wallet.sendTransaction({ to: call.to, data: call.data, value: 0n }));
  const r = await readLaunch(pub, { factory: fac.factory, deployer: pre.vestingDeployer, zone });
  Object.assign(record, { token: r.token, auction: r.auction, launchIndex: Number(r.index) });
  console.log(`GLOAK ${r.token}, launch #${r.index} at ${r.auction}: ${formatEther(r.supply)} GLOAK, admin ${r.admin}, in setup: ${r.setupMode}, born with its zone`);
} else {
  console.log(`\nFrom the owner wallet ${cfg.admin}, ONE transaction, before ${new Date(Number(plan.params.commitEnd) * 1000).toISOString()}:`);
  console.log(`  to    ${call.to}  (the launch deployer's one-time door)`);
  console.log(`  value 0`);
  console.log(`  data  ${call.data}`);
  console.log("Then run gloak-after-settle.mjs once the launch settles.");
}
const out = arg("--out") ? path(arg("--out")) : join(REPO, `deployments/${cfg.name}.json`);
writeFileSync(out, JSON.stringify(record, null, 2) + "\n");
console.log(`record: ${out}`);
