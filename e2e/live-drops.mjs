// Sealed NFT drops live on Elysium testnet, with the hosted keeper doing the opening and settling:
//   a 4-NFT drop with one GTD spot and a one-wallet WL (20% boost); the GTD wallet mints; three public wallets and the
//   WL wallet bid sealed; the hosted keeper opens the bids after the drand round, settles and numbers the tie; winners
//   claim (one to a fresh wallet), losers are refunded; the metadata API serves a minted NFT.
//   Small amounts, funded from DEPLOYER_PK into fresh wallets. Testnet only.
//   DEPLOYER_PK=0x… node e2e/live-drops.mjs
import { generatePrivateKey } from "viem/accounts";
import { CloakDrops, cloakDropAbi, deploymentFor, elysiumTestnet } from "@cloakely/sdk";
import { clients, parseEther, sleep, waitChainTime, waitDrand } from "./lib.mjs";

const chain = elysiumTestnet;
const RPC = process.env.RPC_URL || chain.rpcUrls.default.http[0];
const SITE = process.env.SITE || "https://cloak.boblabs.tech";
const KEEPER = process.env.KEEPER_URL || "https://cloak-keeper.onrender.com";
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
const h = await (await fetch(`${KEEPER}/health`)).json();
ok(h.drops?.factory?.toLowerCase() === dep.dropFactory.toLowerCase(), `the hosted keeper runs drops on ${dep.dropFactory} (commit ${h.commit})`);

const wallet = async (hype) => {
  const c = clients(chain, RPC, generatePrivateKey());
  await send(d.walletClient.sendTransaction({ to: c.account.address, value: parseEther(hype) }));
  return { c, addr: c.account.address, drops: new CloakDrops(c.publicClient, c.walletClient, dep.dropFactory, dep.dropFactoryBlock) };
};
const ws = [];
for (let i = 0; i < 6; i++) ws.push(await wallet("0.01"));
const [creatorW, gtd, wl, p1, p2, p3] = ws;
const F = parseEther("0.001");

const { drop } = await creatorW.drops.create({
  name: "Live Test Foxes",
  symbol: "LTF",
  baseURI: "",
  supply: 4,
  floor: F,
  tickSize: parseEther("0.0005"),
  numTicks: 10,
  maxPerBid: 2,
  gtd: { list: [{ wallet: gtd.addr, spots: 1 }], price: parseEther("0.0008"), durationSecs: 30 },
  wl: { list: [wl.addr], boostBps: 2000 },
  biddingSecs: 75,
  revealSecs: 120,
  description: "An e2e test drop. Testnet only.",
});
const c = creatorW.drops;
let s = await c.get(drop);
ok(s.phase === "gtd" && s.wlBoostBps === 2000, `drop ${drop} is live: GTD first, WL boost 20%`);
ok(s.baseURI.toLowerCase() === `https://cloak.boblabs.tech/api/nft/${drop.toLowerCase()}/`, "with no folder of its own, its metadata comes from Cloak's API");

await gtd.drops.gtdMint(drop, 1);
ok((await c.get(drop)).gtdMinted === 1, "the GTD wallet minted its spot");
await waitChainTime(d.publicClient, s.gtdEnd + 2);
s = await c.get(drop);
ok(s.phase === "bidding" && s.auctionSupply === 3, "bidding is open with 3 NFTs");

// p1 0.0015 ranks first, WL 0.001 ranks as 0.0012, then p2 (2) and p3 (1) tie at 0.001 for the last NFT
const b = {
  p1: await p1.drops.bid(drop, { price: parseEther("0.0015"), quantity: 1 }),
  wl: await wl.drops.bid(drop, { price: F, quantity: 1, wl: true }),
  p2: await p2.drops.bid(drop, { price: F, quantity: 2 }),
  p3: await p3.drops.bid(drop, { price: F, quantity: 1 }),
};
ok((await c.bids(drop)).every((x) => !x.revealed), "4 sealed bids in, unreadable on chain");

console.log("    · waiting for the drand round and the hosted keeper…");
await waitDrand(s.tlockRound);
for (let i = 0; i < 300; i++) {
  s = await c.get(drop);
  if (s.phase === "settled") break;
  await sleep(2000);
}
ok(s.phase === "settled" && s.reveals === 4, "the hosted keeper opened every bid and settled");
ok(s.sold === 3 && s.tieSupply === 1 && s.tieDemand === 3, "3 sold: the 0.0015 bid and the boosted WL bid, then a tie for the last one");
ok(s.publicPrice === F && s.wlPrice === F, "every winner pays the floor, 0.001");
const all = await c.bids(drop);
const of = (w) => all.find((x) => x.bidder.toLowerCase() === w.addr.toLowerCase());
ok(of(p1).nfts === 1 && of(wl).nfts === 1, "the high bid and the WL bid win in full");
ok(of(p2).nfts + of(p3).nfts === 1, `exactly one NFT goes to the tie (${of(p2).nfts} and ${of(p3).nfts})`);

// winners claim now rather than wait for the keeper's hour
const fresh = (await wallet("0.001")).addr;
await p1.drops.claimTo(drop, b.p1.id, fresh);
ok((await d.publicClient.readContract({ address: drop, abi: cloakDropAbi, functionName: "balanceOf", args: [fresh] })) === 1n, "the top bidder took its NFT to a brand-new wallet");
for (const [w, x] of [[wl, b.wl], [p2, b.p2], [p3, b.p3]]) await send(w.c.walletClient.writeContract({ address: drop, abi: cloakDropAbi, functionName: "claim", args: [x.id] }));
const minted = await d.publicClient.readContract({ address: drop, abi: cloakDropAbi, functionName: "totalSupply" });
ok(minted === 4n, "4 NFTs exist: 1 GTD and 3 from the auction");
const loser = of(p2).nfts ? p3 : p2;
ok((await c.bids(drop, loser.addr))[0].claimed, "the tied bid that lost was refunded");

const meta = await fetch(`${SITE}/api/nft/${drop}/1`).then((r) => r.json());
ok(meta.name === "Live Test Foxes #1" && typeof meta.image === "string", `the metadata API serves NFT #1 (${meta.name})`);
const page = await fetch(`${SITE}/app/drop/${drop}`).then((r) => r.status);
ok(page === 200, "the drop page is up on the site");
console.log(`\n${checks} checks passed · ${SITE}/app/drop/${drop}`);
process.exit(0);
