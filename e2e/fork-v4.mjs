// v4 rehearsal on a fork of Elysium testnet, against the real v1, v2 and v3 contracts, with REAL Groth16 proofs:
//   1. a fresh wallet holds private HYPE and SHADE in v3 (shield, then a private buy through v3's router),
//   2. it moves both into the permanent v4 vaults through the keeper's relayer (v3 keys signed once, one migrator),
//   3. v4 works the same afterwards: a private sell and a withdrawal, every launch from v1 to v4 still lists, and the
//      registry in CloakConfig describes all of it.
//   anvil --fork-url https://testnet-rpc.elysium.kinetiq.xyz --chain-id 31337 &
//   DEPLOYER_PK=0x… RPC_URL=http://127.0.0.1:8545 node e2e/deploy-v4.mjs && DEPLOYER_PK=0x… node e2e/fork-v4.mjs
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { defineChain } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Cloak, CloakPrivate, createProver, elysiumTestnet, readRegistry, relayerSubmitter, walletSubmitter } from "@cloakely/sdk";
import { clients, fmt, parseEther, sleep } from "./lib.mjs";

const RPC = "http://127.0.0.1:8545";
const root = new URL("..", import.meta.url).pathname;
const v4 = JSON.parse(readFileSync(`${root}deployments/elysium-testnet-v4.fork.json`, "utf8"));
const [v3, v2, v1] = v4.previous;
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
  env: { ...process.env, RPC_URL: RPC, KEEPER_PK: process.env.DEPLOYER_PK, CONFIG: v4.config, HYPE_USD: "25", HYPE_PRICE_URL: "http://127.0.0.1:9/", PORT, RELAY_PER_MIN: "1000" },
  stdio: ["ignore", "ignore", "inherit"],
});
for (let i = 0; i < 100; i++) {
  if (await fetch(`http://127.0.0.1:${PORT}/health`).then((x) => x.ok, () => false)) break;
  await sleep(300);
}
try {
  const h = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
  const same = (a, b) => a?.toLowerCase() === b?.toLowerCase();
  ok(same(h.router, v4.router) && same(h.migrator, v4.migrator) && same(h.vaults, v4.vaults), `keeper reads v4 from CONFIG alone: router, permanent vaults, migrator (${JSON.stringify({ router: h.router, vaults: h.vaults, migrator: h.migrator })})`);
  const reg = await readRegistry(d.publicClient, v4.config);
  ok(reg.version === 4 && reg.previous.map((p) => p.version).join() === "3,2,1" && reg.previous.every((p) => p.router && p.factory && p.routerBlock > 0n) && reg.launchFactories.length === 4, "the registry lists v4 as current and v3, v2, v1 with their start blocks; all four factories can list vaults");

  // ── 1. a balance in v3 ──
  const u = clients(chain, RPC, generatePrivateKey());
  await d.publicClient.waitForTransactionReceipt({ hash: await d.walletClient.sendTransaction({ to: u.account.address, value: parseEther("0.02") }) });
  const oldKeys = await CloakPrivate.routerKeysFromWallet(u.walletClient, { chainId: chain.id, router: v3.router });
  const old = new CloakPrivate(d.publicClient, v3.router, oldKeys, async () => prover, walletSubmitter(d.publicClient, d.walletClient, v3.router), BigInt(v3.routerBlock));
  await old.loadMarkets();
  await old.shieldHype(u.walletClient, parseEther("0.016"));
  const buy = await old.buy(SHADE, parseEther("0.007"));
  await d.publicClient.waitForTransactionReceipt({ hash: buy.txHash });
  const oldHype = await old.balance(old.hypeMarket.pool);
  const oldShade = await old.balance(old.market(SHADE).pool);
  ok(oldHype > 0n && oldShade > 0n, `v3: ${fmt(oldHype)} private HYPE and ${fmt(oldShade, 2)} private SHADE`);

  // ── 2. move it into the permanent vaults through the relayer ──
  const relay = relayerSubmitter(`http://127.0.0.1:${PORT}`);
  const keys = await CloakPrivate.keysFromWallet(u.walletClient, { chainId: chain.id, verify: true });
  const now = new CloakPrivate(d.publicClient, v4.router, keys, async () => prover, relay, BigInt(v4.vaultsBlock), v4.batcher, v4.migrator);
  await now.loadMarkets();
  ok(now.markets.some((m) => same(m.token, SHADE)) && now.assets.some((a) => a.symbol === "USDC"), "the permanent vaults include SHADE (a v2 launch) and USDC (an asset vault)");
  for (const pool of [old.hypeMarket.pool, old.market(SHADE).pool]) {
    const q = await relay.quote("migrate", pool).catch((e) => ({ error: e.message }));
    console.log(`    · move quote for ${pool}: ${q.error ?? `${q.fee} to ${q.relayer}`}`);
  }
  const moved = await now.migrateFrom(old, (m) => console.log(`    · ${m}`));
  const tx = await d.publicClient.getTransaction({ hash: moved[0].txHash });
  ok(moved.length === 2 && same(tx.from, d.account.address) && same(tx.to, v4.migrator), "moved HYPE and SHADE into the permanent vaults through the one migrator, sent by the relayer");
  const newHype = await now.balance(now.hypeMarket.pool);
  const newShade = await now.balance(now.market(SHADE).pool);
  ok(newHype > 0n && newHype < oldHype && newShade > 0n && newShade < oldShade, `v4: ${fmt(newHype)} HYPE and ${fmt(newShade, 2)} SHADE (minus the relayer's fee and 0.25%)`);
  ok((await old.balance(old.hypeMarket.pool)) === 0n && (await old.balance(old.market(SHADE).pool)) === 0n, "nothing left behind in v3");

  // ── 3. v4 keeps working ──
  const sell = await now.sell(SHADE, (await now.maxSpendable(now.market(SHADE).pool, "privateSwap")) / 2n);
  await d.publicClient.waitForTransactionReceipt({ hash: sell.txHash });
  ok((await now.balance(now.market(SHADE).pool)) < newShade, "private sell of migrated SHADE on v4");
  const fresh = privateKeyToAccount(generatePrivateKey()).address;
  const w = await now.unshieldHype(fresh, parseEther("0.0005"));
  await d.publicClient.waitForTransactionReceipt({ hash: w });
  ok((await d.publicClient.getBalance({ address: fresh })) > 0n, "withdrew v4 HYPE to a fresh address");
  const listed = await new Cloak(d.publicClient, undefined, v4.factory, [v3.factory, v2.factory, v1.factory]).listLaunches();
  const by = (f) => listed.filter((l) => same(l.factory, f)).length;
  ok(by(v2.factory) >= 7 && by(v1.factory) === 5, `v1 (${by(v1.factory)}), v2 (${by(v2.factory)}) and v3 (${by(v3.factory)}) launches still list next to v4`);
} finally {
  keeper.kill();
}
console.log(`\n${checks} checks passed`);
process.exit(0);
