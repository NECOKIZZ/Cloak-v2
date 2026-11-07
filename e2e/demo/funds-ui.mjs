// Proof of funds in the app (testnet): the demo account proves "at least 0.05 HYPE" for a label, the link opens on
// the public /proof page in a fresh browser and verifies, and a link with a changed amount doesn't.
//   DEMO_DIR=<dir with demo.key> [BASE=http://localhost:4173] node e2e/demo/funds-ui.mjs
import { open } from "./harness.mjs";
let fails = 0;
const ok = (x, m) => { console.log(`${x ? "✓" : "✗"} ${m}`); if (!x) fails++; };
const { browser, ctx, page, base } = await open(process.env.BASE ? { base: process.env.BASE } : {});
await ctx.addInitScript(() => { localStorage.setItem("cloak.welcomed", "1"); localStorage.setItem("cloak.guide", JSON.stringify({ done: [], hidden: true, shown: true })); });
const errs = []; page.on("pageerror", (e) => errs.push(e.message));
await page.goto(`${base}/app`, { waitUntil: "domcontentloaded" });
for (let i = 0; i < 5 && !(await page.locator(".wallet-actions").count()); i++) {
  const b = page.locator("main button:not([disabled])", { hasText: /Connect wallet|Unlock private account/ }).first();
  if (await b.isVisible({ timeout: 4000 }).catch(() => false)) { await b.click(); const bw = page.locator(".wm-item", { hasText: "Browser wallet" }); if (await bw.isVisible({ timeout: 3000 }).catch(() => false)) await bw.click(); }
  await page.waitForTimeout(1500);
}
await page.locator(".wallet-actions a", { hasText: "Prove funds" }).click();
await page.locator("input[placeholder='100']").waitFor();
await page.waitForFunction(() => document.querySelector("select option"), null, { timeout: 120000 });
await page.locator("input[placeholder='100']").fill("0.05");
await page.locator("input[placeholder='OTC desk, Nov 7']").fill("Test desk");
const t = Date.now();
await page.locator("button", { hasText: "Create the proof" }).click();
await page.locator("text=Proof ready").waitFor({ timeout: 240000 });
ok(true, `proof made in the browser in ${((Date.now() - t) / 1000).toFixed(1)}s (circuit download included)`);
const link = await page.locator("a", { hasText: "Open it like they will" }).getAttribute("href");
ok(/\/proof#/.test(link), `a shareable link (${link.length} characters)`);
const fresh = await browser.newContext(); const v = await fresh.newPage();
await v.goto(link, { waitUntil: "domcontentloaded" });
await v.locator(".pill", { hasText: /Verified|Not valid/ }).waitFor({ timeout: 120000 });
ok(await v.locator(".pill", { hasText: "Verified" }).count() === 1, `a stranger's browser verifies it: ${(await v.locator(".card").innerText()).split("\n").slice(0, 3).join(" · ")}`);
// tamper: change the amount in the link
const body = JSON.parse(Buffer.from(link.split("#")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
body.threshold = (BigInt(body.threshold) * 10n).toString();
const bad = link.split("#")[0] + "#" + Buffer.from(JSON.stringify(body)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
await v.goto("about:blank"); await v.goto(bad, { waitUntil: "domcontentloaded" });
await v.locator(".pill", { hasText: /Verified|Not valid/ }).waitFor({ timeout: 120000 });
ok(await v.locator(".pill", { hasText: "Not valid" }).count() === 1, "a link with a bigger amount is shown as not valid");
await v.setViewportSize({ width: 375, height: 800 });
ok(await v.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "the proof page fits a phone");
ok(!errs.length, `no page errors ${errs.join(" | ")}`);
await browser.close();
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
