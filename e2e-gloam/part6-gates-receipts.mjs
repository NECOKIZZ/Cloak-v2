// Part 6: allocation gates by proof of funds (CloakFundsGate) and private receipts (CloakReceiptCheck), on Gloam's
// final funds and receipt keys, from balances in Cloak's launch vault, through the relay. The keeper loop confirms
// the gate once it closes.
//
//   node e2e-gloam/part6-gates-receipts.mjs
import { join } from "node:path";
import { parseAbi, parseEther, zeroAddress } from "viem";
import { CLOAK_FUNDS_GATE_ABI, CLOAK_RECEIPT_CHECK_ABI, GloamCore, joinFundsGate, proveReceipt } from "@cloakely/sdk";
import { createGloamRelay } from "../services/keeper/gloam.mjs";
import { createGloamLoop } from "../services/keeper/gloamLoop.mjs";
import { ANVIL_KEYS, CIRCUITS, ELYSIUM_TESTNET_ID, assert, clients, finalProver, localGloam, ourArtifact, rpc, sendAndLog, writeMeasurements } from "./lib.mjs";

const snarkjs = await import("snarkjs");
const LV_ABI = parseAbi([
  "function setShieldVerifier(address)",
  "function setWithdrawFee(uint16 bps, address recipient)",
  "function turnOnDepositLimits()",
  "function setDepositLimit(address asset, uint128 perDeposit, uint128 total)",
  "function endSetup()",
]);

const timings = {};
const holderProver = (circuit) => async (input) => {
  const t = performance.now();
  const out = await snarkjs.groth16.fullProve(input, join(CIRCUITS, `${circuit}.wasm`), join(CIRCUITS, `final/${circuit}_final.zkey`));
  timings[`${circuit}ProofMs`] = Math.round(performance.now() - t);
  return out;
};

const t0 = performance.now();
const L = await localGloam({ port: 8557 });
const { rpcUrl, stack } = L;
const pub = L.dep.pub;
const who = (i) => clients(rpcUrl, ANVIL_KEYS[i], ELYSIUM_TESTNET_ID);
const [alice, bob, carol, keeper] = [who(1), who(2), who(3), who(8)];
const [aliceWallet, carolWallet] = [who(4).account.address, who(6).account.address]; // the wallets they join with
const dep = L.dep.wallet;
const write = (address, abi, functionName, args = []) => sendAndLog(pub, functionName, dep.writeContract({ address, abi, functionName, args }));
try {
  console.log("Part 6 on anvil (chain 99801): allocation gates and receipts on Gloam's final keys");
  const factory = (await sendAndLog(pub, "deploy factory", dep.deployContract({ ...ourArtifact("CloakLaunchVault.t.sol", "FakeFactory") }))).contractAddress;
  const lv = (await sendAndLog(pub, "deploy CloakLaunchVault", dep.deployContract({ ...ourArtifact("CloakLaunchVault.sol", "CloakLaunchVault"), args: [L.poseidon, stack.dual, factory, 10n ** 24n, 10n ** 26n] }))).contractAddress;
  await write(lv, LV_ABI, "setShieldVerifier", [stack.shieldVerifier]);
  await write(lv, LV_ABI, "setWithdrawFee", [50, keeper.account.address]);
  await write(lv, LV_ABI, "turnOnDepositLimits");
  await write(lv, LV_ABI, "setDepositLimit", [zeroAddress, 10n ** 21n, 10n ** 23n]);
  await write(lv, LV_ABI, "endSetup");
  const fv = (await sendAndLog(pub, "deploy GloamFundsVerifierFinal", dep.deployContract({ ...ourArtifact("GloamFundsVerifierFinal.sol", "GloamFundsVerifierFinal") }))).contractAddress;
  const rv = (await sendAndLog(pub, "deploy GloamReceiptVerifierFinal", dep.deployContract({ ...ourArtifact("GloamReceiptVerifierFinal.sol", "GloamReceiptVerifierFinal") }))).contractAddress;
  const gate = (await sendAndLog(pub, "deploy CloakFundsGate", dep.deployContract({ ...ourArtifact("CloakFundsGate.sol", "CloakFundsGate"), args: [fv, stack.pool, lv] }))).contractAddress;
  const receipts = (await sendAndLog(pub, "deploy CloakReceiptCheck", dep.deployContract({ ...ourArtifact("CloakReceiptCheck.sol", "CloakReceiptCheck"), args: [rv, stack.pool, lv] }))).contractAddress;
  const lvBlock = await pub.getBlockNumber();

  const relay = createGloamRelay({ publicClient: pub, walletClient: keeper.wallet, vault: stack.pool, launchVault: lv, memoBoard: stack.payMemo, escrows: [gate], hourlySpendWei: parseEther("1") });
  const submit = (call) => relay({ kind: call.kind, to: call.to, data: call.data });
  const provers = { shield: await finalProver("shield"), transfer: await finalProver("transfer"), unshield: await finalProver("unshield") };
  const cfg = { publicClient: pub, chainId: ELYSIUM_TESTNET_ID, pool: lv, poolBlock: lvBlock, payMemo: stack.payMemo, provers, submit };
  const A = await GloamCore.unlock(alice.wallet, cfg);
  const B = await GloamCore.unlock(bob.wallet, cfg);
  const C = await GloamCore.unlock(carol.wallet, cfg);
  for (const x of ["4", "2"]) await A.shield(alice.wallet, zeroAddress, parseEther(x));
  await C.shield(carol.wallet, zeroAddress, parseEther("6"));
  await A.sync();
  await C.sync();

  // 1. a launch's gate: hold at least 5 HYPE privately, closing in an hour
  const closesAt = (await pub.getBlock()).timestamp + 3600n;
  await sendAndLog(pub, "createGate", bob.wallet.writeContract({ address: gate, abi: CLOAK_FUNDS_GATE_ABI, functionName: "createGate", args: [zeroAddress, parseEther("5"), closesAt] }));
  const gateId = 0n;
  const joinedA = await joinFundsGate(A, { gate, gateId, wallet: aliceWallet, prover: holderProver("funds") });
  assert(await pub.readContract({ address: gate, abi: CLOAK_FUNDS_GATE_ABI, functionName: "isEligible", args: [gateId, aliceWallet] }), "Alice's wallet joins the gate on a final-key funds proof from two notes (4 + 2 HYPE), her balance unshown");
  assert(joinedA.nullifiers.filter((n) => n !== 0n).length === 2, "the proof used two notes");
  const tx = await pub.getTransaction({ hash: joinedA.txHash });
  assert(tx.from.toLowerCase() === keeper.account.address.toLowerCase(), "sent by the relay, so no wallet of Alice's sent it");
  let again = null;
  try {
    await joinFundsGate(A, { gate, gateId, wallet: who(5).account.address, prover: holderProver("funds") });
  } catch (e) {
    again = e;
  }
  assert(again?.status === 400, "the same notes can't qualify a second wallet (refused at the relay's simulation, cost nothing)");
  await joinFundsGate(C, { gate, gateId, wallet: carolWallet, prover: holderProver("funds") });
  assert(await pub.readContract({ address: gate, abi: CLOAK_FUNDS_GATE_ABI, functionName: "isEligible", args: [gateId, carolWallet] }), "Carol's wallet joins too");
  // Carol moves her funds before the close (say, to prove them again for another wallet): she drops out
  await C.withdraw(zeroAddress, carol.account.address, parseEther("6"));
  assert(!(await pub.readContract({ address: gate, abi: CLOAK_FUNDS_GATE_ABI, functionName: "isEligible", args: [gateId, carolWallet] })), "Carol spent the proven note before the close, so her wallet drops out");

  // 2. the keeper loop confirms the gate once it closes
  const loop = createGloamLoop({ publicClient: pub, account: keeper.account, send: async (call) => (await sendAndLog(pub, call.functionName, keeper.wallet.writeContract(call))).transactionHash, fundsGate: gate });
  assert((await loop.tick()).confirmed.length === 0, "nothing to confirm while the gate is open");
  await rpc(rpcUrl, "evm_increaseTime", [3601]);
  await rpc(rpcUrl, "evm_mine");
  const t = await loop.tick();
  assert(t.confirmed.length === 1 && t.confirmed[0].wallet.toLowerCase() === aliceWallet.toLowerCase(), "after the close the keeper loop confirms Alice's wallet, and not Carol's");
  await A.sync();
  await A.withdraw(zeroAddress, alice.account.address, parseEther("4"));
  assert(await pub.readContract({ address: gate, abi: CLOAK_FUNDS_GATE_ABI, functionName: "isEligible", args: [gateId, aliceWallet] }), "once confirmed, Alice is free to spend and stays eligible");
  const list = await pub.readContract({ address: gate, abi: CLOAK_FUNDS_GATE_ABI, functionName: "wallets", args: [gateId, 0n, 100n] });
  assert(list.length === 2, "the creator reads the entries for the allowlist (and keeps the confirmed ones)");

  // 3. a private receipt: Alice pays Bob 1.5 HYPE and proves it to a shop, without showing either wallet
  await A.sync();
  await A.send(zeroAddress, await B.address(), parseEther("1.5"));
  const payment = A.sentPayments().at(-1);
  assert(payment && payment.amount === parseEther("1.5"), "the payer keeps the payment note for its receipt");
  const expiresAt = Number((await pub.getBlock()).timestamp) + 86_400;
  const hidden = await proveReceipt(A, payment, { verifierName: "Shop #7", expiresAt, reveal: false, minAmount: parseEther("1"), prover: holderProver("receipt") });
  const check = (r, minAmount, name = r.verifierName) => pub.readContract({ address: receipts, abi: CLOAK_RECEIPT_CHECK_ABI, functionName: "check", args: [r.vault, r.proof.a, r.proof.b, r.proof.c, r.proof.pub, r.asset, minAmount, BigInt(r.expiresAt), name] });
  let [ok, amount, commitment] = await check(hidden, parseEther("1"));
  assert(ok && amount === 0n, "a final-key receipt for at least 1 HYPE passes on chain, the amount hidden");
  assert(BigInt(commitment) === payment.commitment, "and names the payment note, so Bob can match it to what he received");
  [ok] = await check(hidden, parseEther("1.2"));
  assert(!ok, "it doesn't pass a higher bar than it proved");
  [ok] = await check(hidden, parseEther("1"), "Shop #8");
  assert(!ok, "nor for another reader");
  const shown = await proveReceipt(A, payment, { verifierName: "Accountant", expiresAt, reveal: true, prover: holderProver("receipt") });
  [ok, amount] = await check(shown, parseEther("1.5"));
  assert(ok && amount === parseEther("1.5"), "a receipt with the amount shown says exactly 1.5 HYPE");
  await B.sync(); // Bob sweeps the payment into his own note
  [ok] = await check(hidden, parseEther("1"));
  assert(ok, "after Bob sweeps it the receipt still holds (it never shows the nullifier, so it says nothing of the spend)");

  writeMeasurements("part6-gates-receipts", { circuits: "funds + receipt (Gloam, final keys)", timingsMs: timings, seconds: Math.round((performance.now() - t0) / 1000) });
  console.log("\ntimings (ms):", timings);
  console.log(`\nPart 6 passed in ${Math.round((performance.now() - t0) / 1000)} s`);
} finally {
  L.stop();
}
process.exit(0);
