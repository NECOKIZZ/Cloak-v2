// Live: bid on a drop through the site with the demo wallet (on the WL), then check the result once the keeper settles.
//   DEPLOYER_PK=0x… DEMO_DIR=<dir with demo.key> node e2e/demo/drop-ui.mjs   (testnet only)
import { open, demoAddress } from "./harness.mjs";
import { CloakDrops, deploymentFor, elysiumTestnet } from "@cloakely/sdk";
import { clients, parseEther, sleep } from "../lib.mjs";
const dep = deploymentFor(elysiumTestnet.id);
const d = clients(elysiumTestnet, elysiumTestnet.rpcUrls.default.http[0], process.env.DEPLOYER_PK);
const c = new CloakDrops(d.publicClient, d.walletClient, dep.dropFactory, dep.dropFactoryBlock);
const { drop } = await c.create({ name: "Site Test Owls", symbol: "OWL", baseURI: "", supply: 3, floor: parseEther("0.001"), tickSize: parseEther("0.0005"), numTicks: 20, wl: { list: [demoAddress], boostBps: 2000 }, biddingSecs: 240, revealSecs: 120, description: "Bid through the site, sealed. Testnet only." });
console.log("drop", drop);
const { browser, ctx, page, base } = await open();
await ctx.addInitScript(() => { localStorage.setItem("cloak.welcomed", "1"); localStorage.setItem("cloak.guide", JSON.stringify({ done: [], hidden: true, shown: true })); });
let fails = 0; const ok = (x, m) => { console.log(`${x ? "✓" : "✗"} ${m}`); if (!x) fails++; };
page.on("pageerror", (e) => console.log("pageerror", e.message));
await page.goto(`${base}/app/drop/${drop}`, { waitUntil: "networkidle" });
for (let i = 0; i < 60 && !(await page.locator("text=Place a sealed bid").isVisible().catch(() => false)); i++) { await sleep(3000); await page.reload({ waitUntil: "networkidle" }); }
ok(await page.locator("text=WL bid boost").isVisible(), "the WL boost is shown publicly: " + (await page.locator(".drop-stats").innerText()).replace(/\s+/g, " "));
await page.locator("main button.btn-ink.btn-lg").first().click(); // connect
const bw = page.locator(".wm-item", { hasText: "Browser wallet" }); if (await bw.isVisible({ timeout: 8000 }).catch(() => false)) await bw.click();
await page.waitForFunction(() => /Seal a bid/.test(document.querySelector("main button.btn-ink.btn-lg")?.textContent ?? ""), null, { timeout: 120000 });
ok(await page.locator("text=Ranks as (WL").waitFor({ timeout: 30000 }).then(() => true, () => false), "the bid form knows this wallet is WL and shows the boosted rank");
await page.locator("main input.mono").first().fill("0.002");
await page.locator("main button.btn-ink.btn-lg").first().dblclick();
await page.locator(".drop-bids").waitFor({ timeout: 180000 });
const row = await page.locator(".drop-bids").innerText();
ok(/sealed/.test(row) && /WL/.test(row), "my bid shows as sealed, tagged WL: " + row.replace(/\s+/g, " "));
ok((await c.bids(drop)).length === 1, "a double-click placed one bid");
await page.setViewportSize({ width: 375, height: 800 });
await page.screenshot({ path: process.env.SHOT || "/tmp/drop-mobile.png", fullPage: true });
ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "the drop page fits a phone");
console.log("waiting for the hosted keeper to settle…");
for (let i = 0; i < 200; i++) { if ((await c.get(drop)).phase === "settled") break; await sleep(5000); }
await page.setViewportSize({ width: 1440, height: 900 });
await page.reload({ waitUntil: "networkidle" }); await sleep(4000);
const res = await page.locator("main").innerText();
ok(/Results/.test(res) && /won 1/.test(res), "after settling the page shows the result and my win: " + (res.match(/won[^\n]*/)?.[0] ?? ""));
ok(/WL winners paid\s*0\.001/.test(res.replace(/\n/g, " ")), "WL paid the floor (0.002 ranks as 0.0024, the only bid, so it clears at the floor)");
await browser.close();
console.log(fails ? `${fails} FAILED` : "all passed", `${base}/app/drop/${drop}`);
process.exit(0);
