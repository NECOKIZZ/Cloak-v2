// Records the walkthrough on the live site: CDP screencast frames + a timeline of voice cues and fast-forward spans.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { open, DIR, hooks } from "./harness.mjs";
const durs = JSON.parse(readFileSync(DIR + "vo/durs.json", "utf8"));
const FRIEND = readFileSync(DIR + "friend.cloak", "utf8").trim();
const ONLY = process.env.ONLY; // dry: skip money-moving clicks
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now() / 1000;

rmSync(DIR + "frames", { recursive: true, force: true }); mkdirSync(DIR + "frames");
const { browser, ctx, page, base } = await open();
await ctx.addInitScript({ path: new URL("./overlay.js", import.meta.url).pathname });
page.on("pageerror", (e) => console.log("pageerror", e.message.slice(0, 200)));

const ev = [];
let voiceFree = 0;
const ov = (fn, ...a) => page.evaluate(([fn, a]) => window.__ov[fn](...a), [fn, a]);
async function voiceDone(extra = 0) { const w = voiceFree - now(); if (w > 0) await sleep(w * 1000); if (extra) await sleep(extra); }
async function say(id, wait = false) {
  await voiceDone();
  ev.push({ t: now(), type: "say", id });
  voiceFree = now() + durs[id] + 0.45;
  console.log("say", id, durs[id].toFixed(1));
  if (wait) await voiceDone();
}
async function ffStart(text) { await voiceDone(); await ov("ff", true, text); ev.push({ t: now() + 0.6, type: "ff", on: true }); }
async function ffEnd() { ev.push({ t: now(), type: "ff", on: false }); await ov("ff", false); await sleep(400); }
async function inView(loc) { const b = await loc.boundingBox(); return b && b.y > 70 && b.y + b.height < 1050; }
async function smooth(loc, block = "center") { await loc.evaluate((e, b) => e.scrollIntoView({ behavior: "smooth", block: b }), block); await sleep(1200); }
async function moveTo(loc, ms = 750) {
  await loc.waitFor({ state: "visible" });
  if (!(await inView(loc))) await smooth(loc);
  const b = await loc.boundingBox(); const x = b.x + b.width / 2, y = b.y + b.height / 2;
  await ov("move", x, y, ms); await sleep(ms + 150); return { x, y };
}
async function click(loc, after = 500) { const { x, y } = await moveTo(loc); await ov("ring", x, y); await sleep(160); await loc.click(); await sleep(after); }
async function type(loc, text) { await click(loc, 200); await loc.press("Control+A"); await loc.press("Backspace"); await loc.pressSequentially(text, { delay: 70 }); await sleep(300); }
async function box(loc, label, pos = "top", tag = "a") { if (!(await inView(loc))) await smooth(loc); await ov("box", await loc.boundingBox(), label, pos, tag); }
async function arrow(loc, label, from = "left", tag = "a") { if (!(await inView(loc))) await smooth(loc); await ov("arrow", await loc.boundingBox(), label, from, tag); }
const clear = (tag) => ov("clear", tag);
const step = (n, title) => ov("step", n, 8, title);
const side = (name) => page.locator("a.side-link", { hasText: name }).first();

hooks.beforeWallet = async (method) => {
  const [t, d, ok] = method === "eth_requestAccounts" ? ["Connect to Cloak", "cloak.boblabs.tech wants to see your wallet address.", "Connect"]
    : method === "eth_sendTransaction" ? ["Confirm transaction", "Review the details and confirm. The network fee is paid in HYPE.", "Confirm"]
    : ["Signature request", "Sign to unlock your Cloak private account. It's free and sends no transaction.", "Sign"];
  const p = await ov("wallet", t, d, ok);
  await sleep(1100); await ov("move", p.x, p.y, 650); await sleep(850); await ov("ring", p.x, p.y); await sleep(300); await ov("wallet", null);
};

// ── start ──
await page.goto(base + "/");
await page.waitForLoadState("networkidle").catch(() => {});
await sleep(2500);
const cdp = await ctx.newCDPSession(page);
const frames = []; let n = 0;
cdp.on("Page.screencastFrame", (f) => {
  const name = `f${String(n++).padStart(6, "0")}.jpg`;
  writeFileSync(DIR + "frames/" + name, Buffer.from(f.data, "base64"));
  frames.push([f.metadata.timestamp, name]);
  cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
});
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
const T0 = now();
ev.push({ t: T0, type: "start" });
const save = () => writeFileSync(DIR + "timeline.json", JSON.stringify({ T0, ev, frames }, null, 0));

try {
  await sleep(800);
  await say("intro");
  await sleep(2500);
  await box(page.locator("h1").first(), null, "top", "h");
  await voiceDone(0.3);
  await clear();
  await click(page.locator("a.btn", { hasText: "Open app" }).first(), 1500);

  await say("welcome");
  const enter = page.getByRole("button", { name: "Enter the app" });
  await box(page.locator(".modal").first(), null);
  await sleep(2600); await clear();
  await arrow(enter, "Click", "left");
  await voiceDone(); await clear();
  await click(enter, 900);
  await say("guide");
  await box(page.locator(".modal").first(), null);
  await voiceDone(); await clear();
  await click(page.locator("button.btn-ghost", { hasText: "Close" }), 700);

  // 1 connect + unlock
  await step(1, "Connect and unlock");
  await say("connect");
  const cw = page.locator("main button.btn-ink", { hasText: "Connect wallet" }).first();
  await sleep(2600);
  await arrow(cw, "Connect wallet", "bottom");
  await sleep(1200); await clear();
  await click(cw, 1000);
  const bw = page.locator(".wm-item", { hasText: "Browser wallet" });
  await box(bw, "Your wallet", "top");
  await voiceDone(); await clear();
  await click(bw, 600);
  // picking the wallet goes straight on to the unlock signature
  await say("unlock");
  await sleep(4500);
  await box(page.locator(".side-wallet"), "Connected", "top", "w").catch(() => {});
  await sleep(2500); await clear();
  await ffStart("Unlocking your private account");
  await page.locator("main a.btn", { hasText: "Shield" }).first().waitFor({ timeout: 120000 });
  await ffEnd();
  await say("unlocked");
  await box(page.locator("main .card").first(), "Only you can see this", "bottom");
  await voiceDone(0.4); await clear();

  // 2 shield
  await step(2, "Shield HYPE");
  await say("shield1");
  const sh = page.locator("main a.btn", { hasText: "Shield" }).first();
  await sleep(3800);
  await arrow(sh, "Shield", "bottom");
  await voiceDone(); await clear();
  await click(sh, 1500);
  await say("shield2");
  await box(page.locator(".picker-btn").first(), "Token", "top");
  await sleep(1500);
  const amt = page.locator("main input.input").first();
  await type(amt, "0.5");
  await clear();
  const sbtn = page.locator("main button.btn-lg", { hasText: /^Shield/ });
  await arrow(sbtn, "Shield HYPE", "bottom");
  await voiceDone(); await clear();
  await say("shield3");
  if (!ONLY) await click(sbtn, 300);
  await box(page.locator("main p.note").first(), null, "top");
  await voiceDone(); await clear();
  if (!ONLY) {
    await ffStart("Waiting for the deposit to confirm");
    await page.locator(".okmsg").waitFor({ timeout: 180000 });
    await ffEnd();
    await say("shielded");
    await box(page.locator(".okmsg"), null);
    await voiceDone(0.3); await clear();
  }

  // 3 launches
  await step(3, "Browse launches");
  await say("launches1");
  await sleep(2200);
  await click(side("Launches"), 1800);
  await say("launches2");
  const heads = page.locator("main h2, main h3").filter({ hasText: /Bidding now|Trading|Didn/ });
  await box(heads.nth(0), null, "top", "s1"); await sleep(1300);
  await box(heads.nth(1), null, "top", "s2"); await sleep(1300);
  await clear();
  const search = page.locator("main input").first();
  await box(search, "Search", "top");
  await voiceDone(); await clear();
  await say("launches3");
  const lantern = page.locator("main a[href*='0x16D7D87547450415A8Db74A313A0F8514a9a7aaF' i]").first();
  await box(lantern, "Bidding now", "right");
  await sleep(1600); await clear();
  await click(lantern, 2500);
  await voiceDone();

  await say("launchpage");
  await box(page.locator("main .card").first(), "Token, ticker, contract, description", "bottom");
  await sleep(5200); await clear();
  await box(page.locator("main .card").nth(1), "Countdown and demand", "top");
  await voiceDone(); await clear();

  // 4 bid
  await step(4, "Place a private bid");
  await say("bid1");
  const pb = page.getByRole("button", { name: "Private balance", exact: true });
  await sleep(1500);
  await click(pb, 600);
  await box(pb.locator("xpath=ancestor::div[contains(@class,'field')]").first(), "Paid from your private HYPE", "left");
  await voiceDone(); await clear();
  await say("bid2");
  const bidInputs = page.locator(".card", { hasText: "Place a sealed bid" }).locator("input.input");
  await type(bidInputs.nth(0), "0.0000003");
  await type(bidInputs.nth(1), "10000");
  await sleep(500);
  const buck = page.locator(".bucket:not([disabled])").first();
  await click(buck, 500);
  await box(page.locator(".card", { hasText: "Place a sealed bid" }).locator(".summary"), "What you pay at most", "left");
  await voiceDone(); await clear();
  const seal = page.locator("button", { hasText: /Seal bid/ }).first();
  await say("bid3");
  await arrow(seal, "Seal bid", "bottom");
  await sleep(1800); await clear();
  if (!ONLY) await click(seal, 300);
  await voiceDone();
  if (!ONLY) {
    await ffStart("Sealing your bid");
    await page.locator(".okmsg", { hasText: "Bid sealed" }).waitFor({ timeout: 240000 });
    await ffEnd();
    await say("bidded");
    await box(page.locator(".okmsg", { hasText: "Bid sealed" }), null);
    await voiceDone(0.3); await clear();
  }
  await say("record");
  const rec = page.locator("main", { hasText: "On-chain record" }).locator("h3, h2", { hasText: "On-chain record" }).first();
  await smooth(rec, "start");
  await box(rec.locator("xpath=ancestor::div[contains(@class,'card')][1]"), "Every transaction, bids as hashes only", "top").catch(() => {});
  await voiceDone(0.4); await clear();

  // 5 create
  await step(5, "Create a launch");
  await say("create1");
  await sleep(1800);
  await click(side("Create a launch"), 1600);
  await say("create2");
  await page.locator("input[type=file]").setInputFiles(DIR + "beacon.png");
  await sleep(600);
  await type(page.locator("input[placeholder='Shade']"), "Beacon");
  await type(page.locator("input[placeholder='SHADE']"), "BEACON");
  await type(page.locator("textarea"), "A demo token made in the Cloak walkthrough. Play money only.");
  await voiceDone();
  await say("create3");
  const quick = page.locator("button.choice", { hasText: "Quick" });
  await box(quick, "15 minutes of bidding", "top");
  await sleep(4200); await clear();
  const lock = page.locator("button.choice", { hasText: "Locked forever" });
  await click(lock, 400);
  await box(lock, "Recommended", "top");
  await voiceDone(); await clear();
  await say("create4");
  const summary = page.locator(".card", { hasText: "Your launch" }).first();
  await box(summary, null, "top");
  await sleep(5500); await clear();
  const cb = page.locator("button", { hasText: "Create sealed-bid launch" });
  await arrow(cb, "Create", "bottom");
  await sleep(1500); await clear();
  if (!ONLY) {
    await click(cb, 300);
    await ffStart("Deploying your launch");
    await page.waitForURL(/\/app\/launch\/0x/, { timeout: 180000 });
    await sleep(2500);
    await ffEnd();
  }
  await voiceDone();
  await say("created");
  await box(page.locator("main .card").first(), null);
  await voiceDone(0.4); await clear();

  // 6 trade
  await step(6, "Trade privately");
  await say("trade1");
  await sleep(1200);
  await click(side("Trade"), 2000);
  await say("trade2");
  const tsel = page.locator(".token-sel").nth(1);
  await box(tsel, "Token you get", "right");
  await sleep(1500); await clear();
  const tin = page.locator("input[aria-label=Amount]");
  await type(tin, "0.05");
  await box(page.locator(".card", { hasText: "What the chain sees" }).first(), "What the chain sees", "top");
  await voiceDone(); await clear();
  await say("trade3");
  const batch = page.locator("button", { hasText: "Batch · hides size" });
  await box(batch, "Hides your size", "top");
  await sleep(3000); await clear();
  const inst = page.locator("button", { hasText: /^Instant/ });
  await click(inst, 500);
  const swap = page.locator("button", { hasText: "Swap privately" });
  await arrow(swap, "Swap privately", "bottom");
  await voiceDone(); await clear();
  if (!ONLY) await click(swap, 300);
  await say("trade4");
  await voiceDone();
  if (!ONLY) {
    await ffStart("Building the proof and relaying the trade");
    await page.locator(".okmsg").first().waitFor({ timeout: 240000 });
    await ffEnd();
    await say("traded");
    await box(page.locator(".okmsg").first(), null);
    await voiceDone(0.3); await clear();
  }

  // 7 send
  await step(7, "Send privately");
  await say("send1");
  await sleep(1500);
  await click(side("Portfolio"), 1500);
  const sp = page.locator("main a.btn", { hasText: "Send privately" });
  await click(sp, 1500);
  await say("send2");
  const sinputs = page.locator("main input.input");
  await box(page.locator(".picker-btn").first(), "Token", "top"); await sleep(1300); await clear();
  await type(sinputs.nth(0), "0.05");
  await click(sinputs.nth(1), 200);
  await sinputs.nth(1).fill(FRIEND);
  await box(sinputs.nth(1), "Their cloak: address", "top");
  await voiceDone(); await clear();
  await say("send3");
  const sb = page.locator("main button.btn-lg", { hasText: "Send privately" });
  await arrow(sb, "Send privately", "bottom");
  await sleep(1500); await clear();
  if (!ONLY) await click(sb, 300);
  await voiceDone();
  if (!ONLY) {
    await ffStart("Building the proof and relaying the send");
    await page.locator(".okmsg").first().waitFor({ timeout: 240000 });
    await ffEnd();
    await say("sent");
    await box(page.locator(".okmsg").first(), null);
    await voiceDone(0.3); await clear();
  }

  // 8 portfolio
  await step(8, "Your portfolio");
  await click(side("Portfolio"), 2500);
  await say("port1");
  await box(page.locator("main .card").first(), "Visible only to you", "bottom");
  await sleep(4500); await clear();
  await box(page.locator("main .card").nth(1), "Everything you hold privately", "top");
  await sleep(3500); await clear();
  await arrow(page.locator("main a.btn", { hasText: "Withdraw" }), "Public on purpose", "bottom");
  await voiceDone(0.3); await clear();
  await step(0);
  await click(page.locator("a.side-link", { hasText: "Docs" }).first(), 1500);
  await say("outro");
  await voiceDone(1.2);
  await ov("fade", true); await sleep(1200);
  ev.push({ t: now(), type: "end" });
} catch (e) {
  console.log("FAILED", e.message.split("\n")[0]);
  await page.screenshot({ path: DIR + "fail.png" });
  ev.push({ t: now(), type: "end", failed: true });
}
await cdp.send("Page.stopScreencast").catch(() => {});
await sleep(500);
save();
console.log("frames", frames.length, "dur", (now() - T0).toFixed(1));
await browser.close();
