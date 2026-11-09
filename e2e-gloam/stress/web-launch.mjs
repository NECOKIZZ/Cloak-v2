// Launches and sealed-bid auctions on the real site + direct contract calls, on a fork of Elysium testnet (Cloak's live
// v4 factory). Creates launches (UI and SDK), bids publicly and from the private balance through the UI, then tries to
// game them: an unopenable sealed bid revealed selectively, a dust bid in an undersubscribed launch, filling the auction
// deposit cap, bids and reveals exactly at the time boundaries, the anti-snipe fee right after listing, claiming twice
// and claiming someone else's bid. drand is real time, so the commit window is a few real minutes.
//
//   cd e2e-gloam && PATH=~/.foundry/bin:$PATH NODE_USE_ENV_PROXY=1 NO_PROXY=127.0.0.1,localhost node stress/web-launch.mjs
import { createWalletClient, formatEther, http, parseEther, toHex, erc20Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Cloak, cloakAuctionAbi, commitmentOf, randomSalt, drandRoundTime, sealBid } from "@cloakely/sdk";
import { createGloamLoop } from "../../services/keeper/gloamLoop.mjs";
import { ANVIL_KEYS, D, G, connectAndUnlock, dismissIntro, newPage, overflow, recorder, rpc, shot, sleep, startStack, visibleErrors } from "./web-harness.mjs";

const R = recorder("web-launch");
const S = await startStack({ base: 8660, vitePort: 5210 });
const nav = (page, p) => page.evaluate((p) => { history.pushState(null, "", p); dispatchEvent(new PopStateEvent("popstate")); }, p);
const W = (i) => createWalletClient({ chain: S.chain, account: privateKeyToAccount(ANVIL_KEYS[i]), transport: http(S.anvilUrl) });
const C = (i) => new Cloak(S.pub, W(i), D.factory);
const chainNow = async () => Number((await S.pub.getBlock({ blockTag: "latest" })).timestamp);
const tx = async (p) => S.pub.waitForTransactionReceipt({ hash: await p });
const tryTx = async (label, fn) => {
  try {
    const r = await fn();
    return { ok: true, status: r?.status ?? "sent" };
  } catch (e) {
    const m = String(e.shortMessage ?? e.message).split("\n")[0];
    const reason = (String(e.message).match(/reverted with reason string '([^']+)'|reason: ([^\n]+)|Error: ([^\n(]+)/) ?? [])[1] ?? m;
    return { ok: false, reason: reason.slice(0, 160) };
  }
};
const auctionRead = (a, fn, args = []) => S.pub.readContract({ address: a, abi: cloakAuctionAbi, functionName: fn, args });
const unit = 10n ** 10n; // 1e-8 HYPE

async function launchShots(page, mpage, a, phase) {
  for (const [pg, m] of [[page, "desktop"], [mpage, "mobile"]]) {
    await pg.goto(`${S.site}/app/launch/${a}`).catch(() => {});
    await dismissIntro(pg).catch(() => {});
    await pg.waitForFunction(() => !document.querySelector(".page-skel") && document.body.innerText.length > 200, null, { timeout: 30_000 }).catch(() => {});
    await pg.waitForTimeout(2500);
    const ov = m === "mobile" ? await overflow(pg) : null;
    await shot(pg, `launch-${phase}-${m}`);
    if (ov && ov.scrollWidth > ov.clientWidth + 1) R.note(`overflow-${phase}`, `launch page (${phase}) on a phone scrolls sideways: ${ov.wide.slice(0, 3).join("; ")}`);
  }
}

try {
  // ── users ──
  const creator = await newPage(S, { keyIndex: 4 });
  const bidder = await newPage(S, { keyIndex: 1 });
  const mobile = await newPage(S, { keyIndex: 2, mobile: true });

  // bidder shields first, so the private bid has a balance
  await bidder.page.goto(`${S.site}/app`);
  await R.time("bidder: connect + unlock", () => connectAndUnlock(bidder.page, S.site));
  await nav(bidder.page, "/app/portfolio/shield");
  await bidder.page.locator("input.input").first().fill("2");
  await R.time("bidder: shield 2 HYPE", async () => {
    await bidder.page.locator("button.btn-ink.btn-lg.btn-block").click();
    await bidder.page.getByText(/is now private/).waitFor({ timeout: 180_000 });
  });

  // ── create launch form: edge inputs ──
  await creator.page.goto(`${S.site}/app`);
  await R.time("creator: connect + unlock", () => connectAndUnlock(creator.page, S.site));
  await nav(creator.page, "/app/create");
  await dismissIntro(creator.page);
  await creator.page.getByRole("button", { name: /Advanced settings/ }).click();
  const fields = async () => creator.page.locator(".advanced input.input");
  const setField = async (label, v) => {
    const f = creator.page.locator(".field", { has: creator.page.locator("label", { hasText: label }) }).locator("input").first();
    await f.fill(v);
  };
  await creator.page.getByPlaceholder("Shade", { exact: true }).fill("Stress Test");
  await creator.page.getByPlaceholder("SHADE", { exact: true }).fill("STRS");
  const hint = async () => (await creator.page.locator(".hint").allInnerTexts()).join(" | ") || "(no hint)";
  const btnState = async () => (await creator.page.locator("button.btn-primary.btn-block").isDisabled()) ? "disabled" : "enabled";
  for (const [label, v, restore] of [
    ["Tokens for sale", "0", "1000000"], ["Tokens for sale", "-5", "1000000"], ["Tokens for sale", "1e6", "1000000"], ["Tokens for sale", "99999999999999999999999999999", "1000000"],
    ["Starting price", "0", "0.00000001"], ["Starting price", "0.0000000000000000001", "0.00000001"],
    ["Price levels", "0", "50"], ["Price levels", "257", "50"], ["Price levels", "2.5", "50"], ["Price levels", "1", "50"],
    ["Top price", "0.000000001", "0.000001"],
    ["Bidding", "0", "4"], ["Bidding", "0.5", "4"], ["Reveal window", "4", "5"], ["Reveal window", "99999999", "5"],
    ["Pool's share", "101", "50"], ["Pool's share", "-1", "50"],
    ["Penalty", "5", "10"], ["Penalty", "51", "10"],
    ["Your own share", "21", "0"], ["Your own share", "5", "0"],
  ]) {
    await setField(label, v);
    await creator.page.waitForTimeout(150);
    const h = await hint();
    R.check(`create form ${label}='${v}' → button ${await btnState()}, hint: ${h}`, true, { label, v, h });
    await setField(label, restore);
  }
  {
    // symbol and name edges
    for (const sym of ["", "$$$", "TOOLONGSYMBOL12", "a b"]) {
      await creator.page.getByPlaceholder("SHADE", { exact: true }).fill(sym);
      await creator.page.waitForTimeout(100);
      R.check(`create form symbol '${sym}' → ${await btnState()}, ${await hint()}`, true);
    }
    await creator.page.getByPlaceholder("SHADE", { exact: true }).fill("STRS");
    await creator.page.getByPlaceholder("Shade", { exact: true }).fill("<img src=x onerror=alert(1)> 🚀 Ünïcode");
  }
  await shot(creator.page, "launch-create-form");
  // the real one: 1M for sale, 1e-8 .. 1e-6 over 50 levels, 4 min bidding, 5 min reveal
  await setField("Tokens for sale", "1000000");
  await setField("Starting price", "0.00000001");
  await setField("Price levels", "50");
  await setField("Top price", "0.000001");
  await setField("Bidding", "4");
  await setField("Reveal window", "5");
  await creator.page.waitForTimeout(500);
  const t0 = performance.now();
  await creator.page.locator("button.btn-primary.btn-block").click();
  await creator.page.waitForURL(/\/app\/launch\/0x[0-9a-fA-F]{40}/, { timeout: 120_000 }).catch(() => {});
  R.r.timings.push({ label: "create a launch from the form (click to launch page)", ms: Math.round(performance.now() - t0), ok: /\/app\/launch\//.test(creator.page.url()) });
  const A = creator.page.url().match(/0x[0-9a-fA-F]{40}/)?.[0];
  if (!A) {
    R.check(`launch created from the UI: ${await creator.page.locator(".err").allInnerTexts()}`, false);
    await shot(creator.page, "launch-create-failed");
    throw new Error("no launch");
  }
  const sA = await C(4).getAuction(A);
  R.check(`launch A created from the UI: ${A}, commitEnd in ${sA.commitEnd - (await chainNow())} s, ticks ${sA.numTicks}, name '${sA.tokenName}'`, true);
  const fromBlock = (await S.pub.getBlockNumber()) - 5n;

  // SDK launches B (dust, undersubscribed), C (no bids), D (cap filled), all closing with A
  const mk = async (name, sym) => {
    const r = await C(4).createLaunch({ name, symbol: sym, saleSupply: 1_000_000n * 10n ** 18n, minPrice: unit, tickSize: unit, numTicks: 50, commitEnd: sA.commitEnd, revealEnd: sA.revealEnd, lpBps: 8000, lpLockUntil: "fees" });
    return r.auction;
  };
  const B = await mk("Dust Test", "DUST");
  const Cc = await mk("Nobody Bids", "NONE");
  const Dd = await mk("Cap Fill", "CAPF");
  R.say(`launches A ${A} B ${B} C ${Cc} D ${Dd}`);
  await launchShots(bidder.page, mobile.page, A, "commit-empty");

  // ── public bid through the UI, with edge inputs ──
  await nav(bidder.page, `/app/launch/${A}`);
  const bc = bidder.page.locator(".card", { has: bidder.page.getByText("Place a sealed bid") });
  await bc.waitFor({ timeout: 60_000 });
  const priceIn = bc.locator("input.input").nth(0);
  const qtyIn = bc.locator("input.input").nth(1);
  const sealBtn = bc.locator("button.btn-ink.btn-block");
  for (const [p, q] of [["0.000000009", "10000"], ["0.00000001", "0"], ["abc", "10"], ["0.00000001", "0.0000000000000000001"], ["-1", "10"], ["0.01", "10000"], ["0.000001", "999999999999"], ["0.000001", "100000000"]]) {
    await priceIn.fill(p);
    await qtyIn.fill(q);
    await bidder.page.waitForTimeout(300);
    const h = (await bc.locator(".hint").allInnerTexts()).join(" ");
    const dis = await sealBtn.isDisabled();
    const lock = (await bc.locator(".summary").innerText()).replace(/\s+/g, " ");
    R.check(`bid form price '${p}' qty '${q}' → ${dis ? "disabled" : "ENABLED"}; ${h || "no hint"}; ${lock}`, true, { p, q, h, dis });
    if (!dis && (p === "0.000001" && q === "100000000")) {
      // 100M tokens at the top price = 100 HYPE deposit bucket (over the 100 HYPE per-bid cap?)
      await sealBtn.click();
      const r = await bidder.page.waitForFunction(() => [...document.querySelectorAll(".card .err, .card .okmsg")].map((x) => x.innerText).join(" ") || null, null, { timeout: 60_000 }).then((h) => h.jsonValue()).catch(() => "nothing");
      R.check(`bid of 100M tokens at the top price → '${r}'`, true, { r });
      await shot(bidder.page, "launch-bid-over-cap");
    }
  }
  await shot(bidder.page, "launch-bid-edge");
  await priceIn.fill("0.0000005");
  await qtyIn.fill("200000");
  await R.time("public sealed bid from the UI (click to 'Bid sealed')", async () => {
    await sealBtn.click();
    await bc.locator(".okmsg").waitFor({ timeout: 90_000 });
  });
  // double-click: does it place two bids?
  {
    const before = Number(await auctionRead(A, "bidsCount"));
    await priceIn.fill("0.0000002");
    await qtyIn.fill("1000");
    await sealBtn.dblclick();
    await sleep(6000);
    const after = Number(await auctionRead(A, "bidsCount"));
    R.check(`double-click 'Seal bid' placed ${after - before} bid(s)`, after - before === 1, { n: after - before });
  }
  // ── private bid through the UI ──
  await bc.getByRole("button", { name: "Private balance" }).click();
  await priceIn.fill("0.0000004");
  await qtyIn.fill("300000");
  await bidder.page.waitForTimeout(3000);
  R.say(`  private bid hint: ${(await bc.locator(".hint").allInnerTexts()).join(" ") || "none"}`);
  await R.time("private sealed bid from the UI (click to 'Bid sealed', proof + relay + one-time wallet)", async () => {
    await bc.locator("button.btn-ink.btn-block").click();
    await bc.locator(".okmsg").waitFor({ timeout: 240_000 });
  });
  await shot(bidder.page, "launch-private-bid");

  // ── other bidders (SDK) ──
  const secrets = {};
  secrets.u5 = await C(5).bid(A, { maxPrice: 50n * unit, quantity: 400_000n * 10n ** 18n });
  secrets.u6 = await C(6).bid(A, { maxPrice: 30n * unit, quantity: 400_000n * 10n ** 18n });
  // the griefer: a valid commitment with a ciphertext nobody can open (only he can reveal it, after seeing the rest)
  const g = W(7);
  const gTick = 49, gQty = 600_000n * 10n ** 18n, gSalt = randomSalt();
  const gCommit = commitmentOf(A, g.account.address, gTick, gQty, gSalt);
  const gCost = (sA.minPrice + BigInt(gTick) * sA.tickSize) * gQty / 10n ** 18n;
  await tx(g.writeContract({ address: A, abi: cloakAuctionAbi, functionName: "commit", args: [gCommit, toHex("not a drand ciphertext")], value: gCost }));
  const gId = Number(await auctionRead(A, "bidsCount")) - 1;
  R.say(`  griefer bid #${gId}: tick ${gTick}, ${formatEther(gQty)} tokens, deposit ${formatEther(gCost)}, ciphertext garbage`);
  // a bid sealed to the wrong round would open too late: seal for a round far in the future
  const late = W(3);
  {
    const salt = randomSalt();
    const q = 50_000n * 10n ** 18n;
    const sealed = await sealBid({ auction: A, bidder: late.account.address, tick: 10, quantity: q, salt }, sA.tlockRound + 100000);
    await tx(late.writeContract({ address: A, abi: cloakAuctionAbi, functionName: "commit", args: [commitmentOf(A, late.account.address, 10, q, salt), sealed], value: parseEther("0.01") }));
  }
  // B: one dust bid at the minimum tick (1 token)
  secrets.dust = await C(5).bid(B, { maxPrice: unit, quantity: 10n ** 18n });
  // D: fill the auction deposit cap with min-price bids, then an honest bid
  {
    const [perBid, total] = await S.pub.readContract({ address: D.config, abi: [{ type: "function", name: "auctionLimit", stateMutability: "view", inputs: [], outputs: [{ type: "uint128" }, { type: "uint128" }] }], functionName: "auctionLimit" });
    const whale = C(0);
    const n = Number(total / perBid);
    const t = performance.now();
    // each min-price bid: deposit 100 HYPE, quantity sized to that deposit at the minimum price
    const qty = (perBid * 10n ** 18n) / unit;
    for (let i = 0; i < n; i++) await whale.bid(Dd, { maxPrice: unit, quantity: qty / 10n, deposit: perBid });
    R.say(`  whale filled D's cap with ${n} bids of ${formatEther(perBid)} HYPE in ${Math.round((performance.now() - t) / 1000)} s`);
    const honest = await tryTx("honest bid on D", () => C(6).bid(Dd, { maxPrice: 40n * unit, quantity: 1000n * 10n ** 18n }));
    R.check(`after the whale fills D's ${formatEther(total)} HYPE deposit cap, an honest bid fails: ${honest.ok ? "NO, it went through" : honest.reason}`, !honest.ok);
    // and what the honest user sees in the UI
    await nav(bidder.page, `/app/launch/${Dd}`);
    const bcd = bidder.page.locator(".card", { has: bidder.page.getByText("Place a sealed bid") });
    await bcd.waitFor({ timeout: 60_000 });
    await bcd.getByRole("button", { name: "Wallet" }).click();
    await bcd.locator("input.input").nth(0).fill("0.0000004");
    await bcd.locator("input.input").nth(1).fill("10000");
    await bcd.locator("button.btn-ink.btn-block").click();
    const msg = await bidder.page.waitForFunction(() => [...document.querySelectorAll(".card .err, .card .okmsg")].map((x) => x.innerText).join(" ") || null, null, { timeout: 60_000 }).then((h) => h.jsonValue()).catch(() => "nothing");
    R.check(`UI bid on a launch whose cap is full says: '${msg}'`, true, { msg });
    await shot(bidder.page, "launch-cap-full-bid");
  }
  await launchShots(bidder.page, mobile.page, A, "commit-bids");

  // ── commit boundary: last second and exactly at commitEnd ──
  while ((await chainNow()) < sA.commitEnd - 4) await sleep(1000);
  await rpc(S.anvilUrl, "evm_setNextBlockTimestamp", [sA.commitEnd - 1]);
  const last = await tryTx("bid at commitEnd-1", () => C(3).bid(A, { maxPrice: 20n * unit, quantity: 1000n * 10n ** 18n }));
  await rpc(S.anvilUrl, "evm_setNextBlockTimestamp", [sA.commitEnd]);
  // raw commit (the SDK refuses client-side once the phase is over)
  const atEnd = await tryTx("bid at commitEnd", () => tx(W(3).writeContract({ address: A, abi: cloakAuctionAbi, functionName: "commit", args: [toHex(1n, { size: 32 }), "0x"], value: 1n, gas: 300_000n })));
  R.check(`boundary: bid at commitEnd-1 ${last.ok ? "accepted" : "refused (" + last.reason + ")"}; at commitEnd ${atEnd.ok ? "ACCEPTED" : "refused (" + atEnd.reason + ")"}`, last.ok && !atEnd.ok);
  // reveal before the drand round: SDK revealAll can't open anything yet
  {
    const early = await C(8).revealAll(A, { fromBlock }).catch((e) => ({ err: e.message }));
    R.check(`revealAll before the drand round passes: ${early.err ? "error " + early.err.slice(0, 120) : `revealed ${early.revealed}, unopenable ${early.unopenable.length}`}`, true);
  }
  await launchShots(bidder.page, mobile.page, A, "reveal-before-drand");

  // ── reveal (as the keeper would), publish unopenable ──
  while (Date.now() / 1000 < drandRoundTime(sA.tlockRound) + 2) await sleep(1000);
  const tReveal = performance.now();
  const rev = {};
  for (const [k, a] of [["A", A], ["B", B], ["C", Cc], ["D", Dd]]) {
    rev[k] = await C(8).revealAll(a, { fromBlock });
    S.unopenable.set(a.toLowerCase(), rev[k].unopenable.map((b) => ({ id: String(b.id), bidder: b.bidder, deposit: String(b.deposit), why: b.why })));
  }
  R.r.timings.push({ label: "keeper revealAll on 4 launches (SDK)", ms: Math.round(performance.now() - tReveal), ok: true });
  R.check(`revealAll A: revealed ${rev.A.revealed}, unopenable ${rev.A.unopenable.map((u) => `#${u.id} (${u.why.slice(0, 60)})`).join(", ")}`, rev.A.unopenable.length >= 2);
  await launchShots(bidder.page, mobile.page, A, "reveal-unopenable");
  {
    const txt = await bidder.page.evaluate(() => document.body.innerText);
    const m = txt.match(/\d+ sealed bids? \([^)]*\) couldn't be opened[^.]*\./);
    R.check(`the launch page shows the unopenable bids: '${m?.[0] ?? "NOT SHOWN"}'`, !!m);
  }
  // demand chart during reveal: does it leak the griefer's absence?
  const priceBeforeG = await (async () => { const c = await auctionRead(A, "demandCurve"); return c.map(Number); })();

  // ── selective reveal: the griefer watches, then opens his bid at the last second ──
  await rpc(S.anvilUrl, "evm_setNextBlockTimestamp", [sA.revealEnd - 1]);
  const sel = await tryTx("griefer reveal at revealEnd-1", () => tx(g.writeContract({ address: A, abi: cloakAuctionAbi, functionName: "reveal", args: [BigInt(gId), gTick, gQty, gSalt] })));
  R.check(`selective reveal: the griefer opened his unopenable bid at revealEnd-1: ${sel.ok ? "accepted" : sel.reason}`, true, { sel });
  // the late-round bidder reveals with his own preimage? (he can't: we didn't keep it; it stays sealed and pays the penalty)
  await S.mine();
  const settleEarly = await tryTx("settle at revealEnd-1", async () => { await rpc(S.anvilUrl, "evm_setNextBlockTimestamp", [sA.revealEnd - 1].map((x) => x + 0)); return 0; });
  void settleEarly;
  await S.warp(2);
  await launchShots(bidder.page, mobile.page, A, "settle-phase");

  // ── settle A from the UI ──
  await nav(bidder.page, `/app/launch/${A}`);
  const settleBtn = bidder.page.getByRole("button", { name: /Settle it now/ });
  if (await settleBtn.isVisible({ timeout: 20_000 }).catch(() => false)) {
    await R.time("settle from the launch page (click to Trading)", async () => {
      await settleBtn.click();
      await bidder.page.locator(".pill.ok", { hasText: "Trading" }).first().waitFor({ timeout: 120_000 });
    });
  } else {
    R.check("the 'Settle it now' button is shown after the reveal window", false);
    await C(8).settle(A);
  }
  const listedAt = await chainNow();
  for (const a of [B, Cc, Dd]) await tryTx("settle", () => C(8).settle(a));
  const sA2 = await C(8).getAuction(A);
  R.check(`A settled at ${formatEther(sA2.clearingPrice)} HYPE/token, sold ${formatEther(sA2.sold ?? 0n)}, griefer's revealed bid moved the price: tick ${sA2.clearingTick}`, sA2.settled, { clearing: formatEther(sA2.clearingPrice) });
  for (const [k, a] of [["B (dust)", B], ["C (no bids)", Cc], ["D (cap filled)", Dd]]) {
    const s = await C(8).getAuction(a);
    R.check(`${k}: settled=${s.settled} failed=${s.failed} price ${formatEther(s.clearingPrice)} raised ${formatEther(s.raised ?? 0n)} pool ${s.pair}`, s.settled, { pair: s.pair });
  }
  await launchShots(bidder.page, mobile.page, A, "settled");
  await launchShots(bidder.page, mobile.page, B, "dust-settled");
  await launchShots(bidder.page, mobile.page, Cc, "failed");
  await launchShots(bidder.page, mobile.page, Dd, "capfilled-settled");

  // ── anti-snipe: a public buy right after listing vs 6 minutes later (same pool state via a snapshot) ──
  {
    const buyer = W(9);
    const token = sA2.token;
    const buyOnce = async () => {
      await nav(bidder.page, `/app/launch/${A}`);
      const tc = bidder.page.locator(".card", { has: bidder.page.getByText("Trade from your wallet") });
      if (!(await tc.isVisible({ timeout: 20_000 }).catch(() => false))) return null;
      await tc.locator("input.input").fill("0.01");
      await bidder.page.waitForTimeout(2500);
      const est = (await tc.locator(".summary").innerText()).replace(/\s+/g, " ");
      const before = await S.pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [bidder.account] });
      await tc.locator("button.btn-primary.btn-block").click();
      const msg = await bidder.page.waitForFunction((el) => [...document.querySelectorAll(".card .okmsg, .card .err")].map((x) => x.innerText).join(" ") || null, null, { timeout: 60_000 }).then((h) => h.jsonValue()).catch(() => "nothing");
      const got = (await S.pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [bidder.account] })) - before;
      return { est, got: formatEther(got), msg };
    };
    void buyer;
    const snap = await rpc(S.anvilUrl, "evm_snapshot");
    const early = await buyOnce();
    await rpc(S.anvilUrl, "evm_revert", [snap]);
    await S.warp(6 * 60);
    const later = await buyOnce();
    R.check(`anti-snipe: 0.01 HYPE public buy right after listing got ${early?.got} (UI estimate '${early?.est}', ${early?.msg}); 6 min later got ${later?.got} (estimate '${later?.est}')`, true, { early, later, listedAt });
    await shot(bidder.page, "launch-trade-after-listing");
  }

  // ── claims ──
  await nav(bidder.page, `/app/launch/${A}`);
  await bidder.page.waitForTimeout(4000);
  await shot(bidder.page, "launch-claim-before");
  {
    const claimBtn = bidder.page.getByRole("button", { name: /^(Claim all|Claim to wallet)$/ });
    if (await claimBtn.isVisible({ timeout: 20_000 }).catch(() => false)) {
      await R.time("claim public bid from the launch page", async () => {
        await claimBtn.click();
        await bidder.page.getByText(/claimed/i).first().waitFor({ timeout: 60_000 });
      });
    } else R.check("claim button on the launch page", false);
    const pb = bidder.page.getByRole("button", { name: /Claim privately and move refunds in/ });
    if (await pb.isVisible({ timeout: 20_000 }).catch(() => false)) {
      await R.time("claim the private bid into the private balance (Your private bids)", async () => {
        await pb.click();
        await bidder.page.waitForFunction(() => !/Claim privately and move refunds in|Working/.test(document.body.innerText), null, { timeout: 240_000 });
      });
      R.say(`  after private claim: ${(await visibleErrors(bidder.page)).join(" | ")}`);
    } else R.check("the 'Your private bids' card offers the private claim", false);
    await shot(bidder.page, "launch-claimed");
  }
  {
    const id5 = secrets.u5.id;
    const c1 = await tryTx("u5 claim", () => C(5).claim(A, [id5]));
    const c2 = await tryTx("u5 claim again", () => C(5).claim(A, [id5]));
    const cl = await tryTx("claim(id) twice", () => tx(W(5).writeContract({ address: A, abi: cloakAuctionAbi, functionName: "claim", args: [id5] })));
    R.check(`claim twice: first ${c1.ok ? "ok" : c1.reason}; claimBatch again ${c2.ok ? "OK (no-op?)" : c2.reason}; claim(id) again ${cl.ok ? "OK" : cl.reason}`, c1.ok && !cl.ok, { c2 });
    // someone else's: u3 claims u6's bid → goes to u6
    const tok = sA2.token;
    const bal = (a) => S.pub.readContract({ address: tok, abi: erc20Abi, functionName: "balanceOf", args: [a] });
    const [b3, b6] = [await bal(W(3).account.address), await bal(W(6).account.address)];
    const o = await tryTx("u3 claims u6's bid", () => tx(W(3).writeContract({ address: A, abi: cloakAuctionAbi, functionName: "claim", args: [secrets.u6.id] })));
    const [a3, a6] = [await bal(W(3).account.address), await bal(W(6).account.address)];
    R.check(`claim someone else's bid: ${o.ok ? "allowed" : o.reason}; caller got ${formatEther(a3 - b3)}, bidder got ${formatEther(a6 - b6)}`, a3 === b3);
    const p = await tryTx("u3 claimPrivate u5's", () => tx(W(3).writeContract({ address: A, abi: cloakAuctionAbi, functionName: "claimPrivate", args: [secrets.u5.id, 1n, 1n, "0x"], gas: 500_000n })));
    R.check(`claimPrivate of someone else's bid: ${p.ok ? "ALLOWED" : "refused (" + p.reason + ")"}`, !p.ok);
    // the griefer and the late bidder
    const ag = await auctionRead(A, "allocationOf", [BigInt(gId)]);
    R.check(`griefer (selectively revealed) gets ${formatEther(ag[0])} tokens, refund ${formatEther(ag[1])}, penalty ${formatEther(ag[2])}`, true);
    const lateId = BigInt(gId + 1);
    const al = await auctionRead(A, "allocationOf", [lateId]);
    R.check(`the bid sealed to a far-future round (never opened) gets ${formatEther(al[0])} tokens, refund ${formatEther(al[1])}, penalty ${formatEther(al[2])}`, al[2] > 0n);
    // dust launch: claim
    const cd = await tryTx("dust claim", () => C(5).claim(B, [secrets.dust.id]));
    const sB = await C(8).getAuction(B);
    R.check(`dust launch B claim ${cd.ok ? "ok" : cd.reason}; B has pool ${sB.pair}, creatorOwed ${formatEther(sB.creatorOwed ?? 0n)}`, cd.ok);
    // C refunds (no bids at all): nothing to claim; D: whale bought everything at the minimum price
    const sD = await C(8).getAuction(Dd);
    R.check(`cap-filled launch D: whale is the only bidder; cleared at ${formatEther(sD.clearingPrice)} (the minimum ${formatEther(sD.minPrice)}), sold ${formatEther(sD.sold ?? 0n)}`, true);
  }

  // ── private trading after listing (the keeper loop admits the token) ──
  {
    const loop = createGloamLoop({ publicClient: S.pub, account: S.keeperWallet.account, send: (x) => S.keeperWallet.writeContract(x).then((h) => S.pub.waitForTransactionReceipt({ hash: h }).then(() => h)), launchVault: G.launchVault });
    const t = await loop.tick().catch((e) => ({ err: e.message }));
    R.check(`keeper loop after settlement: admitted ${JSON.stringify(t.admitted?.map((x) => x.token) ?? t.err).slice(0, 200)}`, true);
    await bidder.page.reload();
    await connectAndUnlock(bidder.page, S.site);
    await nav(bidder.page, `/app/trade?token=${sA2.token}`);
    await bidder.page.getByLabel("Amount").waitFor({ timeout: 60_000 }).catch(() => {});
    await bidder.page.waitForTimeout(3000);
    const sym = await bidder.page.locator(".swap-box").nth(1).innerText().catch(() => "");
    R.say(`  trade page market: ${sym.replace(/\s+/g, " ")}`);
    await bidder.page.getByLabel("Amount").fill("0.002");
    await bidder.page.waitForTimeout(3000);
    const btn = bidder.page.locator(".swap-wrap button.btn-ink.btn-lg.btn-block");
    if (/Swap privately/.test(await btn.innerText())) {
      await R.time("private instant buy of the new launch right after listing", async () => {
        await btn.click();
        await bidder.page.getByText(/Swapped privately/).waitFor({ timeout: 240_000 });
      });
    } else R.check(`private trade of the new token: button '${await btn.innerText()}'`, false);
    await shot(bidder.page, "launch-private-trade");
  }
  // launches list with the new ones
  await bidder.page.goto(`${S.site}/app/launches`);
  await bidder.page.waitForTimeout(6000);
  await shot(bidder.page, "launch-list-after");
  await mobile.page.goto(`${S.site}/app/launches`);
  await mobile.page.waitForTimeout(4000);
  await shot(mobile.page, "launch-list-after-mobile");
  R.r.consoleErrors = [...new Set([...bidder.errors, ...creator.errors].filter((e) => !/favicon|Failed to load resource|net::/i.test(e)))].slice(0, 30);
  R.r.demandDuringReveal = priceBeforeG;
} finally {
  R.save();
  await S.stop();
}
process.exit(0);
