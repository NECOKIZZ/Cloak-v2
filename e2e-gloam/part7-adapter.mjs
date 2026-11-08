// Part 7: GloamPrivate, the backend the site's pages call (the same methods and return shapes as CloakPrivate), on
// anvil (chain 99801), Gloam's final keys, through the keeper's relay. Calls each method the way the pages do.
//
//   node e2e-gloam/part7-adapter.mjs
import { join } from "node:path";
import { formatEther, parseEther, zeroAddress } from "viem";
import { GloamPrivate, decodeFundsProof, encodeFundsProof, verifyFundsProof } from "@cloakely/sdk";
import { createGloamRelay } from "../services/keeper/gloam.mjs";
import { createGloamLoop } from "../services/keeper/gloamLoop.mjs";
import { deployCloakGloam } from "./stack.mjs";
import { ANVIL_KEYS, CIRCUITS, ELYSIUM_TESTNET_ID, assert, clients, finalProver, rpc, sendAndLog, startAnvil, writeMeasurements } from "./lib.mjs";

const snarkjs = await import("snarkjs");
const t0 = performance.now();
const anvil = await startAnvil({ port: 8561 });
const rpcUrl = anvil.rpcUrl;
const who = (i) => clients(rpcUrl, ANVIL_KEYS[i], ELYSIUM_TESTNET_ID);
const [dep, alice, bob, keeper] = [who(0), who(1), who(2), who(8)];
const pub = dep.pub;
try {
  console.log("Part 7 on anvil (chain 99801): GloamPrivate, the site's backend on Gloam");
  const ROUND = 60n;
  const { contracts: c, block } = await deployCloakGloam({ me: dep, rpcUrl, pk: ANVIL_KEYS[0], roundSecs: ROUND, seed: { hype: parseEther("50"), tokens: parseEther("50000") } });
  const relay = createGloamRelay({ publicClient: pub, walletClient: keeper.wallet, vault: c.gloamVault, launchVault: c.launchVault, memoBoard: c.memoBoard, escrows: [c.launchSwap, c.graduation, c.batcher, c.fundsGate], hourlySpendWei: parseEther("1") });
  const loop = createGloamLoop({ publicClient: pub, account: keeper.account, send: async (call) => (await sendAndLog(pub, call.functionName, keeper.wallet.writeContract(call))).transactionHash, launchVault: c.launchVault, batcher: c.batcher, batcherBlock: block });
  await loop.tick(); // admits the launch

  const provers = { shield: await finalProver("shield"), transfer: await finalProver("transfer"), unshield: await finalProver("unshield") };
  let saved = [];
  const cfg = {
    publicClient: pub,
    chainId: ELYSIUM_TESTNET_ID,
    gloamVault: { pool: c.gloamVault, poolBlock: block },
    launchVault: { pool: c.launchVault, poolBlock: block },
    payMemo: c.memoBoard,
    provers,
    submit: (call) => relay({ kind: call.kind, to: call.to, data: call.data }),
    whype: c.whypeStandIn,
    launchSwap: c.launchSwap,
    batcher: c.batcher,
    records: { load: () => saved, save: (r) => (saved = r) },
  };
  const A = await GloamPrivate.unlock(alice.wallet, cfg);
  const B = await GloamPrivate.unlock(bob.wallet, cfg);

  // markets, as the pages load them
  await A.loadMarkets();
  A.addAsset({ symbol: "USDC", token: "0x00000000000000000000000000000000000000Ee", decimals: 6 });
  assert(A.markets.length === 3 && A.hypeMarket.token === c.whypeStandIn && A.market(c.launchToken).pair !== null, "markets: HYPE, the launch token with its pool, and an added asset");
  const H = A.hypeMarket.pool;
  const T = A.market(c.launchToken).pool;

  // Portfolio: deposit, balance, send, receive, withdraw
  await A.shieldHype(alice.wallet, parseEther("3"));
  assert((await A.balance(H)) === parseEther("3"), "shieldHype, then balance(hypeMarket.pool) reads 3 HYPE");
  assert((await A.maxSpendable(H)) === parseEther("3") && (await A.relayFee("transact", H)).fee === 0n, "no relayer fee comes out of the balance");
  assert((await A.afterFee(H, parseEther("1"))) === parseEther("0.995"), "afterFee takes the vault's 0.5%");
  const bobAddr = await B.address();
  assert(bobAddr.startsWith("cloak:gloamr1."), `one private address for both vaults, in the site's cloak: format (${bobAddr.slice(0, 16)}…)`);
  const sendTx = await A.send(A.hypeMarket.token, bobAddr, parseEther("0.5"));
  assert(/^0x[0-9a-f]{64}$/.test(sendTx), "send(hypeMarket.token, …) returns its transaction hash, as the pages expect");
  assert((await B.balance(H)) === parseEther("0.5"), "Bob's balance shows the payment (swept into his own note on sync)");
  const out = who(9).account.address;
  const before = await pub.getBalance({ address: out });
  await B.unshieldHype(out, parseEther("0.5"));
  assert((await pub.getBalance({ address: out })) - before === parseEther("0.4975"), "unshieldHype pays 0.4975 HYPE to a public address");

  // Trade: instant buy and sell, the buffer back as a note
  const hypeBefore = await A.balance(H);
  const r = await A.buy(c.launchToken, parseEther("0.1"));
  assert(r.amountOut > 0n && (await A.balance(T)) === r.amountOut, `buy(token, 0.1 HYPE) gives exactly ${formatEther(r.amountOut)} tokens`);
  const spent = hypeBefore - (await A.balance(H));
  assert(spent < parseEther("0.1"), `and the price buffer came straight back: the buy cost ${formatEther(spent)} HYPE of the 0.1 sent`);
  const s = await A.sell(c.launchToken, parseEther("20"));
  assert(s.amountOut > 0n, `sell(token, 20) gives ${formatEther(s.amountOut)} HYPE as a note`);

  // Trade: batch order into the next round
  const b = await A.batch(c.launchToken, "buy", parseEther("0.25"));
  assert(b.orders.length === 2 && b.rest === 0n, "batch(token, buy, 0.25) places standard orders of 0.2 and 0.05");
  const info = await A.roundInfo();
  await rpc(rpcUrl, "evm_increaseTime", [info.roundSecs + 1]);
  await rpc(rpcUrl, "evm_mine");
  const t = await loop.tick();
  assert(t.rounds.some((x) => x.action === "settled"), "the keeper loop settles the round");

  // Funds page: an off-chain proof of funds for a named reader
  const prover = async (input) => snarkjs.groth16.fullProve(input, join(CIRCUITS, "funds.wasm"), join(CIRCUITS, "final/funds_final.zkey"));
  const pf = await A.proveFunds(A.hypeMarket.token, parseEther("1"), { label: "Landlord", expiresAt: Math.floor(Date.now() / 1000) + 86400, prover });
  const check = await verifyFundsProof(pub, decodeFundsProof(encodeFundsProof(pf)));
  assert(pf.v === 2 && check.ok, `proveFunds makes a shareable final-key proof (v2) that the site's checker passes: ${check.checks.map((x) => x.name).join(", ")}`);
  const bad = await verifyFundsProof(pub, { ...pf, label: "Someone else" });
  assert(!bad.ok, "and fails for another reader");

  // Links page: sweep everything to another private address
  const sw = await A.sweep(c.launchToken, bobAddr);
  assert(sw.amount > 0n && sw.left === 0n && (await B.balance(T)) === sw.amount, "sweep(token, gloamr1…) moves the whole balance privately");

  writeMeasurements("part7-adapter", { seconds: Math.round((performance.now() - t0) / 1000) });
  console.log(`\nPart 7 passed in ${Math.round((performance.now() - t0) / 1000)} s`);
} finally {
  anvil.stop();
}
process.exit(0);
