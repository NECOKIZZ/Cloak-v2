// The money flows on the real site, with edge inputs and abuse: shield / send / withdraw (incl. in pieces over time),
// trade instant + batch, double clicks, refresh mid-action, two tabs, wallet disconnect, slow RPC, relay down.
// Fork of Elysium testnet + local relay only.
//
//   cd e2e-gloam && PATH=~/.foundry/bin:$PATH NODE_USE_ENV_PROXY=1 NO_PROXY=127.0.0.1,localhost node stress/web-flows.mjs
import { formatEther, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createGloamLoop } from "../../services/keeper/gloamLoop.mjs";
import { ANVIL_KEYS, G, connectAndUnlock, newPage, recorder, setWallet, shot, sleep, startStack } from "./web-harness.mjs";

const R = recorder("web-flows");
const S = await startStack({ base: 8655, vitePort: 5205 });
const nav = (page, p) => page.evaluate((p) => { history.pushState(null, "", p); dispatchEvent(new PopStateEvent("popstate")); }, p);
const bal = (a) => S.pub.getBalance({ address: a });
const fresh = (i) => privateKeyToAccount(ANVIL_KEYS[i]).address;
const SUBMIT = "button.btn-ink.btn-lg.btn-block";

/** Fill the action form and click; return { err, ok, ms } once an .err or .okmsg shows (or timeout). */
async function act(page, { amt, to, click = "click", timeout = 180_000 } = {}) {
  await page.waitForFunction((sel) => { const b = document.querySelector(sel); return b && !b.disabled; }, SUBMIT, { timeout: 240_000 }).catch(() => {});
  if (amt !== undefined) await page.locator("input.input").first().fill(amt);
  if (to !== undefined) await page.locator("input.input").nth(1).fill(to);
  const t = performance.now();
  const btn = page.locator(SUBMIT).first();
  if (click === "dbl") await btn.dblclick();
  else await btn.click();
  const r = await page.waitForFunction(() => {
    const e = [...document.querySelectorAll(".err, .okmsg")].find((x) => x.offsetParent !== null);
    return e ? { cls: e.className, text: e.innerText } : null;
  }, null, { timeout }).then((h) => h.jsonValue()).catch(() => null);
  const ms = Math.round(performance.now() - t);
  return r ? { [r.cls.includes("err") ? "err" : "ok"]: r.text, ms } : { timeout: true, ms };
}
async function privBalance(page) {
  // the private balance number on the Portfolio card
  await nav(page, "/app");
  await page.waitForFunction(() => /HYPE\s+Hyperliquid\s+[\d.,]+\s+HYPE/.test(document.body.innerText), null, { timeout: 60_000 }).catch(() => {});
  const m = (await page.evaluate(() => document.body.innerText)).match(/HYPE\s+Hyperliquid\s+([\d.,]+)\s+HYPE/);
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

try {
  const { page, errors } = await newPage(S, { keyIndex: 1 });
  await page.goto(`${S.site}/app`);
  const addr = await R.time("connect + unlock (desktop, cold fork)", () => connectAndUnlock(page, S.site));
  R.say(`address ${addr}`);

  // ── Shield: edge inputs ──
  await nav(page, "/app/portfolio/shield");
  await page.locator("input.input").first().waitFor();
  for (const amt of ["", "0", "-1", "abc", "1e3", "0x10", "1,5", "0.0000000000000000001", " 0.5 ", "Infinity", "9999999999"]) {
    const r = await act(page, { amt, timeout: amt.trim() === "0.5" ? 180_000 : 20_000 });
    R.check(`shield '${amt}' → ${r.err ? "error: " + r.err : r.ok ? "OK: " + r.ok : "no message in 20s"}`, !!r.err || (amt.trim() === "0.5" && r.ok), { amt, r });
    if (r.ok) break; // " 0.5 " shields 0.5 (trimmed)
  }
  await shot(page, "flows-shield-edge");
  // over the launch vault's per-deposit cap
  {
    const r = await act(page, { amt: "50", timeout: 60_000 });
    R.check(`shield 50 HYPE (over the vault's deposit cap?) → ${r.err ?? r.ok ?? "timeout"}`, true, { r });
    await shot(page, "flows-shield-50");
  }
  // max link
  {
    const max = page.locator(".link", { hasText: /^max / }).first();
    if (await max.isVisible().catch(() => false)) {
      await max.click();
      await page.waitForTimeout(500);
      R.check(`shield 'max' fills ${await page.locator("input.input").first().inputValue()}`, true);
    }
  }
  // a normal shield, timed
  {
    const r = await act(page, { amt: "2" });
    R.r.timings.push({ label: "shield 2 HYPE (click to 'is now private')", ms: r.ms, ok: !!r.ok });
    R.check(`shield 2 HYPE in ${r.ms} ms: ${r.ok ?? r.err}`, !!r.ok);
  }
  // double click
  {
    const before = await bal(fresh(1));
    const r = await act(page, { amt: "0.1", click: "dbl" });
    await sleep(3000);
    const spent = before - (await bal(fresh(1)));
    R.check(`double-click shield 0.1 → wallet paid ${formatEther(spent)} HYPE (one deposit plus gas expected): ${r.ok ?? r.err}`, spent < parseEther("0.15"), { spent: formatEther(spent) });
  }
  const p0 = await privBalance(page);
  R.say(`private balance after shields: ${p0}`);

  // ── a second user to send to ──
  const B = await newPage(S, { keyIndex: 2 });
  await B.page.goto(`${S.site}/app`);
  const addrB = await connectAndUnlock(B.page, S.site);

  // ── Send: edge inputs ──
  await nav(page, "/app/portfolio/send");
  await page.locator("input.input").nth(1).waitFor({ timeout: 60_000 });
  const v1Hex = "cloak:0x" + "ab".repeat(64);
  for (const [amt, to, label] of [
    ["0.1", "", "empty recipient"],
    ["0.1", "0x" + "11".repeat(20), "a 0x address"],
    ["0.1", v1Hex, "a v1 hex cloak: address"],
    ["0.1", "cloak:gloamr1.garbage", "garbage gloamr1"],
    ["0.1", addrB.slice(0, -4), "truncated address"],
    ["0.1", addrB + "x", "address plus one char"],
    ["100000", addrB, "more than the balance"],
    ["0", addrB, "zero"],
  ]) {
    const r = await act(page, { amt, to, timeout: 90_000 });
    R.check(`send ${label} → ${r.err ? "error: " + r.err : r.ok ? "SENT: " + r.ok : "no message"}`, !!r.err, { label, r });
  }
  await shot(page, "flows-send-edge");
  {
    const r = await act(page, { amt: "0.2", to: addrB });
    R.r.timings.push({ label: "send 0.2 HYPE privately (click to 'Sent')", ms: r.ms, ok: !!r.ok });
    R.check(`send 0.2 HYPE to user B in ${r.ms} ms: ${r.ok ?? r.err}`, !!r.ok);
    // to yourself
    const r2 = await act(page, { amt: "0.05", to: addr });
    R.check(`send 0.05 HYPE to your own address → ${r2.ok ?? r2.err}`, true, { r2 });
  }
  {
    const t = performance.now();
    const got = await (async () => {
      await nav(B.page, "/app");
      for (let i = 0; i < 60; i++) {
        const m = (await B.page.evaluate(() => document.body.innerText)).match(/HYPE\s+Hyperliquid\s+([\d.,]+)\s+HYPE/);
        if (m) return Number(m[1]);
        await sleep(2000);
        if (i % 10 === 9) await nav(B.page, "/app/trade").then(() => nav(B.page, "/app"));
      }
      return null;
    })();
    R.r.timings.push({ label: "recipient sees a private send on Portfolio (page already open)", ms: Math.round(performance.now() - t), ok: got !== null });
    R.check(`user B's Portfolio shows ${got} HYPE`, got !== null && got >= 0.2);
    await shot(B.page, "flows-send-recipient");
  }

  // ── Withdraw: edge inputs ──
  await nav(page, "/app/portfolio/withdraw");
  await page.locator("input.input").nth(1).waitFor({ timeout: 60_000 });
  for (const [amt, to, label] of [
    ["0.1", "", "empty address"],
    ["0.1", addr, "a cloak: address"],
    ["0.1", "0x123", "short hex"],
    ["0.1", "0x" + "zz".repeat(20), "non-hex 40 chars"],
    ["0.1", "nobody-here-xyz.ely", "unknown .ely name"],
    ["0.1", "0x0000000000000000000000000000000000000000", "the zero address"],
    ["0.1", G.launchVault, "the launch vault itself"],
    ["0.1", "0xabcdefABCDEF0123456789abcdefABCDEF012345", "bad checksum mixed case"],
    ["100000", fresh(9), "more than the balance"],
  ]) {
    const r = await act(page, { amt, to, timeout: 120_000 });
    R.check(`withdraw ${label} → ${r.err ? "error: " + r.err : r.ok ? "WITHDRAWN: " + r.ok : "no message"}`, !!r.err, { label, r });
  }
  await shot(page, "flows-withdraw-edge");
  {
    const before = await bal(fresh(9));
    const r = await act(page, { amt: "0.3", to: fresh(9) });
    const got = (await bal(fresh(9))) - before;
    R.r.timings.push({ label: "withdraw 0.3 HYPE (click to 'withdrawn', proof + relay)", ms: r.ms, ok: !!r.ok });
    R.check(`withdraw 0.3 → ${formatEther(got)} landed in ${r.ms} ms: ${r.ok ?? r.err}`, got === parseEther("0.2985"));
  }
  // in pieces over time
  {
    const dest = "0x000000000000000000000000000000000000bEEF";
    await page.locator("input.input").first().fill("0.6");
    await page.locator("input.input").nth(1).fill(dest);
    await page.locator(".field.spread input[type=checkbox]").check();
    await page.locator("select[aria-label='Over how long']").selectOption("3600");
    const destBefore = await bal(dest);
    const r = await act(page, {});
    R.r.timings.push({ label: "withdraw 0.6 HYPE in 3 pieces (click to 'goes to … in 3 pieces')", ms: r.ms, ok: !!r.ok });
    R.check(`withdraw in pieces → ${r.ok ?? r.err}`, !!r.ok);
    await shot(page, "flows-withdraw-pieces");
    let got = 0n;
    for (let i = 0; i < 8 && got < parseEther("0.59"); i++) {
      await S.warp(900);
      await S.schedule.tick?.();
      await sleep(4000);
      got = (await bal(dest)) - destBefore;
    }
    R.check(`after warping an hour the keeper's queue paid ${formatEther(got)} HYPE to the destination (0.597 expected)`, got === parseEther("0.597"), { got: formatEther(got), stats: S.stats.scheduled });
    await nav(page, "/app");
    await sleep(3000);
    await shot(page, "flows-withdraw-pieces-portfolio");
  }

  // ── refresh mid-withdraw ──
  {
    await nav(page, "/app/portfolio/withdraw");
    await page.locator("input.input").nth(1).waitFor({ timeout: 60_000 });
    const dest = fresh(5);
    const before = await bal(dest);
    const before0 = await privBalance(page);
    await nav(page, "/app/portfolio/withdraw");
    await page.locator("input.input").nth(1).waitFor({ timeout: 60_000 });
    await page.locator("input.input").first().fill("0.1");
    await page.locator("input.input").nth(1).fill(dest);
    await page.locator(SUBMIT).first().click();
    await sleep(2500); // in the middle of proving
    await page.reload();
    await connectAndUnlock(page, S.site).catch(() => {});
    await sleep(15_000);
    const got = (await bal(dest)) - before;
    const after0 = await privBalance(page);
    R.check(`refresh during a withdrawal: destination got ${formatEther(got)}, private balance ${before0} → ${after0} (consistent either way?)`, (got === 0n && Math.abs(after0 - before0) < 1e-9) || (got > 0n && Math.abs(before0 - after0 - 0.1) < 1e-6), { got: formatEther(got), before0, after0 });
    await shot(page, "flows-refresh-mid-withdraw");
  }

  // ── two tabs, same account, withdraw at the same time ──
  {
    const T2 = await newPage(S, { keyIndex: 1 });
    await T2.page.goto(`${S.site}/app`);
    await connectAndUnlock(T2.page, S.site);
    const pb = await privBalance(page);
    for (const pg of [page, T2.page]) {
      await nav(pg, "/app/portfolio/withdraw");
      await pg.locator("input.input").nth(1).waitFor({ timeout: 60_000 });
    }
    const amt = String(Math.floor((pb - 0.05) * 1000) / 1000); // almost all of it, so both need the same notes
    const [a, b] = await Promise.all([act(page, { amt, to: fresh(4) }), act(T2.page, { amt, to: fresh(3) })]);
    R.check(`two tabs withdraw ${amt} of ${pb} at once: tab1 ${a.ok ? "OK" : "ERR " + a.err}, tab2 ${b.ok ? "OK" : "ERR " + b.err}`, !(a.ok && b.ok), { a, b });
    await shot(page, "flows-two-tabs-1");
    await shot(T2.page, "flows-two-tabs-2");
    await T2.context.close();
    await page.reload();
    await connectAndUnlock(page, S.site);
  }

  // top up for the rest
  await nav(page, "/app/portfolio/shield");
  await page.locator("input.input").first().waitFor();
  await act(page, { amt: "3" });

  // ── wallet disconnect mid-shield ──
  {
    await page.locator("input.input").first().fill("0.2");
    await page.locator(SUBMIT).first().click();
    await setWallet(page, { connected: false });
    await sleep(6000);
    const vis = await page.evaluate(() => document.body.innerText.slice(0, 600));
    R.check(`wallet disconnected right after clicking Shield: page now says '${vis.replace(/\s+/g, " ").slice(0, 220)}'`, true);
    await shot(page, "flows-disconnect-mid-shield");
    await setWallet(page, { connected: true });
    await sleep(2000);
    await page.goto(`${S.site}/app`);
    await connectAndUnlock(page, S.site);
  }
  // ── wallet rejects the signature at unlock ──
  {
    const X = await newPage(S, { keyIndex: 3 });
    await X.page.goto(`${S.site}/app`);
    await X.page.evaluate(() => (window.__tw.rejectNext = true));
    await connectAndUnlock(X.page, S.site).catch(() => {});
    await sleep(1500);
    const text = (await X.page.evaluate(() => document.body.innerText)).replace(/\s+/g, " ");
    const m = text.match(/.{0,80}(reject|cancel|denied).{0,80}/i);
    R.check(`wallet rejects the connect request → '${m?.[0] ?? "no message"}'`, !!m);
    await shot(X.page, "flows-wallet-reject");
    await X.context.close();
  }

  // ── slow RPC and RPC down ──
  {
    S.knobs.delayMs = 1500;
    await nav(page, "/app/portfolio/withdraw");
    await page.locator("input.input").nth(1).waitFor({ timeout: 120_000 }).catch(() => {});
    const before = await bal(fresh(6));
    const r = await act(page, { amt: "0.05", to: fresh(6), timeout: 400_000 });
    const got = (await bal(fresh(6))) - before;
    R.r.timings.push({ label: "withdraw 0.05 with every RPC call 1.5 s slow", ms: r.ms, ok: !!r.ok, slow: true });
    R.check(`slow RPC (1.5 s per call) withdraw: ${r.ok ?? r.err ?? "timeout"} in ${r.ms} ms, landed ${formatEther(got)}`, !!r.ok);
    S.knobs.delayMs = 0;
    S.knobs.down = true;
    const r2 = await act(page, { amt: "0.05", to: fresh(6), timeout: 120_000 });
    R.check(`RPC down (503): withdraw says '${r2.err ?? r2.ok ?? "nothing within 2 min"}'`, !!r2.err, { r2 });
    await shot(page, "flows-rpc-down");
    S.knobs.down = false;
    S.knobs.failRate = 0.3;
    const r3 = await act(page, { amt: "0.05", to: fresh(6), timeout: 240_000 });
    R.check(`flaky RPC (30% of calls fail): withdraw → ${r3.ok ?? r3.err ?? "timeout"}`, !!r3.ok, { r3 });
    S.knobs.failRate = 0;
  }
  // ── relay down ──
  {
    S.keeperKnobs.relayDown = true;
    await nav(page, "/app/portfolio/withdraw");
    await page.locator("input.input").nth(1).waitFor({ timeout: 60_000 });
    const r = await act(page, { amt: "0.05", to: fresh(6), timeout: 180_000 });
    R.check(`relay down: withdraw says '${r.err ?? r.ok ?? "nothing"}'`, !!r.err, { r });
    await shot(page, "flows-relay-down");
    S.keeperKnobs.relayDown = false;
    const pb = await privBalance(page);
    R.check(`after the failed relay the private balance still reads ${pb}`, pb !== null);
  }

  // ── Trade: edge inputs, then instant buy/sell and a batch round ──
  await nav(page, "/app/trade");
  await page.getByLabel("Amount").waitFor({ timeout: 60_000 });
  for (const amt of ["0", "-0.01", "abc", "1e-3", "100000", "0.0000000000000000001"]) {
    await page.getByLabel("Amount").fill(amt);
    await page.waitForTimeout(1500);
    const cta = await page.locator(".swap-wrap button.btn-ink.btn-lg.btn-block").innerText().catch(() => "?");
    const est = await page.getByLabel("Estimated output").inputValue().catch(() => "?");
    R.check(`trade amount '${amt}': button '${cta}', estimate '${est}'`, !/^Swap privately$/.test(cta) || ["1e-3"].includes(amt), { amt, cta, est });
    if (amt === "-0.01" && /Swap privately/.test(cta)) {
      await page.locator(".swap-wrap button.btn-ink.btn-lg.btn-block").click();
      const r = await page.waitForFunction(() => [...document.querySelectorAll(".err, .okmsg")].map((x) => x.innerText).join(" ") || null, null, { timeout: 60_000 }).then((h) => h.jsonValue()).catch(() => "nothing");
      R.note("trade-negative", `a negative amount enables 'Swap privately'; clicking it shows: ${r}`);
      await shot(page, "flows-trade-negative");
    }
  }
  await shot(page, "flows-trade-edge");
  {
    await page.getByLabel("Amount").fill("0.005");
    await page.waitForFunction(() => Number((document.querySelector("input[aria-label='Estimated output']") || {}).value || 0) > 0, null, { timeout: 60_000 }).catch(() => {});
    const t = performance.now();
    await page.getByRole("button", { name: "Swap privately" }).click();
    const ok = await page.getByText(/Swapped privately/).waitFor({ timeout: 240_000 }).then(() => true, () => false);
    R.r.timings.push({ label: "instant private buy 0.005 HYPE (click to 'Swapped privately')", ms: Math.round(performance.now() - t), ok });
    R.check(`instant buy ok=${ok}`, ok, { err: await page.locator(".err").allInnerTexts() });
    // sell back max
    await page.getByLabel("Switch direction").click();
    await page.waitForTimeout(2000);
    const maxLink = page.locator(".swap-box .k .link").first();
    if (await maxLink.isVisible().catch(() => false)) await maxLink.click();
    await page.waitForTimeout(1500);
    const sellAmt = await page.getByLabel("Amount").inputValue();
    const t2 = performance.now();
    const btn = page.locator(".swap-wrap button.btn-ink.btn-lg.btn-block");
    const label = await btn.innerText();
    if (/Swap privately/.test(label)) {
      await btn.click();
      const ok2 = await page.getByText(/Swapped privately/).waitFor({ timeout: 240_000 }).then(() => true, () => false);
      R.r.timings.push({ label: "instant private sell (max) back to HYPE", ms: Math.round(performance.now() - t2), ok: ok2 });
      R.check(`instant sell of max (${sellAmt}) ok=${ok2} ${await page.locator(".err").allInnerTexts()}`, ok2);
    } else R.check(`sell side after a buy: button says '${label}' with amount '${sellAmt}'`, false);
    await shot(page, "flows-trade-sold");
  }
  if (G.batcherV4) {
    await page.getByLabel("Switch direction").click();
    await page.getByRole("button", { name: /Batch · hides size/ }).click();
    for (const amt of ["0.0000001", "0.003"]) {
      await page.getByLabel("Amount").fill(amt);
      await page.waitForTimeout(800);
      R.say(`  batch amount ${amt}: button '${await page.locator(".swap-wrap button.btn-ink.btn-lg.btn-block").innerText()}'`);
    }
    const fromBlock = await S.pub.getBlockNumber();
    const t = performance.now();
    await page.getByRole("button", { name: /Place \d+ sealed orders?/ }).click();
    const ok = await page.getByText(/sealed buy orders? placed in round/).waitFor({ timeout: 240_000 }).then(() => true, () => false);
    R.r.timings.push({ label: "batch: place sealed orders 0.003 HYPE (click to 'placed in round')", ms: Math.round(performance.now() - t), ok });
    await shot(page, "flows-batch-placed");
    const loop = createGloamLoop({ publicClient: S.pub, account: S.keeperWallet.account, send: (x) => S.keeperWallet.writeContract(x).then((h) => S.pub.waitForTransactionReceipt({ hash: h }).then(() => h)), batcherV4: G.batcherV4, batcherV4Block: fromBlock });
    let settled = [];
    for (let i = 0; i < 6 && !settled.length; i++) {
      await S.warp(70);
      settled = (await loop.tick()).rounds.filter((r) => r.action === "settled");
    }
    R.check(`batch round settled by the keeper loop: ${settled.map((r) => r.round).join(",")}`, settled.length > 0);
    await sleep(8000);
    await shot(page, "flows-batch-after-settle");
  }

  const errs = errors.filter((e) => !/favicon|Failed to load resource|net::/i.test(e));
  R.r.consoleErrors = [...new Set(errs)].slice(0, 30);
  R.say(`relayed ${S.stats.relayed}, relay errors: ${S.stats.relayErrors.slice(0, 8).join(" | ")}`);
} finally {
  R.save();
  await S.stop();
}
process.exit(0);
