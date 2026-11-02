// Walkthrough recorder: a scripted browser with a stand-in EIP-1193 wallet backed by a demo key (testnet only).
// Usage: put a funded testnet key in $DEMO_DIR/demo.key, run friend.mjs once, generate voice clips into $DEMO_DIR/vo,
// then `node e2e/demo/record.mjs` (ONLY=1 for a dry run that moves no money).
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, numberToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { elysiumTestnet } from "@cloakely/sdk";
import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const { chromium } = (() => { try { return req("playwright"); } catch { return req(process.env.PLAYWRIGHT_PATH || "/opt/node-tools/node_modules/playwright/index.js"); } })();
// working folder for the demo key, voice clips, frames and timeline (never committed)
export const DIR = (process.env.DEMO_DIR || new URL("./out/", import.meta.url).pathname).replace(/\/?$/, "/");
const account = privateKeyToAccount(readFileSync(DIR + "demo.key", "utf8").trim());
const pub = createPublicClient({ chain: elysiumTestnet, transport: http() });
const wal = createWalletClient({ chain: elysiumTestnet, transport: http(), account });
export const demoAddress = account.address;
export const walletLog = [];
export const hooks = { beforeWallet: null };

async function handle(method, params = []) {
  walletLog.push({ t: Date.now(), method });
  if (hooks.beforeWallet && ["eth_requestAccounts", "personal_sign", "eth_signTypedData_v4", "eth_sendTransaction"].includes(method)) await hooks.beforeWallet(method, params);
  switch (method) {
    case "eth_requestAccounts": case "eth_accounts": return [account.address];
    case "eth_chainId": return numberToHex(elysiumTestnet.id);
    case "net_version": return String(elysiumTestnet.id);
    case "wallet_switchEthereumChain": case "wallet_addEthereumChain": return null;
    case "personal_sign": return account.signMessage({ message: { raw: params[0] } });
    case "eth_signTypedData_v4": { const td = typeof params[1] === "string" ? JSON.parse(params[1]) : params[1]; const { EIP712Domain, ...types } = td.types; return account.signTypedData({ domain: td.domain, types, primaryType: td.primaryType, message: td.message }); }
    case "eth_sendTransaction": { const tx = params[0]; return wal.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : 0n, gas: tx.gas ? BigInt(tx.gas) : undefined }); }
    default: return pub.request({ method, params });
  }
}

export async function open({ record = false, base = "https://cloak.boblabs.tech", headless = true } = {}) {
  const browser = await chromium.launch({ headless });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, colorScheme: "light", ...(record ? { recordVideo: { dir: DIR + "rec", size: { width: 1920, height: 1080 } } } : {}) });
  await ctx.exposeBinding("__wallet", async (_s, method, params) => {
    try { return { ok: await handle(method, params) }; } catch (e) { return { err: { message: e.shortMessage || e.message, code: e.code } }; }
  });
  await ctx.addInitScript(() => {
    const listeners = {};
    window.ethereum = {
      isDemo: true,
      request: async ({ method, params }) => {
        const r = await window.__wallet(method, params ?? []);
        if (r.err) { const e = new Error(r.err.message); e.code = r.err.code; throw e; }
        return r.ok;
      },
      on: (ev, fn) => ((listeners[ev] ??= []).push(fn)),
      removeListener: (ev, fn) => (listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn)),
    };
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(240000);
  return { browser, ctx, page, base };
}
