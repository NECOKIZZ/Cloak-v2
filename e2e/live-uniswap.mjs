// Uniswap launches, live on Elysium testnet: the live contracts, the real Uniswap V2, REAL Groth16 proofs and the hosted
// keeper (reveals, settles, opens the vault, relays). Small amounts, funded from DEPLOYER_PK into fresh wallets:
//   1. a launch from the new factory; the keeper reveals, settles (opening a Uniswap V2 pool at the clearing price) and
//      opens the token's private vault,
//   2. a winner claims privately, then sells privately and buys privately through the vaults: the trades land in the
//      Uniswap pool, sent by the relayer,
//   3. a sealed batch round crosses at the pool's time-weighted price,
//   4. an outside wallet trades the same pool straight on Uniswap, and every earlier launch still lists.
//   DEPLOYER_PK=0x… node e2e/live-uniswap.mjs
import { readFileSync } from "node:fs";
import { defineChain, parseAbi } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Cloak, CloakPrivate, cloakV2MarketAbi, cloakVaultsAbi, createProver, elysiumTestnet, readRegistry, relayerSubmitter } from "@cloakely/sdk";
import { clients, fmt, parseEther, sleep } from "./lib.mjs";

const RPC = elysiumTestnet.rpcUrls.default.http[0];
const root = new URL("..", import.meta.url).pathname;
const v4 = JSON.parse(readFileSync(`${root}deployments/elysium-testnet-v4.json`, "utf8"));
const chain = elysiumTestnet;
const KEEPER = "https://cloak-keeper.onrender.com";
const PAIR = parseAbi([
  "function getReserves() view returns (uint112, uint112, uint32)",
  "function token0() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function swap(uint256, uint256, address, bytes)",
]);
const WETH = parseAbi(["function deposit() payable", "function transfer(address, uint256) returns (bool)"]);
let checks = 0;
const ok = (c, m) => {
  if (!c) throw new Error(`✗ ${m}`);
  checks++;
  console.log(`  ✓ ${m}`);
};
const same = (a, b) => a?.toLowerCase() === b?.toLowerCase();
const until = async (what, fn, secs = 300) => {
  for (let i = 0; i < secs / 3; i++) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    await sleep(3000);
  }
  throw new Error(`timed out waiting for ${what}`);
};

const k = clients(chain, RPC, process.env.DEPLOYER_PK); // funds the fresh wallets (also the hosted keeper's key)
const fund = async (to, v) => k.publicClient.waitForTransactionReceipt({ hash: await k.walletClient.sendTransaction({ to, value: parseEther(v) }) });
const creatorC = clients(chain, RPC, generatePrivateKey());
const pub = creatorC.publicClient;
const prover = createProver(readFileSync(`${root}apps/web/public/circuits/transaction2x2.wasm`), readFileSync(`${root}apps/web/public/circuits/transaction2x2_final.zkey`));
const PORT = null;
const relayUrl = KEEPER;
{
  const h = await (await fetch(`${KEEPER}/health`)).json();
  ok(same(h.factory, v4.factory), `hosted keeper runs the Uniswap factory (${h.factory})`);
  const reg = await readRegistry(pub, v4.config);
  ok(same(reg.factory, v4.factory) && same(reg.earlierFactories[0], v4.earlierFactories[0]) && reg.version === 4, "registry: the Uniswap factory is current, v4's first factory listed as earlier, still version 4");
  await fund(creatorC.account.address, "0.03");

  // ── 1. a launch from the new factory ──
  const creator = new Cloak(pub, creatorC.walletClient, v4.factory);
  const now = Number((await pub.getBlock()).timestamp);
  const unit = 10n ** 9n; // 0.000000001 HYPE per token: the whole sale raises about 0.01 HYPE
  const l = await creator.createLaunch({ name: "Uni Shade", symbol: "USHADE", metadataURI: "", saleSupply: 1_000_000n * 10n ** 18n, minPrice: unit, tickSize: unit, numTicks: 50, commitEnd: now + 90, revealEnd: now + 150, lpBps: 8000 });
  console.log(`    · launch ${l.auction}`);
  const keysOut = [generatePrivateKey(), generatePrivateKey()];
  if (process.env.KEYS_FILE) (await import("node:fs")).writeFileSync(process.env.KEYS_FILE, JSON.stringify({ A: keysOut[0], B: keysOut[1] }));
  const bidders = keysOut.map((pk) => clients(chain, RPC, pk));
  await fund(bidders[0].account.address, "0.08");
  await fund(bidders[1].account.address, "0.02");
  const s0 = await creator.getAuction(l.auction);
  const qA = creator.quoteBid(s0, unit * 20n, 150_000n * 10n ** 18n); // A: 15% of the sale (a private claim stays under the per-deposit cap)
  const qB = creator.quoteBid(s0, unit * 10n, 850_000n * 10n ** 18n);
  const secretA = await new Cloak(pub, bidders[0].walletClient).bid(l.auction, { maxPrice: unit * 20n, quantity: 150_000n * 10n ** 18n, deposit: qA.cost });
  await new Cloak(pub, bidders[1].walletClient).bid(l.auction, { maxPrice: unit * 10n, quantity: 850_000n * 10n ** 18n, deposit: qB.cost });
  console.log("    · two sealed bids in; the keeper reveals, settles and opens the vault");

  const vaultOf = (token) => pub.readContract({ address: v4.vaults, abi: cloakVaultsAbi, functionName: "poolOf", args: [token] });
  const s = await until("settlement and the vault", async () => {
    const st = await creator.getAuction(l.auction);
    if (!st.settled) return undefined;
    // since the shared vault went live, the keeper admits new launch tokens there instead of opening a vault per token
    if (h.shared && (await pub.readContract({ address: h.shared, abi: parseAbi(["function admitted(address) view returns (bool)"]), functionName: "admitted", args: [st.token] }))) return { ...st, shared: true };
    return BigInt(await vaultOf(st.token)) !== 0n ? st : undefined;
  });
  if (s.shared) {
    ok(!s.failed && s.uniPair && BigInt(s.uniPair) !== 0n, `settled into a Uniswap V2 pool ${s.uniPair}, token admitted to the shared vault`);
    console.log(`\n${checks} checks passed. The token went to the shared vault, whose private claims and trades e2e/shared.mjs covers.`);
    process.exit(0);
  }
  ok(!s.failed && s.uniPair && BigInt(s.uniPair) !== 0n, `settled into a Uniswap V2 pool ${s.uniPair}`);
  const [r0, r1] = await pub.readContract({ address: s.uniPair, abi: PAIR, functionName: "getReserves" });
  const tokenIs0 = same(await pub.readContract({ address: s.uniPair, abi: PAIR, functionName: "token0" }), s.token);
  const [rH, rT] = tokenIs0 ? [r1, r0] : [r0, r1];
  const poolPrice = (rH * 10n ** 18n) / rT;
  ok(poolPrice * 10_000n >= s.clearingPrice * 9_999n && poolPrice * 10_000n <= s.clearingPrice * 10_001n, `the pool opened at the clearing price (${fmt(poolPrice, 9)} vs ${fmt(s.clearingPrice, 9)} HYPE per token), ${fmt(rH)} HYPE + ${fmt(rT, 0)} tokens`);
  const [dead, supply] = await Promise.all([pub.readContract({ address: s.uniPair, abi: PAIR, functionName: "balanceOf", args: ["0x000000000000000000000000000000000000dEaD"] }), pub.readContract({ address: s.uniPair, abi: PAIR, functionName: "totalSupply" })]);
  ok(dead + 1000n === supply, "LP burned: every LP token at 0x…dEaD (plus Uniswap's own 1000)");
  const market = s.pair;
  ok(same(await pub.readContract({ address: market, abi: cloakV2MarketAbi, functionName: "uniPair" }), s.uniPair), "the launch's market is a CloakV2Market in front of that pool");

  // ── 2. claim privately, sell and buy privately ──
  const A = bidders[0];
  const relay = relayerSubmitter(relayUrl);
  const keys = await CloakPrivate.keysFromWallet(A.walletClient, { chainId: chain.id });
  const priv = new CloakPrivate(pub, v4.router, keys, async () => prover, relay, BigInt(v4.vaultsBlock), v4.batcher, v4.migrator);
  await priv.loadMarkets();
  ok(priv.markets.some((m) => same(m.token, s.token) && same(m.pair, market)), "the router lists the token with the Uniswap market");
  const c = await priv.claimPrivately(A.walletClient, l.auction, secretA.id);
  const pool = priv.market(s.token).pool;
  const held = await priv.balance(pool);
  ok(held === c.tokens && held > 0n, `A claimed ${fmt(held, 0)} USHADE straight into the private vault`);

  const sell = await priv.sell(s.token, held / 2n);
  const sellTx = await pub.getTransaction({ hash: sell.txHash });
  const [s0r, s1r] = await pub.readContract({ address: s.uniPair, abi: PAIR, functionName: "getReserves" });
  const rT2 = tokenIs0 ? s0r : s1r;
  ok(same(sellTx.from, k.account.address) && !same(sellTx.from, A.account.address) && rT2 > rT, `private sell went through the Uniswap pool, sent by the relayer (${fmt(rT2 - rT, 0)} tokens in)`);
  const hypeAfterSell = await priv.balance(priv.hypeMarket.pool);
  ok(hypeAfterSell > 0n, `the sale landed as ${fmt(hypeAfterSell)} private HYPE`);

  await priv.shieldHype(A.walletClient, parseEther("0.05"));
  const before = await priv.balance(pool);
  const buy = await priv.buy(s.token, parseEther("0.0005"));
  await pub.waitForTransactionReceipt({ hash: buy.txHash });
  const afterBuy = await priv.balance(pool);
  ok(afterBuy > before, `private buy through the Uniswap pool: +${fmt(afterBuy - before, 0)} USHADE`);

  // ── 3. a sealed batch round, priced by the pool's time-weighted price ──
  // a round may move the pool by at most 5% (the batcher's impact guard), so the order is small next to this tiny pool
  const b = await priv.batch(s.token, "buy", parseEther("0.0002"));
  ok(b.orders.length > 0, `placed ${b.orders.length} standard-size batch order(s) for round ${b.orders[0].round}`);
  const got = await until("the batch round to settle and pay out", async () => ((await priv.balance(pool)) > afterBuy ? await priv.balance(pool) : undefined), 180);
  ok(got > afterBuy, `the round settled at the pool's average price and paid +${fmt(got - afterBuy, 0)} USHADE privately`);

  // ── 4. the same pool, straight on Uniswap, from an outside wallet ──
  const outside = clients(chain, RPC, generatePrivateKey());
  await fund(outside.account.address, "0.01");
  const [q0, q1] = await pub.readContract({ address: s.uniPair, abi: PAIR, functionName: "getReserves" });
  const [qH, qT] = tokenIs0 ? [q1, q0] : [q0, q1];
  const amt = parseEther("0.002");
  const out = (amt * 997n * qT) / (qH * 1000n + amt * 997n);
  for (const [functionName, args, value] of [["deposit", [], amt], ["transfer", [s.uniPair, amt]]]) {
    await pub.waitForTransactionReceipt({ hash: await outside.walletClient.writeContract({ address: v4.uniswap.whype, abi: WETH, functionName, args, value }) });
  }
  await pub.waitForTransactionReceipt({ hash: await outside.walletClient.writeContract({ address: s.uniPair, abi: PAIR, functionName: "swap", args: tokenIs0 ? [out, 0n, outside.account.address, "0x"] : [0n, out, outside.account.address, "0x"] }) });
  const p2 = await pub.readContract({ address: market, abi: cloakV2MarketAbi, functionName: "price" });
  ok(p2 > poolPrice, `an outside wallet bought straight on Uniswap and Cloak's market sees the new price (${fmt(p2, 9)})`);

  const listed = await new Cloak(pub, undefined, v4.factory, [...v4.earlierFactories, ...v4.previous.map((p) => p.factory)]).listLaunches();
  const by = (f) => listed.filter((x) => same(x.factory, f)).length;
  ok(by(v4.factory) >= 1 && by(v4.earlierFactories[0]) >= 1, `launches from both v4 factories list (${by(v4.factory)} new, ${by(v4.earlierFactories[0])} earlier) next to ${listed.length - by(v4.factory) - by(v4.earlierFactories[0])} older ones`);
  const snap = await until("a snapshot with the new market", async () => {
    const j = await (await fetch(`${KEEPER}/snapshot`)).text();
    return j.toLowerCase().includes(market.toLowerCase()) ? j : undefined;
  }, 90);
  ok(snap.includes('"batchable":true'), "the keeper's snapshot lists the new market as batchable");
  const fresh = privateKeyToAccount(generatePrivateKey()).address;
  await pub.waitForTransactionReceipt({ hash: await priv.unshieldToken(s.token, fresh, (await priv.maxSpendable(pool, "transact")) / 2n) });
  ok((await pub.readContract({ address: s.token, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [fresh] })) > 0n, "withdrew private USHADE to a fresh wallet");
  console.log(`\n    launch page: https://cloak.boblabs.tech/app/launch/${l.auction}\n    Uniswap pool: ${elysiumTestnet.blockExplorers.default.url}/address/${s.uniPair}`);
}
console.log(`\n${checks} checks passed`);
process.exit(0);
