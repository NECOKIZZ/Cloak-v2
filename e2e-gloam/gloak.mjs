// GLOAK's launch (docs/GLOAK.md, docs/GLOAK-EXPERIMENT.md): the launch plan with its checks, the maker that gives GLOAK
// its private zone, and the owner wallet's one call through the launch deployer's one-time door.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeFunctionData, formatEther, parseAbi, zeroAddress } from "viem";
import { drandRoundAt, drandRoundTime } from "@cloakely/sdk";
import { REPO, sendAndLog } from "./lib.mjs";

export const ROLES = { RECEIVE: 1, SEND: 2, FEED: 4, SWAP: 8, VAULT: 16, PAYEE: 32 };
const art = (dir, file, name) => {
  const j = JSON.parse(readFileSync(join(REPO, dir, "out", file, `${name}.json`), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object };
};
export const makerArt = () => art("contracts-v4", "GloakToken.sol", "GloakMaker");
export const GLOAK_ABI = () => art("contracts-v4", "GloakToken.sol", "GloakToken").abi;
export const FACTORY_ABI = () => art("contracts", "CloakFactory.sol", "CloakFactory").abi;
export const DEPLOYER_ABI = () => art("contracts", "CloakVesting.sol", "CloakVestingDeployer").abi;
export const AUCTION_ABI = () => art("contracts", "CloakAuction.sol", "CloakAuction").abi;
export const HOOK_ABI = () => art("contracts-v4", "CloakV4Hook.sol", "CloakV4Hook").abi;
export const CONFIG_ABI = parseAbi([
  "function auctionLimit() view returns (uint128 perBid, uint128 total)",
  "function depositLimitsOn() view returns (bool)",
  "function launchFeeBps() view returns (uint16)",
  "function feeRecipient() view returns (address)",
  "function launchFloors() view returns (uint128 minRaise, uint16 minLpBps)",
]);
const LV_ABI = parseAbi(["function factory() view returns (address)", "function isLaunchToken(address) view returns (bool)", "function admitLaunch(uint256) returns (address)"]);
const BATCH_ABI = parseAbi(["function marketOf(address) view returns (address)", "function register(uint256) returns (address)"]);

const E = 10n ** 18n;
const MAX_TICKS = 256;
const MIN_REVEAL = 5 * 60;
const MAX_REVEAL = 7 * 86400;
const REVEAL_MARGIN = 120;
const fmt = (wei, d = 4) => Number(formatEther(wei)).toLocaleString("en-US", { maximumFractionDigits: d });

/** GLOAK's private zone from Cloak's partner deploy record: born approved, with these roles. */
export function zoneOf(partner) {
  const z = [
    [partner.launchVault, ROLES.RECEIVE | ROLES.VAULT, "launch vault"],
    [partner.router, ROLES.RECEIVE | ROLES.FEED | ROLES.SWAP | ROLES.PAYEE, "router (CloakRouterV4)"],
    [partner.batcherV4, ROLES.RECEIVE | ROLES.FEED | ROLES.PAYEE, "batch rounds (CloakGloamBatcherV4)"],
    [partner.bids, ROLES.RECEIVE, "private bids (CloakGloamBids)"],
  ];
  for (const [a, , what] of z) if (!/^0x[0-9a-fA-F]{40}$/.test(a ?? "")) throw new Error(`the partner record has no ${what}`);
  return z.map(([address, roles, what]) => ({ address, roles, what }));
}

/**
 * The launch, checked against the auction's rules and the live bid caps, with what it does at its lowest and highest
 * clearing price. `l` (wei strings): saleSupply, lpReserve, minPrice, maxPrice, numTicks, lpBps, noRevealPenaltyBps,
 * commitEnd (unix seconds), revealMinutes, metadataURI, minRaise (optional, default 0). The team share is always 0.
 */
export function planGloak(l, { treasury, launchFeeBps, perBid, totalCap, capsOn, now, floors = { minRaise: 0n, minLpBps: 0 } }) {
  const S = BigInt(l.saleSupply);
  const L = BigInt(l.lpReserve);
  const minPrice = BigInt(l.minPrice);
  const maxPrice = BigInt(l.maxPrice);
  const n = Number(l.numTicks);
  const lpBps = Number(l.lpBps);
  const penalty = Number(l.noRevealPenaltyBps ?? 2000);
  const commitEnd = Number(l.commitEnd);
  const revealEnd = commitEnd + Math.round(Number(l.revealMinutes) * 60);
  const minRaise = BigInt(l.minRaise ?? 0);
  const problems = [];
  const warnings = [];
  if (S <= 0n) problems.push("saleSupply must be above zero");
  if (L < 0n) problems.push("lpReserve can't be negative");
  if (minPrice <= 0n) problems.push("minPrice must be above zero");
  if (!(n >= 1 && n <= MAX_TICKS)) problems.push(`numTicks must be 1 to ${MAX_TICKS}`);
  if (n > 1 && maxPrice <= minPrice) problems.push("maxPrice must be above minPrice");
  const tickSize = n > 1 ? (maxPrice - minPrice) / BigInt(n - 1) : 0n;
  if (n > 1 && tickSize === 0n) problems.push("the price range is too narrow for that many ticks");
  const top = minPrice + BigInt(n - 1) * tickSize;
  if (!(lpBps >= 0 && lpBps <= 10_000)) problems.push("lpBps must be 0 to 10,000");
  if (penalty < 2000 || penalty > 5000) problems.push("noRevealPenaltyBps must be 2,000 to 5,000");
  // Cloak's launch floors and the reserve rule (CloakAuction's constructor)
  if (lpBps < floors.minLpBps) problems.push(`lpBps is under Cloak's floor of ${floors.minLpBps}`);
  if (minRaise < floors.minRaise) problems.push(`minRaise is under Cloak's floor of ${fmt(floors.minRaise)} HYPE`);
  if (L * 10_000n < S * BigInt(lpBps)) problems.push(`lpReserve must be at least saleSupply × lpBps (${fmt((S * BigInt(lpBps)) / 10_000n, 0)} GLOAK)`);
  if (commitEnd <= now) problems.push("commitEnd is in the past");
  const window = revealEnd - commitEnd;
  if (window < MIN_REVEAL || window > MAX_REVEAL) problems.push("the reveal window must be 5 minutes to 7 days");
  const tlockRound = drandRoundAt(commitEnd);
  if (drandRoundTime(tlockRound) < commitEnd || drandRoundTime(tlockRound) + REVEAL_MARGIN > revealEnd) problems.push("the reveal window is too short for the time-lock round");

  // what the auction does at a clearing price p with the whole sale sold (CloakAuction.settle)
  const at = (p) => {
    const raised = (p * S) / E;
    const fee = (raised * BigInt(launchFeeBps)) / 10_000n;
    const net = raised - fee;
    let poolHype = (net * BigInt(lpBps)) / 10_000n;
    let poolTokens = (poolHype * E) / p;
    if (poolTokens > L) {
      poolTokens = L;
      poolHype = (L * p) / E;
    }
    return { price: p, raised, fee, poolHype, poolTokens, creator: net - poolHype, burned: L - poolTokens, fdv: (p * (S + L - (L - poolTokens))) / E };
  };
  const low = at(minPrice);
  const high = at(top);
  const needL = (S * BigInt(10_000 - launchFeeBps) * BigInt(lpBps)) / 100_000_000n;
  if (L < needL) warnings.push(`lpReserve is under what a sold-out sale puts in the pool (${fmt(needL, 0)}): the pool gets less HYPE and Cloak more`);
  if (L > needL + needL / 50n) warnings.push(`lpReserve is above what a sold-out sale uses (${fmt(needL, 0)}): ${fmt(L - needL, 0)} would be burned even then`);
  if (minRaise > high.raised) problems.push("minRaise is more than a sell-out at the top price raises");
  if (capsOn && high.raised > BigInt(totalCap)) warnings.push(`a sell-out at the top price (${fmt(high.raised, 0)} HYPE) is over the launch cap (${fmt(BigInt(totalCap), 0)} HYPE): bids stop at the cap`);
  if (capsOn && BigInt(perBid) < (minPrice * S) / E / 100n) warnings.push(`the per-bid cap (${fmt(BigInt(perBid), 0)} HYPE) means at least 100 bidders for a sell-out at the lowest price`);
  if (n > 1 && tickSize * 4n > minPrice) warnings.push(`the first price step is ${Number((tickSize * 10_000n) / minPrice) / 100}% of the lowest price: coarse at the bottom of the range`);

  const params = {
    creator: treasury,
    saleSupply: S,
    lpReserve: L,
    minPrice,
    tickSize: n > 1 ? tickSize : minPrice,
    numTicks: n,
    commitEnd: BigInt(commitEnd),
    revealEnd: BigInt(revealEnd),
    lpBps,
    noRevealPenaltyBps: penalty,
    lpLockUntil: 2n ** 64n - 1n, // locked forever, the pool's fees to the creator (Cloak's treasury)
    tlockRound: BigInt(tlockRound),
    minRaise,
  };
  return { params, supply: S + L, top, low, high, problems, warnings };
}

/** Print a plan the way the owner wallet should read it before signing. */
export function printPlan(plan, l) {
  const p = plan.params;
  const row = (k, v) => console.log(`  ${k.padEnd(34)} ${v}`);
  console.log("GLOAK launch plan");
  row("supply", `${fmt(plan.supply, 0)} GLOAK (sale ${fmt(p.saleSupply, 0)}, pool reserve ${fmt(p.lpReserve, 0)}, team 0)`);
  row("prices", `${formatEther(p.minPrice)} to ${formatEther(plan.top)} HYPE per GLOAK, ${p.numTicks} levels`);
  row("bidding closes", new Date(Number(p.commitEnd) * 1000).toISOString());
  row("bids open (reveal) until", `${new Date(Number(p.revealEnd) * 1000).toISOString()} (time-lock round ${p.tlockRound})`);
  row("pool's share of the raise", `${p.lpBps / 100}%, locked forever, fees to ${p.creator}`);
  row("unrevealed-bid penalty", `${p.noRevealPenaltyBps / 100}%`);
  row("minimum raise", p.minRaise > 0n ? `${fmt(p.minRaise)} HYPE (under it, everyone is refunded)` : "none");
  for (const [name, s] of [["sold out at the lowest price", plan.low], ["sold out at the top price", plan.high]]) {
    console.log(`  ${name}:`);
    row("  raised", `${fmt(s.raised)} HYPE (fee ${fmt(s.fee)})`);
    row("  pool", `${fmt(s.poolHype)} HYPE + ${fmt(s.poolTokens, 0)} GLOAK`);
    row("  to Cloak's treasury", `${fmt(s.creator)} HYPE`);
    row("  burned (unused pool reserve)", `${fmt(s.burned, 0)} GLOAK`);
    row("  value of all GLOAK at that price", `${fmt(s.fdv, 0)} HYPE`);
  }
  console.log("  An undersold sale burns the unsold part too, and its pool is smaller in proportion.");
  for (const w of plan.warnings) console.log(`  ! ${w}`);
  for (const x of plan.problems) console.log(`  ✗ ${x}`);
  if (l?.metadataURI) row("metadata", l.metadataURI);
}

/** Read everything the door depends on, and refuse to go on if anything is off. */
export async function preflight(pub, { factory, hook, deployer, config, admin, treasury, zone }) {
  const F = FACTORY_ABI();
  const D = DEPLOYER_ABI();
  const H = HOOK_ABI();
  const [vd, seeder] = await Promise.all([pub.readContract({ address: factory, abi: F, functionName: "vestingDeployer" }), pub.readContract({ address: factory, abi: F, functionName: "seeder" })]);
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  const fails = [];
  if (deployer && !same(vd, deployer)) fails.push(`the factory's token deployer is ${vd}, the record says ${deployer}`);
  if (!same(seeder, hook)) fails.push(`the factory's seeder is ${seeder}, not the hook ${hook}`);
  const [doorAdmin, doorUsed, hookFactory, privatePool] = await Promise.all([
    pub.readContract({ address: vd, abi: D, functionName: "doorAdmin" }),
    pub.readContract({ address: vd, abi: D, functionName: "doorUsed" }),
    pub.readContract({ address: hook, abi: H, functionName: "factory" }),
    pub.readContract({ address: hook, abi: H, functionName: "privatePool" }),
  ]);
  if (!same(doorAdmin, admin)) fails.push(`the door belongs to ${doorAdmin}, not the owner wallet ${admin}`);
  if (doorUsed) fails.push("the door has been used already");
  if (!same(hookFactory, factory)) fails.push(`the hook's factory is ${hookFactory}`);
  if (BigInt(privatePool) !== 0n) fails.push("the hook already has a private pool");
  const floors = await pub
    .readContract({ address: config, abi: CONFIG_ABI, functionName: "launchFloors" })
    .then(([minRaise, minLpBps]) => ({ minRaise, minLpBps: Number(minLpBps) }))
    .catch(() => ({ minRaise: 0n, minLpBps: 0 }));
  const [feeRecipient, launchFeeBps, [perBid, totalCap], capsOn] = await Promise.all([
    pub.readContract({ address: config, abi: CONFIG_ABI, functionName: "feeRecipient" }),
    pub.readContract({ address: config, abi: CONFIG_ABI, functionName: "launchFeeBps" }),
    pub.readContract({ address: config, abi: CONFIG_ABI, functionName: "auctionLimit" }),
    pub.readContract({ address: config, abi: CONFIG_ABI, functionName: "depositLimitsOn" }),
  ]);
  if (!same(feeRecipient, treasury)) fails.push(`the launch fee goes to ${feeRecipient}, the config's treasury is ${treasury}`);
  for (const z of zone) if (((await pub.getCode({ address: z.address })) ?? "0x") === "0x") fails.push(`the ${z.what} at ${z.address} has no code`);
  const lv = zone.find((z) => z.roles & ROLES.VAULT)?.address;
  if (lv && !same(await pub.readContract({ address: lv, abi: LV_ABI, functionName: "factory" }), factory)) fails.push("the launch vault admits another factory's launches");
  return { vestingDeployer: vd, launchFeeBps: Number(launchFeeBps), perBid, totalCap, capsOn, floors, fails };
}

/** Deploy GLOAK's maker (anyone can: it only answers the door) and read it back. */
export async function deployMaker(pub, wallet, { door, admin, poolManager, hook, zone }) {
  const a = makerArt();
  const r = await sendAndLog(pub, "deploy GloakMaker", wallet.deployContract({ abi: a.abi, bytecode: a.bytecode, args: [door, admin, poolManager, hook, zone.map((z) => z.address), zone.map((z) => z.roles)] }));
  const maker = r.contractAddress;
  await checkMaker(pub, maker, { door, admin, poolManager, hook, zone });
  return maker;
}

export async function checkMaker(pub, maker, { door, admin, poolManager, hook, zone }) {
  const a = makerArt().abi;
  const same = (x, y) => String(x).toLowerCase() === String(y).toLowerCase();
  const [d, ad, pm, h, [zs, rs]] = await Promise.all(["door", "admin", "poolManager", "hook", "zone"].map((functionName) => pub.readContract({ address: maker, abi: a, functionName })));
  if (!same(d, door) || !same(ad, admin) || !same(pm, poolManager) || !same(h, hook)) throw new Error("the maker reads back wrong (door, admin, PoolManager or hook)");
  if (zs.length !== zone.length || zone.some((z, i) => !same(zs[i], z.address) || Number(rs[i]) !== z.roles)) throw new Error("the maker's zone reads back wrong");
}

/** The owner wallet's one call: useDoor(maker, factory, createLaunch(GLOAK)). */
export function doorCall({ deployer, maker, factory, params, metadataURI = "" }) {
  const createLaunch = encodeFunctionData({ abi: FACTORY_ABI(), functionName: "createLaunch", args: ["GLOAK", "GLOAK", 0n, 0n, params, metadataURI] });
  return { to: deployer, value: 0n, data: encodeFunctionData({ abi: DEPLOYER_ABI(), functionName: "useDoor", args: [maker, factory, createLaunch] }) };
}

/** After the door: the launch, its token, and the zone GLOAK was born with. */
export async function readLaunch(pub, { factory, deployer, zone }) {
  const F = FACTORY_ABI();
  const token = await pub.readContract({ address: deployer, abi: DEPLOYER_ABI(), functionName: "doorToken" });
  if (token === zeroAddress) throw new Error("the door hasn't made a token");
  const count = await pub.readContract({ address: factory, abi: F, functionName: "launchesCount" });
  let index = -1n;
  let auction = zeroAddress;
  for (let i = count - 1n; i >= 0n && index < 0n; i--) {
    const [a, t] = await pub.readContract({ address: factory, abi: F, functionName: "launches", args: [i] });
    if (t.toLowerCase() === token.toLowerCase()) [index, auction] = [i, a];
  }
  if (index < 0n) throw new Error("the door's token isn't one of the factory's launches");
  const G = GLOAK_ABI();
  for (const z of zone) {
    const r = Number(await pub.readContract({ address: token, abi: G, functionName: "rolesOf", args: [z.address] }));
    if ((r & z.roles) !== z.roles) throw new Error(`GLOAK wasn't born with the ${z.what}'s roles`);
  }
  const [supply, admin, setupMode] = await Promise.all(["totalSupply", "admin", "setupMode"].map((functionName) => pub.readContract({ address: token, abi: G, functionName })));
  return { token, auction, index, supply, admin, setupMode };
}

/** After settlement: what's done, and the owner wallet's calls still to make (approve the adapter, end setup). */
export async function afterSettle(pub, { token, auction, index, hook, launchVault, batcherV4, endSetup }) {
  const A = AUCTION_ABI();
  const H = HOOK_ABI();
  const G = GLOAK_ABI();
  const [settled, failed] = await Promise.all([pub.readContract({ address: auction, abi: A, functionName: "settled" }), pub.readContract({ address: auction, abi: A, functionName: "failed" })]);
  if (!settled) throw new Error("the launch hasn't settled yet");
  if (failed) throw new Error("the launch failed (no valid bids): there's no pool");
  const [adapter, pool, privatePool] = await Promise.all([
    pub.readContract({ address: auction, abi: A, functionName: "pair" }),
    pub.readContract({ address: hook, abi: H, functionName: "poolIdOf", args: [token] }),
    pub.readContract({ address: hook, abi: H, functionName: "privatePool" }),
  ]);
  const status = {
    adapter,
    privatePool: pool === privatePool && BigInt(pool) !== 0n,
    admitted: launchVault ? await pub.readContract({ address: launchVault, abi: LV_ABI, functionName: "isLaunchToken", args: [token] }) : null,
    registered: batcherV4 ? (await pub.readContract({ address: batcherV4, abi: BATCH_ABI, functionName: "marketOf", args: [token] })) !== zeroAddress : null,
  };
  const calls = [];
  const roles = Number(await pub.readContract({ address: token, abi: G, functionName: "rolesOf", args: [adapter] }));
  if (!(roles & ROLES.SWAP)) calls.push({ what: "approve the pool's batch-round adapter (Swap)", to: token, value: 0n, data: encodeFunctionData({ abi: G, functionName: "setRoles", args: [adapter, roles | ROLES.SWAP] }) });
  if (endSetup && (await pub.readContract({ address: token, abi: G, functionName: "setupMode" }))) calls.push({ what: "end setup: new approvals wait 3 days in public from now on", to: token, value: 0n, data: encodeFunctionData({ abi: G, functionName: "endSetup" }) });
  const permissionless = [];
  if (status.admitted === false) permissionless.push({ what: "admit GLOAK to the launch vault (anyone; the keeper does it)", to: launchVault, data: encodeFunctionData({ abi: LV_ABI, functionName: "admitLaunch", args: [index] }) });
  if (status.registered === false) permissionless.push({ what: "register GLOAK for batch rounds (anyone; the keeper does it)", to: batcherV4, data: encodeFunctionData({ abi: BATCH_ABI, functionName: "register", args: [index] }) });
  return { status, calls, permissionless };
}
