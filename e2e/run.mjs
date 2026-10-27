// End-to-end: deploy → launch → sealed bids (tlock) → keeper auto-reveal → settle → claim → trade at the clearing price.
// Local:   anvil & ; node e2e/run.mjs
// Elysium: RPC_URL=https://testnet-rpc.elysium.kinetiq.xyz DEPLOYER_PK=0x… node e2e/run.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { generatePrivateKey } from "viem/accounts";
import { anvilLocal, elysiumTestnet, cloakPairAbi, cloakTokenAbi } from "@cloakonelysium/sdk";
import { Cloak, clients, deployFactory, fmt, parseEther, sleep, waitChainTime, waitDrand } from "./lib.mjs";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const local = RPC.includes("127.0.0.1") || RPC.includes("localhost");
const chain = local ? anvilLocal : elysiumTestnet;
const PK = process.env.DEPLOYER_PK ?? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // anvil #0
const COMMIT_SECS = Number(process.env.COMMIT_SECS ?? (local ? 25 : 60));
const REVEAL_SECS = Number(process.env.REVEAL_SECS ?? (local ? 20 : 45));
const BIDDER_FUNDS = parseEther(process.env.BIDDER_FUNDS ?? "3000");
const GAS_BUFFER = parseEther(process.env.GAS_BUFFER ?? "0.002");

let checks = 0;
const ok = (cond, msg) => {
  if (!cond) throw new Error(`✗ ${msg}`);
  checks++;
  console.log(`  ✓ ${msg}`);
};
const explorer = (h) => (local ? h : `${elysiumTestnet.blockExplorers.default.url}/tx/${h}`);
const txs = {};

const deployer = clients(chain, RPC, PK);
const mine = local ? () => deployer.publicClient.request({ method: "evm_mine", params: [] }) : undefined;
console.log(`chain ${chain.name} (${chain.id}) · deployer ${deployer.account.address}`);

const factory = process.env.FACTORY ?? (await deployFactory(deployer.publicClient, deployer.walletClient)).factory;
console.log(`factory ${factory}`);
const creator = new Cloak(deployer.publicClient, deployer.walletClient, factory);

// Price scale: local uses whole-HYPE prices; testnet uses tiny prices so a faucet balance covers the demo.
const unit = local ? 10n ** 14n : 10n ** 9n; // min price & tick size (wei per whole token)
const now = Number((await deployer.publicClient.getBlock()).timestamp);
const launch = await creator.createLaunch({
  name: "Cloak Demo",
  symbol: "CLOAK",
  saleSupply: 1_000_000n * 10n ** 18n,
  creatorAlloc: 100_000n * 10n ** 18n,
  minPrice: unit,
  tickSize: unit,
  numTicks: 100,
  commitEnd: now + COMMIT_SECS,
  revealEnd: now + COMMIT_SECS + REVEAL_SECS,
  lpBps: 5000,
  lpLockUntil: "burn",
  metadataURI: "https://github.com/NECOKIZZ/cloak",
});
txs.createLaunch = launch.txHash;
console.log(`auction ${launch.auction} · token ${launch.token}`);
let s = await creator.getAuction(launch.auction);
ok(s.phase === "commit", "launch is in commit phase");

const bidders = [];

// Sealed bids: max price in ticks above min, quantity in tokens. Sum > supply → oversubscribed.
const plan = [
  [40n, 400_000n], // "sniper" — bids high, still pays the clearing price
  [20n, 300_000n],
  [12n, 250_000n],
  [12n, 250_000n], // marginal tick → pro rata
  [5n, 300_000n], // below clearing → full refund
];
const secrets = [];
for (let i = 0; i < plan.length; i++) {
  const [ticksAbove, qty] = plan[i];
  const maxPrice = unit + ticksAbove * unit;
  const quantity = qty * 10n ** 18n;
  const q = creator.quoteBid(s, maxPrice, quantity);
  const deposit = local ? q.deposit : q.cost + (q.cost / 5n) + 1n; // testnet: cost + 20% blur
  // fresh wallet per bidder, funded with its deposit + gas (local: a flat amount)
  const c = clients(chain, RPC, generatePrivateKey());
  const fund = local ? BIDDER_FUNDS : deposit + GAS_BUFFER;
  const fh = await deployer.walletClient.sendTransaction({ to: c.account.address, value: fund });
  await deployer.publicClient.waitForTransactionReceipt({ hash: fh });
  bidders.push({ ...c, cloak: new Cloak(c.publicClient, c.walletClient) });
  const secret = await bidders[i].cloak.bid(launch.auction, { maxPrice, quantity, deposit });
  secrets.push(secret);
  txs[`commit${i}`] = secret.txHash;
}
s = await creator.getAuction(launch.auction);
ok(s.commits === plan.length, `${plan.length} sealed bids committed`);
ok(s.totalDemand === 0n && (await creator.demandCurve(launch.auction)).every((p) => p.demand === 0n), "demand is invisible during commit");

console.log(`waiting for commit to close + drand round ${s.tlockRound}…`);
await waitChainTime(deployer.publicClient, s.commitEnd, { mine });
await waitDrand(s.tlockRound);
// Bidders are gone — nobody reveals manually. The keeper opens every bid from the public beacon.
const r = await creator.revealAll(launch.auction, { fromBlock: launch.block, log: (m) => console.log(`  keeper: ${m}`) });
txs.revealBatch = r.txs[0];
s = await creator.getAuction(launch.auction);
ok(s.reveals === plan.length, "keeper auto-revealed every sealed bid (no bidder action)");

await waitChainTime(deployer.publicClient, s.revealEnd, { mine });
if (mine) await mine();
txs.settle = await creator.settle(launch.auction);
s = await creator.getAuction(launch.auction);
ok(s.settled && !s.failed, "settled");
console.log(`  clearing price ${fmt(s.clearingPrice, 9)} HYPE/token · sold ${fmt(s.sold, 0)} · raised ${fmt(s.raised)} HYPE`);
ok(s.clearingTick === 12, "clearing tick is the marginal bid level");

const claim = await creator.claimAll(launch.auction, { fromBlock: launch.block });
txs.claimAll = claim.txs[0];
const tokenOf = (a) =>
  deployer.publicClient.readContract({ address: s.token, abi: cloakTokenAbi, functionName: "balanceOf", args: [a] });
const got = await Promise.all(bidders.map((b) => tokenOf(b.account.address)));
ok(got[0] === 400_000n * 10n ** 18n, "high bidder filled in full");
ok(got[1] === 300_000n * 10n ** 18n, "second bidder filled in full");
ok(got[2] === got[3] && got[2] === 150_000n * 10n ** 18n, "marginal bidders split pro rata");
if (plan.length > 4) ok(got[4] === 0n, "below-clearing bidder got a full refund, no tokens");

const pairPrice = await creator.pairPrice(s.pair);
const diff = pairPrice > s.clearingPrice ? pairPrice - s.clearingPrice : s.clearingPrice - pairPrice;
ok(diff * 1_000_000n <= s.clearingPrice, "pool opens at the clearing price");
const shares = await deployer.publicClient.readContract({ address: s.pair, abi: cloakPairAbi, functionName: "sharesOf", args: ["0x000000000000000000000000000000000000dEaD"] });
const total = await deployer.publicClient.readContract({ address: s.pair, abi: cloakPairAbi, functionName: "totalShares" });
ok(shares === total, "LP shares burned (liquidity locked forever)");

const buyer = bidders[4] ?? bidders[0];
const swap = await buyer.walletClient.writeContract({ address: s.pair, abi: cloakPairAbi, functionName: "swapExactHypeForTokens", args: [0n, buyer.account.address], value: s.clearingPrice * 1000n });
await deployer.publicClient.waitForTransactionReceipt({ hash: swap });
txs.firstTrade = swap;
ok((await tokenOf(buyer.account.address)) > 0n, "trading is live on the pool");

console.log(`\n${checks} checks passed`);
if (!local) {
  mkdirSync(new URL("../deployments", import.meta.url), { recursive: true });
  const out = { chainId: chain.id, factory, auction: launch.auction, token: s.token, pair: s.pair, txs: Object.fromEntries(Object.entries(txs).map(([k, v]) => [k, explorer(v)])) };
  writeFileSync(new URL("../deployments/elysium-testnet.json", import.meta.url), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}
