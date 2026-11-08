// Part 10: fragmented balances on Gloam. Sends take one note in, so notes never merge privately, and every payment
// received stays its own note. What a 10-note balance can still do: send (in how many pieces), and meet a launch gate's
// minimum when a proof of funds covers at most 4 notes. Anvil (chain 99801), final keys, through the relay.
//
//   node e2e-gloam/part10-fragmentation.mjs
import { join } from "node:path";
import { formatEther, parseEther } from "viem";
import { CLOAK_FUNDS_GATE_ABI, GloamPrivate, joinFundsGate } from "@cloakely/sdk";
import { createGloamRelay } from "../services/keeper/gloam.mjs";
import { createGloamLoop } from "../services/keeper/gloamLoop.mjs";
import { deployCloakGloam } from "./stack.mjs";
import { ANVIL_KEYS, CIRCUITS, ELYSIUM_TESTNET_ID, assert, clients, finalProver, rpc, sendAndLog, startAnvil, writeMeasurements } from "./lib.mjs";

const snarkjs = await import("snarkjs");
const t0 = performance.now();
const anvil = await startAnvil({ port: 8563 });
const rpcUrl = anvil.rpcUrl;
const who = (i) => clients(rpcUrl, ANVIL_KEYS[i], ELYSIUM_TESTNET_ID);
const [dep, alice, bob, carol, keeper] = [who(0), who(1), who(2), who(3), who(8)];
const pub = dep.pub;
const out = {};
try {
  console.log("Part 10 on anvil (chain 99801): fragmented balances");
  const warp = async (s) => (await rpc(rpcUrl, "evm_increaseTime", [s]), await rpc(rpcUrl, "evm_mine"));
  const { contracts: c, block } = await deployCloakGloam({ me: dep, rpcUrl, pk: ANVIL_KEYS[0], warp });
  const relay = createGloamRelay({ publicClient: pub, walletClient: keeper.wallet, vault: c.gloamVault, launchVault: c.launchVault, memoBoard: c.memoBoard, escrows: [c.fundsGate], hourlySpendWei: parseEther("5") });
  await createGloamLoop({ publicClient: pub, account: keeper.account, send: async (x) => (await sendAndLog(pub, x.functionName, keeper.wallet.writeContract(x))).transactionHash, launchVault: c.launchVault }).tick();
  const provers = { shield: await finalProver("shield"), transfer: await finalProver("transfer"), unshield: await finalProver("unshield") };
  const cfg = { publicClient: pub, chainId: ELYSIUM_TESTNET_ID, gloamVault: { pool: c.gloamVault, poolBlock: block }, launchVault: { pool: c.launchVault, poolBlock: block }, payMemo: c.memoBoard, provers, submit: (call) => relay({ kind: call.kind, to: call.to, data: call.data }), whype: c.whypeStandIn };
  const A = await GloamPrivate.unlock(alice.wallet, cfg);
  const B = await GloamPrivate.unlock(bob.wallet, cfg);
  const C = await GloamPrivate.unlock(carol.wallet, cfg);
  for (const p of [A, B, C]) await p.loadMarkets();
  const H = A.hypeMarket.pool;
  const lv = A.cores.find((x) => x.config.pool === c.launchVault);

  // Alice is paid 10 times: each payment, once swept, is its own note
  await B.shieldHype(bob.wallet, parseEther("2"));
  for (let i = 0; i < 10; i++) await B.send(B.hypeMarket.token, await A.address(), parseEther("0.1"));
  assert((await A.balance(H)) === parseEther("1"), "Alice holds 1 HYPE privately");
  out.notes = lv.ownNotes("0x0000000000000000000000000000000000000000").length;
  assert(out.notes === 10, "in 10 separate notes: received payments never merge");

  // sending more than one note holds: one payment per note used
  const before = performance.now();
  await A.send(A.hypeMarket.token, await C.address(), parseEther("0.75"));
  out.sendMs = Math.round(performance.now() - before);
  assert((await C.balance(H)) === parseEther("0.75"), `a 0.75 HYPE send from 10 notes of 0.1 arrives in full (${(out.sendMs / 1000).toFixed(1)} s)`);
  out.notesAfterSend = lv.ownNotes("0x0000000000000000000000000000000000000000").length;
  assert(out.notesAfterSend === 3, `it took 8 pieces (7 whole notes and part of an eighth): Alice has ${out.notesAfterSend} notes left (two 0.1 and the 0.05 change)`);

  // a launch gate: a proof covers at most the 4 largest notes
  const prover = async (input) => snarkjs.groth16.fullProve(input, join(CIRCUITS, "funds.wasm"), join(CIRCUITS, "final/funds_final.zkey"));
  for (let i = 0; i < 6; i++) await B.send(B.hypeMarket.token, await A.address(), parseEther("0.1"));
  await A.balance(H);
  out.notesForGate = lv.ownNotes("0x0000000000000000000000000000000000000000").length;
  const closes = (await pub.getBlock()).timestamp + 3600n;
  await sendAndLog(pub, "createGate 0.4", bob.wallet.writeContract({ address: c.fundsGate, abi: CLOAK_FUNDS_GATE_ABI, functionName: "createGate", args: ["0x0000000000000000000000000000000000000000", parseEther("0.4"), closes] }));
  await sendAndLog(pub, "createGate 0.6", bob.wallet.writeContract({ address: c.fundsGate, abi: CLOAK_FUNDS_GATE_ABI, functionName: "createGate", args: ["0x0000000000000000000000000000000000000000", parseEther("0.6"), closes] }));
  await joinFundsGate(lv, { gate: c.fundsGate, gateId: 0n, wallet: who(4).account.address, prover });
  assert(await pub.readContract({ address: c.fundsGate, abi: CLOAK_FUNDS_GATE_ABI, functionName: "isEligible", args: [0n, who(4).account.address] }), `with ${formatEther(await A.balance(H))} HYPE in ${out.notesForGate} notes, a 0.4 HYPE gate passes on the 4 largest`);
  let e = null;
  await joinFundsGate(lv, { gate: c.fundsGate, gateId: 1n, wallet: who(5).account.address, prover }).catch((x) => (e = x));
  out.gateMessage = e?.message;
  assert(/four largest private balances/.test(String(e?.message)) && /public/.test(String(e?.message)), "a 0.6 HYPE gate can't be met by any 4 of them, though the balance is 0.85: the app says to cash out and redeposit, and that it's public");

  writeMeasurements("part10-fragmentation", { ...out, seconds: Math.round((performance.now() - t0) / 1000) });
  console.log(`\nPart 10 passed in ${Math.round((performance.now() - t0) / 1000)} s`);
} finally {
  anvil.stop();
}
process.exit(0);
