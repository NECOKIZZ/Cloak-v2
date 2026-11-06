// The shared launch-token vault, end to end with REAL proofs (both circuits) and a real Uniswap launch:
//   1. a Uniswap launch with a wallet bid and a private-balance bid; the keeper reveals, settles and admits the token to
//      the shared vault (no vault of its own),
//   2. the wallet bidder claims and shields into the shared vault; the private bidder wraps up into it,
//   3. a private send that hides its token (fee paid from private HYPE in the same transaction),
//   4. a private sell (token → HYPE) and a private buy (HYPE → token) through the Uniswap pool,
//   5. a withdrawal to a fresh address; the vault holds exactly what its notes and fees are worth; a forged proof fails.
// Fork (spawns a local keeper):  anvil --fork-url https://testnet-rpc.elysium.kinetiq.xyz --chain-id 31337 &
//   DEPLOYER_PK=0x… RPC_URL=http://127.0.0.1:8545 node e2e/deploy-shared.mjs && DEPLOYER_PK=0x… RPC_URL=http://127.0.0.1:8545 node e2e/shared.mjs
// Live testnet (hosted keeper):  DEPLOYER_PK=0x… node e2e/shared.mjs
// POOL=v4: the same run on the Uniswap v4 factory (fork: deploy with e2e/deploy-v4pools.mjs first), plus v4 checks:
//   the pool lists at the clearing price, the anti-snipe fee, and the creator collecting trading fees through the hook.
//   Mainnet rehearsal: DEPLOY_FILE=deployments/elysium-mainnet.fork.json on a fork of chain 99901 (e2e/deploy-mainnet.mjs).
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { decodeEventLog, defineChain, parseAbi } from "viem";
import { generatePrivateKey } from "viem/accounts";
import {
  cloakV4MarketAbi, Cloak, CloakPrivate, SharedVaultClient, cloakVaultsAbi, createProver, createSharedProver, elysiumTestnet, readRegistry, relayerSubmitter, sharedRelayerSubmitter, sharedVaultAbi,
} from "@cloakely/sdk";
import { clients, fmt, parseEther, sleep } from "./lib.mjs";

const RPC = process.env.RPC_URL || elysiumTestnet.rpcUrls.default.http[0];
const local = RPC.includes("127.0.0.1") || RPC.includes("localhost");
const root = new URL("..", import.meta.url).pathname;
const V4POOLS = process.env.POOL === "v4";
const v4 = JSON.parse(readFileSync(process.env.DEPLOY_FILE ? new URL(process.env.DEPLOY_FILE, `file://${process.cwd()}/`) : `${root}deployments/elysium-testnet-v4${local ? (V4POOLS ? "-v4pools.fork" : "-shared.fork") : ""}.json`, "utf8"));
const chain = local ? defineChain({ ...elysiumTestnet, id: 31337, rpcUrls: { default: { http: [RPC] } } }) : elysiumTestnet;
const S = local ? 1000n : 1n;
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"]);
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
  KEEPER = "http://127.0.0.1:3995";
  keeper = spawn(process.execPath, [`${root}services/keeper/index.mjs`], {
    env: { ...process.env, RPC_URL: RPC, KEEPER_PK: process.env.DEPLOYER_PK, CONFIG: v4.config, CLAIM_DELAY: "900", HYPE_USD: "25", HYPE_PRICE_URL: "http://127.0.0.1:9/", PORT: "3995", RELAY_PER_MIN: "1000", SNAPSHOT: "0" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  await until("keeper", () => fetch(`${KEEPER}/health`).then((x) => x.ok), 60);
}
const keys = {};
try {
  const h = await (await fetch(`${KEEPER}/health`)).json();
  ok(same(h.shared, v4.shared) && same(h.sharedRouter, v4.sharedRouter), `keeper relays for the shared vault ${h.shared}`);
  const reg = await readRegistry(pub, v4.config);
  ok(same(reg.shared, v4.shared) && same(reg.factory, v4.factory) && same(reg.vaults, v4.vaults), "registry: shared vault and router added, factory and vaults unchanged");
  const tokensBefore = await pub.readContract({ address: v4.shared, abi: sharedVaultAbi, functionName: "tokensCount" });

  // ── 1. a Uniswap launch, bid from a wallet and from a private balance ──
  const C = clients(chain, RPC, (keys.creator = generatePrivateKey()));
  const A = clients(chain, RPC, (keys.a = generatePrivateKey()));
  const P = clients(chain, RPC, (keys.p = generatePrivateKey()));
  if (process.env.KEYS_FILE) writeFileSync(process.env.KEYS_FILE, JSON.stringify(keys));
  await fund(C.account.address, "0.02");
  await fund(A.account.address, "0.05");
  await fund(P.account.address, "0.08");
  const creator = new Cloak(pub, C.walletClient, v4.factory);
  const now = Number((await pub.getBlock()).timestamp);
  const unit = 10n ** 9n * S;
  const sale = 1_000_000n * 10n ** 18n;
  const l = await creator.createLaunch({
    name: "Shared Shade", symbol: "SSHADE", saleSupply: sale, minPrice: unit, tickSize: unit, numTicks: 50,
    commitEnd: now + 240, revealEnd: now + 330, lpBps: 8000, lpLockUntil: "fees", noRevealPenaltyBps: 1000, metadataURI: "",
  });
  console.log(`    · launch ${l.auction}`);
  const s0 = await creator.getAuction(l.auction);
  const qA = creator.quoteBid(s0, unit * 10n, 600_000n * 10n ** 18n);
  await new Cloak(pub, A.walletClient).bid(l.auction, { maxPrice: unit * 10n, quantity: 600_000n * 10n ** 18n, deposit: qA.cost });

  const relay = relayerSubmitter(KEEPER);
  const sharedRelay = sharedRelayerSubmitter(KEEPER);
  const account = async (W) => {
    const k = await CloakPrivate.keysFromWallet(W.walletClient, { chainId: chain.id });
    const priv = new CloakPrivate(pub, v4.router, k, async () => prover, relay, BigInt(v4.vaultsBlock), v4.batcher, v4.migrator);
    await priv.loadMarkets();
    return { priv, shared: new SharedVaultClient(priv, v4.shared, v4.sharedRouter, async () => sharedProver, sharedRelay, BigInt(v4.sharedBlock)) };
  };
  const PA = await account(P);
  const AA = await account(A);
  await PA.priv.shieldHype(P.walletClient, parseEther("0.06") * S);
  await PA.priv.bidPrivately(l.auction, { maxPrice: unit * 20n, quantity: 150_000n * 10n ** 18n }, (m) => console.log(`    · ${m}`));
  ok((await creator.committedLogs(l.auction, l.block)).length === 2, "two sealed bids: one from a wallet, one from a one-time wallet paid privately");

  // ── keeper: reveal, settle, admit into the shared vault ──
  const admitted = (t) => pub.readContract({ address: v4.shared, abi: sharedVaultAbi, functionName: "admitted", args: [t] });
  const s = await until("settlement and admission", async () => {
    const st = await creator.getAuction(l.auction);
    return st.settled && (await admitted(st.token)) ? st : undefined;
  });
  ok(!s.failed && BigInt(s.uniPair) !== 0n, `settled into Uniswap pool ${s.uniPair}`);
  if (V4POOLS) {
    ok(s.pool === "v4" && s.creatorFees, `it's a Uniswap v4 pool with Cloak's hook ${s.hook}, fees to the creator`);
    const m = { address: s.pair, abi: cloakV4MarketAbi };
    const [px, fee] = await Promise.all([pub.readContract({ ...m, functionName: "price" }), pub.readContract({ ...m, functionName: "feePips" })]);
    const err = px > s.clearingPrice ? px - s.clearingPrice : s.clearingPrice - px;
    ok(err * 1_000_000n <= s.clearingPrice, `the v4 pool opened at the clearing price (${fmt(px, 12)} vs ${fmt(s.clearingPrice, 12)})`);
    ok(fee > 3000, `right after listing the anti-snipe fee is ${Number(fee) / 1e4}% (it falls to 0.3%)`);
  }
  const own = await pub.readContract({ address: v4.vaults, abi: cloakVaultsAbi, functionName: "poolOf", args: [s.token] });
  ok(BigInt(own) === 0n, "the keeper admitted the token to the shared vault and opened no vault of its own");
  ok((await pub.readContract({ address: v4.shared, abi: sharedVaultAbi, functionName: "tokensCount" })) === tokensBefore + 1n, "only this new launch was admitted (earlier launches keep their own vaults)");

  // ── 2. into the shared vault ──
  await new Cloak(pub, A.walletClient).claim(l.auction, [0n]);
  const aTok = await pub.readContract({ address: s.token, abi: ERC20, functionName: "balanceOf", args: [A.account.address] });
  await AA.shared.shield(A.walletClient, s.token, aTok / 4n);
  ok((await AA.shared.balance(s.token)) === aTok / 4n, `wallet bidder shielded ${fmt(aTok / 4n, 0)} SSHADE into the shared vault (under the 10%-of-supply deposit cap)`);
  const r = await PA.priv.finishPrivateBids(l.auction, (m) => console.log(`    · ${m}`), PA.shared);
  const pTok = await PA.shared.balance(s.token);
  ok(r.claimed === 1 && pTok > 0n && r.movedHype > 0n, `private bidder wrapped up: ${fmt(pTok, 0)} SSHADE in the shared vault, ${fmt(r.movedHype)} HYPE back`);

  // ── 3. a send that hides its token ──
  const aBefore = await AA.shared.balance(s.token);
  const amount = pTok / 3n;
  const sendTx = await PA.shared.send(s.token, amount, await AA.priv.address(), (m) => console.log(`    · ${m}`));
  const rc = await pub.waitForTransactionReceipt({ hash: sendTx });
  ok(rc.status === "success", "hidden send relayed with the fee paid from private HYPE");
  const vaultEvents = rc.logs.filter((x) => same(x.address, v4.shared)).map((x) => decodeEventLog({ abi: sharedVaultAbi, data: x.data, topics: x.topics }).eventName);
  ok(!vaultEvents.some((e) => ["Deposit", "Withdrawal", "WithdrawFee"].includes(e)) && !rc.logs.some((x) => same(x.address, s.token)), "the send's transaction names no token: no token transfer, no deposit or withdrawal event");
  const sendCall = await pub.getTransaction({ hash: sendTx });
  ok(!sendCall.input.toLowerCase().includes(s.token.slice(2).toLowerCase()), "the token's address appears nowhere in the call data");
  ok((await until("the note to arrive", async () => ((await AA.shared.balance(s.token)) === aBefore + amount ? true : undefined), 60)) === true, `recipient sees exactly ${fmt(amount, 0)} SSHADE arrive`);

  // ── 4. sell and buy through the Uniswap pool ──
  const hypeA0 = await AA.priv.balance(AA.priv.hypeMarket.pool);
  await pub.waitForTransactionReceipt({ hash: await AA.shared.sell(s.token, (aBefore + amount) / 4n) });
  const hypeA1 = await until("sell output", async () => ((await AA.priv.balance(AA.priv.hypeMarket.pool)) > hypeA0 ? AA.priv.balance(AA.priv.hypeMarket.pool) : undefined), 60);
  ok(hypeA1 > hypeA0, `private sell: SSHADE → ${fmt(hypeA1 - hypeA0, 8)} private HYPE`);
  const pTok1 = await PA.shared.balance(s.token);
  await pub.waitForTransactionReceipt({ hash: await PA.shared.buy(s.token, parseEther("0.002") * S) });
  const pTok2 = await until("buy output", async () => ((await PA.shared.balance(s.token)) > pTok1 ? PA.shared.balance(s.token) : undefined), 60);
  ok(pTok2 > pTok1, `private buy: private HYPE → ${fmt(pTok2 - pTok1, 0)} SSHADE in the shared vault`);

  // ── 5. withdraw, solvency, forged proof ──
  const fresh = clients(chain, RPC, generatePrivateKey()).account.address;
  const out = (await AA.shared.balance(s.token)) / 2n;
  await pub.waitForTransactionReceipt({ hash: await AA.shared.unshield(s.token, out, fresh) });
  const got = await pub.readContract({ address: s.token, abi: ERC20, functionName: "balanceOf", args: [fresh] });
  const net = await pub.readContract({ address: v4.shared, abi: sharedVaultAbi, functionName: "afterFee", args: [out] });
  ok(got === net, `withdrew ${fmt(got, 0)} SSHADE to a fresh address (after the 0.25% fee)`);
  const [held, dep, owed] = await Promise.all([
    pub.readContract({ address: s.token, abi: ERC20, functionName: "balanceOf", args: [v4.shared] }),
    pub.readContract({ address: v4.shared, abi: sharedVaultAbi, functionName: "deposited", args: [s.token] }),
    pub.readContract({ address: v4.shared, abi: sharedVaultAbi, functionName: "feesOwed", args: [s.token] }),
  ]);
  ok(held === dep + owed, `the vault holds exactly its notes plus fees (${fmt(held, 0)} SSHADE)`);
  let forged = false;
  try {
    const q = await sharedRelay.quote("sharedTransact", s.token);
    const real = await AA.shared.balance(s.token);
    // a genuine proof with one byte of it changed: the verifier must refuse it
    const orig = sharedRelay;
    const tamper = Object.assign(async (call) => orig({ ...call, proof: { ...call.proof, a: [call.proof.a[0] ^ 1n, call.proof.a[1]] } }), { quote: orig.quote });
    const bad = new SharedVaultClient(AA.priv, v4.shared, v4.sharedRouter, async () => sharedProver, tamper, BigInt(v4.sharedBlock));
    await bad.unshield(s.token, real / 10n > q.fee ? real / 10n : real / 2n, fresh);
  } catch {
    forged = true;
  }
  ok(forged && (await pub.readContract({ address: s.token, abi: ERC20, functionName: "balanceOf", args: [fresh] })) === got, "a tampered proof is refused and moves nothing");
  if (V4POOLS) {
    // ── 6. the creator's trading fees, through the hook ──
    const fees = await creator.creatorFees(l.auction);
    ok(fees && fees.whype + fees.tokens > 0n, `the private trades earned the creator ${fmt(fees?.whype ?? 0n, 8)} HYPE and ${fmt(fees?.tokens ?? 0n, 0)} SSHADE in fees`);
    const c0 = await pub.getBalance({ address: C.account.address });
    await new Cloak(pub, A.walletClient).claimCreatorFees(l.auction); // anyone can trigger it; it always pays the creator
    const c1 = await pub.getBalance({ address: C.account.address });
    ok(c1 - c0 === fees.whype, "someone else triggered the payout, and the creator received exactly those HYPE fees");
    ok((await creator.creatorFees(l.auction)).claimableLp === 0n, "nothing left to collect right after");
  }
  console.log(`\n    launch page: https://cloak.boblabs.tech/app/launch/${l.auction}`);
} finally {
  keeper?.kill();
}
console.log(`\n${checks} checks passed`);
process.exit(0);
