// Launch flow with creator fees and a bid paid from a private balance, with REAL proofs:
//   1. a creator launches with "locked forever, creator earns fees", a 10% creator share and a 20% no-reveal penalty,
//   2. one bidder bids from a wallet, another from a private balance (a relayed withdrawal funds a one-time wallet),
//   3. the keeper reveals, settles (Uniswap pool at the clearing price, LP into the fee locker) and opens the vault,
//   4. the private bidder claims into the private balance and moves the refund back in one call,
//   5. trades on the pool earn fees, and the creator collects them; the locked liquidity never shrinks.
// Fork (spawns a local keeper):  anvil --fork-url https://testnet-rpc.elysium.kinetiq.xyz --chain-id 31337 &
//   DEPLOYER_PK=0x… RPC_URL=http://127.0.0.1:8545 node e2e/deploy-fees.mjs && DEPLOYER_PK=0x… RPC_URL=http://127.0.0.1:8545 node e2e/launch-fees.mjs
// Live testnet (hosted keeper):  DEPLOYER_PK=0x… node e2e/launch-fees.mjs
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { defineChain, parseAbi } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { Cloak, CloakPrivate, cloakFeeLockerAbi, cloakVaultsAbi, createProver, elysiumTestnet, readRegistry, relayerSubmitter } from "@cloakely/sdk";
import { clients, fmt, parseEther, sleep } from "./lib.mjs";

const RPC = process.env.RPC_URL || elysiumTestnet.rpcUrls.default.http[0];
const local = RPC.includes("127.0.0.1") || RPC.includes("localhost");
const root = new URL("..", import.meta.url).pathname;
const v4 = JSON.parse(readFileSync(`${root}deployments/elysium-testnet-v4${local ? "-fees.fork" : ""}.json`, "utf8"));
const chain = local ? defineChain({ ...elysiumTestnet, id: 31337, rpcUrls: { default: { http: [RPC] } } }) : elysiumTestnet;
const S = local ? 1000n : 1n; // amounts ×1000 on a fork
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"]);
let checks = 0;
const ok = (c, m) => {
  if (!c) throw new Error(`✗ ${m}`);
  checks++;
  console.log(`  ✓ ${m}`);
};
const same = (a, b) => a?.toLowerCase() === b?.toLowerCase();
const mine = () => (local ? fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "evm_mine", params: [] }) }).catch(() => {}) : Promise.resolve());
const until = async (what, fn, secs = 360) => {
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
// live, the funder is also the hosted keeper's key, so a send can race the keeper's own: retry with a fresh nonce
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
const prover = createProver(readFileSync(`${root}apps/web/public/circuits/transaction2x2.wasm`), readFileSync(`${root}apps/web/public/circuits/transaction2x2_final.zkey`));

let keeper;
let KEEPER = "https://keeper.boblabs.tech";
if (local) {
  KEEPER = "http://127.0.0.1:3996";
  keeper = spawn(process.execPath, [`${root}services/keeper/index.mjs`], {
    env: { ...process.env, RPC_URL: RPC, KEEPER_PK: process.env.DEPLOYER_PK, CONFIG: v4.config, CLAIM_DELAY: "600", HYPE_USD: "25", HYPE_PRICE_URL: "http://127.0.0.1:9/", PORT: "3996", RELAY_PER_MIN: "1000" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  await until("keeper", () => fetch(`${KEEPER}/health`).then((x) => x.ok), 60);
}
const keys = {};
try {
  const h = await (await fetch(`${KEEPER}/health`)).json();
  ok(same(h.factory, v4.factory), `keeper runs the creator-fee factory (${h.factory})`);
  const reg = await readRegistry(pub, v4.config);
  ok(same(reg.factory, v4.factory) && reg.earlierFactories.length >= 2, `registry: current factory plus ${reg.earlierFactories.length} earlier v4 factories`);

  // ── 1. the launch ──
  const C = clients(chain, RPC, (keys.creator = generatePrivateKey()));
  const A = clients(chain, RPC, (keys.walletBidder = generatePrivateKey()));
  const P = clients(chain, RPC, (keys.privateBidder = generatePrivateKey()));
  if (process.env.KEYS_FILE) writeFileSync(process.env.KEYS_FILE, JSON.stringify(keys));
  await fund(C.account.address, "0.02");
  await fund(A.account.address, "0.05");
  await fund(P.account.address, "0.08");
  const creator = new Cloak(pub, C.walletClient, v4.factory);
  const now = Number((await pub.getBlock()).timestamp);
  const unit = 10n ** 9n * S;
  const sale = 1_000_000n * 10n ** 18n;
  const l = await creator.createLaunch({
    name: "Fee Shade", symbol: "FSHADE", saleSupply: sale, minPrice: unit, tickSize: unit, numTicks: 50,
    commitEnd: now + 240, revealEnd: now + 330, lpBps: 8000, lpLockUntil: "fees", noRevealPenaltyBps: 2000,
    creatorAlloc: (2n * sale * 10n) / 90n, creatorVestSecs: 30 * 86400, metadataURI: "",
  });
  console.log(`    · launch ${l.auction}`);
  const s0 = await creator.getAuction(l.auction);
  ok(s0.lpLockUntil >= 2 ** 63 && s0.noRevealPenaltyBps === 2000, "launch: LP locked forever with fees, 20% no-reveal penalty");

  // ── 2. a wallet bid and a private-balance bid ──
  const qA = creator.quoteBid(s0, unit * 10n, 600_000n * 10n ** 18n);
  await new Cloak(pub, A.walletClient).bid(l.auction, { maxPrice: unit * 10n, quantity: 600_000n * 10n ** 18n, deposit: qA.cost });
  const relay = relayerSubmitter(KEEPER);
  const pk = await CloakPrivate.keysFromWallet(P.walletClient, { chainId: chain.id });
  const priv = new CloakPrivate(pub, v4.router, pk, async () => prover, relay, BigInt(v4.vaultsBlock), v4.batcher, v4.migrator);
  await priv.loadMarkets();
  await priv.shieldHype(P.walletClient, parseEther("0.05") * S);
  const qP = creator.quoteBid(s0, unit * 20n, 150_000n * 10n ** 18n);
  const pb = await priv.bidPrivately(l.auction, { maxPrice: unit * 20n, quantity: 150_000n * 10n ** 18n }, (m) => console.log(`    · ${m}`));
  const fundTx = await pub.getTransaction({ hash: pb.fundTx });
  ok(!same(pb.bidWallet, P.account.address) && !same(fundTx.from, P.account.address), `private bid sealed from one-time wallet ${pb.bidWallet}, funded by the relayer (${fundTx.from})`);
  const committed = await creator.committedLogs(l.auction, l.block);
  ok(committed.length === 2 && committed.every((c) => !same(c.args.bidder, P.account.address)), "two sealed bids on-chain, neither from the private bidder's wallet");
  ok((await priv.bidWallets(l.auction)).length === 1, "the one-time wallet is found again from the private account alone");

  // ── 3. keeper reveals, settles, opens the vault ──
  const vaultOf = (t) => pub.readContract({ address: v4.vaults, abi: cloakVaultsAbi, functionName: "poolOf", args: [t] });
  const s = await until("settlement and the vault", async () => {
    const st = await creator.getAuction(l.auction);
    return st.settled && BigInt(await vaultOf(st.token)) !== 0n ? st : undefined;
  });
  ok(!s.failed && BigInt(s.uniPair) !== 0n && s.creatorFees, `settled into Uniswap pool ${s.uniPair}, LP locked forever for the creator`);
  const fees0 = await creator.creatorFees(l.auction);
  ok(same(fees0.beneficiary, C.account.address) && fees0.claimableLp === 0n, "fee locker position pays the creator; nothing earned before any trade");
  const lpInLocker = await pub.readContract({ address: s.uniPair, abi: ERC20, functionName: "balanceOf", args: [fees0.locker] });
  ok(lpInLocker > 0n && (await pub.readContract({ address: s.uniPair, abi: ERC20, functionName: "balanceOf", args: [l.auction] })) === 0n, "the LP sits in the locker, none left in the auction");

  // ── 4. the private bidder wraps up ──
  await priv.loadMarkets();
  const r = await priv.finishPrivateBids(l.auction, (m) => console.log(`    · ${m}`));
  const held = await priv.balance(priv.market(s.token).pool);
  ok(r.claimed === 1 && held > 0n, `private bidder claimed ${fmt(held, 0)} FSHADE straight into the private balance`);
  const left = await pub.getBalance({ address: pb.bidWallet });
  ok(r.movedHype > 0n && left < parseEther("0.001") * S, `refund moved back in (${fmt(r.movedHype)} HYPE); the one-time wallet keeps ${fmt(left)} HYPE of gas dust`);

  // ── 5. trades earn fees, the creator collects ──
  await new Cloak(pub, A.walletClient).claim(l.auction, [0n]);
  const m = { address: s.pair, abi: parseAbi(["function swapExactHypeForTokens(uint256,address) payable returns (uint256)", "function swapExactTokensForHype(uint256,uint256,address) returns (uint256)"]) };
  for (let i = 0; i < 3; i++) {
    await pub.waitForTransactionReceipt({ hash: await A.walletClient.writeContract({ ...m, functionName: "swapExactHypeForTokens", args: [0n, A.account.address], value: parseEther("0.0005") * S }) });
  }
  const tok = await pub.readContract({ address: s.token, abi: ERC20, functionName: "balanceOf", args: [A.account.address] });
  await pub.waitForTransactionReceipt({ hash: await A.walletClient.writeContract({ address: s.token, abi: ERC20, functionName: "approve", args: [s.pair, tok / 4n] }) });
  await pub.waitForTransactionReceipt({ hash: await A.walletClient.writeContract({ ...m, functionName: "swapExactTokensForHype", args: [tok / 4n, 0n, A.account.address] }) });
  const sell = await priv.sell(s.token, held / 3n);
  await pub.waitForTransactionReceipt({ hash: sell.txHash });
  const fees1 = await creator.creatorFees(l.auction);
  ok(fees1.claimableLp > 0n && (fees1.whype > 0n || fees1.tokens > 0n), `trades earned fees: ${fmt(fees1.whype, 8)} WHYPE + ${fmt(fees1.tokens, 2)} FSHADE claimable`);
  const W = parseAbi(["function balanceOf(address) view returns (uint256)"]);
  const wBefore = await pub.readContract({ address: v4.uniswap.whype, abi: W, functionName: "balanceOf", args: [C.account.address] });
  await creator.claimCreatorFees(l.auction);
  const wAfter = await pub.readContract({ address: v4.uniswap.whype, abi: W, functionName: "balanceOf", args: [C.account.address] });
  ok(wAfter > wBefore, `the creator collected ${fmt(wAfter - wBefore, 8)} WHYPE in fees (plus tokens)`);
  const pos = await pub.readContract({ address: fees0.locker, abi: cloakFeeLockerAbi, functionName: "positions", args: [fees0.position] });
  ok(pos.shares > 0n && pos.shares < lpInLocker, `the locker burned only the fee share of the LP (${fmt(lpInLocker - pos.shares, 0)} of ${fmt(lpInLocker, 0)} units) and keeps the rest forever`);
  console.log(`\n    launch page: https://cloak.boblabs.tech/app/launch/${l.auction}`);
} finally {
  keeper?.kill();
}
console.log(`\n${checks} checks passed`);
process.exit(0);
