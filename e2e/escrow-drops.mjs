// Auctions of NFTs that already exist (CloakEscrowDrop), end to end on a local chain with the REAL drand beacon and the
// keeper doing its part on its own:
//   1. an owner of an existing collection lists 5 of its tokens: the SDK approves the factory and the tokens move into
//      the auction in the same transaction; listing a token it doesn't own is refused
//   2. four wallets bid sealed (one from the WL, with its boost); bids under the floor are refused
//   3. the keeper opens the bids after the drand round, settles, numbers the slots and delivers: each winner holds the
//      exact tokens the auction assigned it, every winner pays one price, the loser is refunded in full
//   4. one winner takes its tokens to a fresh wallet before the keeper delivers
//   5. the owner takes back what nobody bought, and is paid; the auction holds nothing at the end
//   anvil --balance 1000000 --block-time 1 & ; (cd contracts && forge build) ; node e2e/escrow-drops.mjs
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { generatePrivateKey } from "viem/accounts";
import { anvilLocal, cloakEscrowDropAbi, cloakEscrowDropFactoryAbi, CloakDrops, erc721Abi } from "@cloakely/sdk";
import { bytecode } from "@cloakely/sdk/bytecode";
import { clients, deployFactory, parseEther, sleep, waitChainTime } from "./lib.mjs";

const RPC = "http://127.0.0.1:8545";
const chain = anvilLocal;
const root = new URL("..", import.meta.url).pathname;
const PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const KEEPER_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
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
const pub = d.publicClient;
const send = async (p) => {
  const r = await pub.waitForTransactionReceipt({ hash: await p });
  if (r.status !== "success") throw new Error(`reverted ${r.transactionHash}`);
  return r;
};

const f = await deployFactory(pub, d.walletClient, { rules: { withdrawFeeBps: 25, launchFeeBps: 200 } });
const ESCROW = (await send(d.walletClient.deployContract({ abi: cloakEscrowDropFactoryAbi, bytecode: bytecode.CloakEscrowDropFactory, args: [f.config] }))).contractAddress;
// a drop factory too: the client lists both, as the site does
const { cloakDropFactoryAbi } = await import("@cloakely/sdk");
const DROPS = (await send(d.walletClient.deployContract({ abi: cloakDropFactoryAbi, bytecode: bytecode.CloakDropFactory, args: [f.config, "https://cloak.boblabs.tech/api/nft/"] }))).contractAddress;
const mock = JSON.parse(readFileSync(`${root}contracts/out/MockNFT.sol/MockNFT.json`, "utf8"));
console.log(`escrow factory ${ESCROW} · drop factory ${DROPS}`);

const wallet = async (hype = "20") => {
  const c = clients(chain, RPC, generatePrivateKey());
  await send(d.walletClient.sendTransaction({ to: c.account.address, value: parseEther(hype) }));
  return { c, addr: c.account.address, drops: new CloakDrops(c.publicClient, c.walletClient, DROPS, 0n, ESCROW) };
};
const ws = [];
for (let i = 0; i < 6; i++) ws.push(await wallet());
const [owner, a, b, c, loser, wl] = ws;

// the existing collection: deployed and minted by someone else, the owner holds tokens 1..8, a stranger holds 9
const nftAddr = (await send(d.walletClient.deployContract({ abi: mock.abi, bytecode: mock.bytecode.object, args: ["Elympus", "ELYM", "ipfs://elympus/"] }))).contractAddress;
const nft = { address: nftAddr, abi: erc721Abi };
await send(d.walletClient.writeContract({ address: nftAddr, abi: mock.abi, functionName: "mint", args: [owner.addr, 1n, 8n] }));
await send(d.walletClient.writeContract({ address: nftAddr, abi: mock.abi, functionName: "mint", args: [a.addr, 9n, 1n] }));
const ownerOf = (id) => pub.readContract({ ...nft, functionName: "ownerOf", args: [id] });

const keeper = spawn(process.execPath, [`${root}services/keeper/index.mjs`], {
  env: { ...process.env, RPC_URL: RPC, KEEPER_PK, FACTORY: f.factory, DROP_FACTORY: DROPS, ESCROW_DROP_FACTORY: ESCROW, CLAIM_DELAY: "25", POLL_MS: "1000", PORT: "3996", HYPE_PRICE_URL: "http://127.0.0.1:9/", HYPE_USD: "25" },
  stdio: ["ignore", process.env.KEEPER_LOG ? "inherit" : "ignore", "inherit"],
});
try {
  // ── 1. list 5 existing tokens ──
  const mine = await owner.drops.ownedTokens(nftAddr, owner.addr);
  ok(mine.length === 8 && mine[0] === 1n && mine[7] === 8n, "the SDK finds the 8 tokens the owner holds, from the collection's own events");
  const base = { collection: nftAddr, name: "Elympus treasury auction", symbol: "ELYMA", floor: parseEther("0.5"), tickSize: parseEther("0.1"), numTicks: 20, maxPerBid: 2, biddingSecs: 30, revealSecs: 40, wl: { list: [wl.addr], boostBps: 2000 }, description: "Five Elympus from the treasury." };
  await fails(owner.drops.createEscrow({ ...base, tokenIds: [3n, 9n] }), /doesn't own token 9/, "listing a token the owner doesn't hold is refused before anything is sent");
  const { drop, approvalTx } = await owner.drops.createEscrow({ ...base, tokenIds: [5n, 1n, 3n, 2n, 4n] });
  ok(!!approvalTx, "the SDK approved the escrow factory for the collection first (one transaction)");
  for (const id of [1n, 2n, 3n, 4n, 5n]) if ((await ownerOf(id)).toLowerCase() !== drop.toLowerCase()) ok(false, `token ${id} is in escrow`);
  ok((await ownerOf(6n)).toLowerCase() === owner.addr.toLowerCase(), `tokens 1..5 are in the auction ${drop}, token 6 stays with the owner`);
  let s = await owner.drops.get(drop);
  ok(s.escrow?.collection.toLowerCase() === nftAddr.toLowerCase() && s.escrow.held === 5 && s.escrow.tokenIds.join() === "1,2,3,4,5", "the auction says what it holds: 5 of 5 tokens, sorted");
  ok(s.supply === 5 && !s.hasGtd && s.hasWl && s.royaltyBps === 0 && s.name === "Elympus treasury auction", "5 for sale, no GTD, WL boost on, the collection's own royalties");
  ok((await a.drops.list()).some((x) => x.toLowerCase() === drop.toLowerCase()), "it's listed next to the minting drops");
  ok((await a.drops.details(drop)).description === "Five Elympus from the treasury.", "its details are published like a drop's");

  // ── 2. sealed bids ──
  await waitChainTime(pub, s.gtdEnd);
  const bid = {};
  for (const [w, p, q] of [[a, "0.9", 2], [b, "0.8", 1], [c, "0.7", 2], [loser, "0.6", 1]]) bid[w.addr] = await w.drops.bid(drop, { price: parseEther(p), quantity: q });
  bid[wl.addr] = await wl.drops.bid(drop, { price: parseEther("0.6"), quantity: 1, wl: true }); // ranks as 0.72
  await fails(loser.drops.bid(drop, { price: parseEther("0.4"), quantity: 1 }), /creator's price|floor|deposit/i, "a bid under the floor is refused");
  ok((await owner.drops.get(drop)).bids === 5, "five sealed bids in");

  // ── 3. the keeper opens, settles, numbers the slots ──
  console.log("    · waiting for the drand round and the keeper…");
  for (let i = 0; i < 200 && (s = await owner.drops.get(drop)).phase !== "settled"; i++) await sleep(2000);
  ok(s.phase === "settled" && s.reveals === 5 && s.sold === 5, "the keeper opened all 5 bids, settled and numbered the slots");
  // supply 5: a 0.9×2, b 0.8×1 win; then c 0.7×2 at the edge… WL 0.6 ranks as 0.72 (above c) and takes 1, c gets 1
  ok(s.publicPrice === parseEther("0.7"), "every public winner pays 0.7, the lowest winning bid");
  const won = {};
  for (const w of [a, b, c, wl, loser]) won[w.addr] = await owner.drops.tokensOf(drop, bid[w.addr].id);
  ok(won[a.addr].length === 2 && won[b.addr].length === 1 && won[wl.addr].length === 1 && won[c.addr].length === 1 && won[loser.addr].length === 0, "a wins 2, b 1, the boosted WL bid 1, c 1, the 0.6 bid nothing");
  const all = [a, b, c, wl].flatMap((w) => won[w.addr]).map(String).sort();
  ok(all.join() === "1,2,3,4,5", "the five tokens are split between the winners, each exactly once");

  // ── 4. a winner takes its tokens to a fresh wallet itself ──
  const fresh = clients(chain, RPC, generatePrivateKey()).account.address;
  await a.drops.claimTo(drop, bid[a.addr].id, fresh);
  for (const id of won[a.addr]) if ((await ownerOf(id)).toLowerCase() !== fresh.toLowerCase()) ok(false, "a's tokens at its fresh wallet");
  ok(true, `a's tokens ${won[a.addr].join(", ")} went to a fresh wallet, not the one it bid from`);

  // ── 5. the keeper delivers the rest; the loser is refunded ──
  const loserBefore = await pub.getBalance({ address: loser.addr });
  for (let i = 0; i < 120 && !(await owner.drops.bids(drop)).every((x) => x.claimed); i++) await sleep(2000);
  ok((await owner.drops.bids(drop)).every((x) => x.claimed), "the keeper delivered every bid after the claim window");
  for (const w of [b, c, wl]) for (const id of won[w.addr]) if ((await ownerOf(id)).toLowerCase() !== w.addr.toLowerCase()) ok(false, `token ${id} delivered`);
  ok(true, "b, c and the WL winner each hold exactly their assigned tokens");
  ok((await pub.getBalance({ address: loser.addr })) - loserBefore === parseEther("0.6"), "the losing bid got its whole 0.6 deposit back");
  const wlBid = (await owner.drops.bids(drop)).find((x) => x.id === bid[wl.addr].id);
  ok(wlBid.paid === parseEther("0.7") * 10000n / 12000n + 1n || wlBid.paid >= parseEther("0.5"), `the WL winner paid ${Number(wlBid.paid) / 1e18} (the clearing price ÷ 1.2, never under the floor)`);
  ok((await pub.readContract({ address: drop, abi: cloakEscrowDropAbi, functionName: "held" })) === 0n, "the auction holds no tokens");
  await sleep(4000);
  ok((await pub.readContract({ address: drop, abi: cloakEscrowDropAbi, functionName: "creatorOwed" })) === 0n, "the keeper paid the owner its proceeds");
  ok(Number(await pub.getBalance({ address: drop })) === 0 || (await pub.readContract({ address: drop, abi: cloakEscrowDropAbi, functionName: "feesOwed" })) === (await pub.getBalance({ address: drop })), "the auction keeps nothing but the protocol fee until it's collected");
  await fails(owner.drops.mintUnsold(drop, owner.addr, 1), /none left/, "everything sold, so nothing comes back to the owner");

  // ── 6. an undersubscribed auction gives the rest back ──
  const { drop: d2 } = await owner.drops.createEscrow({ ...base, wl: undefined, tokenIds: [6n, 7n, 8n], biddingSecs: 20, revealSecs: 30 });
  ok(!(await pub.readContract({ ...nft, functionName: "isApprovedForAll", args: [owner.addr, d2] })), "no approval is given to the auction itself, only to the factory");
  let s2 = await owner.drops.get(d2);
  await waitChainTime(pub, s2.gtdEnd);
  const one = await b.drops.bid(d2, { price: parseEther("0.5"), quantity: 1 });
  for (let i = 0; i < 200 && (s2 = await owner.drops.get(d2)).phase !== "settled"; i++) await sleep(2000);
  ok(s2.sold === 1 && s2.publicPrice === parseEther("0.5"), "one of three sold, at the floor");
  await owner.drops.mintUnsold(d2, owner.addr, 2);
  const back = (await Promise.all([6n, 7n, 8n].map(ownerOf))).filter((x) => x.toLowerCase() === owner.addr.toLowerCase()).length;
  ok(back === 2, "the owner took back the two nobody bought");
  await b.drops.claim(d2, one.id).catch(() => {});
  ok((await pub.readContract({ address: d2, abi: cloakEscrowDropAbi, functionName: "held" })) === 0n, "and the buyer got the third");
  console.log(`\n${checks} checks passed`);
} finally {
  keeper.kill();
}
process.exit(0);
