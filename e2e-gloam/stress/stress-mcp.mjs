// The MCP agent tools in Gloam mode (packages/mcp createCloakServer, core "gloam"), over an in-memory transport, with
// the keeper's relay behind HTTP. Weird inputs, the spending limits under parallel tool calls, and what a dry run does.
//
//   node e2e-gloam/stress/stress-mcp.mjs
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatEther, parseUnits } from "viem";
import { deployments } from "@cloakely/sdk";
import { setup, record, summary, ms, GloamPrivate, ANVIL_KEYS, parseEther } from "./common.mjs";
import { CIRCUITS, REPO, chainFor } from "../lib.mjs";

const MCP_SDK = `${REPO}/packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm`;
const { Client } = await import(`${MCP_SDK}/client/index.js`);
const { InMemoryTransport } = await import(`${MCP_SDK}/inMemory.js`);
const { createCloakServer } = await import(`${REPO}/packages/mcp/dist/server.js`);

const S = await setup({ port: 8612, hourly: "100" });
const { pub, c, block, rpcUrl } = S;
let http;
try {
  console.log("stress-mcp: agent tools on Gloam");
  http = createServer((req, res) => {
    let body = "";
    req.on("data", (x) => (body += x));
    req.on("end", async () => {
      try {
        const txHash = await S.relay(JSON.parse(body), { sender: "mcp" });
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ txHash }));
      } catch (e) {
        res.writeHead(e.status ?? 400, { "content-type": "application/json" }).end(JSON.stringify({ error: e.message }));
      }
    });
  }).listen(8613);
  const D = deployments[99801];
  const deployment = {
    ...D,
    factory: c.factoryStandIn,
    earlierFactories: [],
    previous: [],
    relayerUrl: "http://127.0.0.1:8613",
    whype: c.whypeStandIn,
    assets: [{ symbol: "USDC", token: c.usdc, pool: c.gloamVault, decimals: 6, fromBlock: block }],
    gloam: { gloamVault: c.gloamVault, memoBoard: c.memoBoard, launchVault: c.launchVault, block, launchSwap: c.launchSwap, batcher: c.batcher, whype: c.whypeStandIn },
  };
  const connect = async (pk, limits) => {
    const server = createCloakServer({ network: "custom", chain: chainFor(rpcUrl), rpcUrl, deployment, core: "gloam", gloamCircuitsDir: CIRCUITS, launchesFromBlock: block, privateKey: pk, dryRun: false, stateDir: mkdtempSync(join(tmpdir(), "cloak-mcp-stress-")), limits });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "stress", version: "1" });
    await Promise.all([server.connect(a), client.connect(b)]);
    return async (name, args = {}) => {
      const r = await client.callTool({ name, arguments: args });
      const text = r.content?.[0]?.text ?? "";
      if (r.isError) throw new Error(text);
      return JSON.parse(text);
    };
  };
  const limits = { hypePerTx: parseEther("1"), hypePerDay: parseEther("2"), usdcPerTx: parseUnits("100", 6), usdcPerDay: parseUnits("1000", 6), launchesPerDay: 3 };
  const agent = await connect(ANVIL_KEYS[3], limits);
  const me = S.who(3);
  // fund the agent's private balance outside the agent (so the day's limit starts at zero): 4 notes of 1 HYPE
  const direct = await GloamPrivate.unlock(me.wallet, S.cfgFor(S.viaRelay("direct")));
  await direct.loadMarkets();
  for (let i = 0; i < 4; i++) await direct.shieldHype(me.wallet, parseEther("1"));
  console.log(`  agent's private balance: ${(await agent("private_balance")).balances.HYPE} HYPE; limits 1 HYPE a call, 2 a day`);

  // ── 1. weird amounts and addresses ──
  const sink = S.who(9).account.address;
  const amounts = ["-1", "0", "1e3", "0x10", " 0.5 ", "1,5", "NaN", "Infinity", "0.0000000000000000001", "99999999999999999999999999999", "max", ""];
  const out = [];
  for (const a of amounts) {
    let r;
    try {
      r = await agent("withdraw", { asset: "HYPE", to: sink, amount: a, dry_run: true });
      r = `OK ${r.wouldWithdraw}`;
    } catch (e) {
      r = `refused: ${e.message.slice(0, 60)}`;
    }
    out.push(`${JSON.stringify(a)} -> ${r}`);
  }
  console.log("    " + out.join("\n    "));
  const tinyOk = out.find((x) => x.startsWith('"0.0000000000000000001"'));
  record("mcp-amounts", !/OK/.test(tinyOk), `weird withdraw amounts (dry run): 19-decimal HYPE amount -> ${tinyOk.split("-> ")[1]}`);
  const usdcTiny = await agent("withdraw", { asset: "USDC", to: sink, amount: "0.0000009", dry_run: true }).then((r) => `OK ${r.wouldWithdraw}`, (e) => `refused: ${e.message.slice(0, 60)}`);
  record("mcp-amount-rounding", !/OK 0.000001/.test(usdcTiny), `USDC "0.0000009" (7 decimals for a 6-decimal asset) -> ${usdcTiny}`);
  const addrs = ["0x123", "0x0000000000000000000000000000000000000000", c.launchVault, "vitalik.eth", "cloak:gloamr1.garbage"];
  const ao = [];
  for (const to of addrs) {
    ao.push(`${to.slice(0, 24)} -> ${await agent("withdraw", { asset: "HYPE", to, amount: "0.1", dry_run: true }).then((r) => `dry run OK (${r.to})`, (e) => `refused: ${e.message.slice(0, 70)}`)}`);
  }
  console.log("    " + ao.join("\n    "));
  const zeroDry = ao[1];
  record("mcp-bad-destination", !/dry run OK/.test(zeroDry) && !/dry run OK/.test(ao[2]), `withdraw to the zero address / the launch vault: dry run says "${ao[1].split("-> ")[1]}" / "${ao[2].split("-> ")[1]}" (the relay refuses both only at send time)`);
  const sendBad = await agent("private_send", { asset: "HYPE", to: "cloak:gloamr1.AAAA", amount: "0.1", dry_run: true }).then((r) => `dry run OK`, (e) => `refused: ${e.message.slice(0, 80)}`);
  record("mcp-bad-cloak-address", !/OK/.test(sendBad), `private_send to "cloak:gloamr1.AAAA" (not a real receive tag), dry run -> ${sendBad}`);

  // ── 2. what a dry run does: a payment is waiting to be swept ──
  const other = await GloamPrivate.unlock(S.who(4).wallet, S.cfgFor(S.viaRelay("other")));
  await other.loadMarkets();
  await other.shieldHype(S.who(4).wallet, parseEther("0.5"));
  await other.send(other.hypeMarket.token, await direct.address(), parseEther("0.1"));
  const n0 = await pub.getTransactionCount({ address: S.keeper.account.address });
  await agent("private_send", { asset: "HYPE", to: await other.address(), amount: "0.01", dry_run: true });
  const n1 = await pub.getTransactionCount({ address: S.keeper.account.address });
  await agent("withdraw", { asset: "HYPE", to: sink, amount: "max", dry_run: true }).catch(() => {});
  const n2 = await pub.getTransactionCount({ address: S.keeper.account.address });
  record("mcp-dryrun-sends", n2 === n0, `with a received payment waiting: a dry-run private_send (exact amount) made the relay send ${n1 - n0} transaction(s); a dry-run withdraw of "max" made it send ${n2 - n1} (reading the balance syncs, and sync sweeps received payments)`);

  // ── 3. the spending limit under parallel tool calls: 1 a call, 2 a day ──
  const t = performance.now();
  const par = await Promise.allSettled(Array.from({ length: 4 }, () => agent("withdraw", { asset: "HYPE", to: sink, amount: "0.9" })));
  const okN = par.filter((x) => x.status === "fulfilled").length;
  const info = await agent("cloak_info");
  record("mcp-limit-parallel", okN * 0.9 <= 2, `4 parallel withdraw calls of 0.9 HYPE under a 2 HYPE daily limit: ${okN} went through (${(okN * 0.9).toFixed(1)} HYPE) in ${Math.round(ms(t) / 1000)} s; the day's record now says used ${info.limits?.hype?.usedToday}, left ${info.limits?.hype?.leftToday}. Refusals: ${par.filter((x) => x.status === "rejected").map((x) => x.reason.message.slice(0, 50)).join(" | ")}`);
  const after = await agent("withdraw", { asset: "HYPE", to: sink, amount: "0.1", dry_run: true }).then(() => "allowed", (e) => `refused (${e.message.slice(0, 50)})`);
  console.log(`    a further 0.1 HYPE withdraw now: ${after}`);
  console.log(`    sink received ${formatEther(await pub.getBalance({ address: sink }) - parseEther("1000000"))} HYPE`);
} finally {
  http?.close();
  S.stop();
  summary("stress-mcp");
}
process.exit(0);
