// WL spot sales end to end on a local chain with the REAL drand beacon:
//   a partner gives 3 WL spots; we sell them as a sealed drop marked as a spot sale; 5 wallets bid; the bids open after
//   the drand round and settle; each winner names the wallet to whitelist (a fresh one, not the bidding wallet); losers
//   can't; a wallet can't take two spots; a winner changes its wallet; the book's list and CSV are exactly the 3 spots.
//   anvil --balance 1000000 --block-time 1 & ; node e2e/spots.mjs
import { generatePrivateKey } from "viem/accounts";
import { anvilLocal, cloakDropFactoryAbi, cloakSpotBookAbi, CloakDrops, CloakSpots } from "@cloakely/sdk";
import { bytecode } from "@cloakely/sdk/bytecode";
import { clients, deployFactory, parseEther, sleep, waitChainTime, waitDrand } from "./lib.mjs";

const RPC = "http://127.0.0.1:8545";
const chain = anvilLocal;
const PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
let checks = 0;
const ok = (c, m) => {
  if (!c) throw new Error(`✗ ${m}`);
  checks++;
  console.log(`  ✓ ${m}`);
};
const fails = async (p, re, m) => {
  try {
    await p;
  } catch (e) {
    return ok(re.test(e.message), `${m} (${(e.shortMessage || e.message).split("\n")[0].slice(0, 90)})`);
  }
  ok(false, m);
};
const d = clients(chain, RPC, PK);
const send = async (p) => {
  const r = await d.publicClient.waitForTransactionReceipt({ hash: await p });
  if (r.status !== "success") throw new Error(`reverted ${r.transactionHash}`);
  return r;
};

const f = await deployFactory(d.publicClient, d.walletClient, { rules: { withdrawFeeBps: 25, launchFeeBps: 200 } });
const DROP_FACTORY = (await send(d.walletClient.deployContract({ abi: cloakDropFactoryAbi, bytecode: bytecode.CloakDropFactory, args: [f.config, "https://cloak.boblabs.tech/api/nft/"] }))).contractAddress;
const BOOK = (await send(d.walletClient.deployContract({ abi: cloakSpotBookAbi, bytecode: bytecode.CloakSpotBook, args: [DROP_FACTORY] }))).contractAddress;
console.log(`drop factory ${DROP_FACTORY} · spot book ${BOOK}`);

const wallet = async (hype = "20") => {
  const c = clients(chain, RPC, generatePrivateKey());
  await send(d.walletClient.sendTransaction({ to: c.account.address, value: parseEther(hype) }));
  const drops = new CloakDrops(c.publicClient, c.walletClient, DROP_FACTORY);
  return { c, addr: c.account.address, drops, spots: new CloakSpots(drops, BOOK) };
};
const ws = [];
for (let i = 0; i < 5; i++) ws.push(await wallet());
const [a, b, c, e, loser] = ws;
const fresh = () => clients(chain, RPC, generatePrivateKey()).account.address;

// ── 1. the sale: 3 Moonfoxes WL spots, floor 0.5 ──
const us = new CloakSpots(new CloakDrops(d.publicClient, d.walletClient, DROP_FACTORY), BOOK);
const { drop, deadline } = await us.create({ name: "Moonfoxes WL spots", symbol: "MWL", supply: 3, floor: parseEther("0.5"), tickSize: parseEther("0.1"), numTicks: 20, biddingSecs: 30, revealSecs: 40, partner: "Moonfoxes", walletDays: 2 });
const sale = await us.sale(drop);
ok(sale?.partner === "Moonfoxes" && sale.deadline === deadline, `drop ${drop} is a WL spot sale for Moonfoxes`);
let s = await us.drops.get(drop);
ok(s.supply === 3 && s.maxPerBid === 1 && !s.hasGtd, "3 spots, one per bid, no GTD");
ok((await us.drops.details(drop)).spots?.partner === "Moonfoxes", "the drop's published details say it sells WL spots");
ok((await us.sales()).some((x) => x.toLowerCase() === drop.toLowerCase()), "the book lists the sale");
await fails(us.open(drop, "Again", deadline), /already a sale/, "a drop is a sale only once");
await fails(a.spots.open(drop, "Hijack", deadline), /creator/, "only the creator can mark a drop as a sale");
ok((await new CloakSpots(us.drops, BOOK).sale(f.factory)) === null, "any other address is not a sale");

// ── 2. sealed bids: a 0.9, b 0.8, c 0.7 win; e and loser at 0.5 lose ──
await waitChainTime(d.publicClient, s.gtdEnd);
const bid = {};
for (const [w, p] of [[a, "0.9"], [b, "0.8"], [c, "0.7"], [e, "0.5"], [loser, "0.5"]]) bid[w.addr] = await w.drops.bid(drop, { price: parseEther(p), quantity: 1 });
await fails(a.spots.setWallets(drop, bid[a.addr].id, [fresh()]), /not settled/, "wallets wait until the sale settles");

// ── 3. open and settle (here the test does the keeper's part) ──
console.log("    · waiting for the drand round…");
await waitDrand(s.tlockRound);
await waitChainTime(d.publicClient, s.commitEnd);
await us.drops.revealAll(drop);
await waitChainTime(d.publicClient, s.revealEnd);
await us.drops.settle(drop);
s = await us.drops.get(drop);
ok(s.phase === "settled" && s.sold === 3 && s.publicPrice === parseEther("0.7"), "settled: 3 spots sold, every winner pays 0.7 (the lowest winning bid)");
let winners = await us.winners(drop);
ok(winners.length === 3 && winners.every((w) => w.spots === 1 && !w.wallets.length), "3 winners, none has named a wallet yet");

// ── 4. winners name wallets ──
const wa = fresh();
const wb = fresh();
const wc = fresh();
await a.spots.setWallets(drop, bid[a.addr].id, [wa]);
await b.spots.setWallets(drop, bid[b.addr].id, [wb]);
ok((await us.winners(drop)).filter((w) => w.wallets.length).length === 2, "two winners named fresh wallets, not the ones they bid from");
await fails(loser.spots.setWallets(drop, bid[loser.addr].id, [fresh()]), /won no spots/, "a losing bid can't take a spot");
await fails(loser.spots.setWallets(drop, bid[c.addr].id, [fresh()]), /not your bid/, "nobody can name wallets for someone else's win");
await fails(c.spots.setWallets(drop, bid[c.addr].id, [wa]), /already has a spot/, "a wallet can't take two spots");
await fails(c.spots.setWallets(drop, bid[c.addr].id, [wc, fresh()]), /one wallet per spot/, "one wallet per spot won");
await fails(c.spots.setWallets(drop, bid[c.addr].id, ["0x123"]), /isn't a wallet address/, "a typo'd address is caught before sending");
await c.spots.setWallets(drop, bid[c.addr].id, [wc]);

// ── 5. a winner changes its mind ──
const wa2 = fresh();
await a.spots.setWallets(drop, bid[a.addr].id, [wa2]);
winners = await us.winners(drop);
const named = winners.flatMap((w) => w.wallets).map((x) => x.toLowerCase());
ok(named.length === 3 && named.includes(wa2.toLowerCase()) && !named.includes(wa.toLowerCase()), "a winner swapped its wallet: the old one is off the list");
ok((await d.publicClient.readContract({ address: BOOK, abi: cloakSpotBookAbi, functionName: "spotOf", args: [drop, wa] })) === 0n, "and freed for anyone else");

// ── 6. the partner's list ──
const csv = CloakSpots.csv(winners);
const rows = csv.trim().split("\n");
ok(rows.length === 4 && rows[0] === "wallet,bid,bidder,status" && rows.slice(1).every((r) => r.endsWith(",named")), "the CSV has the 3 wallets to whitelist");
ok(![a, b, c].some((w) => named.includes(w.addr.toLowerCase())), "no bidding wallet is on the whitelist");

// ── 7. after the deadline the list is final ──
const rpc = (method, params) => fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
const now = Number((await d.publicClient.getBlock()).timestamp);
// the clock jumps 2 days here; put it back after, since later tests on this chain seal bids to drand rounds by chain time
const snap = (await (await rpc("evm_snapshot", [])).json()).result;
await rpc("evm_increaseTime", [deadline - now + 5]);
await rpc("evm_mine", []);
await fails(b.spots.setWallets(drop, bid[b.addr].id, [fresh()]), /deadline passed/, "after the deadline the list is final");
await us.drops.claimAll(drop);
ok((await us.drops.bids(drop)).every((x) => x.claimed), "winners got their receipt NFTs and losers their refunds");
await rpc("evm_revert", [snap]);
console.log(`\n${checks} checks passed`);
await sleep(10);
process.exit(0);
