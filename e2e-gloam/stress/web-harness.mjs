// Shared harness for the web stress scripts (web-*.mjs). Copied from part8-site.mjs, with extras for breaking things:
//  - anvil forks Elysium testnet (never sends to a live chain)
//  - an RPC proxy in front of anvil whose delay / failure rate can be changed at runtime (slow RPC tests)
//  - a local keeper: POST /gloam/relay, /schedule (spread-out withdrawals), /unopenable (fed by our own revealAll), /
//  - the site (Vite, VITE_CORE=gloam) pointed at the proxy and the local keeper
//  - an EIP-6963 test wallet backed by an anvil dev account, which a test can disconnect, switch, slow down or reject
//
// Ports: anvil base, proxy base+1, keeper base+2 (8650-8699); vite 5200-5249.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deployments } from "@cloakely/sdk";
import { createGloamRelay } from "../../services/keeper/gloam.mjs";
import { startSchedule } from "../../services/keeper/schedule.mjs";
import { ANVIL_KEYS, ELYSIUM_TESTNET_ID, ELYSIUM_TESTNET_RPC, REPO, chainFor, rpc, startAnvil } from "../lib.mjs";

export const { chromium, devices } = createRequire(import.meta.url)("playwright");
export const G = deployments[ELYSIUM_TESTNET_ID].gloam;
export const D = deployments[ELYSIUM_TESTNET_ID];
export const SHOTS = join(REPO, "docs/stress/shots");
export const OUT = join(REPO, "docs/stress/raw");
mkdirSync(SHOTS, { recursive: true });
mkdirSync(OUT, { recursive: true });
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export { ANVIL_KEYS, ELYSIUM_TESTNET_ID, REPO, rpc };

/** Results collected by a script: timings, findings (observations), checks. Written to docs/stress/raw/<name>.json. */
export function recorder(name) {
  const r = { name, started: new Date().toISOString(), timings: [], notes: [], checks: [] };
  const file = join(OUT, `${name}.json`);
  const save = () => writeFileSync(file, JSON.stringify(r, null, 2));
  const log = join(OUT, `${name}.log`);
  writeFileSync(log, "");
  const say = (m) => {
    console.log(m);
    appendFileSync(log, m + "\n");
  };
  return {
    r,
    save,
    say,
    /** Time fn (click to confirmation). Never throws: a failure is recorded. */
    async time(label, fn, { slowMs = 15_000 } = {}) {
      const t = performance.now();
      try {
        const v = await fn();
        const ms = Math.round(performance.now() - t);
        r.timings.push({ label, ms, ok: true, slow: ms > slowMs });
        say(`  [${(ms / 1000).toFixed(1)}s] ${label}`);
        save();
        return v;
      } catch (e) {
        const ms = Math.round(performance.now() - t);
        r.timings.push({ label, ms, ok: false, error: String(e?.message ?? e).slice(0, 300) });
        say(`  FAIL [${(ms / 1000).toFixed(1)}s] ${label}: ${String(e?.message ?? e).split("\n")[0].slice(0, 200)}`);
        save();
        return undefined;
      }
    },
    note(id, text, extra = {}) {
      r.notes.push({ id, text, ...extra });
      say(`  NOTE ${id}: ${text}`);
      save();
    },
    check(label, ok, extra = {}) {
      r.checks.push({ label, ok: !!ok, ...extra });
      say(`  ${ok ? "ok  " : "BAD "} ${label}`);
      save();
      return ok;
    },
  };
}

/** Fork + proxy + keeper + vite. Returns everything a script needs; call stop() at the end. */
export async function startStack({ base = 8650, vitePort = 5200, wantVite = true } = {}) {
  const anvil = await startAnvil({ port: base, forkUrl: process.env.RPC_URL ?? ELYSIUM_TESTNET_RPC });
  const anvilUrl = anvil.rpcUrl;

  // RPC proxy with runtime knobs: { delayMs, failRate, down }
  const knobs = { delayMs: 0, failRate: 0, down: false, calls: 0 };
  const proxy = createServer((req, res) => {
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST,GET,OPTIONS" };
    if (req.method === "OPTIONS") return res.writeHead(204, cors).end();
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      knobs.calls++;
      if (knobs.delayMs) await sleep(knobs.delayMs);
      if (knobs.down) return res.writeHead(503, cors).end("down");
      if (knobs.failRate && Math.random() < knobs.failRate) return res.writeHead(502, cors).end("bad gateway");
      try {
        const r = await fetch(anvilUrl, { method: "POST", headers: { "content-type": "application/json" }, body });
        const txt = await r.text();
        res.writeHead(r.status, { ...cors, "content-type": "application/json" }).end(txt);
      } catch (e) {
        res.writeHead(502, cors).end(String(e));
      }
    });
  }).listen(base + 1);
  const rpcUrl = `http://127.0.0.1:${base + 1}`;

  const chain = chainFor(anvilUrl);
  const pub = createPublicClient({ chain, transport: http(anvilUrl), pollingInterval: 100 });
  const keeperWallet = createWalletClient({ chain, account: privateKeyToAccount(ANVIL_KEYS[8]), transport: http(anvilUrl) });
  const relay = createGloamRelay({ publicClient: pub, walletClient: keeperWallet, vault: G.gloamVault, launchVault: G.launchVault, memoBoard: G.memoBoard, escrows: [G.launchSwap, G.launchSwapV4, G.receive, G.bids, G.graduation, G.batcher, G.batcherV4, G.fundsGate].filter(Boolean), hourlySpendWei: parseEther("5") });
  const keeperKnobs = { relayDown: false, relayDelayMs: 0 };
  const stats = { relayed: 0, relayErrors: [], scheduled: 0 };
  // the schedule on the chain's clock, so tests can warp time
  let chainNow = Math.floor(Date.now() / 1000);
  const syncClock = async () => (chainNow = Number((await pub.getBlock({ blockTag: "latest" })).timestamp));
  const gloamPiece = (call) => ({ to: call.to, data: call.data });
  const schedule = startSchedule({
    check: async () => { throw new Error("no Cloak v1 relay here"); },
    send: async () => { throw new Error("no Cloak v1 relay here"); },
    gloam: { check: (call) => relay(gloamPiece(call), { dryRun: true, sender: "schedule" }), send: (call) => relay(gloamPiece(call), { sender: "schedule" }) },
    now: () => chainNow,
    tickMs: 0,
  });
  /** auction (lowercase) → [{ id, bidder, deposit, why }] (the keeper's /unopenable) */
  const unopenable = new Map();
  const keeper = createServer((req, res) => {
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "content-type": "application/json" };
    const send = (code, obj) => res.writeHead(code, cors).end(JSON.stringify(obj));
    const path = (req.url ?? "/").split("?")[0];
    const q = new URL(req.url, "http://x").searchParams;
    if (req.method === "OPTIONS") return res.writeHead(204, cors).end();
    if (req.method === "GET" && (path === "/" || path === "/health")) return send(200, { keeper: keeperWallet.account.address, chain: ELYSIUM_TESTNET_ID, local: true });
    if (req.method === "GET" && path === "/unopenable") {
      const a = (q.get("auction") ?? "").toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(a)) return send(400, { error: "pass ?auction=0x…" });
      return send(200, { auction: a, checked: unopenable.has(a), bids: unopenable.get(a) ?? [] });
    }
    if (req.method === "GET" && path === "/schedule") {
      const ids = (q.get("ids") ?? "").split(",").filter((x) => /^0x[0-9a-f]{64}$/.test(x)).slice(0, 20);
      return send(200, { pieces: schedule.status(ids) });
    }
    if (req.method === "POST" && (path === "/gloam/relay" || path === "/schedule")) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        try {
          if (path === "/schedule") {
            const ids = await schedule.add(JSON.parse(body));
            stats.scheduled += ids.length;
            return send(200, { ids });
          }
          if (keeperKnobs.relayDelayMs) await sleep(keeperKnobs.relayDelayMs);
          if (keeperKnobs.relayDown) return send(503, { error: "relay is down" });
          const txHash = await relay(JSON.parse(body));
          stats.relayed++;
          send(200, { txHash });
        } catch (e) {
          stats.relayErrors.push(String(e.message).slice(0, 200));
          send(e.status ?? 400, { error: e.message });
        }
      });
      return;
    }
    send(404, {});
  }).listen(base + 2);
  const keeperUrl = `http://127.0.0.1:${base + 2}`;

  let vite;
  const site = `http://127.0.0.1:${vitePort}`;
  if (wantVite) {
    vite = spawn("npx", ["vite", "--port", String(vitePort), "--strictPort", "--host", "127.0.0.1"], {
      cwd: join(REPO, "apps/web"),
      env: { ...process.env, VITE_CORE: "gloam", VITE_CHAIN_ID: String(ELYSIUM_TESTNET_ID), VITE_RPC_URL: rpcUrl, VITE_KEEPER_URL: keeperUrl, VITE_RELAYER_URL: keeperUrl },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    await new Promise((ok, no) => {
      const t = setTimeout(() => no(new Error("vite did not start")), 90_000);
      vite.stdout.on("data", (d) => String(d).includes(String(vitePort)) && (clearTimeout(t), ok()));
      vite.stderr.on("data", (d) => process.env.DEBUG && console.error(String(d)));
    });
  }
  const browser = wantVite ? await chromium.launch() : null;

  const stop = async () => {
    try { await browser?.close(); } catch {}
    try { process.kill(-vite.pid); } catch {}
    proxy.close();
    keeper.close();
    anvil.stop();
  };
  const mine = () => rpc(anvilUrl, "evm_mine");
  const warp = async (secs) => {
    await rpc(anvilUrl, "evm_increaseTime", [secs]);
    await mine();
    await syncClock();
  };
  return { anvilUrl, rpcUrl, keeperUrl, site, chain, pub, keeperWallet, relay, schedule, syncClock, unopenable, knobs, keeperKnobs, stats, browser, stop, mine, warp };
}

/**
 * A new page with the test wallet. Controls on window.__tw: { connected, rejectNext, delayMs, account, chainHex }.
 * Use setWallet(page, {...}) to change them; it emits accountsChanged/chainChanged like a real wallet.
 */
export async function newPage(stack, { keyIndex = 1, viewport = { width: 1280, height: 900 }, mobile = false, ctx } = {}) {
  const account = privateKeyToAccount(ANVIL_KEYS[keyIndex]).address;
  const context = ctx ?? (await stack.browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport }));
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push("PAGEERROR " + String(e)));
  await page.addInitScript(({ rpc, account, chainHex }) => {
    let id = 1;
    const tw = (window.__tw = { connected: true, rejectNext: false, delayMs: 0, account, chainHex, listeners: {} });
    const call = async (method, params) => {
      const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }) }).then((x) => x.json());
      if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
      return r.result;
    };
    const provider = {
      request: async ({ method, params }) => {
        if (tw.delayMs) await new Promise((r) => setTimeout(r, tw.delayMs));
        if (method === "eth_requestAccounts") {
          if (tw.rejectNext) { tw.rejectNext = false; throw Object.assign(new Error("User rejected the request."), { code: 4001 }); }
          tw.connected = true;
          return [tw.account];
        }
        if (method === "eth_accounts") return tw.connected ? [tw.account] : [];
        if (method === "eth_chainId") return tw.chainHex;
        if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
        if (!tw.connected && /^(eth_sendTransaction|personal_sign|eth_signTypedData)/.test(method)) throw Object.assign(new Error("Wallet is disconnected"), { code: 4100 });
        if (tw.rejectNext && /^(eth_sendTransaction|personal_sign|eth_signTypedData)/.test(method)) { tw.rejectNext = false; throw Object.assign(new Error("User rejected the request."), { code: 4001 }); }
        // anvil's dev accounts are unlocked: eth_sendTransaction and personal_sign go straight through
        if (method === "eth_sendTransaction") params = [{ ...params[0], from: tw.account }];
        return call(method, params ?? []);
      },
      on(ev, fn) { (tw.listeners[ev] ??= []).push(fn); },
      removeListener(ev, fn) { tw.listeners[ev] = (tw.listeners[ev] ?? []).filter((f) => f !== fn); },
    };
    tw.emit = (ev, arg) => (tw.listeners[ev] ?? []).forEach((f) => { try { f(arg); } catch {} });
    const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: { uuid: "test", name: "Test Wallet", icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>", rdns: "test.wallet" }, provider } }));
    window.addEventListener("eip6963:requestProvider", announce);
    announce();
  }, { rpc: stack.rpcUrl, account, chainHex: "0x" + ELYSIUM_TESTNET_ID.toString(16) });
  return { page, context, errors, account };
}

export async function setWallet(page, patch) {
  await page.evaluate((p) => {
    const tw = window.__tw;
    const wasConnected = tw.connected;
    Object.assign(tw, p);
    if ("connected" in p && p.connected !== wasConnected) tw.emit("accountsChanged", p.connected ? [tw.account] : []);
    if ("account" in p) tw.emit("accountsChanged", [p.account]);
    if ("chainHex" in p) tw.emit("chainChanged", p.chainHex);
  }, patch);
}

/** Screenshot to docs/stress/shots/<name>.png (full page by default). */
export async function shot(page, name, full = true) {
  const p = join(SHOTS, `${name}.png`);
  await page.screenshot({ path: p, fullPage: full }).catch(() => {});
  return `docs/stress/shots/${name}.png`;
}

/** Dismiss the first-visit welcome and the checklist, if shown. */
export async function dismissIntro(page) {
  const enter = page.getByRole("button", { name: "Enter the app" });
  if (await enter.isVisible({ timeout: 4000 }).catch(() => false)) await enter.click();
  const later = page.getByRole("button", { name: "Don't show again" });
  if (await later.isVisible({ timeout: 2500 }).catch(() => false)) await later.click();
}

/** Connect the test wallet and unlock the private account (on /app). Returns the cloak: address. */
export async function connectAndUnlock(page, site, { timeout = 180_000 } = {}) {
  if (!page.url().startsWith(site + "/app")) await page.goto(`${site}/app`);
  const copy = page.getByRole("button", { name: /Copy cloak address/ });
  const unlockBtn = page.getByRole("button", { name: /^Unlock private account/ }).first();
  const t0 = Date.now();
  // on a cold fork the welcome can appear late and cover the button; after a reload the wallet may still be connected
  for (let i = 0; Date.now() - t0 < timeout; i++) {
    await dismissIntro(page);
    if (await copy.isVisible().catch(() => false)) break;
    if (await unlockBtn.isVisible().catch(() => false)) { await unlockBtn.click().catch(() => {}); await copy.waitFor({ timeout: 20_000 }).catch(() => {}); continue; }
    const tw = page.getByRole("button", { name: /Test Wallet/ });
    if (await tw.isVisible().catch(() => false)) { await tw.click().catch(() => {}); await page.waitForTimeout(1500); continue; }
    await page.getByRole("button", { name: "Connect wallet" }).first().click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }
  await copy.waitFor({ timeout: 5_000 });
  return copy.getAttribute("title");
}

/** Visible error/notice texts on the page right now (error banners, toasts, inline errors). */
export async function visibleErrors(page) {
  return page.evaluate(() => {
    const sel = [".errmsg", ".err", ".error", ".banner", ".toast", "[role=alert]", ".warnmsg", ".field-err", ".hint.warn", ".bad"];
    const out = new Set();
    for (const s of sel) for (const el of document.querySelectorAll(s)) { const t = el.innerText?.trim(); if (t && el.offsetParent !== null) out.add(t.slice(0, 300)); }
    return [...out];
  });
}

/** Horizontal overflow check for phone layouts: elements wider than the viewport. */
export async function overflow(page) {
  return page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    const sw = document.documentElement.scrollWidth;
    const wide = [];
    if (sw > w + 1)
      for (const el of document.querySelectorAll("body *")) {
        const r = el.getBoundingClientRect();
        if (r.right > w + 2 && r.width > 0 && getComputedStyle(el).position !== "fixed") {
          const id = el.tagName.toLowerCase() + (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "");
          wide.push(`${id} right=${Math.round(r.right)} '${(el.innerText || "").slice(0, 40).replace(/\n/g, " ")}'`);
          if (wide.length > 6) break;
        }
      }
    return { clientWidth: w, scrollWidth: sw, wide };
  });
}
