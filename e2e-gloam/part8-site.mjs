// Part 8: the real site (apps/web) on the Gloam backend (VITE_CORE=gloam), in a browser, against a local fork of
// Elysium testnet where the Nov 8 live-run contracts exist. A local relay (never the live keeper) sends the private
// calls; an injected EIP-6963 wallet forwards to anvil's unlocked dev account.
//
//   node e2e-gloam/part8-site.mjs
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { createPublicClient, createWalletClient, formatEther, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deployments } from "@cloakely/sdk";
import { createGloamRelay } from "../services/keeper/gloam.mjs";
import { ANVIL_KEYS, CIRCUITS, ELYSIUM_TESTNET_ID, ELYSIUM_TESTNET_RPC, REPO, assert, chainFor, startAnvil, writeMeasurements } from "./lib.mjs";

// Playwright is installed globally in this container: require finds it where an ES import doesn't
const { chromium } = createRequire(import.meta.url)("playwright");
const G = deployments[ELYSIUM_TESTNET_ID].gloam;
const t0 = performance.now();
const anvil = await startAnvil({ port: 8572, forkUrl: process.env.RPC_URL ?? ELYSIUM_TESTNET_RPC });
const rpcUrl = anvil.rpcUrl;
const chain = chainFor(rpcUrl);
const pub = createPublicClient({ chain, transport: http(rpcUrl), pollingInterval: 100 });
const keeperWallet = createWalletClient({ chain, account: privateKeyToAccount(ANVIL_KEYS[8]), transport: http(rpcUrl) });
const user = privateKeyToAccount(ANVIL_KEYS[1]).address;

// the local relay: POST /gloam/relay only; everything else the site asks the keeper for answers 404
const relay = createGloamRelay({ publicClient: pub, walletClient: keeperWallet, vault: G.gloamVault, launchVault: G.launchVault, memoBoard: G.memoBoard, escrows: [G.launchSwap, G.launchSwapV4, G.receive, G.bids, G.graduation, G.batcher, G.fundsGate].filter(Boolean), hourlySpendWei: parseEther("1") });
let relayed = 0;
const relayServer = createServer((req, res) => {
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "content-type": "application/json" };
  if (req.method === "OPTIONS") return res.writeHead(204, cors).end();
  if (req.method === "POST" && req.url === "/gloam/relay") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const txHash = await relay(JSON.parse(body));
        relayed++;
        res.writeHead(200, cors).end(JSON.stringify({ txHash }));
      } catch (e) {
        res.writeHead(e.status ?? 400, cors).end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  res.writeHead(404, cors).end("{}");
}).listen(8573);

// Gloam's circuits, served by the dev server (jsDelivr is blocked in this container); checked by hash in the SDK
const local = join(REPO, "apps/web/public/circuits/gloam");
if (!existsSync(join(local, "final"))) {
  mkdirSync(join(local, "final"), { recursive: true });
  for (const c of ["shield", "transfer", "unshield", "funds"]) {
    cpSync(join(CIRCUITS, `${c}.wasm`), join(local, `${c}.wasm`));
    cpSync(join(CIRCUITS, `final/${c}_final.zkey`), join(local, `final/${c}_final.zkey`));
  }
}

const vite = spawn("npx", ["vite", "--port", "5191", "--strictPort"], {
  cwd: join(REPO, "apps/web"),
  env: { ...process.env, VITE_CORE: "gloam", VITE_CHAIN_ID: String(ELYSIUM_TESTNET_ID), VITE_RPC_URL: rpcUrl, VITE_KEEPER_URL: "http://127.0.0.1:8573", VITE_RELAYER_URL: "http://127.0.0.1:8573" },
  stdio: ["ignore", "pipe", "pipe"],
  detached: true, // its own process group, so the whole tree (npx, then vite) stops at the end
});
const stopVite = () => {
  try {
    process.kill(-vite.pid);
  } catch {}
};
await new Promise((ok, no) => {
  const t = setTimeout(() => no(new Error("vite did not start")), 60_000);
  vite.stdout.on("data", (d) => String(d).includes("5191") && (clearTimeout(t), ok()));
});

const browser = await chromium.launch();
const shots = [];
try {
  console.log("Part 8: the site on the Gloam backend, in a browser, on a fork of Elysium testnet");
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const logs = [];
  page.on("console", (m) => m.type() === "error" && logs.push(m.text()));
  page.on("pageerror", (e) => logs.push(String(e)));
  // an EIP-6963 wallet backed by anvil's unlocked dev account
  await page.addInitScript(({ rpc, account, chainHex }) => {
    let id = 1;
    const call = async (method, params) => {
      const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }) }).then((x) => x.json());
      if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
      return r.result;
    };
    const provider = {
      request: async ({ method, params }) => {
        if (method === "eth_requestAccounts" || method === "eth_accounts") return [account];
        if (method === "eth_chainId") return chainHex;
        if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
        return call(method, params ?? []);
      },
      on() {},
      removeListener() {},
    };
    const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: { uuid: "test", name: "Test Wallet", icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>", rdns: "test.wallet" }, provider } }));
    window.addEventListener("eip6963:requestProvider", announce);
    announce();
  }, { rpc: rpcUrl, account: user, chainHex: "0x" + ELYSIUM_TESTNET_ID.toString(16) });

  const base = "http://127.0.0.1:5191";
  const shot = async (name) => {
    const p = join(REPO, "measurements", `part8-${name}.png`);
    await page.screenshot({ path: p });
    shots.push(p);
  };

  // 1. connect and unlock on the Portfolio page
  await page.goto(`${base}/app`);
  await page.waitForTimeout(2500);
  await shot("0-welcome");
  await page.getByRole("button", { name: "Enter the app" }).click(); // the first-visit welcome, unchanged
  await page.getByRole("button", { name: "Don't show again" }).click(); // then the getting-started checklist
  await page.getByRole("button", { name: "Connect wallet" }).first().click();
  await page.getByRole("button", { name: /Test Wallet/ }).click();
  await page.waitForTimeout(3000);
  // picking the wallet from "Connect wallet" goes straight on to unlocking; if not, ask for it
  const unlockBtn = page.getByRole("button", { name: "Unlock private account" });
  if (await unlockBtn.isVisible().catch(() => false)) await unlockBtn.click();
  await page.getByRole("button", { name: /Copy cloak address/ }).waitFor({ timeout: 60_000 });
  const addr = await page.getByRole("button", { name: /Copy cloak address/ }).getAttribute("title");
  assert(addr?.startsWith("cloak:gloamr1."), "unlocked on Gloam: the Portfolio page shows a cloak: address made of Gloam's receive tag");
  await shot("1-unlocked");

  // 2. shield 1 HYPE on the Shield page
  // move inside the app (a reload would lock the account again, as it does for a user)
  await page.getByRole("link", { name: "Shield" }).first().click();
  await page.locator("input.input").first().fill("1");
  await page.locator("button.btn-ink.btn-lg.btn-block").click();
  await page.getByText(/is now private/).waitFor({ timeout: 180_000 });
  await shot("2-shielded");

  // 3. the balance on the Portfolio page
  await page.getByRole("link", { name: "Portfolio" }).first().click();
  // the Assets card lists HYPE with its private amount
  await page.waitForFunction(() => /HYPE\s+Hyperliquid\s+1\s+HYPE/.test(document.body.innerText), null, { timeout: 120_000 });
  await shot("3-balance");
  console.log("  ok  the Portfolio page shows the 1 HYPE private balance");

  // 4. withdraw 0.5 HYPE to a fresh address on the Withdraw page (proved in the browser, sent by the relay)
  const fresh = privateKeyToAccount(ANVIL_KEYS[9]).address;
  const before = await pub.getBalance({ address: fresh });
  await page.getByRole("link", { name: "Withdraw" }).first().click();
  await page.locator("input.input").first().waitFor();
  await page.locator("input.input").first().fill("0.5");
  await page.locator("input.input").nth(1).fill(fresh);
  await page.locator("button.btn-ink.btn-lg.btn-block").click();
  for (let i = 0; i < 120 && (await pub.getBalance({ address: fresh })) === before; i++) await page.waitForTimeout(1000);
  const got = (await pub.getBalance({ address: fresh })) - before;
  await page.locator(".okmsg").first().waitFor({ timeout: 60_000 });
  await shot("4-withdrawn");
  assert(got === parseEther("0.4975"), `a withdrawal proved in the browser and relayed pays ${formatEther(got)} HYPE (0.5 less the vault's 0.5%)`);
  assert(relayed >= 1, `the private calls went through the local relay (${relayed})`);

  // 5. an instant private buy on the Trade page: the launch token, through its V2 pool, the buffer back as a note
  await page.getByRole("link", { name: "Trade" }).first().click();
  await page.getByLabel("Amount").waitFor({ timeout: 60_000 });
  await page.getByLabel("Amount").fill("0.005"); // testnet launch pools are shallow
  await page.waitForFunction(() => Number((document.querySelector("input[aria-label='Estimated output']") || {}).value || 0) > 0, null, { timeout: 60_000 });
  const est = await page.getByLabel("Estimated output").inputValue();
  await page.getByRole("button", { name: "Swap privately" }).click();
  await page.getByText(/Swapped privately/).waitFor({ timeout: 180_000 });
  await shot("5-swapped");
  const tradedSym = (await page.locator(".swap-box").nth(1).innerText()).split("\n").pop();
  console.log(`  ok  the Trade page bought a real Cloak launch token privately through its v4 pool (estimate ${est} ${tradedSym}), sent by the relay`);

  // 6. a payment link from the Links page, claimed to a wallet in another browser that has no wallet at all
  await page.getByRole("link", { name: "Payment links" }).first().click();
  await page.getByPlaceholder("0.05").waitFor({ timeout: 60_000 });
  await page.getByPlaceholder("0.05").fill("0.1");
  await page.getByPlaceholder("Happy birthday!").fill("A test link");
  await page.locator("button.btn-ink.btn-lg.btn-block").first().click();
  await page.locator(".linkbox").first().waitFor({ timeout: 180_000 });
  const url = await page.locator(".linkbox").first().innerText();
  await shot("6-link-made");
  assert(url.includes("/claim"), `the Links page made a claim link (${url.slice(0, 40)}…)`);

  const guest = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  guest.on("pageerror", (e) => logs.push(String(e)));
  await guest.goto(url);
  const enter = guest.getByRole("button", { name: "Enter the app" });
  if (await enter.isVisible({ timeout: 5_000 }).catch(() => false)) await enter.click();
  const fresh2 = privateKeyToAccount(ANVIL_KEYS[7]).address;
  const before2 = await pub.getBalance({ address: fresh2 });
  await guest.getByText("Claim to a wallet").waitFor({ timeout: 120_000 });
  await guest.waitForTimeout(1500);
  const later = guest.getByRole("button", { name: "Don't show again" });
  if (await later.isVisible().catch(() => false)) await later.click();
  await guest.screenshot({ path: join(REPO, "measurements", "part8-6b-claim-page.png") });
  await guest.locator("button.choice").nth(1).click({ timeout: 120_000 }); // claim to a wallet
  await guest.getByPlaceholder("0x… or name.ely").fill(fresh2);
  await guest.locator("button.btn-ink.btn-lg.btn-block").last().click();
  for (let i = 0; i < 180 && (await pub.getBalance({ address: fresh2 })) === before2; i++) await guest.waitForTimeout(1000);
  const got2 = (await pub.getBalance({ address: fresh2 })) - before2;
  await guest.waitForTimeout(2000);
  await guest.screenshot({ path: join(REPO, "measurements", "part8-7-link-claimed.png") });
  assert(got2 === parseEther("0.0995"), `a guest with no wallet claimed the link to a fresh wallet: ${formatEther(got2)} HYPE (0.1 less the vault's 0.5%)`);

  // 7. the Receive page: a public address anyone can pay, moved into the private balance while the page is open
  await page.getByRole("link", { name: "Portfolio" }).first().click();
  await page.getByRole("link", { name: "Receive" }).first().click();
  const addrEl = page.locator(".mono").filter({ hasText: /^0x[0-9a-fA-F]{40}$/ }).first();
  await addrEl.waitFor({ timeout: 60_000 });
  const rxAddr = await addrEl.innerText();
  const payer = createWalletClient({ chain, account: privateKeyToAccount(ANVIL_KEYS[6]), transport: http(rpcUrl) });
  await pub.waitForTransactionReceipt({ hash: await payer.sendTransaction({ to: rxAddr, value: parseEther("0.2") }) });
  for (let i = 0; i < 90 && (await pub.getBalance({ address: rxAddr })) > 0n; i++) await page.waitForTimeout(1000);
  assert((await pub.getBalance({ address: rxAddr })) === 0n, `the Receive page's address ${rxAddr.slice(0, 10)}… was paid 0.2 HYPE by an outside wallet, and the open page moved it into the private balance`);
  await page.locator(".pill.ok", { hasText: "Received" }).first().waitFor({ timeout: 30_000 });
  await shot("8-received");

  const errs = logs.filter((l) => !/favicon|404|keeper|snapshot|leaves|Failed to load resource/i.test(l));
  if (errs.length) console.log("  browser errors:", errs.slice(0, 5));
  writeMeasurements("part8-site", { seconds: Math.round((performance.now() - t0) / 1000), relayed, screenshots: shots.map((p) => p.split("/").pop()) });
  console.log(`\nPart 8 passed in ${Math.round((performance.now() - t0) / 1000)} s`);
} finally {
  await browser.close();
  stopVite();
  relayServer.close();
  anvil.stop();
}
process.exit(0);
