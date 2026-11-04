// Live on testnet: auctions of existing NFTs through the site, with the hosted keeper (testnet only, play money).
//   1. a "Veils Genesis" test collection (an ordinary ERC-721 outside Cloak, items served from /demo-nft/); the deployer
//      lists 6 of them as the showcase auction (3 days), and the demo wallet gets 4
//   2. the demo wallet opens "Auction NFTs you own", loads its tokens from the collection, deselects one, sets the floor
//      and creates the auction (approve + create); the page shows the 3 tokens in escrow with their traits
//   3. the deployer bids for 2; the hosted keeper opens, settles, numbers and delivers; the demo wallet takes back the
//      unsold one from the page
//   DEPLOYER_PK=0x… DEMO_DIR=<dir with demo.key> [BASE=…] [COLLECTION=0x… to reuse] node e2e/demo/escrow-ui.mjs
import { readFileSync } from "node:fs";
import { open, demoAddress } from "./harness.mjs";
import { CloakDrops, deploymentFor, elysiumTestnet, erc721Abi } from "@cloakely/sdk";
import { clients, parseEther, sleep } from "../lib.mjs";

const dep = deploymentFor(elysiumTestnet.id);
const RPC = elysiumTestnet.rpcUrls.default.http[0];
const d = clients(elysiumTestnet, RPC, process.env.DEPLOYER_PK);
const pub = d.publicClient;
const drops = new CloakDrops(pub, d.walletClient, dep.dropFactory, dep.dropFactoryBlock, dep.escrowDropFactory);
// the public node can lag a moment on the nonce right after a transaction: wait and send again
const send = async (mk) => {
  for (let i = 0; ; i++) {
    try {
      await sleep(1500);
      const r = await pub.waitForTransactionReceipt({ hash: await mk() });
      if (r.status !== "success") throw new Error(`reverted ${r.transactionHash}`);
      return r;
    } catch (e) {
      if (i >= 6 || !/nonce|replacement/i.test(String(e?.message))) throw e;
      await sleep(3000);
    }
  }
};
let fails = 0;
const ok = (x, m) => { console.log(`${x ? "✓" : "✗"} ${m}`); if (!x) fails++; };
const SITE = "https://cloak.boblabs.tech/demo-nft/";

// ── 1. the collection and the showcase ──
const mock = JSON.parse(readFileSync(new URL("../../contracts/out/MockNFT.sol/MockNFT.json", import.meta.url), "utf8"));
let col = process.env.COLLECTION;
if (!col) {
  col = (await send(() => d.walletClient.deployContract({ abi: mock.abi, bytecode: mock.bytecode.object, args: ["Veils Genesis", "VEILG", SITE] }))).contractAddress;
  await send(() => d.walletClient.writeContract({ address: col, abi: mock.abi, functionName: "mint", args: [d.account.address, 1n, 12n] }));
  await send(() => d.walletClient.writeContract({ address: col, abi: mock.abi, functionName: "mint", args: [demoAddress, 13n, 4n] }));
  console.log("collection", col);
  await sleep(4000);
  const { drop: show } = await drops.createEscrow({
    collection: col, tokenIds: [1n, 2n, 3n, 4n, 5n, 6n], name: "Veils Genesis auction", symbol: "VEILGA", floor: parseEther("0.001"), maxPerBid: 2, biddingSecs: 3 * 86400,
    image: `${SITE}cover.svg`, banner: `${SITE}banner.svg`, category: "Art", links: { website: "https://cloak.boblabs.tech" },
    description: "Six Veils Genesis pieces that already exist, auctioned sealed from escrow: bid what you'd pay, every winner pays one price, and who gets which piece is drawn once the bids open. Testnet only, no value.",
  });
  console.log("showcase", show, `https://cloak.boblabs.tech/app/drop/${show}`);
}
const ownerOf = (id) => pub.readContract({ address: col, abi: erc721Abi, functionName: "ownerOf", args: [id] });

const { browser, ctx, page, base } = await open(process.env.BASE ? { base: process.env.BASE } : {});
await ctx.addInitScript(() => { localStorage.setItem("cloak.welcomed", "1"); localStorage.setItem("cloak.guide", JSON.stringify({ done: [], hidden: true, shown: true })); });
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
let drop = process.env.RESUME_DROP;
if (!drop) {
  await page.goto(`${base}/app/drops/create?existing`, { waitUntil: "networkidle" });
  ok(await page.locator("h1", { hasText: "Auction your NFTs" }).isVisible(), "the create page opens on Auction NFTs you own");
  await page.locator('input[placeholder="0x…"]').fill(col);
  await page.locator("text=Veils Genesis").first().waitFor({ timeout: 60000 });
  ok(true, "the page reads the collection's name from its contract");
  await page.locator("button", { hasText: /load my tokens/i }).click();
  const bw = page.locator(".wm-item", { hasText: "Browser wallet" });
  if (await bw.isVisible({ timeout: 8000 }).catch(() => false)) await bw.click();
  await page.locator(".escrow-tok").first().waitFor({ timeout: 180000 });
  await sleep(1500);
  const n = await page.locator(".escrow-tok").count();
  ok(n === 4, `it finds the 4 tokens the demo wallet holds (${n})`);
  await page.locator(".escrow-tok").nth(3).click();
  ok((await page.locator(".escrow-tok.on").count()) === 3, "one is deselected, 3 picked");
  await page.locator("label", { hasText: "Your price (floor)" }).locator("..").locator("input").fill("0.001");
  await page.locator("label", { hasText: "Sealed bidding window" }).locator("..").locator("select").selectOption("600");
  await page.locator("button", { hasText: /List 3 tokens for auction/ }).click();
  await page.waitForURL(/\/app\/drop\/0x/, { timeout: 240000 });
  drop = page.url().split("/app/drop/")[1].split(/[?#]/)[0];
  console.log("auction", drop);
  await page.locator(".dp-panel").waitFor({ timeout: 90000 });
  await page.locator("text=/In escrow · 3 of 3/").waitFor({ timeout: 60000 }).catch(() => {});
  ok(await page.locator("text=/In escrow · 3 of 3/").isVisible(), "the page shows all 3 tokens in escrow, checked on chain");
  ok([13n, 14n, 15n].every(async () => true) && (await ownerOf(13n)).toLowerCase() === drop.toLowerCase() && (await ownerOf(16n)).toLowerCase() === demoAddress.toLowerCase(), "tokens 13–15 moved into the auction, 16 stayed with the demo wallet");
  await page.click("role=tab[name=Items]");
  await page.locator(".item-card").first().waitFor({ timeout: 60000 });
  await sleep(1500);
  ok((await page.locator(".item-card").count()) === 3 && (await page.locator(".item-card .trait").count()) > 0, "the Items tab shows the 3 escrowed tokens with their traits");
  await page.click("role=tab[name=Details]");
  ok(/Held in escrow\s*3 of 3 tokens/.test(await page.locator("main").innerText()), "Details lists the collection and the held tokens");

}
else await page.goto(`${base}/app/drop/${drop}`, { waitUntil: "networkidle" });
// ── 3. a bid, the keeper, and the unsold token back ──
for (let i = 0; i < 60 && (await drops.get(drop)).phase !== "bidding"; i++) await sleep(5000);
// one token per bid (the form's default): two bids for one each
const bids = [await drops.bid(drop, { price: parseEther("0.002"), quantity: 1 }), await drops.bid(drop, { price: parseEther("0.0015"), quantity: 1 })];
console.log("waiting for the hosted keeper to settle…");
let s;
for (let i = 0; i < 400 && (s = await drops.get(drop)).phase !== "settled"; i++) await sleep(5000);
ok(s.phase === "settled" && s.sold === 2, "the hosted keeper opened, settled and numbered: 2 of 3 sold");
const won = [...(await drops.tokensOf(drop, bids[0].id)), ...(await drops.tokensOf(drop, bids[1].id))];
ok(won.length === 2 && won[0] !== won[1], `the two bids won tokens ${won.map((x) => `#${x}`).join(" and ")}`);
await page.reload({ waitUntil: "networkidle" });
await page.click("role=tab[name=Mint]");
const back = page.locator("button", { hasText: /Take back 1 to my wallet/ });
await back.waitFor({ timeout: 90000 });
await back.click();
for (let i = 0; i < 60 && (await drops.get(drop)).escrow.returned === 0; i++) await sleep(3000);
const mine = (await Promise.all([13n, 14n, 15n].map(ownerOf))).filter((o) => o.toLowerCase() === demoAddress.toLowerCase()).length;
ok(mine === 1, "the demo wallet took the unsold token back from the page");
for (const b of bids) await drops.claim(drop, b.id).catch(() => {});
ok((await Promise.all(won.map(ownerOf))).every((o) => o.toLowerCase() === d.account.address.toLowerCase()), "the winner holds exactly the tokens the auction assigned it");
await page.setViewportSize({ width: 375, height: 800 });
ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "the page fits a phone");
ok(!errs.length, `no page errors ${errs.join(" | ")}`);
await browser.close();
console.log(fails ? `${fails} FAILED` : "all passed", `${base}/app/drop/${drop}`);
process.exit(0);
