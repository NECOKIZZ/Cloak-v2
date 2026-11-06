// Batch rounds for the shared launch-token vault, end to end with REAL proofs and the keeper:
//   1. a fresh Uniswap launch (pool deep enough for rounds to clear); the keeper settles it and admits it,
//   2. a private account places a batch buy (standard sizes, from private HYPE); the keeper settles the round and the
//      tokens arrive as a note in the shared vault,
//   3. a batch sell (from the shared vault, the proof naming the token); HYPE arrives in the HYPE vault,
//   4. the batcher keeps nothing but rounding dust, and the vault holds exactly what its notes and fees are worth.
// Fork:  DEPLOYER_PK=0x… RPC_URL=http://127.0.0.1:8545 node e2e/deploy-shared-batcher.mjs && DEPLOYER_PK=0x… RPC_URL=http://127.0.0.1:8545 node e2e/shared-batch.mjs
// Live testnet (hosted keeper):  DEPLOYER_PK=0x… node e2e/shared-batch.mjs
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { defineChain, parseAbi, parseEventLogs } from "viem";
import { generatePrivateKey } from "viem/accounts";
import {
  Cloak, CloakPrivate, SharedVaultClient, createProver, createSharedProver, elysiumTestnet, readRegistry, relayerSubmitter, sharedBatcherAbi, sharedRelayerSubmitter, sharedVaultAbi,
} from "@cloakely/sdk";
import { clients, fmt, parseEther, sleep } from "./lib.mjs";

const RPC = process.env.RPC_URL || elysiumTestnet.rpcUrls.default.http[0];
const local = RPC.includes("127.0.0.1") || RPC.includes("localhost");
const root = new URL("..", import.meta.url).pathname;
const v4 = JSON.parse(readFileSync(`${root}deployments/elysium-testnet-v4${local ? "-sharedbatch.fork" : ""}.json`, "utf8"));
const chain = local ? defineChain({ ...elysiumTestnet, id: 31337, rpcUrls: { default: { http: [RPC] } } }) : elysiumTestnet;
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
// a fork's gas costs about 10× live, and each order pays its relayer, so the fork runs with 10× the amounts
const S = local ? 10n : 1n;
let checks = 0;
const ok = (c, m) => {
  if (!c) throw new Error(`✗ ${m}`);
  checks++;
  console.log(`  ✓ ${m}`);
};
const same = (a, b) => a?.toLowerCase() === b?.toLowerCase();
const mine = () => (local ? fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "evm_mine", params: [] }) }).catch(() => {}) : Promise.resolve());
const until = async (what, fn, secs = 420) => {
  for (let i = 0; i < secs / 3; i++) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    await mine();
    await sleep(3000);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const funder = clients(chain, RPC, local ? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" : process.env.DEPLOYER_PK);
const pub = funder.publicClient;
const fund = async (to, v) => {
  for (let i = 0; ; i++) {
    try {
      const nonce = await pub.getTransactionCount({ address: funder.account.address, blockTag: "pending" });
      return await pub.waitForTransactionReceipt({ hash: await funder.walletClient.sendTransaction({ to, value: parseEther(v) * S, nonce }) });
    } catch (e) {
      if (i >= 5 || !/nonce|replacement/i.test(String(e?.message))) throw e;
      await sleep(2000);
    }
  }
};
const circ = (f) => readFileSync(`${root}apps/web/public/circuits/${f}`);
const prover = createProver(circ("transaction2x2.wasm"), circ("transaction2x2_final.zkey"));
const sharedProver = createSharedProver(circ("transactionMA2x2.wasm"), circ("transactionMA2x2_final.zkey"));

let keeper;
let KEEPER = "https://keeper.boblabs.tech";
if (local) {
  KEEPER = "http://127.0.0.1:3994";
  keeper = spawn(process.execPath, [`${root}services/keeper/index.mjs`], {
    env: { ...process.env, RPC_URL: RPC, KEEPER_PK: process.env.DEPLOYER_PK, CONFIG: v4.config, CLAIM_DELAY: "900", HYPE_USD: "25", HYPE_PRICE_URL: "http://127.0.0.1:9/", PORT: "3994", RELAY_PER_MIN: "1000", SNAPSHOT: "0" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  await until("keeper", () => fetch(`${KEEPER}/health`).then((x) => x.ok), 60);
}
try {
  const h = await (await fetch(`${KEEPER}/health`)).json();
  ok(same(h.sharedBatcher, v4.sharedBatcher), `keeper settles rounds for the shared batcher ${h.sharedBatcher}`);
  const reg = await readRegistry(pub, v4.config);
  ok(same(reg.sharedBatcher, v4.sharedBatcher) && same(reg.batcher, v4.batcher), "registry: shared batcher added, the main batcher unchanged");

  // ── 1. a launch with a pool deep enough for a round to clear ──
  const C = clients(chain, RPC, generatePrivateKey());
  const A = clients(chain, RPC, generatePrivateKey());
  const X = clients(chain, RPC, generatePrivateKey());
  await fund(C.account.address, "0.02");
  await fund(A.account.address, "0.3");
  await fund(X.account.address, "0.03");
  const creator = new Cloak(pub, C.walletClient, v4.factory);
  const now = Number((await pub.getBlock()).timestamp);
  const unit = 2n * 10n ** 11n * S; // 2e-7 HYPE per token (×10 on a fork): a 0.2 HYPE raise, a ~0.16 HYPE pool
  const l = await creator.createLaunch({
    name: "Batch Shade", symbol: "BSHADE", saleSupply: 1_000_000n * 10n ** 18n, minPrice: unit, tickSize: unit / 10n, numTicks: 50,
    commitEnd: now + 180, revealEnd: now + 270, lpBps: 8000, lpLockUntil: "fees", noRevealPenaltyBps: 1000, metadataURI: "",
  });
  console.log(`    · launch ${l.auction}`);
  const s0 = await creator.getAuction(l.auction);
  const q = creator.quoteBid(s0, unit, 1_000_000n * 10n ** 18n);
  await new Cloak(pub, A.walletClient).bid(l.auction, { maxPrice: unit, quantity: 1_000_000n * 10n ** 18n, deposit: q.cost });
  const admitted = (t) => pub.readContract({ address: v4.shared, abi: sharedVaultAbi, functionName: "admitted", args: [t] });
  const s = await until("settlement and admission", async () => {
    const st = await creator.getAuction(l.auction);
    return st.settled && (await admitted(st.token)) ? st : undefined;
  });
  ok(!s.failed && BigInt(s.uniPair) !== 0n, `settled into Uniswap pool ${s.uniPair} and admitted to the shared vault`);

  // ── 2. batch buy ──
  const k = await CloakPrivate.keysFromWallet(X.walletClient, { chainId: chain.id });
  const priv = new CloakPrivate(pub, v4.router, k, async () => prover, relayerSubmitter(KEEPER), BigInt(v4.vaultsBlock), v4.batcher, v4.migrator);
  await priv.loadMarkets();
  const shared = new SharedVaultClient(priv, v4.shared, v4.sharedRouter, async () => sharedProver, sharedRelayerSubmitter(KEEPER), BigInt(v4.sharedBlock), v4.sharedBatcher);
  await priv.shieldHype(X.walletClient, parseEther("0.02") * S);
  const buy = await shared.batch(s.token, "buy", parseEther("0.002") * S, { onStatus: (m) => console.log(`    · ${m}`) });
  ok(buy.orders.length >= 1 && buy.orders.every((o) => /^[125]0*$/.test(o.size.toString())), `batch buy placed as ${buy.orders.length} standard-size order(s): ${buy.orders.map((o) => fmt(o.size, 4)).join(", ")} HYPE`);
  const tx0 = await pub.getTransaction({ hash: buy.orders[0].txHash });
  ok(!same(tx0.from, X.account.address), `orders sent by the relayer ${tx0.from}, not the trader`);
  const got = await until("the buy round to settle and pay out", async () => {
    const b = await shared.balance(s.token);
    return b > 0n ? b : undefined;
  }, 240);
  ok(got > 0n, `round settled: ${fmt(got, 0)} BSHADE arrived as a private note in the shared vault`);

  // ── 3. batch sell ──
  const hype0 = await priv.balance(priv.hypeMarket.pool);
  const sell = await shared.batch(s.token, "sell", got / 2n, { onStatus: (m) => console.log(`    · ${m}`) });
  ok(sell.orders.length >= 1, `batch sell placed as ${sell.orders.length} standard-size order(s) from the shared vault`);
  const hype1 = await until("the sell round to settle and pay out", async () => {
    const b = await priv.balance(priv.hypeMarket.pool);
    return b > hype0 ? b : undefined;
  }, 240);
  ok(hype1 > hype0, `round settled: ${fmt(hype1 - hype0, 8)} HYPE arrived in the private HYPE balance`);
  const rc = await pub.waitForTransactionReceipt({ hash: sell.orders[0].txHash });
  ok(parseEventLogs({ abi: sharedBatcherAbi, logs: rc.logs, eventName: "OrderPlaced" }).length === 1, "each order is one OrderPlaced: token, round, side and a standard size, nothing about the trader");

  // ── 4. nothing left behind, once every order's round has settled and paid out ──
  const ids = [...buy.orders, ...sell.orders].map((o) => o.id);
  await until("every order to be paid out", async () => {
    const os = await Promise.all(ids.map((id) => pub.readContract({ address: v4.sharedBatcher, abi: sharedBatcherAbi, functionName: "orders", args: [id] })));
    return os.every((o) => o[3]) || undefined;
  }, 300);
  const [held, dep, owed, stuck] = await Promise.all([
    pub.readContract({ address: s.token, abi: ERC20, functionName: "balanceOf", args: [v4.shared] }),
    pub.readContract({ address: v4.shared, abi: sharedVaultAbi, functionName: "deposited", args: [s.token] }),
    pub.readContract({ address: v4.shared, abi: sharedVaultAbi, functionName: "feesOwed", args: [s.token] }),
    pub.readContract({ address: s.token, abi: ERC20, functionName: "balanceOf", args: [v4.sharedBatcher] }),
  ]);
  ok(held === dep + owed, `the shared vault holds exactly its notes plus fees (${fmt(held, 0)} BSHADE)`);
  ok(stuck < 10n ** 6n, `the batcher keeps at most rounding dust (${stuck} units)`);
  console.log(`\n    launch page: https://cloak.boblabs.tech/app/launch/${l.auction}`);
} finally {
  keeper?.kill();
}
console.log(`\n${checks} checks passed`);
process.exit(0);
