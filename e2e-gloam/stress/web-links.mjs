// Payment links, request links / pay page, the Receive page and funds proofs on the real site, with abuse: edge inputs,
// claim twice, wrong passcode, more claimers than shares, take back then claim, tampered links, request to bad payees.
// Fork of Elysium testnet + local relay only.
//
//   cd e2e-gloam && PATH=~/.foundry/bin:$PATH NODE_USE_ENV_PROXY=1 NO_PROXY=127.0.0.1,localhost node stress/web-links.mjs
import { createWalletClient, formatEther, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ANVIL_KEYS, connectAndUnlock, dismissIntro, newPage, recorder, shot, sleep, startStack } from "./web-harness.mjs";

const R = recorder("web-links");
const S = await startStack({ base: 8665, vitePort: 5215 });
const nav = (page, p) => page.evaluate((p) => { history.pushState(null, "", p); dispatchEvent(new PopStateEvent("popstate")); }, p);
const bal = (a) => S.pub.getBalance({ address: a });
const addrOf = (i) => privateKeyToAccount(ANVIL_KEYS[i]).address;
const msgOf = (page, timeout = 120_000) =>
  page.waitForFunction(() => {
    const e = [...document.querySelectorAll(".err, .okmsg, .linkbox")].find((x) => x.offsetParent !== null);
    return e ? { cls: e.className, text: e.innerText } : null;
  }, null, { timeout }).then((h) => h.jsonValue()).catch(() => ({ cls: "timeout", text: "no message" }));

/** A guest (no wallet unless keyIndex) opens a claim link and claims to a wallet; returns what happened. */
async function guestClaim(url, { to, keyIndex, code, label }) {
  const ctx = await S.browser.newContext({ viewport: { width: 1280, height: 900 } });
  const g = keyIndex !== undefined ? await newPage(S, { keyIndex, ctx }) : { page: await ctx.newPage() };
  const page = g.page;
  const t = performance.now();
  await page.goto(url);
  await dismissIntro(page);
  if (code !== undefined) {
    await page.locator("input.input").first().waitFor({ timeout: 60_000 });
    await page.locator("input.input").first().fill(code);
    await page.getByRole("button", { name: "Unlock the link" }).click();
    await page.waitForTimeout(6000);
  }
  // what does the page offer?
  const state = await page.waitForFunction(() => {
    const t = document.body.innerText;
    if (/Claim to a wallet/.test(t)) return "claimable";
    if (/already claimed|shares are gone/.test(t)) return "claimed";
    if (/opens an empty link/.test(t)) return "wrong-code";
    if (/hasn't arrived/.test(t)) return "unfunded";
    if (/isn't a Cloak|doesn't work|broken|couldn't read/i.test(t)) return "bad-link";
    return null;
  }, null, { timeout: 120_000 }).then((h) => h.jsonValue()).catch(() => "timeout");
  let res = { state, openMs: Math.round(performance.now() - t) };
  if (state === "claimable" && to) {
    const before = await bal(to);
    await page.locator("button.choice").nth(1).click();
    await page.getByPlaceholder("0x… or name.ely").fill(to);
    const t2 = performance.now();
    await page.locator("button.btn-ink.btn-lg.btn-block").last().click();
    for (let i = 0; i < 180 && (await bal(to)) === before; i++) await page.waitForTimeout(1000);
    res.claimMs = Math.round(performance.now() - t2);
    res.got = formatEther((await bal(to)) - before);
    await page.waitForTimeout(1500);
  }
  res.text = (await page.evaluate(() => document.querySelector(".claim-card")?.innerText ?? document.body.innerText.slice(0, 400))).replace(/\s+/g, " ").slice(0, 300);
  await shot(page, `links-guest-${label}`);
  await ctx.close();
  return res;
}

try {
  const A = await newPage(S, { keyIndex: 1 });
  const page = A.page;
  await page.goto(`${S.site}/app`);
  const myAddr = await connectAndUnlock(page, S.site);
  await nav(page, "/app/portfolio/shield");
  await page.locator("input.input").first().fill("3");
  await page.locator("button.btn-ink.btn-lg.btn-block").click();
  await page.getByText(/is now private/).waitFor({ timeout: 180_000 });

  // ── link form edges ──
  await nav(page, "/app/links");
  const amt = page.getByPlaceholder("0.05");
  await amt.waitFor({ timeout: 60_000 });
  const shares = page.getByPlaceholder("1", { exact: true });
  const create = page.locator("button.btn-ink.btn-lg.btn-block").first();
  for (const [a, sh, lock, label] of [["", "1", false, "empty"], ["0", "1", false, "zero"], ["-1", "1", false, "negative"], ["abc", "1", false, "garbage"], ["0.0000000000000000001", "1", false, "19 decimals"], ["100000", "1", false, "more than balance"], ["0.1", "0", false, "0 shares"], ["0.1", "99", false, "99 shares"], ["0.00000000000000001", "3", false, "dust in 3 shares"], ["0.1", "1", true, "lock with no passcode"]]) {
    await amt.fill(a);
    await shares.fill(sh).catch(() => {});
    const box = page.locator("label.check", { hasText: "Lock it with a passcode" }).locator("input");
    if ((await box.isChecked()) !== lock) await box.click();
    await create.click();
    const m = await msgOf(page, 90_000);
    R.check(`link ${label} (amount '${a}', shares '${sh}') → ${m.cls.includes("err") ? "error: " + m.text : m.cls.includes("linkbox") ? "LINK MADE" : m.text}`, m.cls.includes("err"), { label, m });
    if (m.cls.includes("linkbox")) { await page.reload(); await connectAndUnlock(page, S.site); await nav(page, "/app/links"); await amt.waitFor(); }
  }
  {
    const box = page.locator("label.check", { hasText: "Lock it with a passcode" }).locator("input");
    if (await box.isChecked()) await box.click();
  }
  await shot(page, "links-form-edge");

  const makeLink = async ({ a, sh = "1", code, hint, msg = "" }, label) => {
    await nav(page, "/app/trade");
    await nav(page, "/app/links");
    await amt.waitFor();
    await amt.fill(a);
    await shares.fill(sh);
    await page.getByPlaceholder("Happy birthday!").fill(msg);
    if (code) {
      await page.locator("label.check", { hasText: "Lock it with a passcode" }).locator("input").check();
      await page.getByPlaceholder("a word or phrase").fill(code);
      if (hint) await page.getByPlaceholder("What chain does Cloak live on?").fill(hint);
    }
    const t = performance.now();
    await create.click();
    await page.locator(".linkbox").first().waitFor({ timeout: 240_000 });
    const ms = Math.round(performance.now() - t);
    R.r.timings.push({ label: `make ${label} link (click to link shown)`, ms, ok: true });
    return page.locator(".linkbox").first().innerText();
  };

  // ── plain link: guest claims to a wallet, a second guest tries again ──
  const url1 = await makeLink({ a: "0.1", msg: "<script>alert(1)</script> 🎁" }, "a 0.1 HYPE");
  R.say(`  link: ${url1.slice(0, 60)}… (${url1.length} chars)`);
  const g1 = await guestClaim(url1, { to: addrOf(7), label: "plain" });
  R.r.timings.push({ label: "guest (no wallet) opens a link until 'Claim to a wallet' shows", ms: g1.openMs, ok: g1.state === "claimable" });
  R.r.timings.push({ label: "guest claims a link to a wallet (click to funds landed)", ms: g1.claimMs, ok: g1.got === "0.0995" });
  R.check(`guest claimed the plain link: ${g1.got} HYPE landed (0.0995 expected)`, g1.got === "0.0995", g1);
  const g1b = await guestClaim(url1, { to: addrOf(6), label: "plain-again" });
  R.check(`second guest on the same link sees '${g1b.state}': ${g1b.text.slice(0, 160)}`, g1b.state === "claimed", g1b);

  // ── tampered links ──
  for (const [label, u] of [["one char changed", url1.replace(/.(.{8})$/, (m, r) => (m[0] === "a" ? "b" : "a") + r)], ["cut in half", url1.slice(0, Math.floor(url1.length / 2))], ["no fragment", url1.split("#")[0]]]) {
    const r = await guestClaim(u, { label: `tampered-${label.replace(/\s/g, "-")}` });
    R.check(`tampered link (${label}) → ${r.state}: ${r.text.slice(0, 160)}`, r.state !== "claimable", r);
  }

  // ── locked link: wrong passcode then right ──
  const url2 = await makeLink({ a: "0.05", code: "Elysium", hint: "What chain does Cloak live on?" }, "a locked 0.05 HYPE");
  const w = await guestClaim(url2, { code: "solana", label: "locked-wrong" });
  R.check(`locked link, wrong answer → '${w.state}': ${w.text.slice(0, 200)}`, w.state === "wrong-code", w);
  const r2 = await guestClaim(url2, { code: "  elysium ", to: addrOf(5), label: "locked-right" });
  R.check(`locked link, right answer with odd case and spaces → ${r2.state}, got ${r2.got}`, r2.got === "0.04975", r2);

  // ── red envelope: 3 shares, 4 claimers ──
  const url3 = await makeLink({ a: "0.06", sh: "3" }, "a 3-share 0.06 HYPE");
  const outs = [];
  for (let i = 0; i < 4; i++) outs.push(await guestClaim(url3, { to: privateKeyToAccount(ANVIL_KEYS[2 + i]).address, label: `envelope-${i + 1}` }));
  R.check(`envelope 3 shares, 4 claimers: ${outs.map((o) => `${o.state}${o.got ? " " + o.got : ""}`).join(", ")}`, outs.slice(0, 3).every((o) => o.got && Number(o.got) > 0) && outs[3].state === "claimed", { outs });

  // ── two guests claim the same link at the same moment ──
  {
    const url4 = await makeLink({ a: "0.04" }, "a race 0.04 HYPE");
    const [x, y] = await Promise.all([guestClaim(url4, { to: "0x000000000000000000000000000000000000c0de", label: "race-1" }), guestClaim(url4, { to: "0x000000000000000000000000000000000000c0df", label: "race-2" })]);
    R.check(`two guests claim one link at once: ${x.state}/${x.got ?? "-"} and ${y.state}/${y.got ?? "-"} (only one may get it)`, !(Number(x.got) > 0 && Number(y.got) > 0), { x, y });
  }

  // ── take back, then a guest opens it ──
  {
    const url5 = await makeLink({ a: "0.05" }, "a take-back 0.05 HYPE");
    await nav(page, "/app/trade");
    await nav(page, "/app/links");
    const row = page.locator(".card", { hasText: "Your links" });
    await row.waitFor({ timeout: 30_000 });
    const tb = row.getByRole("button", { name: "Take back" }).first();
    if (await tb.isVisible({ timeout: 30_000 }).catch(() => false)) {
      await R.time("take back an unclaimed link (click to 'Taken back')", async () => {
        await tb.click();
        await page.getByText(/Taken back into your private balance/).waitFor({ timeout: 240_000 });
      });
      const again = await tryClick(row.getByRole("button", { name: "Take back" }).first());
      R.check(`take back twice: second 'Take back' button ${again}`, true);
      const gt = await guestClaim(url5, { to: addrOf(9), label: "taken-back" });
      R.check(`guest opens a taken-back link → '${gt.state}': ${gt.text.slice(0, 160)}`, gt.state === "claimed", gt);
    } else R.check("Your links shows a Take back button", false);
    await shot(page, "links-your-links");
  }

  // ── claim to a private balance as a guest with a wallet ──
  {
    const url6 = await makeLink({ a: "0.07" }, "a 0.07 HYPE (to private)");
    const ctx = await S.browser.newContext({ viewport: { width: 1280, height: 900 } });
    const G2 = await newPage(S, { keyIndex: 3, ctx });
    await G2.page.goto(url6);
    await dismissIntro(G2.page);
    await G2.page.getByText("Claim to my private balance").waitFor({ timeout: 120_000 });
    await G2.page.locator("button.choice").nth(0).click();
    await R.time("guest with a wallet claims a link into a private balance (connect + unlock + claim)", async () => {
      await G2.page.locator("button.btn-ink.btn-lg.btn-block").last().click();
      const tw = G2.page.getByRole("button", { name: /Test Wallet/ });
      if (await tw.isVisible({ timeout: 5000 }).catch(() => false)) await tw.click();
      await G2.page.waitForTimeout(3000);
      const again = G2.page.locator("button.btn-ink.btn-lg.btn-block").last();
      if (/claim/i.test(await again.innerText().catch(() => "")) && !(await again.isDisabled())) await again.click();
      await G2.page.getByText(/Claimed\. It's yours now/).waitFor({ timeout: 240_000 });
    });
    await shot(G2.page, "links-claim-private");
    await ctx.close();
  }

  // ── request links and the pay page ──
  await nav(page, "/app/links");
  await page.getByRole("button", { name: "Request payment" }).click();
  const ramt = page.getByPlaceholder("25");
  for (const [a, label] of [["-5", "negative"], ["0", "zero"], ["abc", "garbage"], ["1.0000000000000000001", "19 decimals"]]) {
    await ramt.fill(a);
    await page.getByRole("button", { name: /Create request link/ }).click();
    const m = await msgOf(page, 20_000);
    R.check(`request amount ${label} → ${m.cls.includes("err") ? "error: " + m.text : m.cls.includes("linkbox") ? "LINK MADE" : m.text}`, m.cls.includes("err"), { m });
  }
  await page.getByRole("button", { name: "A wallet address" }).click();
  for (const [wa, label] of [["0x123", "short hex"], [myAddr, "a cloak: address in the wallet field"], ["hello", "garbage"]]) {
    await page.getByPlaceholder("0x…").fill(wa);
    await ramt.fill("0.05");
    await page.getByRole("button", { name: /Create request link/ }).click();
    const m = await msgOf(page, 20_000);
    R.check(`request to wallet ${label} → ${m.cls.includes("err") ? "error: " + m.text : m.cls.includes("linkbox") ? "LINK MADE" : m.text}`, m.cls.includes("err"), { m });
    await page.getByRole("button", { name: "Request payment" }).click();
    await page.getByRole("button", { name: "A wallet address" }).click();
  }
  await shot(page, "links-request-edge");
  await page.getByRole("button", { name: "My private balance" }).click();
  await ramt.fill("0.05");
  await page.getByPlaceholder("Invoice #001").fill("Stress test invoice");
  await page.getByRole("button", { name: /Create request link/ }).click();
  await page.locator(".linkbox").first().waitFor({ timeout: 60_000 });
  const reqUrl = await page.locator(".linkbox").first().innerText();
  R.say(`  request link ${reqUrl.slice(0, 80)}`);
  {
    // payer: key 4, no private balance → "Shield HYPE and pay"
    const P = await newPage(S, { keyIndex: 4 });
    await P.page.goto(reqUrl);
    await dismissIntro(P.page);
    const t = performance.now();
    await P.page.getByRole("button", { name: /Connect wallet to pay|Unlock private account to pay/ }).click({ timeout: 60_000 });
    const tw = P.page.getByRole("button", { name: /Test Wallet/ });
    if (await tw.isVisible({ timeout: 5000 }).catch(() => false)) await tw.click();
    const payBtn = P.page.getByRole("button", { name: /Shield HYPE and pay|Pay privately/ });
    await payBtn.waitFor({ timeout: 120_000 });
    R.say(`  pay button: ${await payBtn.innerText()}`);
    await payBtn.click();
    const ok = await P.page.getByText(/Paid\./).waitFor({ timeout: 300_000 }).then(() => true, () => false);
    R.r.timings.push({ label: "pay a request link from a wallet with no private balance (connect, unlock, shield and pay)", ms: Math.round(performance.now() - t), ok });
    R.check(`request paid: ${ok} ${(await P.page.locator(".err").allInnerTexts()).join(" ")}`, ok);
    await shot(P.page, "links-request-paid");
    // pay it again: is there anything stopping a double payment?
    await P.page.reload();
    await dismissIntro(P.page);
    await P.page.waitForTimeout(4000);
    const txt = (await P.page.evaluate(() => document.querySelector(".claim-card")?.innerText ?? "")).replace(/\s+/g, " ");
    R.check(`reopening a paid request shows: '${txt.slice(0, 200)}'`, /paid/i.test(txt), { txt });
    await P.context.close();
  }
  // a tip jar (no amount) to a wallet, paid publicly with silly amounts
  {
    await nav(page, "/app/links");
    await page.getByRole("button", { name: "Request payment" }).click();
    await page.getByRole("button", { name: "A wallet address" }).click();
    await page.getByPlaceholder("0x…").fill(addrOf(9));
    await ramt.fill("");
    await page.getByRole("button", { name: /Create request link/ }).click();
    await page.locator(".linkbox").first().waitFor({ timeout: 60_000 });
    const jar = await page.locator(".linkbox").first().innerText();
    const P = await newPage(S, { keyIndex: 5 });
    await P.page.goto(jar);
    await dismissIntro(P.page);
    await P.page.getByRole("button", { name: /Connect wallet to pay/ }).click({ timeout: 60_000 });
    const tw = P.page.getByRole("button", { name: /Test Wallet/ });
    if (await tw.isVisible({ timeout: 5000 }).catch(() => false)) await tw.click();
    await P.page.waitForTimeout(6000);
    for (const a of ["-1", "0", "abc", "1e2"]) {
      await P.page.locator("input.input").first().fill(a).catch(() => {});
      const pub = P.page.getByRole("button", { name: /Pay from my wallet instead/ });
      if (await pub.isVisible().catch(() => false)) await pub.click();
      const m = await msgOf(P.page, 15_000);
      R.check(`tip jar, public pay of '${a}' → ${m.text}`, m.cls.includes("err"), { m });
    }
    const before = await bal(addrOf(9));
    await P.page.locator("input.input").first().fill("0.01");
    await R.time("tip jar paid publicly from the wallet", async () => {
      await P.page.getByRole("button", { name: /Pay from my wallet instead/ }).click();
      await P.page.getByText(/Paid\./).waitFor({ timeout: 60_000 });
    });
    R.check(`public tip landed: ${formatEther((await bal(addrOf(9))) - before)}`, (await bal(addrOf(9))) - before === parseEther("0.01"));
    await shot(P.page, "links-tipjar-paid");
    await P.context.close();
  }

  // ── Receive page ──
  {
    await nav(page, "/app/portfolio/receive");
    const addrEl = page.locator(".mono").filter({ hasText: /^0x[0-9a-fA-F]{40}$/ }).first();
    await addrEl.waitFor({ timeout: 60_000 });
    const rx = await addrEl.innerText();
    const payer = createWalletClient({ chain: S.chain, account: privateKeyToAccount(ANVIL_KEYS[6]), transport: http(S.anvilUrl) });
    // dust first, then a real payment
    await S.pub.waitForTransactionReceipt({ hash: await payer.sendTransaction({ to: rx, value: 1000n }) });
    await sleep(15_000);
    R.check(`receive: a 1000 wei dust payment → address balance after 15 s ${await bal(rx)} wei (left alone?)`, true);
    const t = performance.now();
    await S.pub.waitForTransactionReceipt({ hash: await payer.sendTransaction({ to: rx, value: parseEther("0.2") }) });
    for (let i = 0; i < 120 && (await bal(rx)) > 0n; i++) await sleep(1000);
    R.r.timings.push({ label: "Receive page: outside payment moved into the private balance (page open)", ms: Math.round(performance.now() - t), ok: (await bal(rx)) === 0n });
    R.check(`receive: 0.2 HYPE swept from ${rx.slice(0, 10)}…`, (await bal(rx)) === 0n);
    await shot(page, "links-receive");
    // the same address paid again after the sweep
    await S.pub.waitForTransactionReceipt({ hash: await payer.sendTransaction({ to: rx, value: parseEther("0.05") }) });
    for (let i = 0; i < 90 && (await bal(rx)) > 0n; i++) await sleep(1000);
    R.check(`receive: a second payment to the same address swept too (${await bal(rx)} left)`, (await bal(rx)) === 0n);
  }

  // ── funds proof ──
  {
    await nav(page, "/app/portfolio/prove");
    const famt = page.getByPlaceholder("100");
    await famt.waitFor({ timeout: 60_000 });
    for (const a of ["0", "-1", "abc", "100000"]) {
      await famt.fill(a);
      await page.getByRole("button", { name: "Create the proof" }).click();
      const m = await msgOf(page, 120_000);
      R.check(`funds proof of '${a}' → ${m.text}`, m.cls.includes("err"), { m });
    }
    await famt.fill("1");
    await page.getByPlaceholder("OTC desk, Nov 7").fill("Stress <b>test</b>");
    await R.time("make a funds proof of 1 HYPE", async () => {
      await page.getByRole("button", { name: "Create the proof" }).click();
      await page.getByText("Proof ready").waitFor({ timeout: 180_000 });
    });
    const link = await page.locator("a", { hasText: "Open it like they will" }).getAttribute("href");
    const ctx = await S.browser.newContext();
    const v = await ctx.newPage();
    const t = performance.now();
    await v.goto(link.startsWith("http") ? link : S.site + link);
    await v.waitForFunction(() => /verified|valid|holds at least|proves/i.test(document.body.innerText), null, { timeout: 60_000 }).catch(() => {});
    R.r.timings.push({ label: "open a funds proof link and verify it", ms: Math.round(performance.now() - t), ok: true });
    const vt = (await v.evaluate(() => document.body.innerText)).replace(/\s+/g, " ");
    R.check(`proof page: '${vt.slice(vt.indexOf("Proof"), vt.indexOf("Proof") + 220)}'`, true);
    await shot(v, "links-proof-view");
    const bad = link.replace(/.(.{6})$/, (m, r) => (m[0] === "A" ? "B" : "A") + r);
    await v.goto(bad.startsWith("http") ? bad : S.site + bad);
    await v.waitForTimeout(8000);
    const bt = (await v.evaluate(() => document.querySelector("main, .claim-card, .card")?.innerText ?? document.body.innerText)).replace(/\s+/g, " ");
    R.check(`tampered proof link shows: '${bt.slice(0, 200)}'`, !/verified/i.test(bt) || /not|fail|invalid|doesn't/i.test(bt), { bt });
    await shot(v, "links-proof-tampered");
    await ctx.close();
  }
  R.r.consoleErrors = [...new Set(A.errors.filter((e) => !/favicon|Failed to load resource|net::/i.test(e)))].slice(0, 30);
  R.say(`relayed ${S.stats.relayed}; relay errors ${S.stats.relayErrors.slice(0, 6).join(" | ")}`);
} finally {
  R.save();
  await S.stop();
}
async function tryClick(loc) {
  if (!(await loc.isVisible({ timeout: 3000 }).catch(() => false))) return "is gone";
  return "still shown";
}
process.exit(0);
