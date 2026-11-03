// Sealed NFT drops end to end on a local chain, with the REAL drand beacon and the keeper doing its part on its own:
//   a drop with a GTD list and a WL with a 20% boost; a GTD wallet mints its spots and another lets its spot roll into
//   the auction; WL and public wallets bid sealed; the keeper opens the bids after the drand round, settles, numbers the
//   tied bids and delivers; every winner pays one price, WL never under the floor; losers are refunded; the creator is
//   paid and mints what's left. One bidder claims to a fresh wallet before the keeper delivers.
//   anvil --balance 1000000 --block-time 1 & ; node e2e/drops.mjs
import { spawn } from "node:child_process";
import { generatePrivateKey } from "viem/accounts";
import { anvilLocal, cloakDropAbi, cloakDropFactoryAbi, CloakDrops } from "@cloakely/sdk";
import { bytecode } from "@cloakely/sdk/bytecode";
import { clients, deployFactory, fmt, parseEther, sleep, waitChainTime, waitDrand } from "./lib.mjs";

const RPC = "http://127.0.0.1:8545";
const chain = anvilLocal;
const PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // anvil #0: deployer and creator
const KEEPER_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // anvil #1
const root = new URL("..", import.meta.url).pathname;
let checks = 0;
const ok = (c, m) => {
  if (!c) throw new Error(`✗ ${m}`);
  checks++;
  console.log(`  ✓ ${m}`);
};
const send = async (p) => {
  const r = await d.publicClient.waitForTransactionReceipt({ hash: await p });
  if (r.status !== "success") throw new Error(`reverted ${r.transactionHash}`);
  return r;
};

const d = clients(chain, RPC, PK);
const f = await deployFactory(d.publicClient, d.walletClient, { rules: { withdrawFeeBps: 25, launchFeeBps: 200 } });
const df = await send(d.walletClient.deployContract({ abi: cloakDropFactoryAbi, bytecode: bytecode.CloakDropFactory, args: [f.config, "https://cloak.boblabs.tech/api/nft/"] }));
const DROP_FACTORY = df.contractAddress;
console.log(`drop factory ${DROP_FACTORY}`);

const wallet = async (hype = "20") => {
  const c = clients(chain, RPC, generatePrivateKey());
  await send(d.walletClient.sendTransaction({ to: c.account.address, value: parseEther(hype) }));
  return { c, addr: c.account.address, drops: new CloakDrops(c.publicClient, c.walletClient, DROP_FACTORY) };
};
const ws = [];
for (let i = 0; i < 8; i++) ws.push(await wallet()); // one at a time: they share the deployer's nonce
const [gtdA, gtdB, wlA, wlB, p1, p2, p3, p4] = ws;

const keeper = spawn(process.execPath, [`${root}services/keeper/index.mjs`], {
  env: { ...process.env, RPC_URL: RPC, KEEPER_PK, FACTORY: f.factory, DROP_FACTORY, CLAIM_DELAY: "25", POLL_MS: "1000", PORT: "3997", HYPE_PRICE_URL: "http://127.0.0.1:9/", HYPE_USD: "25" },
  stdio: ["ignore", process.env.KEEPER_LOG ? "inherit" : "ignore", "inherit"],
});
try {
  // ── 1. the drop: 6 NFTs, floor 0.5, GTD 2 + 1 spots at 0.4, WL of two with a 20% boost ──
  const creator = new CloakDrops(d.publicClient, d.walletClient, DROP_FACTORY);
  const { drop } = await creator.create({
    name: "Moonfoxes",
    symbol: "MOON",
    baseURI: "ipfs://moonfoxes/",
    supply: 6,
    floor: parseEther("0.5"),
    tickSize: parseEther("0.1"),
    numTicks: 20,
    maxPerBid: 2,
    gtd: { list: [{ wallet: gtdA.addr, spots: 2 }, { wallet: gtdB.addr, spots: 1 }], price: parseEther("0.4"), durationSecs: 20 },
    wl: { list: [wlA.addr, wlB.addr], boostBps: 2000 },
    biddingSecs: 30,
    revealSecs: 40,
    image: "data:image/svg+xml;base64,PHN2Zy8+",
    description: "A test collection",
  });
  let s = await creator.get(drop);
  ok(s.phase === "gtd" && s.supply === 6 && s.wlBoostBps === 2000 && s.hasGtd && s.hasWl, `drop ${drop}: 6 NFTs, GTD open, WL boost 20%`);
  const det = await creator.details(drop);
  ok(det.gtd?.length === 2 && det.wl?.length === 2 && det.image?.startsWith("data:image"), "its details (image, GTD list, WL) are published with it");
  ok((await creator.listed(drop, wlA.addr)).wl && (await creator.listed(drop, gtdA.addr)).gtdSpots === 2, "a wallet can see it's on the WL or the GTD list");

  // ── 2. GTD: A mints its 2 spots, B lets its spot go ──
  await gtdA.drops.gtdMint(drop, 2);
  ok((await d.publicClient.readContract({ address: drop, abi: cloakDropAbi, functionName: "balanceOf", args: [gtdA.addr] })) === 2n, "GTD wallet minted its 2 spots at 0.4");
  await p1.drops.gtdMint(drop, 1).then(() => ok(false, "a wallet off the list minted GTD"), () => ok(true, "a wallet off the GTD list can't mint GTD"));
  await p1.drops.bid(drop, { price: parseEther("0.5"), quantity: 1 }).then(() => ok(false, "bid during GTD"), (e) => ok(/GTD window/.test(e.message), "bidding waits for the GTD window to close"));

  // ── 3. bidding: 4 NFTs left (B's unused spot rolled over) ──
  await waitChainTime(d.publicClient, s.gtdEnd);
  s = await creator.get(drop);
  ok(s.phase === "bidding" && s.auctionSupply === 4, "GTD closed: 4 NFTs go to auction (the unused GTD spot rolled over)");
  // WL 0.5 ranks as 0.6, level with a public 0.6: together 3 NFTs above the public 0.5 bids, which tie for the last one
  const bids = {
    wlA: await wlA.drops.bid(drop, { price: parseEther("0.5"), quantity: 2, wl: true }),
    p3: await p3.drops.bid(drop, { price: parseEther("0.6"), quantity: 1 }),
    p1: await p1.drops.bid(drop, { price: parseEther("0.5"), quantity: 1 }),
    p2: await p2.drops.bid(drop, { price: parseEther("0.5"), quantity: 1 }),
    p4: await p4.drops.bid(drop, { price: parseEther("0.55"), quantity: 2, deposit: parseEther("3") }), // snaps to 0.5; padded deposit
  };
  await p1.drops.bid(drop, { price: parseEther("0.5"), quantity: 1, wl: true }).then(() => ok(false, "WL bid from off the list"), (e) => ok(/isn't on the WL/.test(e.message), "a wallet off the WL can't bid as WL"));
  const before = await creator.bids(drop);
  ok(before.length === 5 && before.every((b) => !b.revealed), "5 sealed bids in, none readable on chain");

  // ── 4. the keeper opens, settles and numbers the ties on its own ──
  console.log("    · waiting for the drand round and the keeper…");
  await waitDrand(s.tlockRound);
  for (let i = 0; i < 180; i++) {
    s = await creator.get(drop);
    if (s.phase === "settled") break;
    await sleep(1000);
  }
  ok(s.phase === "settled" && s.reveals === 5, `the keeper opened all 5 bids and settled (sold ${s.sold})`);
  ok(s.sold === 4 && s.tieSupply === 1 && s.tieDemand === 4, "4 sold: the WL and the 0.6 bid fill, the public 0.5 bids tie for the last one");
  ok(s.publicPrice === parseEther("0.5") && s.wlPrice === parseEther("0.5"), "everyone pays the floor, 0.5 (WL never below it)");
  const after = await creator.bids(drop);
  const by = (who) => after.find((b) => b.bidder.toLowerCase() === who.addr.toLowerCase());
  ok(by(wlA).nfts === 2 && by(p3).nfts === 1, "the boosted WL bid and the public 0.6 bid fill in full");
  const tied = [by(p1), by(p2), by(p4)];
  ok(tied.reduce((a, b) => a + b.nfts, 0) === 1, `exactly one NFT goes to the tied bids (${tied.map((b) => b.nfts).join(", ")})`);
  ok(after.every((b) => b.paid + b.refund === b.deposit && b.paid === BigInt(b.nfts) * parseEther("0.5")), "every deposit is paid at 0.5 per NFT or refunded, nothing kept");

  // ── 5. a winner takes its NFTs to a fresh wallet before the keeper delivers ──
  const fresh = (await wallet("0.01")).addr;
  await p3.drops.claimTo(drop, bids.p3.id, fresh);
  ok((await d.publicClient.readContract({ address: drop, abi: cloakDropAbi, functionName: "balanceOf", args: [fresh] })) === 1n, "the 0.6 winner took its NFT to a brand-new wallet");

  // ── 6. the keeper delivers the rest and pays out ──
  const p4Before = await d.publicClient.getBalance({ address: p4.addr });
  for (let i = 0; i < 120; i++) {
    if ((await creator.bids(drop)).every((b) => b.claimed)) break;
    await sleep(1000);
  }
  ok((await creator.bids(drop)).every((b) => b.claimed), "the keeper delivered every bid after the claim window");
  const p4After = await d.publicClient.getBalance({ address: p4.addr });
  ok(p4After - p4Before === by(p4).refund, `the padded deposit came back (${fmt(by(p4).refund, 2)} HYPE)`);
  const minted = await d.publicClient.readContract({ address: drop, abi: cloakDropAbi, functionName: "totalSupply" });
  ok(minted === 6n, "6 NFTs exist: 2 GTD + 4 from the auction");
  for (let i = 0; i < 30 && (await d.publicClient.readContract({ address: drop, abi: cloakDropAbi, functionName: "creatorOwed" })) > 0n; i++) await sleep(1000);
  ok((await d.publicClient.readContract({ address: drop, abi: cloakDropAbi, functionName: "creatorOwed" })) === 0n, "the keeper paid the creator's proceeds");
  const uri = await d.publicClient.readContract({ address: drop, abi: cloakDropAbi, functionName: "tokenURI", args: [1n] });
  ok(uri === "ipfs://moonfoxes/1", "token metadata points at the collection's folder");
  await creator.mintUnsold(drop, d.account.address, 1).then(() => ok(false, "minted past the supply"), () => ok(true, "the creator can't mint past the supply (all 6 sold)"));
  console.log(`\n${checks} checks passed`);
} finally {
  keeper.kill();
}
process.exit(0);
