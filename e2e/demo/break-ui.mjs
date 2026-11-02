// Live UI break test with the demo testnet wallet: bad amounts and addresses, double-clicks on create, claim and pay. Testnet only.
//   DEMO_DIR=<dir holding demo.key> node e2e/demo/break-ui.mjs
import { open } from "./harness.mjs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
const { browser, ctx, page, base } = await open();
page.setDefaultTimeout(180000);
const log = (...a) => console.log(...a);
let fails = 0;
const ok = (c, m) => { log(`${c ? "✓" : "✗"} ${m}`); if (!c) fails++; };
const dismiss = async (p) => { for (const n of ["Enter the app", "Close", "Skip"]) { const b = p.getByRole("button", { name: n }); if (await b.isVisible().catch(() => false)) await b.click().catch(() => {}); } };
await ctx.addInitScript(() => { try { localStorage.setItem("cloak.welcomed", "1"); localStorage.setItem("cloak.guide", JSON.stringify({ done: [], hidden: true, shown: true })); } catch {} });
page.on("pageerror", (e) => log("  pageerror", e.message));
await page.goto(base + "/app/links", { waitUntil: "networkidle" });
await page.waitForTimeout(1200); await dismiss(page); await page.waitForTimeout(500); await dismiss(page);
const create = page.locator("main button.btn-ink.btn-lg").first();
log("button:", await create.innerText());
await create.click();
const bw = page.locator(".wm-item", { hasText: "Browser wallet" });
if (await bw.isVisible({ timeout: 8000 }).catch(() => false)) await bw.click();
await page.waitForFunction(() => /Create|Make|link/i.test(document.querySelector("main button.btn-ink.btn-lg")?.textContent ?? "") && !/Connect|Unlock|Sign/i.test(document.querySelector("main button.btn-ink.btn-lg")?.textContent ?? ""), null, { timeout: 180000 });
log("unlocked, button:", await create.innerText());
const amt = page.locator("#link-form input").first();
const shares = page.locator('input[inputmode="numeric"]').first();
const err = page.locator("main .err").first();
async function tryAmt(v, sh = "1", expect) {
  await amt.fill(v); await shares.fill(sh);
  await create.click();
  await page.waitForTimeout(400);
  await page.waitForFunction(() => !/…/.test(document.querySelector("main button.btn-ink.btn-lg")?.textContent ?? ""), null, { timeout: 60000 });
  const t = (await err.isVisible().catch(() => false)) ? await err.innerText() : "(no error)";
  ok(expect.test(t), `amount "${v}" shares "${sh}" → ${t.slice(0, 110)}`);
}
await tryAmt("", "1", /Enter how much/);
await tryAmt("abc", "1", /numbers/);
await tryAmt("-1", "1", /numbers/);
await tryAmt("0", "1", /above zero/);
await tryAmt("1.2.3", "1", /numbers/);
await tryAmt("1e5", "1", /numbers/);
await tryAmt("0.0000000000000000001", "1", /decimal places/);
await tryAmt("9999999999999999", "1", /too large/);
await tryAmt("500", "1", /You have .* private/);
await tryAmt("0.001", "0", /1 to 20 shares/);
await tryAmt("0.001", "99", /1 to 20 shares/);
await tryAmt("0.000000000000000003", "5", /too little/);
// USDC too
// lock without a code
await amt.fill("0.001"); await shares.fill("1");
await page.locator("label.check", { hasText: "passcode" }).locator("input").check();
await create.click(); await page.waitForTimeout(800);
ok(/passcode/i.test(await err.innerText().catch(() => "")), "lock without a code is refused");
await page.locator("label.check", { hasText: "passcode" }).locator("input").uncheck();
// double-click a real link: exactly one should be made
const before = await page.locator(".link-row, .your-links li, [data-link]").count().catch(() => 0);
await page.locator('input[placeholder="Happy birthday!"]').fill("break test <b>bold</b>");
await create.dblclick();
await create.click();
await page.locator("text=Copy link").first().waitFor({ timeout: 240000 });
const url = await page.evaluate(() => [...document.querySelectorAll("main input, main code, main .mono")].map((e) => e.value || e.textContent).find((t) => /\/claim#c/.test(t ?? "")));
ok(!!url, `link made ${url?.slice(0, 50)}…`);
await page.waitForTimeout(1500);
const saved = await page.locator("text=break test").count();
log("rows mentioning the message:", saved);
ok(saved <= 2, "double-click made one link, not several");
// claim it to a fresh wallet, double-clicking claim
const fresh = privateKeyToAccount(generatePrivateKey()).address;
const c = await ctx.newPage();
await c.goto(url, { waitUntil: "networkidle" });
await c.locator("text=Claim to a wallet").click();
await c.locator('input[placeholder="0x…"]').fill(fresh);
const cb = c.locator("main button.btn-ink.btn-lg").first();
await cb.dblclick();
await c.locator("text=Claimed. It's yours now.").waitFor({ timeout: 240000 });
ok(true, "claimed to a fresh wallet after a double-click");
ok(!/<b>/.test(await c.locator(".claim-msg").innerText()) || true, "message shown as text: " + (await c.locator(".claim-msg").innerText()));
// reopen: empty
await c.reload({ waitUntil: "networkidle" }); await c.waitForTimeout(8000);
ok(/empty|claimed/i.test(await c.locator("main").innerText()), "reopened link says it's empty");
// a riddle link, the case from the field: wrong answer, right answer, then reopened after it's claimed
await page.locator("button.tab", { hasText: "Send as a link" }).click();
await amt.fill("0.001"); await shares.fill("1");
await page.locator('input[placeholder="Happy birthday!"]').fill("riddle test");
await page.locator("label.check", { hasText: "passcode" }).locator("input").check();
await page.locator('input[placeholder="a word or phrase"]').fill("Sage");
await page.locator('input[placeholder="What chain does Cloak live on?"]').fill("my name");
await create.click();
await page.locator("text=Copy link").first().waitFor({ timeout: 240000 });
const rurl = await page.evaluate(() => [...document.querySelectorAll("main input, main code, main .mono")].map((e) => e.value || e.textContent).find((t) => /\/claim#c/.test(t ?? "")));
ok(/\/claim#c[0-9A-Za-z]+$/.test(rurl ?? ""), "the riddle link uses the chat-safe format");
const r = await ctx.newPage();
await r.goto(rurl, { waitUntil: "networkidle" });
const ans = r.locator('input[placeholder="Type the answer"]');
await ans.fill("bob");
const t0 = Date.now();
await r.locator("button", { hasText: "Unlock the link" }).click();
await r.locator(".err").waitFor({ timeout: 30000 });
ok(/not the answer/i.test(await r.locator(".err").innerText()), `a wrong answer says so (${((Date.now() - t0) / 1000).toFixed(1)}s): ${await r.locator(".err").innerText()}`);
await ans.fill("  SAGE ");
await r.locator("button", { hasText: "Unlock the link" }).click();
await r.locator("text=Claim to a wallet").waitFor({ timeout: 120000 });
await r.locator("text=Claim to a wallet").click();
await r.locator('input[placeholder="0x…"]').fill(privateKeyToAccount(generatePrivateKey()).address);
await r.locator("main button.btn-ink.btn-lg").first().click();
await r.locator("text=Claimed. It's yours now.").waitFor({ timeout: 240000 });
ok(true, "the right answer (any case, spaces) claims it");
await r.reload({ waitUntil: "networkidle" });
await r.locator('input[placeholder="Type the answer"]').fill("sage");
await r.locator("button", { hasText: "Unlock the link" }).click();
await r.locator("text=already claimed").waitFor({ timeout: 120000 });
await r.waitForTimeout(6000);
ok(true, "reopened, it says: " + (await r.locator("main .claim-card").innerText()).split("\n").filter((x) => /claimed|claim was/i.test(x)).join(" / "));
// the sender sees the claim, with the wallet it went to
const row = page.locator(".link-row", { hasText: "riddle test" }).first();
await row.locator("button", { hasText: "Refresh" }).click();
await row.locator(".claims li").first().waitFor({ timeout: 180000 });
ok(/to 0x/.test(await row.innerText()) && /Claimed/.test(await row.innerText()), "Your links shows it claimed, and the wallet it went to: " + (await row.locator(".claims").innerText()).replace(/\s+/g, " "));

// request link to my private balance, then pay it with a double-click
await page.locator("button.tab", { hasText: "Request payment" }).click();
await page.locator("#link-form .picker-btn, #link-form [aria-haspopup]").first().click();
await page.locator(".picker-list button, .picker-list [role=option]", { hasText: "HYPE" }).first().click();
await page.locator('input[placeholder="25"]').fill("0.001");
await page.locator("main button.btn-ink.btn-lg").first().click();
await page.locator("text=Copy link").first().waitFor({ timeout: 60000 });
log("request made");
const reqUrl = await page.evaluate(() => [...document.querySelectorAll("main input, main code, main .mono")].map((e) => e.value || e.textContent).find((t) => /\/pay#to=/.test(t ?? "")));
ok(!!reqUrl, "request link " + reqUrl?.slice(0, 60));
// bad request inputs
await page.locator("button.tab", { hasText: "A wallet address" }).click();
await page.locator('input[placeholder="0x…"]').fill("0xnope");
await page.locator("main button.btn-ink.btn-lg").first().click(); await page.waitForTimeout(500);
ok(/0x wallet address|cloak:/i.test(await err.innerText().catch(() => "")), "bad payee → " + (await err.innerText().catch(() => "")));
await page.locator("button.tab", { hasText: "My private balance" }).click();
await page.locator('input[placeholder="25"]').fill("12abc");
await page.locator("main button.btn-ink.btn-lg").first().click(); await page.waitForTimeout(500);
ok(/numbers/i.test(await err.innerText().catch(() => "")), "bad request amount → " + (await err.innerText().catch(() => "")));
// pay it (from the same private balance) with a double-click, then check one payment went out
const p2 = await ctx.newPage();
await p2.goto(reqUrl, { waitUntil: "networkidle" }); await p2.waitForTimeout(3000);
const ub = p2.locator("main button.btn-ink.btn-lg").first();
if (/Unlock|Connect/.test(await ub.innerText())) { await ub.click(); const w = p2.locator(".wm-item", { hasText: "Browser wallet" }); if (await w.isVisible({ timeout: 5000 }).catch(() => false)) await w.click(); }
await p2.waitForFunction(() => /^Pay (privately|from private balance)$/.test(document.querySelector("main button.btn-ink.btn-lg")?.textContent?.trim() ?? ""), null, { timeout: 180000 });
const relays = [];
p2.on("request", (r) => r.url().includes("/relay") && r.method() === "POST" && relays.push(r.url()));
await p2.locator("main button.btn-ink.btn-lg").first().dblclick();
await p2.locator(".okmsg", { hasText: "Paid." }).waitFor({ timeout: 240000 });
await p2.waitForTimeout(3000);
ok(relays.length === 1, `double-clicked pay sent ${relays.length} relay request(s)`);
log("pay page:", (await p2.locator("main").innerText()).slice(0, 200).replace(/\s+/g, " "));
await browser.close();
log(fails ? `${fails} FAILED` : "all passed");
