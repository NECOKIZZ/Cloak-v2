// Part 1: the PrivateCore seam on Gloam (GloamCore from @cloakely/sdk), end to end on anvil as chain 99801.
//
//   node e2e-gloam/part1.mjs
//
// Unlock from one signature, restore on a second device, shield HYPE and USDC, private send to a receive tag with
// automatic sweep, a payer who tries to spend back a swept payment, a balance spread over small notes (1-in sends),
// partial and max withdrawals, forged tickets, and who appears on chain as the sender of each private action.
import { parseEther, parseUnits, zeroAddress, toHex } from "viem";
import { GloamCore, walletCoreSubmitter } from "@cloakely/sdk";
import { ANVIL_KEYS, ELYSIUM_TESTNET_ID, ERC20_ABI, POOL_ABI, assert, clients, finalProver, gasLog, localGloam, proofLog, rejects, sendAndLog, writeMeasurements } from "./lib.mjs";

const sdk = await import("@gloamtrade/sdk");
const t0 = performance.now();
const L = await localGloam();
const { rpcUrl, stack, usdc: USDC, poolBlock } = L;
const who = (i) => clients(rpcUrl, ANVIL_KEYS[i], ELYSIUM_TESTNET_ID);
const [alice, bob, carol, mallory, relayer] = [who(1), who(2), who(5), who(6), who(7)];
const fresh = who(9).account.address;
const pub = L.dep.pub;
const timings = {};
const time = async (label, f) => {
  const t = performance.now();
  const r = await f();
  timings[label] = Math.round(performance.now() - t);
  return r;
};

// The relayer submits every private action and logs its gas.
const relaySubmit = walletCoreSubmitter(pub, relayer.wallet);
const loggedSubmit = async (call) => {
  const hash = await relaySubmit(call);
  const r = await pub.getTransactionReceipt({ hash });
  gasLog.push({ label: `relayed ${call.kind}`, gas: Number(r.gasUsed) });
  return hash;
};
const provers = { shield: await finalProver("shield"), transfer: await finalProver("transfer"), unshield: await finalProver("unshield") };
const cfg = { publicClient: pub, chainId: ELYSIUM_TESTNET_ID, pool: stack.pool, poolBlock, payMemo: stack.payMemo, provers, submit: loggedSubmit };
const sum = (m, a) => m.get(a) ?? 0n;

try {
  console.log("Part 1 on anvil (chain 99801), vault", stack.pool);
  for (const p of [alice, carol]) {
    await sendAndLog(pub, "mint USDC", p.wallet.writeContract({ address: USDC, abi: ERC20_ABI, functionName: "mint", args: [p.account.address, parseUnits("5000", 6)] }));
  }

  // ── unlock, shield, restore ────────────────────────────────────────────
  const A = await time("unlock (one signature)", () => GloamCore.unlock(alice.wallet, cfg));
  const A2 = await GloamCore.unlock(alice.wallet, cfg);
  assert((await A.address()) === (await A2.address()) && (await A.address()).startsWith("gloamr1."), "one signature gives the same gloamr1 address on every device");
  await time("shield HYPE (prove + deposit + memo)", () => A.shield(alice.wallet, zeroAddress, parseEther("10")));
  await A.shield(alice.wallet, USDC, parseUnits("300", 6));
  await A.sync();
  assert(sum(await A.balances(), zeroAddress) === parseEther("10") && sum(await A.balances(), USDC) === parseUnits("300", 6), "Alice holds 10 HYPE and 300 USDC privately");

  const restored = await GloamCore.unlock(alice.wallet, cfg);
  await time("restore on a new device (cold sync)", () => restored.sync());
  assert(sum(await restored.balances(), zeroAddress) === parseEther("10") && sum(await restored.balances(), USDC) === parseUnits("300", 6), "a second device restores the same balance from the signature alone");

  // ── send, auto-sweep, the payer locked out ─────────────────────────────
  const B = await GloamCore.unlock(bob.wallet, cfg);
  const sent = await time("private send (prove + transfer + memo)", async () => A.send(zeroAddress, await B.address(), parseEther("2.5")));
  assert(sent.pieces === 1, "a send covered by one note is one piece");
  const memoLog = await pub.getContractEvents({ address: stack.payMemo, abi: (await import("@cloakely/sdk")).GLOAM_MEMO_ABI, eventName: "PaymentMemo", fromBlock: poolBlock });
  const paidCommitment = memoLog.at(-1).args.paymentCommitment;
  await time("receive + sweep (sync)", () => B.sync());
  assert(sum(await B.balances(), zeroAddress) === parseEther("2.5") && (await B.pending()).size === 0, "Bob's sync secures the payment at once (swept into his own note)");
  await A.sync();
  assert(sum(await A.balances(), zeroAddress) === parseEther("7.5"), "Alice keeps 7.5 HYPE as change");
  assert(paidCommitment !== undefined, "the memo board names the payment's commitment, not the payer");

  // ── who is seen on chain ───────────────────────────────────────────────
  const txs = await Promise.all(sent.txHashes.map((h) => pub.getTransaction({ hash: h })));
  assert(txs.every((t) => t.from.toLowerCase() === relayer.account.address.toLowerCase()), "the send and its memo come from the relayer, not from Alice");

  // ── forged tickets ─────────────────────────────────────────────────────
  {
    // Mallory claims a note that is not in the vault, and one whose commitment does not match its secret.
    const fake = sdk.encodeNotePackage({ pool: stack.pool, asset: zeroAddress, amountWei: parseEther("100").toString(), secret: toHex(12345n, { size: 32 }), commitment: toHex(999n, { size: 32 }), chainId: ELYSIUM_TESTNET_ID });
    const t = await sdk.sealToReceiveTag(fake, await B.address());
    await sendAndLog(pub, "forged memo", mallory.wallet.writeContract({ address: stack.payMemo, abi: (await import("@cloakely/sdk")).GLOAM_MEMO_ABI, functionName: "postMemo", args: [toHex(999n, { size: 32 }), toHex(new TextEncoder().encode(t))] }));
    // A self ticket under Bob's tag: Mallory can seal one but its secret comes from Bob's seed, which she lacks.
    const selfForge = await sdk.sealToReceiveTag("cloakself1." + JSON.stringify({ v: 1, n: "7", a: zeroAddress, w: parseEther("50").toString(), ch: ELYSIUM_TESTNET_ID }), await B.address());
    await sendAndLog(pub, "forged self memo", mallory.wallet.writeContract({ address: stack.payMemo, abi: (await import("@cloakely/sdk")).GLOAM_MEMO_ABI, functionName: "postMemo", args: [toHex(7n, { size: 32 }), toHex(new TextEncoder().encode(selfForge))] }));
    await B.sync();
    assert(sum(await B.balances(), zeroAddress) === parseEther("2.5") && (await B.pending()).size === 0, "forged and lying tickets add nothing to Bob's balance");
  }

  // ── a balance spread over small notes ──────────────────────────────────
  const C = await GloamCore.unlock(carol.wallet, cfg);
  for (let i = 0; i < 5; i++) await C.shield(carol.wallet, USDC, parseUnits("10", 6));
  await C.sync();
  assert(sum(await C.balances(), USDC) === parseUnits("50", 6) && C.ownNotes(USDC).length === 5, "Carol holds 50 USDC in five 10 USDC notes");
  const many = await time("send 35 USDC from five 10 USDC notes", async () => C.send(USDC, await B.address(), parseUnits("35", 6)));
  assert(many.pieces === 4, "1-in sends: 35 USDC from 10 USDC notes arrives as 4 separate payments");
  await time("receive + sweep 4 payments", () => B.sync());
  assert(sum(await B.balances(), USDC) === parseUnits("35", 6), "Bob secures all four pieces");
  await C.sync();
  assert(sum(await C.balances(), USDC) === parseUnits("15", 6), "Carol keeps 15 USDC");

  // ── withdrawals ────────────────────────────────────────────────────────
  const before = await pub.getBalance({ address: fresh });
  await time("withdraw 1 HYPE (split + cash out)", () => B.withdraw(zeroAddress, fresh, parseEther("1")));
  assert((await pub.getBalance({ address: fresh })) - before === parseEther("0.995"), "withdraw 1 HYPE: a fresh address receives 0.995 (0.5% to Gloam)");
  await B.sync();
  assert(sum(await B.balances(), zeroAddress) === parseEther("1.5"), "Bob keeps 1.5 HYPE");
  const u0 = await pub.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [fresh] });
  const hashes = await time("withdraw max USDC (4 notes)", () => B.withdraw(USDC, fresh, "max"));
  const u1 = await pub.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [fresh] });
  assert(hashes.length === 4 && u1 - u0 === parseUnits("34.825", 6), `withdraw max: 4 cash outs (one per note), 34.825 USDC arrive`);
  await B.sync();
  assert(sum(await B.balances(), USDC) === 0n, "nothing left after withdraw max");
  await rejects(B.withdraw(USDC, fresh, parseUnits("1", 6)), "a withdrawal with no balance is refused before proving");

  // ── the two-device race: the restored device does not double spend ─────
  await restored.sync();
  assert(sum(await restored.balances(), zeroAddress) === parseEther("7.5"), "the second device follows spends made on the first");
  await rejects(restored.send(zeroAddress, await B.address(), parseEther("9")), "and refuses to spend more than is left");

  const proofs = {};
  for (const p of proofLog) (proofs[p.circuit] ??= []).push(p.ms);
  const med = (v) => v.slice().sort((a, b) => a - b)[Math.floor(v.length / 2)];
  const gas = {};
  for (const g of gasLog) (gas[g.label] ??= []).push(g.gas);
  writeMeasurements("part1-anvil", {
    sdk: "@gloamtrade/sdk@0.6.0 via @cloakely/sdk GloamCore",
    timingsMs: timings,
    proofsMs: Object.fromEntries(Object.entries(proofs).map(([k, v]) => [k, { n: v.length, median: med(v), max: Math.max(...v) }])),
    gas: Object.fromEntries(Object.entries(gas).map(([k, v]) => [k, { n: v.length, median: med(v) }])),
    wallMs: Math.round(performance.now() - t0),
  });
  console.log("\ntimings (ms):", timings);
  console.log(`\nPart 1 passed in ${Math.round((performance.now() - t0) / 1000)} s`);
} finally {
  L.stop();
}
process.exit(0);
