// Payment links end to end on Elysium testnet, with REAL proofs and the hosted relayer:
//   a claim link funded by a private send is claimed with nothing but the link, straight to a brand-new wallet that
//   holds no gas; a passcode-locked link opens nothing with the wrong code and is taken back by its sender.
//   LINK_PK=0x… (a testnet wallet with a private HYPE balance) node e2e/links.mjs
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, formatEther, http, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { CloakPrivate, buildClaimLink, createProver, elysiumTestnet, linkAddress, linkKeys, newLinkSecret, parseClaimLink, relayerSubmitter } from "@cloakely/sdk";

const root = new URL("../", import.meta.url).pathname;
const v4 = JSON.parse(readFileSync(`${root}deployments/elysium-testnet-v4.json`, "utf8"));
const KEEPER = process.env.KEEPER_URL || "https://cloak-keeper.onrender.com";
const pub = createPublicClient({ chain: elysiumTestnet, transport: http(), pollingInterval: 500 });
const circ = (f) => readFileSync(`${root}apps/web/public/circuits/${f}`);
const prover = createProver(circ("transaction2x2.wasm"), circ("transaction2x2_final.zkey"));
const relay = relayerSubmitter(KEEPER);
const client = (keys, from) => new CloakPrivate(pub, v4.router, keys, async () => prover, relay, from, v4.batcher, v4.migrator);
let n = 0;
const ok = (c, msg) => { if (!c) throw new Error(`✗ ${msg}`); n++; console.log(`  ✓ ${msg}`); };

const wallet = createWalletClient({ chain: elysiumTestnet, transport: http(), account: privateKeyToAccount(process.env.LINK_PK) });
const sender = client(await CloakPrivate.keysFromWallet(wallet, { chainId: elysiumTestnet.id }), BigInt(v4.vaultsBlock));
await sender.loadMarkets();
const hype = sender.hypeMarket;
const start = await sender.balance(hype.pool);
console.log(`sender private balance ${formatEther(start)} HYPE`);
if (start < parseEther("0.05")) throw new Error("the sender needs at least 0.05 private HYPE");

// 1. a plain link, claimed to a fresh wallet with no gas
const secret = newLinkSecret();
const amt = parseEther("0.01");
const tx = await sender.send(hype.token, await linkAddress(await linkKeys(secret)), amt);
const rc = await pub.waitForTransactionReceipt({ hash: tx });
const url = buildClaimLink({ secret, block: rc.blockNumber, token: "HYPE", amount: "0.01", message: "gm from the e2e" });
console.log(`link ${url.slice(0, 60)}…`);
const parsed = parseClaimLink(url);
const claimer = client(await linkKeys(parsed.secret), BigInt(v4.vaultsBlock));
ok(parsed.block === rc.blockNumber, "the link reads back with its funding block");
await claimer.loadMarkets();
ok((await claimer.balance(hype.pool)) === amt, "the link alone shows the 0.01 HYPE it holds");
const fresh = privateKeyToAccount(generatePrivateKey()).address;
ok((await pub.getBalance({ address: fresh })) === 0n, "the claiming wallet is brand new, with no gas");
const r = await claimer.sweep(hype.token, fresh);
await pub.waitForTransactionReceipt({ hash: r.txHash });
const got = await pub.getBalance({ address: fresh });
ok(got > 0n && got === (await claimer.afterFee(hype.pool, r.amount)), `claimed to that wallet: ${formatEther(got)} HYPE arrived (relayer and withdrawal fees from the link)`);
ok((await claimer.balance(hype.pool)) === 0n, "the link is empty afterwards");
await assertRejects(() => claimer.sweep(hype.token, fresh), "claiming the same link again is refused");

// 2. a locked link: the wrong passcode opens an empty account; the sender takes it back with the right one
const s2 = newLinkSecret();
const tx2 = await sender.send(hype.token, await linkAddress(await linkKeys(s2, "Elysium")), parseEther("0.005"));
await pub.waitForTransactionReceipt({ hash: tx2 });
const wrong = client(await linkKeys(s2, "hyperliquid"), BigInt(v4.vaultsBlock));
await wrong.loadMarkets();
ok((await wrong.balance(hype.pool)) === 0n, "a wrong passcode finds nothing");
const right = client(await linkKeys(s2, "  elysium "), BigInt(v4.vaultsBlock));
await right.loadMarkets();
ok((await right.balance(hype.pool)) === parseEther("0.005"), "the right passcode (any case, extra spaces) finds the 0.005 HYPE");
const before = await sender.balance(hype.pool);
const back = await right.sweep(hype.token, await sender.address());
await pub.waitForTransactionReceipt({ hash: back.txHash });
ok((await sender.balance(hype.pool)) === before + back.amount, `taken back into the sender's private balance (+${formatEther(back.amount)} HYPE)`);

// 3. a red envelope: one link, three shares, three people each claim one, and a fourth finds it empty
const s3 = newLinkSecret();
const k3 = await linkKeys(s3);
const share = parseEther("0.004");
for (let i = 0; i < 3; i++) await pub.waitForTransactionReceipt({ hash: await sender.send(hype.token, await linkAddress(k3), share) });
const env = parseClaimLink(buildClaimLink({ secret: s3, block: 1n, token: "HYPE", amount: "0.004", shares: 3 }));
ok(env.shares === 3, "the envelope link says it holds 3 shares");
const got3 = [];
for (let i = 0; i < 3; i++) {
  const c = client(await linkKeys(env.secret), BigInt(v4.vaultsBlock));
  await c.loadMarkets();
  const w = privateKeyToAccount(generatePrivateKey()).address;
  const r3 = await c.sweep(hype.token, w, () => {}, { one: true });
  await pub.waitForTransactionReceipt({ hash: r3.txHash });
  got3.push(await pub.getBalance({ address: w }));
}
// equal shares; what lands differs only by the relayer's fee, which follows gas and the HYPE price between claims
ok(got3.every((g) => g > 0n && (g > got3[0] ? g - got3[0] : got3[0] - g) * 50n < got3[0]), `three different wallets each claimed one share: ${got3.map((g) => formatEther(g)).join(", ")} HYPE`);
const late = client(await linkKeys(env.secret), BigInt(v4.vaultsBlock));
await late.loadMarkets();
ok((await late.balance(hype.pool)) === 0n, "a fourth person finds the envelope empty");

console.log(`\n${n} checks passed`);

async function assertRejects(f, msg) {
  try { await f(); } catch { return ok(true, msg); }
  throw new Error(`✗ ${msg}`);
}
