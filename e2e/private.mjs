// Private trading e2e with REAL Groth16 proofs: launch → enable private market → shield → private buy → private sell
// → unshield to a fresh address. Asserts the trader's wallet never appears in any trade transaction.
//   anvil --balance 1000000 & ; node e2e/private.mjs
//   Elysium: RPC_URL=… DEPLOYER_PK=… FACTORY=0x… LAUNCH_INDEX=n [ROUTER=0x…] node e2e/private.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { generatePrivateKey } from "viem/accounts";
import { anvilLocal, elysiumTestnet, CloakPrivate, createProver, walletSubmitter, relayerSubmitter, privateRouterAbi, privateBatcherAbi, cloakFactoryAbi, cloakTokenAbi, shieldedPoolAbi } from "@cloakely/sdk";
import { Cloak, clients, deployBatcher, deployFactory, deployPrivacy, exempt, fmt, parseEther, sleep, waitChainTime, waitDrand } from "./lib.mjs";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const local = RPC.includes("127.0.0.1") || RPC.includes("localhost");
const chain = local ? anvilLocal : elysiumTestnet;
const PK = process.env.DEPLOYER_PK ?? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const RELAYER_PK = process.env.RELAYER_PK ?? (local ? "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" : PK);
const scale = local ? 1n : 1000n; // testnet: amounts ÷ 1000
// Through a hosted relayer (RELAYER_URL) every private call also pays the relayer's fee from the private balance, so
// balances are checked to within the fees paid, and the account starts with enough to cover them.
const relayed = !!process.env.RELAYER_URL;
const slack = relayed ? parseEther("0.004") : 0n;
const near = (a, b) => a <= b && a + slack >= b;
const explorer = (h) => (local ? h : `${elysiumTestnet.blockExplorers.default.url}/tx/${h}`);
let checks = 0;
const ok = (c, m) => {
  if (!c) throw new Error(`✗ ${m}`);
  checks++;
  console.log(`  ✓ ${m}`);
};
const txs = {};

const d = clients(chain, RPC, PK);
const mine = local ? () => d.publicClient.request({ method: "evm_mine", params: [] }) : undefined;
console.log(`chain ${chain.name} (${chain.id})`);

// 1. a settled launch (reuse one on testnet via FACTORY + LAUNCH_INDEX)
let factory = process.env.FACTORY;
let config;
let launchIndex = process.env.LAUNCH_INDEX !== undefined ? BigInt(process.env.LAUNCH_INDEX) : undefined;
if (!factory || launchIndex === undefined) {
  if (!factory) {
    // fees on, as on mainnet: 0.25% on withdrawals (cash outs and private swaps), 1.5% of a successful raise
    const f = await deployFactory(d.publicClient, d.walletClient, { rules: { withdrawFeeBps: 25, launchFeeBps: 150 } });
    factory = f.factory;
    config = f.config;
  }
  const creator = new Cloak(d.publicClient, d.walletClient, factory);
  const now = Number((await d.publicClient.getBlock()).timestamp);
  const unit = 10n ** 14n / (local ? 1n : 100_000n); // testnet: the whole sale costs about 0.02 HYPE
  const l = await creator.createLaunch({ name: "Shade", symbol: "SHADE", saleSupply: 1_000_000n * 10n ** 18n, minPrice: unit, tickSize: unit, numTicks: 50, commitEnd: now + 12, revealEnd: now + 50, lpBps: 8000 });
  const b = clients(chain, RPC, generatePrivateKey());
  const q = creator.quoteBid(await creator.getAuction(l.auction), unit * 20n, 1_000_000n * 10n ** 18n);
  await d.publicClient.waitForTransactionReceipt({ hash: await d.walletClient.sendTransaction({ to: b.account.address, value: q.cost + parseEther("0.01") }) });
  await new Cloak(b.publicClient, b.walletClient).bid(l.auction, { maxPrice: unit * 20n, quantity: 1_000_000n * 10n ** 18n, deposit: q.cost });
  const s = await creator.getAuction(l.auction);
  await waitChainTime(d.publicClient, s.commitEnd, { mine });
  await waitDrand(s.tlockRound);
  await creator.revealAll(l.auction, { fromBlock: l.block });
  await waitChainTime(d.publicClient, s.revealEnd, { mine });
  if (mine) await mine();
  await creator.settle(l.auction);
  await creator.claimAll(l.auction, { fromBlock: l.block });
  const st = await creator.getAuction(l.auction);
  ok(st.feesOwed === (st.raised * 150n) / 10_000n, `launch fee: 1.5% of the ${fmt(st.raised, 4)} HYPE raise owed to the treasury`);
  await creator.payOut(l.auction);
  ok((await creator.getAuction(l.auction)).creatorOwed === 0n, "creator proceeds and launch fee pulled out");
  launchIndex = (await d.publicClient.readContract({ address: factory, abi: cloakFactoryAbi, functionName: "launchesCount" })) - 1n;
  console.log(`launch ${l.auction} settled`);
}

// 2. privacy contracts + private market for the launch
let router = process.env.ROUTER;
let routerBlock = BigInt(process.env.ROUTER_BLOCK ?? 0);
config ??= await d.publicClient.readContract({ address: factory, abi: cloakFactoryAbi, functionName: "config" });
if (!router) {
  const p = await deployPrivacy(d.publicClient, d.walletClient, factory, { config });
  router = p.router;
  routerBlock = p.block;
  txs.deployRouter = p.txHash;
  console.log(`router ${router}`);
}
let batcher = process.env.BATCHER;
let batcherBlock = BigInt(process.env.BATCHER_BLOCK ?? 0);
if (!batcher) {
  const b = await deployBatcher(d.publicClient, d.walletClient, router, { roundSecs: local ? 8 : 30, maxSlippageBps: 200, refundAfter: 600 });
  batcher = b.batcher;
  await exempt(d.publicClient, d.walletClient, config, [router, batcher]);
  batcherBlock = b.block;
  txs.deployBatcher = b.txHash;
  console.log(`batcher ${batcher}`);
}
const [, token] = await d.publicClient.readContract({ address: factory, abi: cloakFactoryAbi, functionName: "launches", args: [launchIndex] });
const SYM = await d.publicClient.readContract({ address: token, abi: cloakTokenAbi, functionName: "symbol" });
const existing = await d.publicClient.readContract({ address: router, abi: privateRouterAbi, functionName: "poolOf", args: [token] });
if (existing === "0x0000000000000000000000000000000000000000") {
  const h = await d.walletClient.writeContract({ address: router, abi: privateRouterAbi, functionName: "createPool", args: [launchIndex] });
  await d.publicClient.waitForTransactionReceipt({ hash: h });
  txs.createPool = h;
}
ok(true, "private market enabled for the launch token");

// 3. trader: a public wallet that funds once, then trades privately via a relayer
const trader = clients(chain, RPC, generatePrivateKey());
await d.publicClient.waitForTransactionReceipt({ hash: await d.walletClient.sendTransaction({ to: trader.account.address, value: (relayed ? parseEther("0.03") : parseEther("2") / scale) + parseEther("0.003") }) });
const relayer = clients(chain, RPC, RELAYER_PK);
const root = new URL("..", import.meta.url).pathname;
const prover = createProver(readFileSync(`${root}apps/web/public/circuits/transaction2x2.wasm`), readFileSync(`${root}apps/web/public/circuits/transaction2x2_final.zkey`));
const submit = process.env.RELAYER_URL ? relayerSubmitter(process.env.RELAYER_URL) : walletSubmitter(relayer.publicClient, relayer.walletClient, router, batcher);
const keys = await CloakPrivate.keysFromWallet(trader.walletClient, { chainId: chain.id, router, verify: true });
const priv = new CloakPrivate(d.publicClient, router, keys, async () => prover, submit, routerBlock, batcher);
const markets = await priv.loadMarkets();
const hypePool = markets[0].pool;
const tokenPool = priv.market(token).pool;

const shieldAmt = relayed ? parseEther("0.03") : parseEther("2") / scale;
txs.shield = await priv.shieldHype(trader.walletClient, shieldAmt);
ok((await priv.balance(hypePool)) === shieldAmt, `shielded ${fmt(shieldAmt, 4)} HYPE into a private balance`);

const t0 = Date.now();
const buy = await priv.buy(token, parseEther("1") / scale, { onStatus: (m) => console.log(`    · ${m}`) });
txs.privateBuy = buy.txHash;
console.log(`    proof + relay in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
const tokBal = await priv.balance(tokenPool);
ok(tokBal >= buy.minOut && tokBal > 0n, `private buy: ${fmt(tokBal, 0)} ${SYM} now in private balance`);
ok(near(await priv.balance(hypePool), shieldAmt - parseEther("1") / scale - buy.relayerFee), `private HYPE change returned as a hidden note${relayed ? ` (relayer fee ${fmt(buy.relayerFee, 6)} HYPE)` : ""}`);

const buyTx = await d.publicClient.getTransaction({ hash: buy.txHash });
const buyRcpt = await d.publicClient.getTransactionReceipt({ hash: buy.txHash });
const traderHex = trader.account.address.slice(2).toLowerCase();
ok(buyTx.from.toLowerCase() === relayer.account.address.toLowerCase(), "trade sent by the relayer, not the trader");
ok(!buyTx.input.toLowerCase().includes(traderHex) && !buyRcpt.logs.some((l) => (l.data + l.topics.join("")).toLowerCase().includes(traderHex)), "trader address appears nowhere in the trade's calldata or logs");

const sell = await priv.sell(token, tokBal / 2n, { onStatus: (m) => console.log(`    · ${m}`) });
txs.privateSell = sell.txHash;
const hypeAfter = await priv.balance(hypePool);
ok(hypeAfter > shieldAmt - parseEther("1") / scale - buy.relayerFee, `private sell: private HYPE back up to ${fmt(hypeAfter, 4)}`);
const tokLeft = await priv.balance(tokenPool);
ok(relayed ? tokLeft > 0n && tokLeft <= tokBal - tokBal / 2n : tokLeft === tokBal - tokBal / 2n, `remaining ${SYM} still private${relayed ? " (the sell paid its relayer fee in tokens)" : ""}`);

const fresh = clients(chain, RPC, generatePrivateKey()).account.address;
const out = parseEther("0.5") / scale;
txs.unshield = await priv.unshieldHype(fresh, out, (m) => console.log(`    · ${m}`));
const net = await d.publicClient.readContract({ address: hypePool, abi: shieldedPoolAbi, functionName: "afterFee", args: [out] });
ok(net === out - (out * 25n) / 10_000n && (await d.publicClient.getBalance({ address: fresh })) === net, `unshielded ${fmt(out, 4)} HYPE to a brand-new address, ${fmt(out - net, 6)} kept as the 0.25% fee`);
ok((await d.publicClient.readContract({ address: hypePool, abi: shieldedPoolAbi, functionName: "feesOwed" })) > 0n, "withdrawal fees are waiting in the vault for collectFees()");

// a second trader can't see the first one's notes
const other = new CloakPrivate(d.publicClient, router, await CloakPrivate.keysFromWallet(clients(chain, RPC, generatePrivateKey()).walletClient, { chainId: chain.id, router }), async () => prover, submit, routerBlock, batcher);
await other.loadMarkets();
ok((await other.balance(hypePool)) === 0n && (await other.balance(tokenPool)) === 0n, "another account sees none of these notes");

// ── private send: amount, sender and recipient hidden ──
const sendAmt = relayed ? parseEther("0.006") : parseEther("0.3") / scale; // relayed: enough for the other account's fees too
const hypeBeforeSend = await priv.balance(hypePool);
txs.privateSend = await priv.send(markets[0].token, await other.address(), sendAmt, (m) => console.log(`    · ${m}`));
ok((await other.balance(hypePool)) === sendAmt, `private send: the other account received ${fmt(sendAmt, 4)} HYPE`);
ok(near(await priv.balance(hypePool), hypeBeforeSend - sendAmt), "sender's private balance went down by the same hidden amount");
const sendTx = await d.publicClient.getTransaction({ hash: txs.privateSend });
const sendRc = await d.publicClient.getTransactionReceipt({ hash: txs.privateSend });
const sendAmtHex = sendAmt.toString(16);
ok(!sendTx.input.toLowerCase().includes(sendAmtHex.padStart(32, "0")) && !sendRc.logs.some((l) => l.data.toLowerCase().includes(sendAmtHex.padStart(32, "0"))), "the sent amount appears nowhere in the transaction");

// ── batch auction: standard-size orders, crossed at mid, only the net hits the pool ──
const tokBefore = await priv.balance(tokenPool);
const hypeOtherBefore = await other.balance(hypePool);
// other buys a few tokens instantly so it has something to sell in the batch
const otherBuy = relayed ? parseEther("0.003") : parseEther("0.1") / scale; // relayed: worth more than the order fees
await other.buy(token, otherBuy);
const otherTok = await other.balance(tokenPool);
const buyAmt = parseEther("0.37") / scale; // → 0.2 + 0.1 + 0.05 + 0.02
const placedBuy = await priv.batch(token, "buy", buyAmt, { onStatus: (m) => console.log(`    · ${m}`) });
const placedSell = await other.batch(token, "sell", otherTok, { maxOrders: 3, onStatus: (m) => console.log(`    · ${m}`) });
const allOrders = [...placedBuy.orders, ...placedSell.orders];
txs.batchOrder = allOrders[0].txHash;
ok(placedBuy.orders.length === 4 && placedBuy.rest === 0n, `0.37 HYPE (scaled) split into 4 standard-size buy orders`);
const bc = { address: batcher, abi: privateBatcherAbi };
for (const o of allOrders) {
  const tx = await d.publicClient.getTransaction({ hash: o.txHash });
  if (tx.from.toLowerCase() !== relayer.account.address.toLowerCase()) throw new Error("order not relayed");
}
ok(true, `${allOrders.length} orders placed, every one sent by the relayer`);
// act as the keeper: settle each round that has orders, then pay out
const rounds = [...new Set(allOrders.map((o) => o.round))];
const roundSecs = await d.publicClient.readContract({ ...bc, functionName: "roundSecs" });
for (const r of rounds) {
  await waitChainTime(d.publicClient, Number((r + 1n) * roundSecs), { mine });
  if (mine) await mine();
  await sleep(local ? 0 : 8000); // a hosted keeper may settle first
  const st = await d.publicClient.readContract({ ...bc, functionName: "batches", args: [token, r] });
  if (st[7]) continue; // already settled by a keeper
  // like the keeper: if an earlier round's net swap just moved the pool, wait for this round's TWAP to catch up
  for (let tries = 0; ; tries++) {
    try {
      await d.publicClient.simulateContract({ ...bc, functionName: "settle", args: [token, r], account: relayer.account });
      break;
    } catch (e) {
      if (tries > 30 || !String(e.message).includes("PriceMoved")) throw e;
      console.log(`    · round ${r}: price still settling, retrying`);
      await sleep(local ? 0 : 10_000);
      if (mine) await mine();
    }
  }
  const h = await relayer.walletClient.writeContract({ ...bc, functionName: "settle", args: [token, r] });
  await d.publicClient.waitForTransactionReceipt({ hash: h });
  txs.batchSettle = h;
}
const ch = await relayer.walletClient.writeContract({ ...bc, functionName: "claim", args: [allOrders.map((o) => o.id)] });
await d.publicClient.waitForTransactionReceipt({ hash: ch });
txs.batchClaim = ch;
const gained = (await priv.balance(tokenPool)) - tokBefore;
ok(gained > 0n, `batched buy filled: +${fmt(gained, 0)} ${SYM} privately`);
const otherHype = await other.balance(hypePool);
ok(otherHype + slack > hypeOtherBefore - otherBuy, `batched sell filled: other account has ${fmt(otherHype, 5)} private HYPE`);
// uniform price inside a round: every buy order in the same round got the same rate
const fills = await d.publicClient.getContractEvents({ ...bc, eventName: "OrderFilled", fromBlock: batcherBlock, strict: true });
const byId = new Map(fills.map((f) => [f.args.id, f.args.amountOut]));
const sameRoundBuys = placedBuy.orders.filter((o) => o.round === placedBuy.orders[0].round);
const rates = sameRoundBuys.map((o) => (byId.get(o.id) * 10n ** 18n) / o.size); // every order pays the same fee rate
ok(rates.every((x) => (x > rates[0] ? x - rates[0] : rates[0] - x) * 10n ** 9n <= rates[0]), `uniform price: ${sameRoundBuys.length} buy orders in one round all filled at the same rate`);

console.log(`\n${checks} checks passed`);
if (!local) {
  mkdirSync(new URL("../deployments", import.meta.url), { recursive: true });
  const outj = { chainId: chain.id, factory, router, routerBlock: routerBlock.toString(), batcher, batcherBlock: batcherBlock.toString(), token, hypePool, tokenPool, txs: Object.fromEntries(Object.entries(txs).map(([k, v]) => [k, explorer(v)])) };
  writeFileSync(new URL("../deployments/elysium-testnet-private-v2.json", import.meta.url), JSON.stringify(outj, null, 2));
  console.log(JSON.stringify(outj, null, 2));
}
process.exit(0); // snarkjs leaves worker threads alive
