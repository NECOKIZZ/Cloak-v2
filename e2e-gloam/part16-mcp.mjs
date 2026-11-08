// Part 16: the MCP server (agent tools) on Cloak v2 on Gloam. An agent calls the tools over MCP (in memory, as Claude
// or Cursor would over stdio): unlock, shield HYPE, a private swap with the buffer taken back, a batch order whose
// payout comes back on the next private call, a private send to a second agent, a withdrawal, spending limits and
// dry runs. The relay is the keeper's real Gloam relay behind HTTP (POST /gloam/relay). Anvil, Gloam's final keys.
//
//   node e2e-gloam/part16-mcp.mjs
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEther, parseUnits } from "viem";
import { deployments } from "@cloakely/sdk";
import { createGloamRelay } from "../services/keeper/gloam.mjs";
import { createGloamLoop } from "../services/keeper/gloamLoop.mjs";
import { deployCloakGloam } from "./stack.mjs";
import { ANVIL_KEYS, CIRCUITS, ELYSIUM_TESTNET_ID, REPO, assert, chainFor, clients, rpc, sendAndLog, startAnvil, writeMeasurements } from "./lib.mjs";

const MCP_SDK = `${REPO}/packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm`;
const { Client } = await import(`${MCP_SDK}/client/index.js`);
const { InMemoryTransport } = await import(`${MCP_SDK}/inMemory.js`);
const { createCloakServer } = await import(`${REPO}/packages/mcp/dist/server.js`);

const t0 = performance.now();
const anvil = await startAnvil({ port: 8568 });
const rpcUrl = anvil.rpcUrl;
const who = (i) => clients(rpcUrl, ANVIL_KEYS[i], ELYSIUM_TESTNET_ID);
const [dep, keeper] = [who(0), who(8)];
const pub = dep.pub;
const warp = async (s) => (await rpc(rpcUrl, "evm_increaseTime", [Number(s)]), await rpc(rpcUrl, "evm_mine"));
let http;
try {
  console.log("Part 16 on anvil (chain 99801): the MCP server's tools on Gloam");
  const ROUND = 60n;
  const { contracts: c, block } = await deployCloakGloam({ me: dep, rpcUrl, pk: ANVIL_KEYS[0], roundSecs: ROUND, seed: { hype: parseEther("50"), tokens: parseEther("50000") }, warp });
  const relay = createGloamRelay({ publicClient: pub, walletClient: keeper.wallet, vault: c.gloamVault, launchVault: c.launchVault, memoBoard: c.memoBoard, escrows: [c.launchSwap, c.batcher], hourlySpendWei: parseEther("5") });
  const loop = createGloamLoop({ publicClient: pub, account: keeper.account, send: async (x) => (await sendAndLog(pub, x.functionName, keeper.wallet.writeContract(x))).transactionHash, launchVault: c.launchVault, batcher: c.batcher, batcherBlock: block });
  await loop.tick();

  // the keeper's relay over HTTP, as the MCP server reaches it
  http = createServer((req, res) => {
    let body = "";
    req.on("data", (x) => (body += x));
    req.on("end", async () => {
      try {
        const txHash = await relay(JSON.parse(body), { sender: "mcp" });
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ txHash }));
      } catch (e) {
        res.writeHead(e.status ?? 400, { "content-type": "application/json" }).end(JSON.stringify({ error: e.message }));
      }
    });
  }).listen(8569);

  const D = deployments[ELYSIUM_TESTNET_ID];
  const deployment = {
    ...D,
    factory: c.factoryStandIn,
    earlierFactories: [],
    previous: [],
    relayerUrl: "http://127.0.0.1:8569",
    whype: c.whypeStandIn,
    assets: [{ symbol: "USDC", token: c.usdc, pool: c.gloamVault, decimals: 6, fromBlock: block }],
    gloam: { gloamVault: c.gloamVault, memoBoard: c.memoBoard, launchVault: c.launchVault, block, launchSwap: c.launchSwap, batcher: c.batcher, whype: c.whypeStandIn },
  };
  const settingsFor = (pk) => ({
    network: "custom",
    chain: chainFor(rpcUrl),
    rpcUrl,
    deployment,
    core: "gloam",
    gloamCircuitsDir: CIRCUITS,
    launchesFromBlock: block,
    privateKey: pk,
    dryRun: false,
    stateDir: mkdtempSync(join(tmpdir(), "cloak-mcp-")),
    limits: { hypePerTx: parseEther("5"), hypePerDay: parseEther("20"), usdcPerTx: parseUnits("100", 6), usdcPerDay: parseUnits("1000", 6), launchesPerDay: 3 },
  });
  const connect = async (pk) => {
    const server = createCloakServer(settingsFor(pk));
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "part16", version: "1" });
    await Promise.all([server.connect(a), client.connect(b)]);
    return async (name, args = {}) => {
      const r = await client.callTool({ name, arguments: args });
      const text = r.content?.[0]?.text ?? "";
      if (r.isError) throw new Error(`${name}: ${text}`);
      return JSON.parse(text);
    };
  };
  const agent = await connect(ANVIL_KEYS[3]);
  const other = await connect(ANVIL_KEYS[4]);

  const u = await agent("unlock");
  assert(u.cloakAddress.startsWith("cloak:gloamr1."), `unlock gives the Gloam account's cloak: address (${u.cloakAddress.slice(0, 18)}…)`);

  const dry = await agent("shield", { asset: "HYPE", amount: "3", dry_run: true });
  assert(dry.dryRun === true, "a dry run sends nothing");
  await agent("shield", { asset: "HYPE", amount: "3" });
  const bal = await agent("private_balance");
  assert(bal.balances.HYPE === "3", `shield put 3 HYPE in the private balance (${bal.balances.HYPE})`);

  let refused = "";
  await agent("shield", { asset: "HYPE", amount: "6" }).catch((e) => (refused = e.message));
  assert(/limit|more than|per/i.test(refused), "the spending limit (5 HYPE a call) refuses a 6 HYPE shield");

  const sym = (await agent("private_balance", { include_zero: true })).launchTokens;
  const tokKey = Object.keys(sym)[0];
  assert(!!tokKey, `the admitted launch token is listed (${tokKey})`);
  const token = sym[tokKey].token;
  const q = await agent("private_swap", { token, side: "buy", amount: "0.5", dry_run: true });
  assert(/for about/.test(q.wouldSwap) && /^0(\.0+)? HYPE$/.test(q.relayerFee), `the swap quote shows no relayer fee (${q.wouldSwap})`);
  const sw = await agent("private_swap", { token, side: "buy", amount: "0.5" });
  assert(sw.sentBy.startsWith("the relayer"), `bought privately, sent by the relay (${sw.expected})`);
  const afterSwap = await agent("private_balance");
  const tokBal = Number(afterSwap.launchTokens[tokKey]?.balance ?? 0);
  assert(tokBal > 0 && Number(afterSwap.balances.HYPE) > 2.5, `tokens arrived (${tokBal}) and the price buffer came back (${afterSwap.balances.HYPE} HYPE left of 2.5 + buffer)`);

  // a batch order: the payout comes back on a later private call
  const b = await agent("batch_order", { token, side: "buy", amount: "0.3" });
  assert(b.placed.length === 2, `0.3 HYPE went in as ${b.placed.length} orders`);
  await warp(ROUND + 1n);
  const t = await loop.tick();
  assert(t.rounds.some((r) => r.action === "settled"), "the keeper settled the round");
  const afterBatch = await agent("private_balance");
  assert(Number(afterBatch.launchTokens[tokKey].balance) > tokBal, `the batch payout moved into the private balance on the next call (${afterBatch.launchTokens[tokKey].balance})`);

  // pay a second agent privately
  const to = (await other("unlock")).cloakAddress;
  await agent("private_send", { asset: "HYPE", to, amount: "0.4" });
  const ob = await other("private_balance");
  assert(ob.balances.HYPE === "0.4", `the second agent got 0.4 HYPE privately (${ob.balances.HYPE})`);

  // withdraw to a fresh address
  const dest = "0x000000000000000000000000000000000000c0de";
  const w = await agent("withdraw", { asset: "HYPE", to: dest, amount: "1" });
  assert(w.arrived === "0.995 HYPE" && (await pub.getBalance({ address: dest })) === parseEther("0.995"), `withdrew 1 HYPE, 0.995 arrived (the vault's 0.5%)`);

  // payment links: a locked link in 2 shares, claimed by the second agent into its private balance and to a wallet
  const made = await agent("create_payment_link", { asset: "HYPE", amount: "0.2", shares: 2, passcode: "open sesame", hint: "the magic words" });
  assert(made.link.includes("/claim#") && made.holds.includes("2 shares"), `a locked link in 2 shares (${made.holds})`);
  const chk = await other("check_payment_link", { link: made.link, passcode: "open sesame" });
  assert(chk.holds.HYPE === "0.2 HYPE" && chk.sharesLeft === "2 of 2", `check shows 0.2 HYPE in 2 shares (${chk.holds.HYPE}, ${chk.sharesLeft})`);
  let wrong = "";
  await other("claim_payment_link", { link: made.link, passcode: "wrong" }).catch((e) => (wrong = e.message));
  assert(wrong.length > 0, "a wrong passcode opens nothing");
  const before = (await other("private_balance")).balances.HYPE;
  const c1 = await other("claim_payment_link", { link: made.link, passcode: "open sesame" });
  assert(c1.claimed.length === 1 && c1.claimed[0].claimed === "0.1 HYPE", `one share claimed into the second agent's private balance (${c1.claimed[0].claimed})`);
  const after = (await other("private_balance")).balances.HYPE;
  assert(Number(after) - Number(before) > 0.099, `its private balance went from ${before} to ${after} HYPE`);
  const wallet2 = "0x000000000000000000000000000000000000d00d";
  const c2 = await other("claim_payment_link", { link: made.link, passcode: "open sesame", to: wallet2 });
  assert((await pub.getBalance({ address: wallet2 })) === parseEther("0.0995"), `the other share went to a fresh wallet with no gas (${c2.claimed[0].claimed})`);
  const left = await other("check_payment_link", { link: made.link, passcode: "open sesame" });
  assert(left.empty && left.status === "claimed", "the link is empty once both shares are claimed");

  // a payment request: the second agent asks, the first pays it privately
  const req = await other("request_payment_link", { asset: "HYPE", amount: "0.05", note: "coffee" });
  assert(req.payTo.startsWith("cloak:gloamr1."), "a request link that pays the second agent's cloak: address");
  const b2 = Number((await other("private_balance")).balances.HYPE);
  await agent("pay_payment_request", { link: req.link });
  const a2 = Number((await other("private_balance")).balances.HYPE);
  assert(Math.abs(a2 - b2 - 0.05) < 1e-9, `paid privately (${b2} to ${a2} HYPE)`);

  writeMeasurements("part16-mcp", { seconds: Math.round((performance.now() - t0) / 1000) });
  console.log(`\nPart 16 passed in ${Math.round((performance.now() - t0) / 1000)} s`);
} finally {
  http?.close();
  anvil.stop();
}
process.exit(0);
