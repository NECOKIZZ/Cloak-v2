// Step 7: the whole Cloak v2 on Gloam stack, live on Elysium testnet (chain 99801), on Gloam's final keys, sized for
// a small testnet wallet (about 1 HYPE). One funded key plays deployer, Alice, relay and keeper; Bob is a fresh
// unfunded key (the relay pays his gas).
//
//   node e2e-gloam/live-elysium.mjs --anvil   # rehearsal on a local anvil (chain 99801), same steps
//   node e2e-gloam/live-elysium.mjs           # live: reads GLOAM_TESTNET_PK from ../.env (fresh testnet key only)
//
// Deploys: Gloam's guarded vault and memo board (Cloak's instance, HYPE and a test launch token listed at deploy, so
// no 3-day wait is needed), CloakLaunchVault on the same final-key verifiers, CloakLaunchSwap with a V2 pool stand-in,
// CloakGloamBatcher, CloakFundsGate, CloakReceiptCheck. The launch is a stand-in (FakeFactory and
// FakeAuction): Cloak's real testnet launches trade on Uniswap v4, and this wallet holds none of their tokens.
// Then: deposit, relayed private send, sweep and cash out, the fee paying the relay, a swap whose buffer comes back,
// a batch round settled by the keeper loop, a gate and a receipt, and a final cash out
// of what is left. Writes measurements/live-elysium[-anvil].json and deployments/elysium-testnet-gloam.json (live).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { encodeFunctionData, formatEther, parseAbi, parseEther, zeroAddress } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { CLOAK_FUNDS_GATE_ABI, CLOAK_RECEIPT_CHECK_ABI, GloamCore, finishPending, joinFundsGate, launchRoute, launchSwap, proveReceipt } from "@cloakely/sdk";
import { createGloamRelay } from "../services/keeper/gloam.mjs";
import { createGloamLoop } from "../services/keeper/gloamLoop.mjs";
import { LV_ABI, deployCloakGloam } from "./stack.mjs";
import {
  ANVIL_KEYS,
  CIRCUITS,
  ELYSIUM_TESTNET_ID,
  ELYSIUM_TESTNET_RPC,
  REPO,
  assert,
  clients,
  finalProver,
  gasLog,
  proofLog,
  rpc,
  sendAndLog,
  startAnvil,
  writeMeasurements,
} from "./lib.mjs";

const snarkjs = await import("snarkjs");
const ANVIL = process.argv.includes("--anvil");
const WHERE = ANVIL ? "live-elysium-anvil" : "live-elysium";

function envKey() {
  if (process.env.GLOAM_TESTNET_PK) return process.env.GLOAM_TESTNET_PK;
  const p = join(REPO, ".env");
  if (!existsSync(p)) return null;
  const m = readFileSync(p, "utf8").match(/^GLOAM_TESTNET_PK=(0x[0-9a-fA-F]{64})\s*$/m);
  return m ? m[1] : null;
}

let anvil;
let rpcUrl = process.env.RPC_URL ?? ELYSIUM_TESTNET_RPC;
let pk;
if (ANVIL) {
  anvil = await startAnvil({ port: 8560 });
  rpcUrl = anvil.rpcUrl;
  pk = ANVIL_KEYS[0];
} else {
  pk = envKey();
  if (!pk) throw new Error("set GLOAM_TESTNET_PK in .env (fresh testnet key, never Cloak's deployer or keeper)");
}

const me = clients(rpcUrl, pk, ELYSIUM_TESTNET_ID);
const bobC = clients(rpcUrl, generatePrivateKey(), ELYSIUM_TESTNET_ID); // unfunded: signs only, the relay sends
const pub = me.pub;
if ((await pub.getChainId()) !== ELYSIUM_TESTNET_ID) throw new Error("not Elysium testnet");
const wallet = me.wallet;
const addr = me.account.address;
const write = (address, abi, functionName, args = [], value) => sendAndLog(pub, functionName, wallet.writeContract({ address, abi, functionName, args, value }));
const deploy = async (label, art, args = []) => (await sendAndLog(pub, `deploy ${label}`, wallet.deployContract({ ...art, args }))).contractAddress;
const now = async () => (await pub.getBlock({ blockTag: "latest" })).timestamp;
/** Waits until the chain's clock passes `ts` (anvil: mines a block to move it). */
async function waitUntil(ts, label) {
  console.log(`  waiting for ${label}...`);
  for (;;) {
    if (ANVIL) {
      await rpc(rpcUrl, "evm_mine");
    }
    if ((await now()) > ts) return;
    await new Promise((r) => setTimeout(r, 3000));
  }
}
const timings = {};
const holderProver = (circuit) => async (input) => {
  const t = performance.now();
  const out = await snarkjs.groth16.fullProve(input, join(CIRCUITS, `${circuit}.wasm`), join(CIRCUITS, `final/${circuit}_final.zkey`));
  timings[`${circuit}ProofMs`] = Math.round(performance.now() - t);
  return out;
};
const bal = (m, asset) => [...m].filter(([a]) => a.toLowerCase() === asset.toLowerCase()).reduce((x, [, v]) => x + v, 0n);

const BATCH_ABI = parseAbi([
  "function place((bytes proof, bytes32 root, bytes32 nullifier, address asset, uint256 amount) s, (bytes32 nullifier, address token, bool buy, uint128 size, address ownerKey, address fallbackTo) k) returns (bytes32)",
  "function escrowFor((bytes32 nullifier, address token, bool buy, uint128 size, address ownerKey, address fallbackTo) k) view returns (address)",
  "function currentRound() view returns (uint64)",
  "function batches(address, uint64) view returns (uint128, uint128, uint128, uint128, uint256, uint64, bool settled, bool cancelled)",
]);

const t0 = performance.now();
const startBalance = await pub.getBalance({ address: addr });
const out = { where: WHERE, wallet: addr, startBalance: formatEther(startBalance), checks: [] };
const ok = (cond, msg) => {
  assert(cond, msg);
  out.checks.push(msg);
};
try {
  console.log(`Step 7 on ${ANVIL ? "a local anvil rehearsal" : "Elysium testnet"} (chain 99801), wallet ${addr}, ${formatEther(startBalance)} HYPE`);

  // ── 1. deploy ──────────────────────────────────────────────────────────
  const ROUND = 60n;
  // the anvil rehearsal lists like Gloam's real vault (USDC only, the launch token through the 3-day wait, skipped
  // forward); live, the 3 days can't be skipped, so HYPE and the launch token are listed at deploy
  const d = await deployCloakGloam({ me, rpcUrl, pk, roundSecs: ROUND, gloamAssets: ANVIL ? "realistic" : "open", warp: ANVIL ? async (secs) => (await rpc(rpcUrl, "evm_increaseTime", [secs]), await rpc(rpcUrl, "evm_mine")) : undefined });
  const stack = d.stack;
  ok(stack.forgeLog.includes("All checks passed"), "Gloam's deploy gate passed: its verifiers take final-key proofs and refuse dev-key ones");
  const { launchVault: lv, launchSwap: router, batcher, fundsGate: gate, receiptCheck: receipts, launchToken: launch, whypeStandIn: weth } = d.contracts;
  const lvBlock = d.block;
  out.contracts = d.contracts;
  out.deployedAtBlock = lvBlock.toString();
  console.log("  deployed:", JSON.stringify(out.contracts, null, 1));
  if (!ANVIL) writeFileSync(join(REPO, "deployments/elysium-testnet-gloam.json"), JSON.stringify({ chainId: ELYSIUM_TESTNET_ID, note: "Cloak v2 on Gloam, live test run (testnet only). Launch, WHYPE and V2 are stand-ins.", block: Number(lvBlock), ...out.contracts }, null, 2) + "\n");

  // ── 2. the keeper: relay and loop on the same wallet ───────────────────
  const relay = createGloamRelay({ publicClient: pub, walletClient: wallet, vault: stack.pool, launchVault: lv, memoBoard: stack.payMemo, escrows: [router, batcher, gate], hourlySpendWei: parseEther("0.2"), feeCollectWei: parseEther("0.0004"), log: (m) => console.log("  " + m) });
  const loop = createGloamLoop({ publicClient: pub, account: me.account, send: async (call) => (await sendAndLog(pub, call.functionName, wallet.writeContract(call))).transactionHash, launchVault: lv, batcher, batcherBlock: lvBlock, fundsGate: gate, log: (m) => console.log("  " + m) });
  const t1 = await loop.tick();
  ok(t1.admitted.length === 1, "the keeper loop admitted the settled launch to Cloak's launch vault, with no wait");

  const submit = (call) => relay({ kind: call.kind, to: call.to, data: call.data });
  const provers = { shield: await finalProver("shield"), transfer: await finalProver("transfer"), unshield: await finalProver("unshield") };
  const cfg = { publicClient: pub, chainId: ELYSIUM_TESTNET_ID, pool: lv, poolBlock: lvBlock, payMemo: stack.payMemo, provers, submit, logChunk: 5_000n };
  const A = await GloamCore.unlock(wallet, cfg);
  const B = await GloamCore.unlock(bobC.wallet, cfg);

  // ── 3. deposit, relayed private send, sweep, relayed cash out ──────────
  await A.shield(wallet, zeroAddress, parseEther("0.5"));
  await A.sync();
  ok(bal(await A.balances(), zeroAddress) === parseEther("0.5"), "0.5 HYPE deposited into Cloak's launch vault on a final-key proof");
  await A.send(zeroAddress, await B.address(), parseEther("0.1"));
  await B.sync();
  ok(bal(await B.balances(), zeroAddress) === parseEther("0.1"), "a relayed private send of 0.1 HYPE, swept by Bob, whose wallet has never held gas");
  const bobPayout = clients(rpcUrl, generatePrivateKey(), ELYSIUM_TESTNET_ID).account.address;
  await B.withdraw(zeroAddress, bobPayout, parseEther("0.1"));
  ok((await pub.getBalance({ address: bobPayout })) === parseEther("0.0995"), "Bob's relayed cash out pays 0.0995 HYPE to a fresh address");
  const feeOwed = await pub.readContract({ address: lv, abi: LV_ABI, functionName: "feesOwed", args: [zeroAddress] });
  ok(feeOwed === parseEther("0.0005"), "the launch vault holds Cloak's 0.5% fee");

  // ── 4. a swap whose buffer comes back ──────────────────────────────────
  const swapRec = await launchSwap(A, { router, route: launchRoute([weth, launch]), assetIn: zeroAddress, amountIn: parseEther("0.1"), assetOut: launch, amountOut: parseEther("50"), deadline: (await now()) + 900n });
  await A.sync();
  ok(bal(await A.balances(), launch) === parseEther("50"), "a private swap of 0.1 HYPE for exactly 50 tokens");
  const hypeBefore = bal(await A.balances(), zeroAddress);
  let res = await finishPending(A, [swapRec]);
  ok(res.done.length === 1, `the next app open: ${res.done[0]?.outcome}`);
  await A.sync();
  out.swapBufferBackWei = (bal(await A.balances(), zeroAddress) - hypeBefore).toString();

  // ── 6. a batch round settled by the keeper loop ────────────────────────
  const note = await A.exactNote(zeroAddress, parseEther("0.005"));
  const nullifier = `0x${note.nullifier.toString(16).padStart(64, "0")}`;
  const k = { nullifier, token: launch, buy: true, size: parseEther("0.005"), ownerKey: addr, fallbackTo: addr };
  const escrow = await pub.readContract({ address: batcher, abi: BATCH_ABI, functionName: "escrowFor", args: [k] });
  const s = await A.spendProof(note, escrow);
  await relay({ to: batcher, data: encodeFunctionData({ abi: BATCH_ABI, functionName: "place", args: [s, k] }) });
  const round = await pub.readContract({ address: batcher, abi: BATCH_ABI, functionName: "currentRound" });
  await waitUntil((round + 1n) * ROUND, "the batch round to end");
  let settled = false;
  for (let i = 0; i < 5 && !settled; i++) {
    await loop.tick();
    settled = (await pub.readContract({ address: batcher, abi: BATCH_ABI, functionName: "batches", args: [launch, round] }))[6];
  }
  ok(settled, "a private batch buy order, settled by the keeper loop once its round ended");

  // ── 7. allocation gate and receipt ─────────────────────────────────────
  await A.sync();
  const closesAt = (await now()) + 90n;
  await write(gate, CLOAK_FUNDS_GATE_ABI, "createGate", [zeroAddress, parseEther("0.1"), closesAt]);
  const gateWallet = clients(rpcUrl, generatePrivateKey(), ELYSIUM_TESTNET_ID).account.address;
  await joinFundsGate(A, { gate, gateId: 0n, wallet: gateWallet, prover: holderProver("funds") });
  ok(await pub.readContract({ address: gate, abi: CLOAK_FUNDS_GATE_ABI, functionName: "isEligible", args: [0n, gateWallet] }), "a wallet joins a 0.1 HYPE gate on a final-key funds proof, its balance unshown");
  const payment = A.sentPayments()[0];
  const expiresAt = Number(await now()) + 86_400;
  const r = await proveReceipt(A, payment, { verifierName: "Cloak live test", expiresAt, reveal: false, minAmount: parseEther("0.1"), prover: holderProver("receipt") });
  const [rOk] = await pub.readContract({ address: receipts, abi: CLOAK_RECEIPT_CHECK_ABI, functionName: "check", args: [r.vault, r.proof.a, r.proof.b, r.proof.c, r.proof.pub, r.asset, parseEther("0.1"), BigInt(expiresAt), "Cloak live test"] });
  ok(rOk, "a final-key receipt for Alice's 0.1 HYPE payment to Bob passes on chain, after Bob swept and cashed it out");
  await waitUntil(closesAt, "the gate to close");
  let confirmed = false;
  for (let i = 0; i < 5 && !confirmed; i++) {
    await loop.tick();
    confirmed = await pub.readContract({ address: gate, abi: CLOAK_FUNDS_GATE_ABI, functionName: "isConfirmed", args: [0n, gateWallet] });
  }
  ok(confirmed, "the keeper loop confirmed the wallet once the gate closed");

  // ── 8. the relay's fee income, and taking the rest back out ─────────────
  out.relay = Object.fromEntries(Object.entries(relay.stats()).map(([kk, v]) => [kk, String(v)]));
  await A.sync();
  const left = bal(await A.balances(), zeroAddress);
  if (left > 0n) await A.withdraw(zeroAddress, addr, "max");

  const endBalance = await pub.getBalance({ address: addr });
  out.endBalance = formatEther(endBalance);
  out.spentHype = formatEther(startBalance - endBalance);
  out.timingsMs = timings;
  const proofs = {};
  for (const p of proofLog) (proofs[p.circuit] ??= []).push(p.ms);
  out.proofsMs = proofs;
  out.gas = gasLog;
  out.seconds = Math.round((performance.now() - t0) / 1000);
  writeMeasurements(WHERE, out);
  console.log(`\nspent ${out.spentHype} HYPE in total (pool seed 0.2 HYPE included), ${out.checks.length} checks`);
  console.log(`Step 7 passed in ${out.seconds} s`);
} finally {
  anvil?.stop();
}
process.exit(0);
