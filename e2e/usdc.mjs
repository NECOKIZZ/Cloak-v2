// Private USDC e2e with REAL Groth16 proofs, on a local chain: a 6-decimal USDC, its permanent vault (CloakVaults),
// deposit caps, and the keeper relaying sends and withdrawals with its fee priced in USDC.
//   shield (public) → private send to another account → withdraw to a fresh address → withdraw the max
//   anvil --balance 1000000 & ; node e2e/usdc.mjs   (needs `forge build` for the MockUSDC artifact)
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { anvilLocal, CloakPrivate, createProver, relayerSubmitter, shieldedPoolAbi, cloakConfigAbi } from "@cloakely/sdk";
import { bytecode } from "@cloakely/sdk/bytecode";
import { assetVault, clients, deployFactory, deployPrivacy, parseEther, sleep } from "./lib.mjs";

const RPC = "http://127.0.0.1:8545";
const chain = anvilLocal;
const PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const KEEPER_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const HYPE_USD = 25; // the keeper's fallback price; the live feed is switched off so the fee is predictable
const usd = (x) => (Number(x) / 1e6).toFixed(6);
let checks = 0;
const ok = (c, m) => {
  if (!c) throw new Error(`✗ ${m}`);
  checks++;
  console.log(`  ✓ ${m}`);
};
const d = clients(chain, RPC, PK);
const send = async (p) => d.publicClient.waitForTransactionReceipt({ hash: await p });
const root = new URL("..", import.meta.url).pathname;
const mock = JSON.parse(readFileSync(`${root}contracts/out/MockUSDC.sol/MockUSDC.json`, "utf8"));
const erc20 = mock.abi;

console.log("deploy: config (fees + caps), factory, router, USDC, USDC pool");
const f = await deployFactory(d.publicClient, d.walletClient, { rules: { withdrawFeeBps: 25, launchFeeBps: 150 } });
const r = await deployPrivacy(d.publicClient, d.walletClient, f.factory, { config: f.config });
const usdc = (await send(d.walletClient.deployContract({ abi: erc20, bytecode: mock.bytecode.object }))).contractAddress;
const pool = await assetVault(d.publicClient, d.walletClient, f.config, r.vaults, usdc);
const poolRc = { blockNumber: await d.publicClient.getBlockNumber() };
await send(d.walletClient.writeContract({ address: f.config, abi: cloakConfigAbi, functionName: "turnOnDepositLimits" }));
await send(d.walletClient.writeContract({ address: f.config, abi: cloakConfigAbi, functionName: "setLimit", args: [usdc, 1_000_000_000n, 50_000_000_000n] }));
const [on, per, total] = await d.publicClient.readContract({ address: f.config, abi: cloakConfigAbi, functionName: "limitOf", args: [usdc] });
ok(on && per === 1_000_000_000n && total === 50_000_000_000n, "USDC caps: 1,000 per deposit, 50,000 in the pool");

const keeper = spawn(process.execPath, [`${root}services/keeper/index.mjs`], {
  env: { ...process.env, RPC_URL: RPC, KEEPER_PK, CONFIG: f.config, HYPE_USD: String(HYPE_USD), HYPE_PRICE_URL: "http://127.0.0.1:9/", PORT: "3998", RELAY_PER_MIN: "1000" },
  stdio: ["ignore", "inherit", "inherit"],
});
const KEEPER = "http://127.0.0.1:3998";
for (let i = 0; i < 50; i++) {
  if (await fetch(`${KEEPER}/health`).then((x) => x.ok, () => false)) break;
  await sleep(200);
}
const relayer = privateKeyToAccount(KEEPER_PK).address;
try {
  const prover = createProver(readFileSync(`${root}apps/web/public/circuits/transaction2x2.wasm`), readFileSync(`${root}apps/web/public/circuits/transaction2x2_final.zkey`));
  const relay = relayerSubmitter(KEEPER);
  const account = async () => {
    const c = clients(chain, RPC, generatePrivateKey());
    await send(d.walletClient.sendTransaction({ to: c.account.address, value: parseEther("5") }));
    const keys = await CloakPrivate.keysFromWallet(c.walletClient, { chainId: chain.id, verify: true });
    const p = new CloakPrivate(d.publicClient, r.router, keys, async () => prover, relay, r.block);
    await p.loadMarkets();
    // the router lists the USDC vault as an asset (it has no launch pair)
    if (!p.assets.some((x) => x.pool.toLowerCase() === pool.toLowerCase())) throw new Error("USDC vault not found through the router");
    return { ...c, p };
  };
  const a = await account();
  const b = await account();
  await send(d.walletClient.writeContract({ address: usdc, abi: erc20, functionName: "mint", args: [a.account.address, 5_000_000_000n] }));

  // ── fee quote in USDC ──
  const q = await relay.quote("transact", pool);
  const gasPrice = await d.publicClient.getGasPrice();
  const floor = gasPrice > 100_000_000n ? gasPrice : 100_000_000n;
  const want = (1_900_000n * floor * 12_500n / 10_000n) * BigInt(HYPE_USD * 1e6) * 1_000_000n / (10n ** 18n * 1_000_000n) + 1n;
  ok(q.fee === want && q.relayer === relayer, `relayer quotes its fee in USDC: ${usd(q.fee)} USDC (gas cost × 1.25 at $${HYPE_USD}/HYPE)`);
  const swapQ = await fetch(`${KEEPER}/quote?kind=privateSwap&pool=${pool}`).then((x) => x.status);
  ok(swapQ === 400, "the USDC pool is offered for sends and withdrawals only (no swaps yet)");

  // ── shield ──
  const h1 = await a.p.shieldToken(a.walletClient, usdc, 800_000_000n);
  ok((await a.p.balance(pool)) === 800_000_000n, `shielded 800 USDC (approve + deposit, one-time key) ${h1.slice(0, 10)}…`);
  let refused = "";
  await a.p.shieldToken(a.walletClient, usdc, 1_000_000_001n).catch((e) => (refused = e.shortMessage ?? e.message));
  ok(/OverDepositLimit|reverted/.test(refused), "a deposit over the 1,000 USDC cap is refused");
  const nonce = await d.publicClient.getTransactionCount({ address: b.account.address });
  let empty = "";
  await b.p.shieldToken(b.walletClient, usdc, 1_000_000n).catch((e) => (empty = e.message));
  ok(/insufficient token balance in wallet/.test(empty) && (await d.publicClient.getTransactionCount({ address: b.account.address })) === nonce, "a wallet without USDC is told before any approval is sent (no gas spent)");

  // ── private send ──
  const sent = await a.p.send(usdc, await b.p.address(), 300_000_000n);
  const sentTx = await d.publicClient.getTransaction({ hash: sent });
  await d.publicClient.waitForTransactionReceipt({ hash: sent });
  ok(sentTx.from.toLowerCase() === relayer.toLowerCase(), "private send was sent by the relayer, not the sender's wallet");
  ok((await b.p.balance(pool)) === 300_000_000n, "the other account received 300 private USDC");
  const aLeft = await a.p.balance(pool);
  ok(aLeft >= 800_000_000n - 300_000_000n - q.fee * 2n && aLeft < 500_000_000n, `sender has ${usd(aLeft)} private USDC left (paid the relayer in USDC)`);
  ok(!JSON.stringify(sentTx.input).toLowerCase().includes(a.account.address.slice(2).toLowerCase()), "the sender's address appears nowhere in the send");

  // ── withdraw to a fresh address ──
  const fresh = privateKeyToAccount(generatePrivateKey()).address;
  const before = await d.publicClient.readContract({ address: usdc, abi: erc20, functionName: "balanceOf", args: [relayer] });
  const w = await b.p.unshieldToken(usdc, fresh, 100_000_000n);
  await d.publicClient.waitForTransactionReceipt({ hash: w });
  const got = await d.publicClient.readContract({ address: usdc, abi: erc20, functionName: "balanceOf", args: [fresh] });
  ok(got === 99_750_000n, "fresh address received 99.75 USDC (0.25% fee kept)");
  const after = await d.publicClient.readContract({ address: usdc, abi: erc20, functionName: "balanceOf", args: [relayer] });
  ok(after > before, `relayer was paid ${usd(after - before)} USDC for the withdrawal`);
  const fees = await d.publicClient.readContract({ address: pool, abi: shieldedPoolAbi, functionName: "feesOwed" });
  ok(fees === 250_000n, "0.25 USDC protocol fee waiting in the pool for collectFees()");

  // ── withdraw the max ──
  const max = await a.p.maxSpendable(pool, "transact");
  const w2 = await a.p.unshieldToken(usdc, fresh, max);
  await d.publicClient.waitForTransactionReceipt({ hash: w2 });
  const dust = await a.p.balance(pool);
  ok(dust <= q.fee / 2n, `withdrew the max (${usd(max)} USDC); only ${usd(dust)} USDC stays behind, the cushion for a moving relayer fee`);
  const bal = await d.publicClient.readContract({ address: usdc, abi: erc20, functionName: "balanceOf", args: [pool] });
  const dep = await d.publicClient.readContract({ address: pool, abi: shieldedPoolAbi, functionName: "deposited" });
  ok(bal >= dep + (await d.publicClient.readContract({ address: pool, abi: shieldedPoolAbi, functionName: "feesOwed" })), "pool stays solvent: holds every deposit plus fees owed");
} finally {
  keeper.kill();
}
console.log(`\n${checks} checks passed`);
process.exit(0);
