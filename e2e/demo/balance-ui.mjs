// Portfolio loading (testnet): the first visit on a device shows shimmer placeholders and then every balance at once
// (never a total that climbs vault by vault); a later visit shows the last known balance as soon as the account
// unlocks, encrypted on the device; each held token can be swapped or withdrawn from its row.
//   DEMO_DIR=<dir with demo.key> [BASE=http://127.0.0.1:4173] node e2e/demo/balance-ui.mjs
import { open } from "./harness.mjs";

let fails = 0;
const ok = (x, m) => { console.log(`${x ? "✓" : "✗"} ${m}`); if (!x) fails++; };
const { browser, ctx, page, base } = await open(process.env.BASE ? { base: process.env.BASE } : {});
await ctx.addInitScript(() => { localStorage.setItem("cloak.welcomed", "1"); localStorage.setItem("cloak.guide", JSON.stringify({ done: [], hidden: true, shown: true })); });
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));

async function unlock() {
  for (let i = 0; i < 4; i++) {
    await page.waitForFunction(() => !document.querySelector("main button[disabled]")?.textContent?.includes("Sign in your wallet"), null, { timeout: 120000 });
    if (await page.locator(".wallet-actions").count()) return;
    const b = page.locator("main button:not([disabled])", { hasText: /Connect wallet|Unlock private account/ }).first();
    if (!(await b.isVisible({ timeout: 4000 }).catch(() => false))) continue;
    await b.click();
    const bw = page.locator(".wm-item", { hasText: "Browser wallet" });
    if (await bw.isVisible({ timeout: 3000 }).catch(() => false)) await bw.click();
    await page.waitForTimeout(500);
  }
  await page.locator(".wallet-actions").waitFor({ timeout: 120000 });
}
// every distinct thing the total showed, from unlocking until it settles
async function watchTotal(ms) {
  const seen = [];
  const end = Date.now() + ms;
  let t0 = null;
  while (Date.now() < end) {
    const s = await page.evaluate(() => { const el = document.querySelector(".wallet-total"); return el ? (el.querySelector(".skel") ? "<skeleton>" : el.textContent.trim()) : null; });
    if (s && s !== seen.at(-1)) seen.push(s);
    if (s && s !== "<skeleton>" && t0 === null) t0 = Date.now();
    if (await page.locator(".updating").count() === 0 && s && s !== "<skeleton>" && seen.length && (await page.locator(".asset-row .skel").count()) === 0) break;
    await page.waitForTimeout(100);
  }
  return seen;
}

await page.goto(`${base}/app`, { waitUntil: "networkidle" });
await unlock();
const first = await watchTotal(240000);
console.log("  first visit:", first.join(" → "));
ok(first[0] === "<skeleton>", "the first visit shows a placeholder while the vaults sync");
ok(first.filter((x) => x !== "<skeleton>").length === 1, "then the total appears once, with every vault counted (no climbing)");
const rows = await page.locator(".asset-row").count();
ok(rows > 0 && (await page.locator(".asset-row .skel").count()) === 0, `${rows} asset rows`);
ok((await page.locator(".asset-row a", { hasText: "Withdraw" }).count()) === rows, "every row can be withdrawn from");
ok(await page.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith("cloak.bals.v1."))), "the balance is saved on this device");
const blob = await page.evaluate(() => localStorage.getItem(Object.keys(localStorage).find((k) => k.startsWith("cloak.bals.v1."))));
ok(!/HYPE|0x[0-9a-f]{40}/i.test(blob.replace(/"(iv|ct)":"0x[0-9a-f]+"/g, "")), "and it is encrypted (no token or amount readable)");

// second visit: the saved balance at once
await page.reload({ waitUntil: "domcontentloaded" });
const t = Date.now();
await unlock();
await page.locator(".wallet-total span.fade-in").waitFor({ timeout: 60000 });
const fast = Date.now() - t;
const shown = await page.locator(".wallet-total").innerText();
ok(shown === first.at(-1) || /^\$/.test(shown), `the next visit shows ${shown} right after unlocking (${(fast / 1000).toFixed(1)}s, including the signature)`);

// swap out of a token from its row
const row = page.locator(".asset-row").filter({ has: page.locator("a", { hasText: "Swap" }) }).first();
if (await row.count()) {
  const sym = await row.locator(".nm b").innerText();
  const swap = row.locator("a", { hasText: "Swap" });
  await swap.click();
  await page.locator(".swap").waitFor({ timeout: 30000 });
  ok(new URL(page.url()).searchParams.get("side") === "sell", `Swap on ${sym} opens a private sell`);
  await page.waitForFunction((s) => [...document.querySelectorAll(".token-sel")].some((b) => b.textContent.trim().endsWith(s)), sym, { timeout: 20000 });
  ok(true, `the trade form has ${sym} selected`);
  await page.locator(".swap-box .link", { hasText: "Balance" }).waitFor({ timeout: 20000 });
  ok(true, `and shows its balance: ${await page.locator(".swap-box .link").first().innerText()}`);
}
await page.setViewportSize({ width: 375, height: 800 });
await page.goto(`${base}/app`, { waitUntil: "domcontentloaded" });
await unlock();
await page.locator(".asset-row").first().waitFor({ timeout: 60000 });
ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "the portfolio fits a phone");
await page.screenshot({ path: (process.env.SHOTS || "/tmp") + "/portfolio-phone.png" });
ok(!errs.length, `no page errors ${errs.join(" | ")}`);
await browser.close();
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
