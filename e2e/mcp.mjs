// The MCP server end to end, on a local chain with REAL Groth16 proofs: an agent drives @cloakely/mcp over stdio
// (the way Claude or Cursor would) to create a launch, place a sealed bid, claim, enable private trading, shield HYPE
// and USDC, trade privately, place a batch order, pay a second agent privately and withdraw, with the keeper
// revealing, settling and relaying. Also checks spending limits, dry runs and read-only mode.
//   anvil --balance 1000000 --block-time 1 & ; node e2e/mcp.mjs   (needs `forge build` for the MockUSDC artifact)
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServer } from "node:http";
import { loadSettings } from "@cloakely/mcp";
import { handleMcpRequest } from "@cloakely/mcp/http";
import { anvilLocal, cloakConfigAbi, privateRouterAbi, shieldedPoolAbi } from "@cloakely/sdk";
import { bytecode } from "@cloakely/sdk/bytecode";
import { assetVault, clients, deployBatcher, deployFactory, deployPrivacy, exempt, parseEther, register, sleep } from "./lib.mjs";

const RPC = "http://127.0.0.1:8545";
const chain = anvilLocal;
const PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const KEEPER_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const root = new URL("..", import.meta.url).pathname;
let checks = 0;
const ok = (c, m) => {
  if (!c) throw new Error(`✗ ${m}`);
  checks++;
  console.log(`  ✓ ${m}`);
};
const d = clients(chain, RPC, PK);
const send = async (p) => d.publicClient.waitForTransactionReceipt({ hash: await p });
const mock = JSON.parse(readFileSync(`${root}contracts/out/MockUSDC.sol/MockUSDC.json`, "utf8"));

console.log("deploy: config, factory, router, batcher, USDC and its vault");
const f = await deployFactory(d.publicClient, d.walletClient, { rules: { withdrawFeeBps: 25, launchFeeBps: 150 } });
const r = await deployPrivacy(d.publicClient, d.walletClient, f.factory, { config: f.config });
const b = await deployBatcher(d.publicClient, d.walletClient, r.router, { roundSecs: 8, maxSlippageBps: 200, refundAfter: 600 });
await register(d.publicClient, d.walletClient, f.config, "batcher", b.batcher, 4, b.block);
await exempt(d.publicClient, d.walletClient, f.config, [r.router, b.batcher]);
const usdc = (await send(d.walletClient.deployContract({ abi: mock.abi, bytecode: mock.bytecode.object }))).contractAddress;
const usdcPool = await assetVault(d.publicClient, d.walletClient, f.config, r.vaults, usdc);
const [hypePool, whype] = await Promise.all(["hypePool", "whype"].map((fn) => d.publicClient.readContract({ address: r.router, abi: privateRouterAbi, functionName: fn })));
await send(d.walletClient.writeContract({ address: f.config, abi: cloakConfigAbi, functionName: "turnOnDepositLimits" }));
await send(d.walletClient.writeContract({ address: f.config, abi: cloakConfigAbi, functionName: "setLimit", args: [whype, parseEther("100"), parseEther("10000")] }));
await send(d.walletClient.writeContract({ address: f.config, abi: cloakConfigAbi, functionName: "setLimit", args: [usdc, 1_000_000_000n, 50_000_000_000n] }));
await send(d.walletClient.writeContract({ address: f.config, abi: cloakConfigAbi, functionName: "setAuctionLimit", args: [parseEther("100"), parseEther("10000")] }));
await send(d.walletClient.writeContract({ address: f.config, abi: cloakConfigAbi, functionName: "setDefaultLimit", args: [10000n, 10000n] })); // so a winner's whole allocation can be claimed privately

const PORT = "3997";
const keeper = spawn(process.execPath, [`${root}services/keeper/index.mjs`], {
  env: { ...process.env, RPC_URL: RPC, KEEPER_PK, CONFIG: f.config, CLAIM_DELAY: "600", HYPE_USD: "25", HYPE_PRICE_URL: "http://127.0.0.1:9/", PORT, POLL_MS: "1000", RELAY_PER_MIN: "1000" },
  stdio: ["ignore", process.env.KEEPER_LOG ? "inherit" : "ignore", "inherit"],
});
for (let i = 0; i < 50; i++) {
  if (await fetch(`http://127.0.0.1:${PORT}/health`).then((x) => x.ok, () => false)) break;
  await sleep(200);
}

const dir = mkdtempSync(join(tmpdir(), "cloak-mcp-e2e-"));
const deploymentFile = join(dir, "deployment.json");
writeFileSync(deploymentFile, JSON.stringify({ chainId: chain.id, rpcUrl: RPC, config: f.config, factory: f.factory, router: r.router, routerBlock: r.block.toString(), vaultsBlock: r.vaultsBlock.toString(), batcher: b.batcher, hypePool, whype, relayerUrl: `http://127.0.0.1:${PORT}`, circuitsUrl: "", launchesFromBlock: 0, assets: [{ symbol: "USDC", token: usdc, pool: usdcPool, decimals: 6, fromBlock: r.vaultsBlock.toString() }] }));

/** An agent: the MCP server as a child process, with its own key, state directory and limits. */
async function agent(name, key, extra = {}) {
  const env = { ...process.env, CLOAK_DEPLOYMENT_FILE: deploymentFile, CLOAK_CIRCUITS_DIR: `${root}apps/web/public/circuits`, CLOAK_STATE_DIR: join(dir, name), CLOAK_MAX_HYPE_PER_TX: "30", CLOAK_MAX_HYPE_PER_DAY: "60", ...extra };
  if (key) env.CLOAK_PRIVATE_KEY = key;
  const client = new Client({ name: `e2e-${name}`, version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [`${root}packages/mcp/dist/index.js`], env, stderr: "ignore" }));
  const call = async (tool, args = {}) => {
    const res = await client.callTool({ name: tool, arguments: args });
    const text = res.content[0].text;
    if (res.isError) return { error: text };
    return JSON.parse(text);
  };
  return { client, call };
}
const funded = async (eth) => {
  const k = generatePrivateKey();
  await send(d.walletClient.sendTransaction({ to: privateKeyToAccount(k).address, value: parseEther(eth) }));
  return k;
};
const num = (s) => Number(String(s).split(" ")[0]);

const aliceKey = await funded("100");
const alice = privateKeyToAccount(aliceKey).address;
await send(d.walletClient.writeContract({ address: usdc, abi: mock.abi, functionName: "mint", args: [alice, 500_000_000n] }));
const A = await agent("alice", aliceKey);
const B = await agent("bob", await funded("1"));
const R = await agent("reader");

// the hosted link, served over HTTP the way the site serves https://cloak.boblabs.tech/mcp
const hostedSettings = loadSettings({ CLOAK_DEPLOYMENT_FILE: deploymentFile, CLOAK_PRIVATE_KEY: aliceKey });
const web = createServer(async (req, res) => {
  const body = [];
  for await (const c of req) body.push(c);
  const r = await handleMcpRequest(new Request(`http://127.0.0.1:3995${req.url}`, { method: req.method, headers: req.headers, body: ["GET", "OPTIONS"].includes(req.method) ? undefined : Buffer.concat(body) }), { settings: hostedSettings });
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(3995);
const H = { client: new Client({ name: "e2e-hosted", version: "0" }) };
await H.client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:3995/mcp")));
H.call = async (tool, args = {}) => {
  const res = await H.client.callTool({ name: tool, arguments: args });
  return res.isError ? { error: res.content[0].text } : JSON.parse(res.content[0].text);
};
try {
  const { tools } = await A.client.listTools();
  ok(tools.length === 18, `the server offers ${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`);
  const info = await A.call("cloak_info");
  ok(info.mode === "read and write" && info.wallet.address === alice && info.limits.hype.perTransaction === "30 HYPE", "cloak_info: wallet, public balances and limits (30 HYPE per transaction, 60 a day)");
  const ro = await R.call("shield", { asset: "HYPE", amount: "1" });
  ok(/No wallet configured/.test(ro.error) && (await R.call("cloak_info")).mode.startsWith("read only"), "without a key the server is read only, and write tools say why");

  // ── launch ──
  const plan = await A.call("create_launch", { name: "Ember", symbol: "EMBR", sale_supply: "1000000", min_price: "0.000001", price_ticks: 50, bidding_minutes: 0.25, reveal_minutes: 1, lp_percent: 80, dry_run: true });
  ok(plan.dryRun && plan.wouldCreate.topPrice === "0.00005 HYPE per token", "dry run of create_launch describes the launch without sending anything");
  const launch = await A.call("create_launch", { name: "Ember", symbol: "EMBR", sale_supply: "1000000", min_price: "0.000001", price_ticks: 50, bidding_minutes: 0.25, reveal_minutes: 1, lp_percent: 80 });
  ok(launch.created && launch.auction, `create_launch: ${launch.auction ?? launch.error}`);
  const hostedTools = (await H.client.listTools()).tools.map((t) => t.name);
  ok(hostedTools.length === 8 && !hostedTools.some((t) => ["create_launch", "place_sealed_bid", "my_bids", "claim", "enable_private_trading", "unlock", "private_balance", "shield", "private_swap", "batch_order", "private_send", "withdraw"].includes(t)), `the hosted link offers read and plan tools only: ${hostedTools.join(", ")}`);
  const hi = await H.call("cloak_info");
  ok(/never signs/.test(hi.mode) && !hi.wallet, "the hosted link has no wallet, even when the environment it runs in holds a key");
  ok(/never takes private keys/.test((await H.call("get_launch", { auction: aliceKey })).error), "the hosted link refuses a call that carries a private key");
  ok((await H.call("get_launch", { auction: launch.auction })).symbol === "EMBR", "the hosted link reads the launch the agent just created");
  const listed = await R.call("list_launches", { limit: 5 });
  ok(listed.launches[0].symbol === "EMBR" && listed.launches[0].phase === "commit", "list_launches shows it, in the commit phase");
  const q = await A.call("quote_bid", { auction: launch.auction, max_price: "0.00002", quantity: "1000000" });
  ok(q.cost === "20 HYPE" && q.deposit === "20 HYPE", `quote_bid: ${q.cost} at ${q.price}, deposit ${q.deposit}`);
  const nonce = await d.publicClient.getTransactionCount({ address: alice });
  const dryBid = await A.call("place_sealed_bid", { auction: launch.auction, max_price: "0.00002", quantity: "1000000", dry_run: true });
  ok(dryBid.dryRun && (await d.publicClient.getTransactionCount({ address: alice })) === nonce, "dry-run bid sends nothing");
  const bid = await A.call("place_sealed_bid", { auction: launch.auction, max_price: "0.00002", quantity: "1000000" });
  ok(bid.placed && bid.deposit === "20 HYPE", `place_sealed_bid: sealed bid #${bid.bidId}, 20 HYPE deposit`);
  const hidden = await R.call("get_launch", { auction: launch.auction });
  ok(/hidden/.test(hidden.demand) && hidden.bids === 1, "get_launch: one bid, demand hidden while bidding is open");

  console.log("    · waiting for bidding to close, the drand round, and the keeper to reveal and settle…");
  let st;
  for (let i = 0; i < 90; i++) {
    st = await R.call("get_launch", { auction: launch.auction });
    if (st.phase === "settled") break;
    await sleep(2000);
  }
  ok(st.phase === "settled" && st.clearingPrice === "0.00002 HYPE per token", `the keeper opened the bid and settled at ${st.clearingPrice}, no action from the agent`);
  let vaultOpen = false;
  for (let i = 0; i < 10 && !vaultOpen; i++) {
    vaultOpen = !!(await A.call("enable_private_trading", { auction: launch.auction, dry_run: true })).alreadyOn;
    if (!vaultOpen) await sleep(1000);
  }
  ok(vaultOpen, "the keeper opened the launch's private vault at settlement");
  const claim = await A.call("claim", { auction: launch.auction });
  ok(num(claim.tokensWon) === 1_000_000 && claim.claimedPrivately?.length === 1, `claim: ${claim.tokensWon} EMBR won, claimed straight into the private balance`);
  const embr = (await d.publicClient.readContract({ address: launch.token ?? (await R.call("get_launch", { auction: launch.auction })).token, abi: mock.abi, functionName: "balanceOf", args: [alice] }).catch(() => 0n));
  ok(embr === 0n && num(Object.values((await A.call("private_balance")).launchTokens)[0]?.balance ?? 0) === 1_000_000, "the wallet holds no EMBR: all 1,000,000 are private");
  const mine = await A.call("my_bids", { auction: launch.auction });
  ok(mine.bids[0].opened && mine.bids[0].claimed, "my_bids: opened and claimed");

  // ── private trading ──
  const over = await A.call("shield", { asset: "HYPE", amount: "31" });
  ok(/over the 30 HYPE allowed per transaction/.test(over.error), "a 31 HYPE shield is refused by the per-transaction limit");
  const sh = await A.call("shield", { asset: "HYPE", amount: "10" });
  ok(sh.privateBalance === "10 HYPE", "shield: 10 HYPE now private");
  const unlocked = await A.call("unlock");
  ok(unlocked.cloakAddress.startsWith("cloak:"), "unlock returns the private account's cloak: address");
  const quote = await A.call("quote_swap", { token: "EMBR", side: "buy", amount: "1" });
  const buy = await A.call("private_swap", { token: "EMBR", side: "buy", amount: "1" });
  ok(buy.sentBy && num(buy.privateBalance.EMBR) > 0 && num(buy.privateBalance.EMBR) >= num(quote.expectedOut) * 0.99, `private_swap buy: 1 HYPE → ${buy.privateBalance.EMBR} private EMBR (quoted ${quote.expectedOut})`);
  const tx = await d.publicClient.getTransaction({ hash: buy.tx });
  ok(tx.from.toLowerCase() === privateKeyToAccount(KEEPER_PK).address.toLowerCase() && !tx.input.toLowerCase().includes(alice.slice(2).toLowerCase()), "the buy was sent by the relayer, and the agent's wallet appears nowhere in it");
  const sell = await A.call("private_swap", { token: "EMBR", side: "sell", amount: "max" });
  ok(num(sell.privateBalance.EMBR) < num(buy.privateBalance.EMBR) * 0.01 && num(sell.privateBalance.HYPE) > 9.9, `private_swap sell max: back to ${sell.privateBalance.HYPE} private HYPE`);

  const before = (await A.call("private_balance", { include_zero: true })).launchTokens;
  const batch = await A.call("batch_order", { token: "EMBR", side: "buy", amount: "0.2" });
  ok(batch.placed.length >= 1, `batch_order: ${batch.placed.map((o) => o.size).join(" + ")} HYPE in standard sizes`);
  let filled = 0;
  const startTok = num(Object.values(before)[0]?.balance ?? 0);
  for (let i = 0; i < 30 && filled <= startTok; i++) {
    await sleep(2000);
    filled = num(Object.values((await A.call("private_balance")).launchTokens)[0]?.balance ?? 0);
  }
  ok(filled > startTok, `the keeper settled the round: ${filled} private EMBR`);

  // ── pay another agent privately, then withdraw ──
  const bobAddr = (await B.call("unlock")).cloakAddress;
  const paid = await A.call("private_send", { asset: "HYPE", to: bobAddr, amount: "0.5" });
  ok(paid.sent === "0.5 HYPE", "private_send: 0.5 HYPE to the second agent's cloak: address");
  ok((await B.call("private_balance")).balances.HYPE === "0.5", "the second agent sees 0.5 private HYPE");
  const fresh = privateKeyToAccount(generatePrivateKey()).address;
  const w = await B.call("withdraw", { asset: "HYPE", to: fresh, amount: "0.2" });
  ok(w.arrived === "0.1995 HYPE" && (await d.publicClient.getBalance({ address: fresh })) === parseEther("0.1995"), "withdraw: 0.1995 HYPE arrived at a fresh address (0.25% kept)");

  // ── USDC ──
  const su = await A.call("shield", { asset: "USDC", amount: "50" });
  ok(su.privateBalance === "50 USDC", `shield: 50 USDC now private (approve, then deposit): ${JSON.stringify(su).slice(0, 300)}`);
  const pu = await A.call("private_send", { asset: "USDC", to: bobAddr, amount: "20" });
  ok(pu.sent === "20 USDC" && (await B.call("private_balance")).balances.USDC === "20", "private_send: 20 USDC to the second agent, fee paid in USDC");
  const wu = await B.call("withdraw", { asset: "USDC", to: fresh, amount: "max" });
  ok(/USDC/.test(wu.arrived) && num(wu.privateBalance) < 0.1, `withdraw max: ${wu.arrived} landed at the fresh address`);
  const noSwap = await A.call("private_swap", { token: "USDC", side: "buy", amount: "1" });
  ok(/isn't a launch token/.test(noSwap.error), "USDC swaps are refused with a clear reason (not live yet)");

  // ── limits over the day ──
  const lim = (await A.call("cloak_info")).limits.hype;
  ok(num(lim.usedToday) > 32 && num(lim.leftToday) < 28, `cloak_info tracks today's spend: ${lim.usedToday} used, ${lim.leftToday} left`);
  const day = await A.call("shield", { asset: "HYPE", amount: "29" });
  ok(/daily limit/.test(day.error), "a shield that would pass the 60 HYPE daily limit is refused");
  const restarted = await agent("alice", aliceKey);
  ok(/daily limit/.test((await restarted.call("shield", { asset: "HYPE", amount: "29" })).error), "the daily total survives a server restart");
  await restarted.client.close();
  const hv = await H.call("vault_stats");
  ok(hv.vaults.some((v) => v.asset === "EMBR") && hv.vaults.find((v) => v.asset === "USDC").held !== "0 USDC", "vault_stats over the hosted link shows the EMBR and USDC vaults' totals, not who holds them");
  ok((await fetch("http://127.0.0.1:3995/mcp", { headers: { accept: "text/html" }, redirect: "manual" })).headers.get("location") === "https://cloak.boblabs.tech/docs#agents", "opening the link in a browser leads to the setup docs");
} finally {
  for (const x of [A, B, R, H]) await x.client.close().catch(() => {});
  web.close();
  keeper.kill();
}
console.log(`\n${checks} checks passed`);
process.exit(0);
