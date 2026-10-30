// v3 rehearsal on a fork of Elysium testnet, against the real v1 and v2 contracts, with REAL Groth16 proofs:
//   1. a fresh wallet holds private HYPE and SHADE in v2 (shield, then a private buy through v2's router),
//   2. it moves both into v3 through the keeper's relayer (v2 keys signed once, the v2→v3 migrator),
//   3. v3 works the same afterwards: a private swap and a withdrawal, and v1/v2 launches still list.
//   anvil --fork-url https://testnet-rpc.elysium.kinetiq.xyz --chain-id 31337 &
//   DEPLOYER_PK=0x… RPC_URL=http://127.0.0.1:8545 node e2e/deploy-v3.mjs && DEPLOYER_PK=0x… node e2e/fork-v3.mjs
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { defineChain } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Cloak, CloakPrivate, createProver, elysiumTestnet, relayerSubmitter, walletSubmitter } from "@cloakely/sdk";
import { clients, fmt, parseEther, sleep } from "./lib.mjs";

const RPC = "http://127.0.0.1:8545";
const root = new URL("..", import.meta.url).pathname;
const v3 = JSON.parse(readFileSync(`${root}deployments/elysium-testnet-v3.fork.json`, "utf8"));
const [v2, v1] = v3.previous;
const chain = defineChain({ ...elysiumTestnet, id: 31337, rpcUrls: { default: { http: [RPC] } } });
const SHADE = "0x4319AE71F27A2a7932c238B56f5F96A2B6b902cd";
let checks = 0;
const ok = (c, m) => {
  if (!c) throw new Error(`✗ ${m}`);
  checks++;
  console.log(`  ✓ ${m}`);
};
const d = clients(chain, RPC, process.env.DEPLOYER_PK);
const prover = createProver(readFileSync(`${root}apps/web/public/circuits/transaction2x2.wasm`), readFileSync(`${root}apps/web/public/circuits/transaction2x2_final.zkey`));

const PORT = "3994";
const keeper = spawn(process.execPath, [`${root}services/keeper/index.mjs`], {
  env: { ...process.env, RPC_URL: RPC, KEEPER_PK: process.env.DEPLOYER_PK, FACTORY: v3.factory, START_BLOCK: v3.factoryBlock, ROUTER: v3.router, BATCHER: v3.batcher, BATCHER_BLOCK: v3.batcherBlock, MIGRATIONS: `${v2.router}:${v2.migrator},${v1.router}:${v1.migrator}`, ASSET_POOLS: v3.assets[0].pool, HYPE_USD: "25", HYPE_PRICE_URL: "http://127.0.0.1:9/", PORT, RELAY_PER_MIN: "1000" },
  stdio: ["ignore", "ignore", "inherit"],
});
for (let i = 0; i < 100; i++) {
  if (await fetch(`http://127.0.0.1:${PORT}/health`).then((x) => x.ok, () => false)) break;
  await sleep(300);
}
try {
  const h = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
  ok(h.router === v3.router && h.migrations.length === 2, "keeper on v3, relaying moves from v2 and v1");

  // ── 1. a balance in v2 ──
  const u = clients(chain, RPC, generatePrivateKey());
  await d.publicClient.waitForTransactionReceipt({ hash: await d.walletClient.sendTransaction({ to: u.account.address, value: parseEther("0.02") }) });
  const oldKeys = await CloakPrivate.keysFromWallet(u.walletClient, { chainId: chain.id, router: v2.router });
  const old = new CloakPrivate(d.publicClient, v2.router, oldKeys, async () => prover, walletSubmitter(d.publicClient, d.walletClient, v2.router), BigInt(v2.routerBlock));
  await old.loadMarkets();
  await old.shieldHype(u.walletClient, parseEther("0.016"));
  const buy = await old.buy(SHADE, parseEther("0.007"));
  await d.publicClient.waitForTransactionReceipt({ hash: buy.txHash });
  const oldHype = await old.balance(old.hypeMarket.pool);
  const oldShade = await old.balance(old.market(SHADE).pool);
  ok(oldHype > 0n && oldShade > 0n, `v2: ${fmt(oldHype)} private HYPE and ${fmt(oldShade, 2)} private SHADE`);

  // ── 2. move it to v3 through the relayer ──
  const relay = relayerSubmitter(`http://127.0.0.1:${PORT}`);
  const keys = await CloakPrivate.keysFromWallet(u.walletClient, { chainId: chain.id, router: v3.router });
  const now = new CloakPrivate(d.publicClient, v3.router, keys, async () => prover, relay, BigInt(v3.routerBlock), v3.batcher, v2.migrator);
  await now.loadMarkets();
  ok(now.markets.some((m) => m.token.toLowerCase() === SHADE.toLowerCase()), "v3 has a vault for v2's SHADE launch");
  for (const pool of [old.hypeMarket.pool, old.market(SHADE).pool]) {
    const q = await relay.quote("migrate", pool).catch((e) => ({ error: e.message }));
    console.log(`    · move quote for ${pool}: ${q.error ?? `${q.fee} to ${q.relayer}`}`);
  }
  const moved = await now.migrateFrom(old, (m) => console.log(`    · ${m}`), { migrator: v2.migrator });
  const tx = await d.publicClient.getTransaction({ hash: moved[0].txHash });
  ok(moved.length === 2 && tx.from.toLowerCase() === d.account.address.toLowerCase() && tx.to.toLowerCase() === v2.migrator.toLowerCase(), "moved HYPE and SHADE to v3 through the v2→v3 migrator, sent by the relayer");
  const newHype = await now.balance(now.hypeMarket.pool);
  const newShade = await now.balance(now.market(SHADE).pool);
  ok(newHype > 0n && newHype < oldHype && newShade > 0n && newShade < oldShade, `v3: ${fmt(newHype)} HYPE and ${fmt(newShade, 2)} SHADE (minus the relayer's fee and 0.25%)`);
  ok((await old.balance(old.hypeMarket.pool)) === 0n && (await old.balance(old.market(SHADE).pool)) === 0n, "nothing left behind in v2");

  // ── 3. v3 keeps working ──
  const sell = await now.sell(SHADE, (await now.maxSpendable(now.market(SHADE).pool, "privateSwap")) / 2n);
  await d.publicClient.waitForTransactionReceipt({ hash: sell.txHash });
  ok((await now.balance(now.market(SHADE).pool)) < newShade, "private sell of migrated SHADE on v3");
  const fresh = privateKeyToAccount(generatePrivateKey()).address;
  const w = await now.unshieldHype(fresh, parseEther("0.0005"));
  await d.publicClient.waitForTransactionReceipt({ hash: w });
  ok((await d.publicClient.getBalance({ address: fresh })) > 0n, "withdrew v3 HYPE to a fresh address");
  const listed = await new Cloak(d.publicClient, undefined, v3.factory, [v2.factory, v1.factory]).listLaunches();
  ok(listed.filter((l) => l.factory.toLowerCase() === v2.factory.toLowerCase()).length === 7 && listed.filter((l) => l.factory.toLowerCase() === v1.factory.toLowerCase()).length === 5, "v1 and v2 launches still list next to v3");
} finally {
  keeper.kill();
}
console.log(`\n${checks} checks passed`);
process.exit(0);
