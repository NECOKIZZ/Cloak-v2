// Trying to break sealed drops and WL spot sales on a local chain with the REAL drand beacon and the real keeper:
//   1. the keeper is DOWN when bidding closes: a bidder opens the bids from the SDK and the drop settles early,
//      without waiting out the reveal window
//   2. the keeper runs behind a flaky RPC (a quarter of requests dropped, the rest delayed up to 0.8s) and still
//      opens, settles, numbers 30 bids' ties and delivers
//   3. junk: a garbage ciphertext and a bid sealed for other numbers are skipped and cost their 25%, a bid under the
//      floor is refused, a WL wallet may still bid publicly, nobody can claim twice
//   4. a spot sale whose keeper delivers before winners name wallets: naming still works, and the list is exact
//   anvil --balance 1000000 --block-time 1 & ; node e2e/drops-break.mjs
import { spawn } from "node:child_process";
import http from "node:http";
import { generatePrivateKey } from "viem/accounts";
import { keccak256, toHex } from "viem";
import { anvilLocal, cloakDropAbi, cloakDropFactoryAbi, cloakSpotBookAbi, commitmentOf, CloakDrops, CloakSpots, sealBid } from "@cloakely/sdk";
import { bytecode } from "@cloakely/sdk/bytecode";
import { clients, deployFactory, parseEther, sleep, waitChainTime, waitDrand } from "./lib.mjs";

const RPC = "http://127.0.0.1:8545";
const chain = anvilLocal;
const PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const KEEPER_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const root = new URL("..", import.meta.url).pathname;
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
    return ok(re.test(e.message), `${m} (${(e.shortMessage || e.message).split("\n")[0].slice(0, 80)})`);
  }
  ok(false, m);
};
const d = clients(chain, RPC, PK);
const send = async (p) => {
  const r = await d.publicClient.waitForTransactionReceipt({ hash: await p });
  if (r.status !== "success") throw new Error(`reverted ${r.transactionHash}`);
  return r;
};
const rpcCall = (method, params) => fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json());

// a flaky RPC for the keeper: drops a quarter of requests, delays the rest
let dropped = 0;
const proxy = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    if (Math.random() < 0.25) {
      dropped++;
      return req.socket.destroy();
    }
    await sleep(Math.random() * 800);
    try {
      const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body });
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(await r.text());
    } catch {
      req.socket.destroy();
    }
  });
});
await new Promise((r) => proxy.listen(8546, r));

const f = await deployFactory(d.publicClient, d.walletClient, { rules: { withdrawFeeBps: 25, launchFeeBps: 200 } });
const DF = (await send(d.walletClient.deployContract({ abi: cloakDropFactoryAbi, bytecode: bytecode.CloakDropFactory, args: [f.config, "https://cloak.boblabs.tech/api/nft/"] }))).contractAddress;
const BOOK = (await send(d.walletClient.deployContract({ abi: cloakSpotBookAbi, bytecode: bytecode.CloakSpotBook, args: [DF] }))).contractAddress;
const wallet = async (hype = "20") => {
  const c = clients(chain, RPC, generatePrivateKey());
  await send(d.walletClient.sendTransaction({ to: c.account.address, value: parseEther(hype) }));
  const drops = new CloakDrops(c.publicClient, c.walletClient, DF);
  return { c, addr: c.account.address, drops, spots: new CloakSpots(drops, BOOK) };
};
const creator = new CloakDrops(d.publicClient, d.walletClient, DF);
let keeper = null;
const startKeeper = (rpc) =>
  (keeper = spawn(process.execPath, [`${root}services/keeper/index.mjs`], {
    env: { ...process.env, RPC_URL: rpc, KEEPER_PK, FACTORY: f.factory, DROP_FACTORY: DF, CLAIM_DELAY: "15", POLL_MS: "1000", PORT: "3996", HYPE_PRICE_URL: "http://127.0.0.1:9/", HYPE_USD: "25" },
    stdio: ["ignore", process.env.KEEPER_LOG ? "inherit" : "ignore", "inherit"],
  }));
const until = async (f, secs, m) => {
  for (let i = 0; i < secs; i++) {
    if (await f().catch(() => false)) return true;
    await sleep(1000);
  }
  ok(false, m);
};

try {
  // ── 1. keeper down: a bidder opens the bids, the drop settles early ──
  console.log("1 · the keeper is down");
  const ws = [];
  for (let i = 0; i < 3; i++) ws.push(await wallet());
  const { drop: d1 } = await creator.create({ name: "No Keeper", symbol: "NK", baseURI: "", supply: 2, floor: parseEther("0.5"), tickSize: parseEther("0.1"), numTicks: 10, biddingSecs: 20, revealSecs: 1800 });
  let s = await creator.get(d1);
  ok(s.revealEnd - s.commitEnd >= 1800, "the reveal window is long (30 minutes) by default for safety");
  await waitChainTime(d.publicClient, s.gtdEnd);
  const b1 = [];
  for (const [i, w] of ws.entries()) b1.push(await w.drops.bid(d1, { price: parseEther(["0.7", "0.6", "0.5"][i]), quantity: 1 }));
  await waitDrand(s.tlockRound);
  await waitChainTime(d.publicClient, s.commitEnd);
  ok((await creator.get(d1)).phase === "reveal", "bidding closed, nobody has opened the bids");
  await ws[2].drops.revealAll(d1); // a bidder does the keeper's job
  s = await creator.get(d1);
  ok(s.reveals === 3 && s.phase === "settle", "a bidder opened every bid itself, and the drop is ready to settle at once");
  await ws[2].drops.settle(d1);
  s = await creator.get(d1);
  const t = Number((await d.publicClient.getBlock()).timestamp);
  ok(s.phase === "settled" && t < s.revealEnd - 1000, `settled ${s.revealEnd - t}s before the reveal window would have ended`);
  ok(s.sold === 2 && s.publicPrice === parseEther("0.6"), "2 sold at 0.6");
  await fails(ws[0].drops.revealAll(d1).then(async () => (await creator.get(d1)).reveals === 3 || Promise.reject(new Error("changed"))).then(() => Promise.reject(new Error("noop ok"))), /noop ok/, "opening again after settling changes nothing");
  await ws[2].drops.claim(d1, b1[2].id);
  ok((await ws[2].drops.bids(d1, ws[2].addr))[0].claimed, "the losing bidder took its refund itself, without waiting for the keeper");
  await fails(ws[2].drops.claim(d1, b1[2].id), /claimed/, "nobody can claim twice");

  // ── 2 + 3. the keeper on a flaky RPC, with junk and 30 bids ──
  console.log("2 · the keeper behind a flaky RPC, junk bids, 30 bids with ties");
  startKeeper("http://127.0.0.1:8546");
  const wlW = await wallet();
  const { drop: d2 } = await creator.create({ name: "Flaky", symbol: "FLK", baseURI: "", supply: 10, floor: parseEther("0.5"), tickSize: parseEther("0.1"), numTicks: 10, maxPerBid: 2, wl: { list: [wlW.addr], boostBps: 2000 }, biddingSecs: 75, revealSecs: 600 });
  s = await creator.get(d2);
  await waitChainTime(d.publicClient, s.gtdEnd);
  const bidders = [];
  for (let i = 0; i < 30; i++) bidders.push(await wallet("3"));
  const placed = [];
  // 30 honest bids at the floor (they tie), in parallel batches
  for (let i = 0; i < 30; i += 10) placed.push(...(await Promise.all(bidders.slice(i, i + 10).map((w, k) => w.drops.bid(d2, { price: parseEther("0.5"), quantity: 1 + ((i + k) % 2) })))));
  await wlW.drops.bid(d2, { price: parseEther("0.5"), quantity: 1 }); // a WL wallet bidding publicly, no boost
  ok(true, "31 sealed bids in (30 at the floor, one WL wallet bidding without its boost)");
  // junk: garbage ciphertext, and a valid ciphertext of other numbers than the commitment
  const junk = await wallet();
  const garbageTx = await junk.c.walletClient.writeContract({ address: d2, abi: cloakDropAbi, functionName: "commit", args: [keccak256(toHex("x")), "0xdeadbeef", false, []], value: parseEther("0.5") });
  await send(Promise.resolve(garbageTx));
  const liar = await wallet();
  const salt = keccak256(toHex("liar"));
  const commitment = commitmentOf(d2, liar.addr, 5, 1n, salt);
  const sealedOther = await sealBid({ auction: d2, bidder: liar.addr, tick: 0, quantity: 1n, salt }, s.tlockRound); // seals different numbers
  await send(liar.c.walletClient.writeContract({ address: d2, abi: cloakDropAbi, functionName: "commit", args: [commitment, sealedOther, false, []], value: parseEther("1") }));
  ok(true, "plus a garbage ciphertext and a bid whose ciphertext doesn't match its commitment");
  await fails(junk.c.walletClient.writeContract({ address: d2, abi: cloakDropAbi, functionName: "commit", args: [keccak256(toHex("y")), "0x", false, []], value: parseEther("0.1") }), /deposit/, "a bid under the floor is refused (no cheap spam)");

  console.log("    · waiting for the drand round and the keeper (through the flaky RPC)…");
  await waitDrand(s.tlockRound);
  await until(async () => (await creator.get(d2)).phase === "settled", 900, "the keeper never settled through the flaky RPC");
  s = await creator.get(d2);
  ok(s.reveals === 31 && s.bids === 33, "the keeper opened all 31 honest bids and skipped the 2 junk ones");
  ok(s.sold === 10 && s.tieSupply === 10 && s.tieDemand === 46, "10 sold to 46 tied NFTs asked for: the tie draw decided it");
  const all = await creator.bids(d2);
  ok(all.reduce((a, b) => a + b.nfts, 0) === 10, "exactly the supply was allocated across 30 tied bids");
  const junkBids = all.filter((b) => !b.revealed);
  ok(junkBids.length === 2 && junkBids.every((b) => b.refund * 4n === b.deposit * 3n), "both junk bids lost 25% and get 75% back");
  ok(all.find((b) => b.bidder.toLowerCase() === wlW.addr.toLowerCase())?.wl === false, "the WL wallet's public bid ranked as public");
  await until(async () => (await creator.bids(d2)).every((b) => b.claimed), 600, "the keeper never delivered through the flaky RPC");
  ok(true, `the keeper delivered all 33 bids despite ${dropped} dropped RPC requests`);
  const supply = await d.publicClient.readContract({ address: d2, abi: cloakDropAbi, functionName: "totalSupply" });
  ok(supply === 10n, "10 NFTs minted, never more");
  const bal = await d.publicClient.getBalance({ address: d2 });
  const owed = (await d.publicClient.readContract({ address: d2, abi: cloakDropAbi, functionName: "creatorOwed" })) + (await d.publicClient.readContract({ address: d2, abi: cloakDropAbi, functionName: "feesOwed" }));
  ok(bal === owed, "after delivery the drop holds exactly what it still owes (proceeds and fee)");

  // ── 4. spot sale: the keeper delivers first, winners name wallets after ──
  console.log("3 · a spot sale where the keeper delivers before anyone names a wallet");
  const sp = new CloakSpots(creator, BOOK);
  const sw = [await wallet(), await wallet(), await wallet()];
  const { drop: d3 } = await sp.create({ name: "Late WL", symbol: "LWL", supply: 2, floor: parseEther("0.5"), tickSize: parseEther("0.1"), numTicks: 10, biddingSecs: 20, revealSecs: 600, partner: "Late Partner", walletDays: 1 });
  s = await creator.get(d3);
  await waitChainTime(d.publicClient, s.gtdEnd);
  const sb = [];
  for (const [i, w] of sw.entries()) sb.push(await w.drops.bid(d3, { price: parseEther(["0.9", "0.8", "0.5"][i]), quantity: 1 }));
  await waitDrand(s.tlockRound);
  await until(async () => (await creator.bids(d3)).every((b) => b.claimed), 300, "the keeper never delivered the spot sale");
  ok(true, "the keeper settled early and delivered receipts and refunds");
  await sw[0].spots.setWallets(d3, sb[0].id, [sw[2].addr]); // naming the loser's wallet is allowed: it's the winner's choice
  await sw[1].spots.setWallets(d3, sb[1].id, [sw[1].addr]); // or its own bidding wallet
  await fails(sw[2].spots.setWallets(d3, sb[2].id, [sw[0].addr]), /won no spots/, "the loser still can't take a spot");
  await fails(sw[0].spots.setWallets(d3, sb[0].id, [sw[1].addr]), /already has a spot/, "a winner can't take a wallet another winner named");
  await fails(sw[0].spots.setWallets(d3, sb[0].id, ["0x" + "0".repeat(40)]), /zero wallet|isn't a wallet/, "the zero address can't be whitelisted");
  const list = (await sp.winners(d3)).flatMap((w) => w.wallets);
  ok(list.length === 2, "the whitelist has exactly the 2 spots");
} finally {
  keeper?.kill();
  proxy.close();
}
console.log(`\n${checks} checks passed`);
process.exit(0);
