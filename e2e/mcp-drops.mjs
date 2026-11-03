// The MCP server's drop tools end to end on a local chain with the REAL drand beacon and the keeper:
//   an agent lists drops, reads one (and sees it's on the WL), dry-runs and places a sealed bid with its boost, is held
//   to its spending limit, waits for the keeper to settle, reads its result, names a fresh wallet for its WL spot, is
//   refused for a wrong count or a sale it didn't win, and claims its receipt to a fresh wallet. The hosted (read-only)
//   server can list and read drops but has no bid tool.
//   anvil --balance 1000000 --block-time 1 & ; pnpm build ; node e2e/mcp-drops.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { anvilLocal, cloakDropAbi, cloakDropFactoryAbi, cloakSpotBookAbi, CloakDrops, CloakSpots } from "@cloakely/sdk";
import { bytecode } from "@cloakely/sdk/bytecode";
import { createCloakServer, loadSettings } from "@cloakely/mcp";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { clients, deployFactory, deployPrivacy, parseEther, sleep, waitChainTime } from "./lib.mjs";

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
const send = async (p) => {
  const r = await d.publicClient.waitForTransactionReceipt({ hash: await p });
  if (r.status !== "success") throw new Error(`reverted ${r.transactionHash}`);
  return r;
};
const f = await deployFactory(d.publicClient, d.walletClient, { rules: { withdrawFeeBps: 25, launchFeeBps: 150 } });
const r = await deployPrivacy(d.publicClient, d.walletClient, f.factory, { config: f.config });
const dfR = await send(d.walletClient.deployContract({ abi: cloakDropFactoryAbi, bytecode: bytecode.CloakDropFactory, args: [f.config, "https://cloak.boblabs.tech/api/nft/"] }));
const DF = dfR.contractAddress;
const BOOK = (await send(d.walletClient.deployContract({ abi: cloakSpotBookAbi, bytecode: bytecode.CloakSpotBook, args: [DF] }))).contractAddress;
const [hypePool, whype] = await Promise.all(["hypePool", "whype"].map((fn) => d.publicClient.readContract({ address: r.router, abi: [{ type: "function", name: fn, stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }], functionName: fn })));
const dir = mkdtempSync(join(tmpdir(), "cloak-mcp-drops-"));
const deploymentFile = join(dir, "deployment.json");
writeFileSync(deploymentFile, JSON.stringify({ chainId: chain.id, rpcUrl: RPC, config: f.config, factory: f.factory, router: r.router, routerBlock: r.block.toString(), batcher: r.router, hypePool, whype, relayerUrl: "http://127.0.0.1:9", circuitsUrl: "", launchesFromBlock: 0, dropFactory: DF, dropFactoryBlock: Number(dfR.blockNumber), spotBook: BOOK }));

const keeper = spawn(process.execPath, [`${root}services/keeper/index.mjs`], {
  env: { ...process.env, RPC_URL: RPC, KEEPER_PK, FACTORY: f.factory, DROP_FACTORY: DF, CLAIM_DELAY: "3600", POLL_MS: "1000", PORT: "3994", HYPE_PRICE_URL: "http://127.0.0.1:9/", HYPE_USD: "25" },
  stdio: ["ignore", "ignore", "inherit"],
});
async function agent(name, key, extra = {}) {
  const env = { ...process.env, CLOAK_DEPLOYMENT_FILE: deploymentFile, CLOAK_STATE_DIR: join(dir, name), CLOAK_MAX_HYPE_PER_TX: "1", CLOAK_MAX_HYPE_PER_DAY: "3", ...extra };
  if (key) env.CLOAK_PRIVATE_KEY = key;
  const client = new Client({ name: `e2e-${name}`, version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [`${root}packages/mcp/dist/index.js`], env, stderr: "ignore" }));
  const call = async (tool, args = {}) => {
    const res = await client.callTool({ name: tool, arguments: args });
    return res.isError ? { error: res.content[0].text } : JSON.parse(res.content[0].text);
  };
  return { client, call };
}
const funded = async (eth) => {
  const k = generatePrivateKey();
  await send(d.walletClient.sendTransaction({ to: privateKeyToAccount(k).address, value: parseEther(eth) }));
  return k;
};
const fresh = () => privateKeyToAccount(generatePrivateKey()).address;

try {
  const aKey = await funded("10");
  const aAddr = privateKeyToAccount(aKey).address;
  const A = await agent("alice", aKey);
  const rival = await funded("10");
  const rc = clients(chain, RPC, rival);
  const rivalDrops = new CloakDrops(rc.publicClient, rc.walletClient, DF);

  // a spot sale (alice on its WL) and a plain drop
  const sp = new CloakSpots(new CloakDrops(d.publicClient, d.walletClient, DF), BOOK);
  const { drop: sale } = await sp.create({ name: "Agent WL spots", symbol: "AWL", supply: 2, floor: parseEther("0.5"), tickSize: parseEther("0.1"), numTicks: 10, biddingSecs: 40, revealSecs: 600, partner: "Agent Partner", walletDays: 1, wl: { list: [aAddr], boostBps: 2000 } });
  const s0 = await sp.drops.get(sale);

  const { tools } = await A.client.listTools();
  const names = tools.map((t) => t.name);
  ok(["list_drops", "get_drop", "place_drop_bid", "my_drop_bids", "claim_drop", "set_whitelist_wallets"].every((t) => names.includes(t)), `the local server offers the drop tools (${tools.length} tools in all)`);
  const hosted = createCloakServer(loadSettings({ CLOAK_DEPLOYMENT_FILE: deploymentFile }), { hosted: true });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await hosted.connect(st);
  const H = new Client({ name: "hosted", version: "0" });
  await H.connect(ct);
  const hn = (await H.listTools()).tools.map((t) => t.name);
  ok(hn.includes("list_drops") && hn.includes("get_drop") && !hn.includes("place_drop_bid"), "the hosted server can read drops but has no bid tool");

  const list = await A.call("list_drops", {});
  ok(list.total === 1 && /WL spot sale for Agent Partner/.test(list.drops[0].kind), "list_drops shows the WL spot sale for its partner");
  const info = await A.call("get_drop", { drop: sale });
  ok(info.listing?.onWl === true && /20%/.test(info.wlBoost), "get_drop sees this wallet is on the WL, and the 20% boost");

  await waitChainTime(d.publicClient, s0.gtdEnd);
  const tooLow = await A.call("place_drop_bid", { drop: sale, max_price: "0.4" });
  ok(/at least the floor/.test(tooLow.error ?? ""), "a bid under the floor is refused before anything is signed");
  const tooBig = await A.call("place_drop_bid", { drop: sale, max_price: "1.5" });
  ok(/limit/i.test(tooBig.error ?? ""), `a 1.5 HYPE bid is held to the 1 HYPE per-transaction limit (${(tooBig.error ?? "").slice(0, 70)})`);
  const dry = await A.call("place_drop_bid", { drop: sale, max_price: "0.55", dry_run: true });
  ok(dry.dryRun && dry.wouldBid.wl === true && /snaps down/.test(dry.wouldBid.bidLevel) && dry.wouldBid.ranksAs === "0.6 HYPE each", "dry run: 0.55 snaps to 0.5, ranks as 0.6 with the WL boost, nothing sent");
  ok((await sp.drops.bids(sale)).length === 0, "the dry run placed nothing");
  const bid = await A.call("place_drop_bid", { drop: sale, max_price: "0.5" });
  ok(bid.placed && bid.wl === true, `place_drop_bid sealed a WL bid (${bid.bidId ?? bid.error})`);
  await rivalDrops.bid(sale, { price: parseEther("0.5"), quantity: 1 });
  await rivalDrops.bid(sale, { price: parseEther("0.5"), quantity: 1 });
  const early = await A.call("set_whitelist_wallets", { drop: sale, wallets: [fresh()] });
  ok(/once the sale settles/.test(early.error ?? ""), "naming wallets waits for the sale to settle");

  console.log("    · waiting for the drand round and the keeper…");
  for (let i = 0; i < 240 && (await sp.drops.get(sale)).phase !== "settled"; i++) await sleep(1000);
  const mine = await A.call("my_drop_bids", { drop: sale });
  ok(mine.phase === "settled" && mine.bids[0].won === 1, "my_drop_bids: settled, the WL bid won its spot (its boost beat the two public bids)");
  const res = await A.call("get_drop", { drop: sale });
  ok(res.whitelist?.length === 2 && res.whitelist.every((x) => x.wallet === "not named yet"), "get_drop lists the 2 spots, none named yet");
  const wrongCount = await A.call("set_whitelist_wallets", { drop: sale, wallets: [fresh(), fresh()] });
  ok(/won 1 spot/.test(wrongCount.error ?? ""), "naming 2 wallets for 1 spot is refused");
  const typo = await A.call("set_whitelist_wallets", { drop: sale, wallets: ["0x123"] });
  ok(/isn't a wallet address/.test(typo.error ?? ""), "a typo'd wallet is refused");
  const target = fresh();
  const nd = await A.call("set_whitelist_wallets", { drop: sale, wallets: [target], dry_run: true });
  ok(nd.dryRun && nd.wouldName[0].wallets[0] === target, "dry run shows which wallet would be named");
  const named = await A.call("set_whitelist_wallets", { drop: sale, wallets: [target] });
  ok(named.named && named.partner === "Agent Partner", "set_whitelist_wallets named a fresh wallet for the partner");
  const after = await A.call("get_drop", { drop: sale });
  ok(after.whitelist.some((x) => x.wallet.toLowerCase() === target.toLowerCase()), "the whitelist now shows it");
  const receiptTo = fresh();
  const cl = await A.call("claim_drop", { drop: sale, to: receiptTo });
  ok(cl.claimed && (await d.publicClient.readContract({ address: sale, abi: cloakDropAbi, functionName: "balanceOf", args: [receiptTo] })) === 1n, "claim_drop sent the receipt NFT to another fresh wallet, without waiting for the keeper");
  const again = await A.call("claim_drop", { drop: sale });
  ok(again.nothingToClaim, "claiming again says there's nothing left");
  const B = await agent("bob", await funded("2"));
  const notWon = await B.call("set_whitelist_wallets", { drop: sale, wallets: [fresh()] });
  ok(/didn't win a spot/.test(notWon.error ?? ""), "a wallet that didn't win can't name wallets");
  const R = await agent("reader");
  const ro = await R.call("place_drop_bid", { drop: sale, max_price: "0.5" });
  ok(/No wallet configured/.test(ro.error ?? ""), "without a key, bid tools say why");
  console.log(`\n${checks} checks passed`);
} finally {
  keeper.kill();
}
process.exit(0);
