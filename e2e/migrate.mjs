// Migration e2e with REAL Groth16 proofs, on a local chain:
//   1. deploy the FIRST Cloak deployment (v1 bytecode from e2e/v1), hold private HYPE and tokens in it,
//   2. deploy v2 next to it (reusing v1's WHYPE, with a pool for the v1 launch), plus CloakMigrator and a keeper,
//   3. move every private balance across through the keeper's relayer (paying its fee) and check nothing is lost.
//   anvil --balance 1000000 & ; node e2e/migrate.mjs
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { generatePrivateKey } from "viem/accounts";
import { anvilLocal, CloakPrivate, commitmentOf, createProver, randomSalt, relayerSubmitter, walletSubmitter, privateRouterAbi, shieldedPoolAbi } from "@cloakonelysium/sdk";
import { clients, deployBatcher, deployFactory, deployMigrator, deployPrivacy, exempt, fmt, parseEther, sleep, waitChainTime } from "./lib.mjs";
import * as v1 from "./v1/abis.mjs";
import { bytecodeV1 } from "./v1/bytecode.mjs";

const RPC = "http://127.0.0.1:8545";
const chain = anvilLocal;
const PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const KEEPER_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
let checks = 0;
const ok = (c, m) => {
  if (!c) throw new Error(`✗ ${m}`);
  checks++;
  console.log(`  ✓ ${m}`);
};
const d = clients(chain, RPC, PK);
const mine = () => d.publicClient.request({ method: "evm_mine", params: [] });
const send = async (p) => d.publicClient.waitForTransactionReceipt({ hash: await p });
const deployV1 = async (name, args = []) => (await send(d.walletClient.deployContract({ abi: v1[name[0].toLowerCase() + name.slice(1) + "Abi"] ?? [], bytecode: bytecodeV1[name], args }))).contractAddress;
const raw = async (data) => (await send(d.walletClient.sendTransaction({ data }))).contractAddress;

// ── 1. the first deployment ──
console.log("v1: factory, launch, router");
const p2 = await raw(bytecodeV1.Poseidon2);
const p3 = await raw(bytecodeV1.Poseidon3);
const verifier = await raw(bytecodeV1.Groth16Verifier);
const factoryV1 = await deployV1("CloakFactory");
const now = Number((await d.publicClient.getBlock()).timestamp);
const params = { creator: d.account.address, saleSupply: 10n ** 24n, lpReserve: 10n ** 24n, minPrice: 10n ** 14n, tickSize: 10n ** 14n, numTicks: 10, commitEnd: BigInt(now + 10), revealEnd: BigInt(now + 20), lpBps: 8000, noRevealPenaltyBps: 0, lpLockUntil: 0n, tlockRound: 1n };
await send(d.walletClient.writeContract({ address: factoryV1, abi: v1.cloakFactoryAbi, functionName: "createLaunch", args: ["Old", "OLD", 0n, params, ""] }));
const [auction, token] = await d.publicClient.readContract({ address: factoryV1, abi: v1.cloakFactoryAbi, functionName: "launches", args: [0n] });
const salt = randomSalt();
await send(d.walletClient.writeContract({ address: auction, abi: v1.cloakAuctionAbi, functionName: "commit", args: [commitmentOf(auction, d.account.address, 4, 10n ** 24n, salt), "0x"], value: parseEther("500") }));
await waitChainTime(d.publicClient, now + 10, { mine });
await mine();
await send(d.walletClient.writeContract({ address: auction, abi: v1.cloakAuctionAbi, functionName: "reveal", args: [0n, 4, 10n ** 24n, salt] }));
await waitChainTime(d.publicClient, now + 20, { mine });
await mine();
await send(d.walletClient.writeContract({ address: auction, abi: v1.cloakAuctionAbi, functionName: "settle" }));
const routerV1 = (await send(d.walletClient.deployContract({ abi: v1.privateRouterAbi, bytecode: bytecodeV1.PrivateRouter, args: [verifier, p2, p3, factoryV1] }))).contractAddress;
await send(d.walletClient.writeContract({ address: routerV1, abi: v1.privateRouterAbi, functionName: "createPool", args: [0n] }));
const whype = await d.publicClient.readContract({ address: routerV1, abi: v1.privateRouterAbi, functionName: "whype" });

const root = new URL("..", import.meta.url).pathname;
const prover = createProver(readFileSync(`${root}apps/web/public/circuits/transaction2x2.wasm`), readFileSync(`${root}apps/web/public/circuits/transaction2x2_final.zkey`));
const trader = clients(chain, RPC, generatePrivateKey());
await send(d.walletClient.sendTransaction({ to: trader.account.address, value: parseEther("5") }));
const legacyKeys = await CloakPrivate.legacyKeysFromWallet(trader.walletClient);
const oldPriv = new CloakPrivate(d.publicClient, routerV1, legacyKeys, async () => prover, walletSubmitter(d.publicClient, d.walletClient, routerV1), 0n);
await oldPriv.loadMarkets();
await oldPriv.shieldHype(trader.walletClient, parseEther("3"));
await oldPriv.buy(token, parseEther("1"));
const oldHype = await oldPriv.balance(oldPriv.hypeMarket.pool);
const oldTok = await oldPriv.balance(oldPriv.market(token).pool);
ok(oldHype === parseEther("2") && oldTok > 0n, `v1 private balance: ${fmt(oldHype, 2)} HYPE and ${fmt(oldTok, 0)} OLD`);

// ── 2. v2 next to it ──
console.log("v2: config with fees, factory, router (legacy pools), batcher, migrator, keeper");
const f2 = await deployFactory(d.publicClient, d.walletClient, { verifier, rules: { withdrawFeeBps: 25, launchFeeBps: 150, caps: { assets: [[whype, parseEther("100"), parseEther("1000")]], defaultBps: [100n, 1000n], auction: [parseEther("100"), parseEther("5000")] } } });
const r2 = await deployPrivacy(d.publicClient, d.walletClient, f2.factory, { config: f2.config, poseidon2: p2, poseidon3: p3, legacyFactory: factoryV1, whype });
await send(d.walletClient.writeContract({ address: r2.router, abi: privateRouterAbi, functionName: "createLegacyPool", args: [0n] }));
const b2 = await deployBatcher(d.publicClient, d.walletClient, r2.router, { roundSecs: 8, maxSlippageBps: 200, refundAfter: 600 });
const m = await deployMigrator(d.publicClient, d.walletClient, routerV1, r2.router);
await exempt(d.publicClient, d.walletClient, f2.config, [r2.router, b2.batcher, m.migrator]);
ok(true, "v2 deployed with fees and caps on, reusing v1's WHYPE");

const keeper = spawn(process.execPath, [`${root}services/keeper/index.mjs`], {
  env: { ...process.env, RPC_URL: RPC, KEEPER_PK, FACTORY: f2.factory, ROUTER: r2.router, BATCHER: b2.batcher, MIGRATOR: m.migrator, LEGACY_ROUTER: routerV1, PORT: "3999", RELAY_PER_MIN: "1000" },
  stdio: ["ignore", "inherit", "inherit"],
});
const KEEPER = "http://127.0.0.1:3999";
for (let i = 0; i < 50; i++) {
  if (await fetch(`${KEEPER}/health`).then((r) => r.ok, () => false)) break;
  await sleep(200);
}
try {
  const relay = relayerSubmitter(KEEPER);
  const q = await relay.quote("migrate", oldPriv.hypeMarket.pool);
  ok(q.fee > 0n, `keeper quotes a relayer fee for a move: ${fmt(q.fee, 6)} HYPE`);

  // a call that pays the relayer nothing is refused before it costs any gas
  const freeRider = new CloakPrivate(d.publicClient, routerV1, legacyKeys, async () => prover, Object.assign((c) => relay(c), {}), 0n);
  const keysV2 = await CloakPrivate.keysFromWallet(trader.walletClient, { chainId: chain.id, router: r2.router, verify: true });
  const priv = new CloakPrivate(d.publicClient, r2.router, keysV2, async () => prover, relay, r2.block, b2.batcher, m.migrator);
  const unpaid = new CloakPrivate(d.publicClient, r2.router, keysV2, async () => prover, Object.assign((c) => relay(c), {}), r2.block, b2.batcher, m.migrator);
  await unpaid.loadMarkets();
  let refused = "";
  await unpaid.migrateFrom(freeRider).catch((e) => (refused = e.message));
  ok(/relayer fee|quote/.test(refused), "a relayed call without the relayer's fee is refused");

  // ── 3. move everything ──
  const oldRelayed = new CloakPrivate(d.publicClient, routerV1, legacyKeys, async () => prover, relay, 0n);
  const moved = await priv.migrateFrom(oldRelayed, (s) => console.log(`    · ${s}`));
  ok(moved.length === 2, `moved ${moved.length} balances in ${moved.length} relayed transactions`);
  const newHype = await priv.balance(priv.hypeMarket.pool);
  const newTok = await priv.balance(priv.market(token).pool);
  const qT = await relay.quote("migrate", oldPriv.market(token).pool);
  ok(newHype === oldHype - q.fee, `HYPE arrived in full, minus only the relayer fee: ${fmt(newHype, 6)}`);
  ok(newTok >= oldTok - qT.fee * 2n && newTok < oldTok, `OLD arrived in full, minus only the relayer fee: ${fmt(newTok, 0)}`);
  ok((await oldRelayed.balance(oldPriv.hypeMarket.pool)) === 0n, "nothing left behind in the v1 vault");
  for (const x of moved) {
    const tx = await d.publicClient.getTransaction({ hash: x.txHash });
    if (tx.from.toLowerCase() === trader.account.address.toLowerCase()) throw new Error("move sent by the trader");
  }
  ok(true, "every move was sent by the relayer, not the trader's wallet");

  // the moved balance works in v2: a private buy of the v1 launch token through the v2 router, fee applied
  const buy = await priv.buy(token, parseEther("0.5"));
  ok(buy.relayerFee > 0n, `private buy in v2 paid the relayer ${fmt(buy.relayerFee, 6)} HYPE inside the proof`);
  const fees = await d.publicClient.readContract({ address: priv.hypeMarket.pool, abi: shieldedPoolAbi, functionName: "feesOwed" });
  ok(fees === (parseEther("0.5") * 25n) / 10_000n, `0.25% protocol fee kept on the swap: ${fmt(fees, 6)} HYPE`);
} finally {
  keeper.kill();
}
console.log(`\n${checks} checks passed`);
process.exit(0);
