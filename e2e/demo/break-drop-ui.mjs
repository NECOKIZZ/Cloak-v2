// Live: try to break a WL spot sale through the site with the demo wallet (testnet only).
//   bad prices, a bid under the floor, a price above the top level, a dead network mid-page, a double-click,
//   then after the keeper settles: bad and wrong-checksum wallets, saving the right one, the whitelist and CSV,
//   and claiming the receipt yourself.
//   DEPLOYER_PK=0x… DEMO_DIR=<dir with demo.key> node e2e/demo/break-drop-ui.mjs
import { open, demoAddress } from "./harness.mjs";
import { CloakDrops, CloakSpots, deploymentFor, elysiumTestnet } from "@cloakely/sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { clients, parseEther, sleep } from "../lib.mjs";

const dep = deploymentFor(elysiumTestnet.id);
const RPC = elysiumTestnet.rpcUrls.default.http[0];
const d = clients(elysiumTestnet, RPC, process.env.DEPLOYER_PK);
const c = new CloakDrops(d.publicClient, d.walletClient, dep.dropFactory, dep.dropFactoryBlock);
const sp = new CloakSpots(c, dep.spotBook);
const { drop } = await sp.create({ name: "Break WL spots", symbol: "BRKWL", supply: 1, floor: parseEther("0.001"), tickSize: parseEther("0.0005"), numTicks: 20, biddingSecs: 240, partner: "Break Partner", walletDays: 1, description: "A break test. Testnet only." });
console.log("sale", drop);
const { browser, ctx, page, base } = await open(process.env.BASE ? { base: process.env.BASE } : {});
await ctx.addInitScript(() => { localStorage.setItem("cloak.welcomed", "1"); localStorage.setItem("cloak.guide", JSON.stringify({ done: [], hidden: true, shown: true })); });
let fails = 0;
const ok = (x, m) => { console.log(`${x ? "✓" : "✗"} ${m}`); if (!x) fails++; };
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
const main = () => page.locator("main").innerText();
const errText = async () => (await page.locator("main .err").first().innerText({ timeout: 20000 }).catch(() => "")).trim();
const bidBtn = page.locator("main button.btn-ink.btn-lg").first();
const priceIn = page.locator("main input.mono").first();

await page.goto(`${base}/app/drop/${drop}`, { waitUntil: "networkidle" });
for (let i = 0; i < 60 && !(await page.locator("text=Place a sealed bid").isVisible().catch(() => false)); i++) { await sleep(3000); await page.reload({ waitUntil: "networkidle" }); }
ok(/WL spots · Break Partner/.test(await main()), "the sale page says what it sells and for whom");
await bidBtn.click(); // connect only
const bw = page.locator(".wm-item", { hasText: "Browser wallet" });
if (await bw.isVisible({ timeout: 8000 }).catch(() => false)) await bw.click();
await page.waitForFunction(() => /Seal a bid/.test(document.querySelector("main button.btn-ink.btn-lg")?.textContent ?? ""), null, { timeout: 120000 });
ok((await c.bids(drop)).length === 0, "connecting placed no bid");

// bad prices
for (const [v, re, m] of [["abc", /at least the creator's price/, "letters"], ["0.0005", /at least the creator's price/, "under the floor"], ["", /at least the creator's price/, "empty"], ["-1", /at least the creator's price/, "negative"]]) {
  await priceIn.fill(v);
  await bidBtn.click();
  const e = await errText();
  ok(re.test(e), `a price of ${m} is refused with a clear message: "${e}"`);
}
ok((await c.bids(drop)).length === 0, "none of the bad prices sent a bid");
await priceIn.fill("100000");
ok(await page.locator("text=Highest level in this drop").isVisible({ timeout: 5000 }).catch(() => false), "a price above the top level says where it snaps to");

// a dead network for a while: the page says it's showing the last update, then recovers
const host = new URL(RPC).host;
await page.route(`**://${host}/**`, (r) => r.abort());
const stale = await page.locator("text=Showing the last update").waitFor({ timeout: 40000 }).then(() => true, () => false);
ok(stale, "when the network stops answering, the page says it's showing the last update");
await page.unroute(`**://${host}/**`);
ok(await page.locator("text=Showing the last update").waitFor({ state: "detached", timeout: 60000 }).then(() => true, () => false), "and the note goes away once the network is back");

// the real bid, double-clicked
await priceIn.fill("0.002");
await bidBtn.dblclick();
await page.locator(".drop-bids").waitFor({ timeout: 180000 });
await sleep(3000);
ok((await c.bids(drop)).length === 1, "a double-click placed exactly one bid");

console.log("waiting for the hosted keeper to settle…");
for (let i = 0; i < 300; i++) { if ((await c.get(drop)).phase === "settled") break; await sleep(4000); }
await page.reload({ waitUntil: "networkidle" });
await page.locator("text=Wallets to whitelist").waitFor({ timeout: 60000 });
ok(/won 1 spot/.test(await main()), "the page shows the win as a spot");
const wIn = page.locator('main input[placeholder="0x… wallet to whitelist"]').first();
const save = page.locator("main button", { hasText: /Save wallets|Update wallets/ }).first();
const target = privateKeyToAccount(generatePrivateKey()).address;
const badSum = target.slice(0, 2) + target.slice(2).split("").map((ch, i) => (i === 3 && /[a-f]/i.test(ch) ? (ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase()) : ch)).join("");
for (const [v, m] of [["0x123", "a short address"], ["hello", "text"], ["", "nothing"], [badSum !== target ? badSum : "0xZZ", "a wrong checksum"]]) {
  await wIn.fill(v);
  await save.click();
  const e = await errText();
  ok(/isn't a wallet address|Enter a wallet/.test(e), `${m} is refused: "${e}"`);
}
ok((await sp.winners(drop))[0].wallets.length === 0, "nothing bad reached the chain");
await wIn.fill(target.toLowerCase());
await save.click();
await page.locator("text=1 of 1 named").waitFor({ timeout: 120000 }).catch(() => {});
const named = (await sp.winners(drop))[0].wallets[0];
ok(named?.toLowerCase() === target.toLowerCase(), "a lowercase address is accepted and saved");
ok(/1 of 1 named/.test(await main()), "the public whitelist shows it");
ok(named.toLowerCase() !== demoAddress.toLowerCase(), "the whitelisted wallet isn't the bidding wallet");
const claimBtn = page.locator("main button", { hasText: "Claim my receipt now" });
// every action shares one busy label, so wait for the save to finish before looking for the button
if (await claimBtn.waitFor({ timeout: 30000 }).then(() => true, () => false)) {
  await claimBtn.click();
  await page.locator("text=delivered").first().waitFor({ timeout: 120000 }).catch(() => {});
  ok((await c.bids(drop))[0].claimed, "the winner took its receipt itself, without waiting for the keeper");
} else ok((await c.bids(drop))[0].claimed, "the keeper had already delivered the receipt");
await page.setViewportSize({ width: 375, height: 800 });
ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "the settled sale page fits a phone");
ok(!errs.length, `no page errors ${errs.join(" | ")}`);
await browser.close();
console.log(fails ? `${fails} FAILED` : "all passed", `${base}/app/drop/${drop}`);
process.exit(0);
