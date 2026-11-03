// WL spot sales live on Elysium testnet, with the hosted keeper opening and settling:
//   2 partner WL spots sold sealed; 3 fresh wallets bid; the keeper settles; both winners name a brand-new wallet to
//   whitelist; the loser can't; the book's list and CSV hold exactly the 2 wallets; the sale page is up.
//   Small amounts, funded from DEPLOYER_PK into fresh wallets. Testnet only.
//   DEPLOYER_PK=0x… node e2e/live-spots.mjs
import { generatePrivateKey } from "viem/accounts";
import { CloakDrops, CloakSpots, deploymentFor, elysiumTestnet } from "@cloakely/sdk";
import { clients, parseEther, sleep, waitChainTime, waitDrand } from "./lib.mjs";

const chain = elysiumTestnet;
const RPC = process.env.RPC_URL || chain.rpcUrls.default.http[0];
const SITE = process.env.SITE || "https://cloak.boblabs.tech";
const dep = deploymentFor(chain.id);
let checks = 0;
const ok = (c, m) => {
  if (!c) throw new Error(`✗ ${m}`);
  checks++;
  console.log(`  ✓ ${m}`);
};
const d = clients(chain, RPC, process.env.DEPLOYER_PK);
const send = async (p) => {
  const r = await d.publicClient.waitForTransactionReceipt({ hash: await p });
  if (r.status !== "success") throw new Error(`reverted ${r.transactionHash}`);
  return r;
};
const wallet = async (hype) => {
  const c = clients(chain, RPC, generatePrivateKey());
  await send(d.walletClient.sendTransaction({ to: c.account.address, value: parseEther(hype) }));
  const drops = new CloakDrops(c.publicClient, c.walletClient, dep.dropFactory, dep.dropFactoryBlock);
  return { c, addr: c.account.address, drops, spots: new CloakSpots(drops, dep.spotBook) };
};
const ws = [];
for (let i = 0; i < 4; i++) ws.push(await wallet("0.01"));
const [creator, a, b, loser] = ws;
const fresh = () => clients(chain, RPC, generatePrivateKey()).account.address;

const { drop, deadline } = await creator.spots.create({ name: "Live Test WL spots", symbol: "LTWL", supply: 2, floor: parseEther("0.001"), tickSize: parseEther("0.0005"), numTicks: 10, biddingSecs: 60, revealSecs: 120, partner: "Live Test Partner", walletDays: 1, description: "An e2e test sale. Testnet only." });
ok((await creator.spots.sale(drop))?.partner === "Live Test Partner", `${drop} is a WL spot sale (wallets until ${new Date(deadline * 1000).toISOString()})`);
let s = await creator.drops.get(drop);
await waitChainTime(d.publicClient, s.gtdEnd + 2);
const bid = {
  a: await a.drops.bid(drop, { price: parseEther("0.002"), quantity: 1 }),
  b: await b.drops.bid(drop, { price: parseEther("0.0015"), quantity: 1 }),
  l: await loser.drops.bid(drop, { price: parseEther("0.001"), quantity: 1 }),
};
ok((await creator.drops.bids(drop)).length === 3, "3 sealed bids in for 2 spots");

console.log("    · waiting for the drand round and the hosted keeper…");
await waitDrand(s.tlockRound);
for (let i = 0; i < 300; i++) {
  s = await creator.drops.get(drop);
  if (s.phase === "settled") break;
  await sleep(2000);
}
ok(s.phase === "settled" && s.sold === 2 && s.publicPrice === parseEther("0.0015"), "the hosted keeper settled: 2 spots at 0.0015 each");

const wa = fresh();
const wb = fresh();
await a.spots.setWallets(drop, bid.a.id, [wa]);
await b.spots.setWallets(drop, bid.b.id, [wb]);
let lost = false;
await loser.spots.setWallets(drop, bid.l.id, [fresh()]).catch(() => (lost = true));
ok(lost, "the losing bid can't take a spot");
const winners = await creator.spots.winners(drop);
const named = winners.flatMap((w) => w.wallets).map((x) => x.toLowerCase());
ok(named.length === 2 && named.includes(wa.toLowerCase()) && named.includes(wb.toLowerCase()), "both winners named brand-new wallets to whitelist");
ok(![a, b].some((w) => named.includes(w.addr.toLowerCase())), "neither bidding wallet is on the whitelist");
const csv = CloakSpots.csv(winners).trim().split("\n");
ok(csv.length === 3 && csv.slice(1).every((r) => r.endsWith(",named")), "the CSV holds the 2 wallets");
ok((await fetch(`${SITE}/app/drop/${drop}`)).status === 200, "the sale page is up");
console.log(`\n${checks} checks passed · ${SITE}/app/drop/${drop}`);
process.exit(0);
