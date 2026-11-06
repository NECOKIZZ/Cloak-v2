// .ely names on the withdraw form (testnet): the demo wallet unlocks its private account, types a .ely name and sees
// where it points, a name that isn't registered is refused before anything is sent, and (with WITHDRAW=1) a small
// withdrawal to a fresh 0x address still works.
//   DEMO_DIR=<dir with demo.key> [BASE=http://127.0.0.1:4173] node e2e/demo/ely-ui.mjs
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { open } from "./harness.mjs";

let fails = 0;
const ok = (x, m) => { console.log(`${x ? "✓" : "✗"} ${m}`); if (!x) fails++; };
const { browser, ctx, page, base } = await open(process.env.BASE ? { base: process.env.BASE } : {});
await ctx.addInitScript(() => { localStorage.setItem("cloak.welcomed", "1"); localStorage.setItem("cloak.guide", JSON.stringify({ done: [], hidden: true, shown: true })); });
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
await page.goto(`${base}/app/portfolio/withdraw`, { waitUntil: "networkidle" });
// connect and unlock the private account if the page asks
for (let i = 0; i < 3; i++) {
  const b = page.locator("main button", { hasText: /Connect|Unlock|Sign/ }).first();
  if (!(await b.isVisible({ timeout: 4000 }).catch(() => false))) break;
  await b.click();
  const bw = page.locator(".wm-item", { hasText: "Browser wallet" });
  if (await bw.isVisible({ timeout: 5000 }).catch(() => false)) await bw.click();
  await page.waitForTimeout(3000);
}
const to = page.locator('input[placeholder="0x… or name.ely"]');
await to.waitFor({ timeout: 120000 });
ok(true, "the withdraw form takes a 0x address or a .ely name");
await to.fill("bona.ely");
await page.locator(".rcpt", { hasText: "bona.ely →" }).waitFor({ timeout: 20000 });
ok(/0xe49D…175e/i.test(await page.locator(".rcpt").innerText()), `bona.ely resolves on chain: ${await page.locator(".rcpt").innerText()}`);
ok(/public and tied to this name/.test(await page.locator(".rcpt").innerText()), "it warns that a named wallet links the withdrawal to the name");
await to.fill("zzzz-not-a-name-123.ely");
await page.locator(".rcpt-bad", { hasText: "isn't registered" }).waitFor({ timeout: 20000 });
ok(true, "a name that isn't registered is flagged as you type");
await page.locator("main input[inputmode=decimal]").fill("0.001");
await page.locator("button", { hasText: /Withdraw privately/ }).click();
await page.locator(".err").waitFor({ timeout: 30000 });
ok(/isn't registered/.test(await page.locator(".err").innerText()), "and sending to it is refused before anything is sent");
await to.fill("bona");
ok(/0x address or a \.ely name/.test(await page.locator(".rcpt-bad").innerText()), "a bare word without .ely is caught");
if (process.env.WITHDRAW) {
  const fresh = privateKeyToAccount(generatePrivateKey()).address;
  await to.fill(fresh);
  await page.locator("button", { hasText: /Withdraw privately/ }).click();
  const done = page.locator(".okmsg", { hasText: "withdrawn to" }).or(page.locator("main .err"));
  await done.first().waitFor({ timeout: 300000 });
  const msg = await done.first().innerText();
  ok(/withdrawn to/.test(msg), `a withdrawal to a fresh 0x address still works: ${msg}`);
}
await page.setViewportSize({ width: 375, height: 800 });
ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "the page fits a phone");
ok(!errs.length, `no page errors ${errs.join(" | ")}`);
await browser.close();
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
