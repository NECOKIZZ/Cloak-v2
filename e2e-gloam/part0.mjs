// Part 0: Gloam's stack on (local) Elysium testnet, driven by their published SDK, measured.
//
//   node e2e-gloam/part0.mjs                 # local: starts anvil as chain 99801, deploys everything
//   node e2e-gloam/part0.mjs --fork          # local fork of Elysium testnet: Kinetiq's real test USDC, real chain state
//   RPC_URL=... GLOAM_TESTNET_PK=... node e2e-gloam/part0.mjs --live   # Elysium testnet (fresh testnet key only)
//
// Checks: Gloam's own key gate (final-key proofs accepted, dev-key proofs refused) and the guard, then shield HYPE
// and USDC, private send to a receive tag over the memo board, the bearer-note window before a sweep, sweep, split
// cash-out, full cash-out with the 0.5% fee, fee collection. Writes measurements/part0-<where>.json.
import { parseEther, parseUnits, toHex, parseAbi, zeroAddress } from "viem";
import {
  ANVIL_KEYS,
  POOL_ABI,
  ERC20_ABI,
  assert,
  rejects,
  clients,
  deployGloamStack,
  deployPoseidon,
  devProver,
  finalProver,
  gasLog,
  ourArtifact,
  proofLog,
  sendAndLog,
  startAnvil,
  writeMeasurements,
  ELYSIUM_TESTNET_ID,
  ELYSIUM_TESTNET_RPC,
  ELYSIUM_TESTNET_USDC,
  forkFund,
} from "./lib.mjs";

const sdk = await import("@gloamtrade/sdk");
const LIVE = process.argv.includes("--live");
const FORK = process.argv.includes("--fork");
/** Cloak's live USDC vault on Elysium testnet: the holder a local fork borrows test USDC from (fork only, never live). */
const FORK_USDC_HOLDER = "0x3d5cB722490D9908a118f8B3151f83fcE943E4F0";
const MEMO_ABI = parseAbi([
  "function postMemo(bytes32 paymentCommitment, bytes memo)",
  "event PaymentMemo(bytes32 indexed paymentCommitment, bytes memo)",
]);

let anvil;
let rpcUrl = process.env.RPC_URL;
if (!LIVE) {
  anvil = await startAnvil(FORK ? { forkUrl: process.env.RPC_URL ?? ELYSIUM_TESTNET_RPC } : {});
  rpcUrl = anvil.rpcUrl;
}
const keys = LIVE ? [process.env.GLOAM_TESTNET_PK] : ANVIL_KEYS;
if (LIVE && !keys[0]) throw new Error("set GLOAM_TESTNET_PK (fresh testnet key, never Cloak's deployer or keeper)");

const t0 = performance.now();
const dep = clients(rpcUrl, keys[0], ELYSIUM_TESTNET_ID);
// Live runs use one funded key for every role; local runs give each role its own anvil account.
const alice = LIVE ? dep : clients(rpcUrl, keys[1], ELYSIUM_TESTNET_ID);
const bob = LIVE ? dep : clients(rpcUrl, keys[2], ELYSIUM_TESTNET_ID);
const treasury = LIVE ? dep.account.address : clients(rpcUrl, keys[3], ELYSIUM_TESTNET_ID).account.address;
const pub = dep.pub;

try {
  const WHERE = LIVE ? "elysium-testnet" : FORK ? "elysium-testnet-fork" : "anvil";
  console.log(`Part 0 on ${WHERE}`);

  // ── tokens and the stack ────────────────────────────────────────────────
  let USDC = ELYSIUM_TESTNET_USDC;
  if (FORK) {
    await forkFund(rpcUrl, USDC, FORK_USDC_HOLDER, alice.account.address, parseUnits("280", 6));
  } else if (!LIVE) {
    const tok = ourArtifact("TestToken.sol", "TestToken");
    const usdcR = await sendAndLog(pub, "deploy test USDC", dep.wallet.deployContract({ ...tok, args: ["Test USDC", "USDC", 6] }));
    USDC = usdcR.contractAddress;
    await sendAndLog(pub, "mint USDC", alice.wallet.writeContract({ address: USDC, abi: ERC20_ABI, functionName: "mint", args: [alice.account.address, parseUnits("10000", 6)] }));
  }

  const poseidon = await deployPoseidon(dep);
  const stack = await deployGloamStack({
    rpcUrl,
    pk: keys[0],
    poseidon,
    assets: [
      { address: zeroAddress, perDeposit: parseEther("1000"), total: parseEther("100000") },
      { address: USDC, perDeposit: parseUnits("500", 6), total: parseUnits("25000", 6) },
    ],
    feeBps: 50,
    feeRecipient: treasury,
    controller: dep.account.address,
  });
  const POOL = stack.pool;
  console.log("  vault", POOL, "guard", stack.guard, "memo board", stack.payMemo, `(${stack.deployMs} ms)`);
  assert(stack.forgeLog.includes("All checks passed"), "Gloam key gate: final-key proofs accepted, dev-key proofs refused, by the deployed verifiers");
  assert((await pub.readContract({ address: POOL, abi: POOL_ABI, functionName: "owner" })).toLowerCase() === stack.guard.toLowerCase(), "the vault is owned by its VaultOwnerGuard");
  assert(!(await pub.readContract({ address: POOL, abi: POOL_ABI, functionName: "setupMode" })), "setup has ended, rule changes now take the 3-day timelock");
  assert((await pub.readContract({ address: POOL, abi: POOL_ABI, functionName: "withdrawFeeBps" })) === 50, "cash-out fee is 0.5%");
  const deployBlock = await pub.getBlockNumber();

  const shieldProve = await finalProver("shield");
  const transferProve = await finalProver("transfer");
  const unshieldProve = await finalProver("unshield");

  async function shield(who, asset, amount, label) {
    const intent = await sdk.buildShieldBoundIntent({ chainId: ELYSIUM_TESTNET_ID, poolAddress: POOL, asset, amountWei: amount, prover: shieldProve });
    if (asset !== zeroAddress) {
      await sendAndLog(pub, `approve ${label}`, who.wallet.writeContract({ address: asset, abi: ERC20_ABI, functionName: "approve", args: [POOL, amount] }));
    }
    await sendAndLog(pub, `shield ${label}`, who.wallet.writeContract({ address: POOL, abi: POOL_ABI, functionName: intent.exec.fn, args: intent.exec.args, value: intent.exec.valueWei }));
    return { secret: intent.note.secret, commitment: intent.note.commitment, nullifier: intent.note.nullifier, amountWei: amount.toString(), asset };
  }
  async function pathOf(note) {
    const synced = await sdk.syncTree(pub, { pool: POOL, fromBlock: deployBlock });
    const path = await synced.pathForCommitment(note.commitment);
    if (!path) throw new Error("note not in tree");
    return path;
  }
  async function send(who, note, pay, label) {
    const s = await sdk.buildPrivateSendIntent({
      chainId: ELYSIUM_TESTNET_ID, poolAddress: POOL, secretHex: note.secret, amountInWei: BigInt(note.amountWei), amountPayWei: pay, asset: note.asset, path: await pathOf(note), prove: transferProve,
    });
    await sendAndLog(pub, label, who.wallet.writeContract({ address: POOL, abi: POOL_ABI, functionName: "transfer", args: s.exec.args }));
    return s;
  }
  async function cashOut(who, note, to, label) {
    const exit = await sdk.buildUnshieldIntent({
      chainId: ELYSIUM_TESTNET_ID, poolAddress: POOL, secretHex: note.secret, amountWei: BigInt(note.amountWei), asset: note.asset, to, path: await pathOf(note), prove: unshieldProve,
    });
    return sendAndLog(pub, label, who.wallet.writeContract({ address: POOL, abi: POOL_ABI, functionName: "unshield", args: exit.exec.args }));
  }

  // ── gate on chain: a dev-key deposit proof is refused ───────────────────
  {
    const bad = await sdk.buildShieldBoundIntent({ chainId: ELYSIUM_TESTNET_ID, poolAddress: POOL, asset: zeroAddress, amountWei: parseEther("1"), prover: await devProver("shield") });
    await rejects(
      alice.wallet.writeContract({ address: POOL, abi: POOL_ABI, functionName: "shieldBound", args: bad.exec.args, value: parseEther("1"), gas: 1_000_000n }).then((h) => pub.waitForTransactionReceipt({ hash: h })).then((r) => { if (r.status !== "success") throw new Error("reverted"); }),
      "a deposit proved with the DEV keys is refused by the vault",
    );
  }

  // ── shield ──────────────────────────────────────────────────────────────
  const hypeNote = await shield(alice, zeroAddress, parseEther("10"), "HYPE");
  const usdcNote = await shield(alice, USDC, parseUnits("200", 6), "USDC");
  assert((await pub.readContract({ address: POOL, abi: POOL_ABI, functionName: "deposited", args: [zeroAddress] })) === parseEther("10"), "vault holds 10 HYPE");
  await rejects(shield(alice, USDC, parseUnits("501", 6), "USDC over limit"), "a deposit over the per-deposit limit is refused");

  // ── private send to Bob's receive tag, delivered on the memo board ──────
  const bobKey = await sdk.generateReceiveKey();
  const s1 = await send(alice, hypeNote, parseEther("3"), "private send HYPE (1 in, 2 out)");
  const ticket = await sdk.sealToReceiveTag(JSON.stringify(s1.paymentNote), bobKey.tag);
  await sendAndLog(pub, "post memo", alice.wallet.writeContract({ address: stack.payMemo, abi: MEMO_ABI, functionName: "postMemo", args: [s1.paymentNote.commitment, toHex(new TextEncoder().encode(ticket))] }));
  const memos = await pub.getContractEvents({ address: stack.payMemo, abi: MEMO_ABI, eventName: "PaymentMemo", fromBlock: deployBlock });
  const opened = [];
  for (const m of memos) {
    try {
      opened.push(JSON.parse(await sdk.openSealedTicket(new TextDecoder().decode(Buffer.from(m.args.memo.slice(2), "hex")), bobKey)));
    } catch {}
  }
  assert(opened.length === 1 && opened[0].commitment === s1.paymentNote.commitment, "Bob finds and opens his payment from the memo board with his receive key");
  const bobNote = opened[0];
  assert(BigInt(bobNote.amountWei) === parseEther("3"), "Bob's note holds 3 HYPE");

  // ── the bearer window: the payer still holds the payee's secret ─────────
  // Second payment, which Alice spends back before Bob sweeps it. Shows the window a sweep must close.
  const s2 = await send(alice, s1.changeNote, parseEther("1"), "private send HYPE #2");
  await cashOut(alice, s2.paymentNote, alice.account.address, "payer spends the payee's unswept note");
  assert(await pub.readContract({ address: POOL, abi: POOL_ABI, functionName: "isSpent", args: [s2.paymentNote.nullifier] }), "BEARER RISK: a payer can spend a payment it sent until the payee sweeps it");

  // ── Bob sweeps (whole amount to a fresh note), then cashes out ──────────
  const sweep = await send(bob, bobNote, BigInt(bobNote.amountWei), "sweep received note (1 in, 2 out)");
  const bobBefore = await pub.getBalance({ address: bob.account.address });
  const r = await cashOut(bob, sweep.paymentNote, bob.account.address, "cash out HYPE (whole note)");
  const got = (await pub.getBalance({ address: bob.account.address })) - bobBefore + r.gasUsed * r.effectiveGasPrice;
  assert(got === parseEther("3") - parseEther("3") * 50n / 10000n, "Bob receives 3 HYPE less the 0.5% fee");

  // ── split cash-out: a partial withdraw is a send to yourself, then a cash out ─
  const split = await send(alice, usdcNote, parseUnits("75", 6), "split for partial cash out");
  const aliceUsdc = await pub.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [alice.account.address] });
  await cashOut(alice, split.paymentNote, alice.account.address, "cash out USDC (partial, after split)");
  const aliceUsdc2 = await pub.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [alice.account.address] });
  assert(aliceUsdc2 - aliceUsdc === parseUnits("75", 6) - parseUnits("75", 6) * 50n / 10000n, "partial cash out of 75 USDC pays 74.625");
  await rejects(cashOut(alice, split.paymentNote, alice.account.address, "double spend"), "a spent note cannot be cashed out twice");

  // ── fees ────────────────────────────────────────────────────────────────
  const owed = await pub.readContract({ address: POOL, abi: POOL_ABI, functionName: "feesOwed", args: [USDC] });
  await sendAndLog(pub, "collectFees USDC", bob.wallet.writeContract({ address: POOL, abi: POOL_ABI, functionName: "collectFees", args: [USDC] }));
  assert((await pub.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [treasury] })) >= owed, "anyone can push owed fees, they land at the fee recipient");

  const summary = summarize();
  writeMeasurements(`part0-${WHERE}`, { where: WHERE, sdk: "@gloamtrade/sdk@0.6.0", gloamCommit: "16dac34", stack: { ...stack, forgeLog: undefined }, ...summary, wallMs: Math.round(performance.now() - t0) });
  console.log("\nproof times (ms):", summary.proofs);
  console.log("gas:", summary.gas);
  console.log(`\nPart 0 passed in ${Math.round((performance.now() - t0) / 1000)} s`);
} finally {
  anvil?.stop();
}
// snarkjs leaves worker threads alive; exit once the run is done.
process.exit(0);

function summarize() {
  const proofs = {};
  for (const p of proofLog) (proofs[p.circuit] ??= []).push(p.ms);
  const stats = Object.fromEntries(Object.entries(proofs).map(([k, v]) => [k, { n: v.length, min: Math.min(...v), median: v.slice().sort((a, b) => a - b)[Math.floor(v.length / 2)], max: Math.max(...v) }]));
  return { proofs: stats, gas: Object.fromEntries(gasLog.map((g) => [g.label, g.gas])), machine: { cpus: (globalThis.navigator?.hardwareConcurrency ?? null), node: process.version } };
}
