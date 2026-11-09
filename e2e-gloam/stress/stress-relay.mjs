// Stress and break the Gloam relay (services/keeper/gloam.mjs), called in process like the keeper's HTTP layer does.
//   1. malformed and hostile payloads (all must be refused for free)
//   2. the same spend fired concurrently (lock) on Gloam's vault and on the launch vault
//   3. many different valid spends fired concurrently with a small budget (budget checked before cost is known)
//   4. concurrent sends from one relay wallet (nonces)
// Anvil on port 8600, interval mining (2 s blocks) for 2-4 so the relay's waits look like a real chain's.
//
//   node e2e-gloam/stress/stress-relay.mjs
import { encodeFunctionData, parseAbi, toHex } from "viem";
import { setup, launchCore, unshieldCall, record, summary, ms, rpc, createGloamRelay, MEMO, UNSHIELD, zeroAddress, parseEther } from "./common.mjs";

const t0 = performance.now();
const S = await setup({ port: 8600 });
const { pub, c, keeper } = S;
const sink = S.who(9).account.address;
const errOf = async (p) => {
  try {
    await p;
    return null;
  } catch (e) {
    return e;
  }
};
try {
  console.log("stress-relay: Gloam relay under hostile input and concurrency");
  // notes to play with: Alice holds 14 launch-vault HYPE notes of 0.1
  const { core: A, w: alice } = await launchCore(S, 1);
  for (let i = 0; i < 14; i++) await A.shield(alice.wallet, zeroAddress, parseEther("0.1"));
  await A.sync();
  const notes = A.ownNotes(zeroAddress);
  console.log(`  Alice holds ${notes.length} notes in the launch vault`);

  // ── 1. malformed and hostile payloads ──
  const k0 = await pub.getBalance({ address: keeper.account.address });
  const bad = [
    ["null body", null],
    ["array body", []],
    ["data not hex", { to: c.launchVault, data: "0xzz" }],
    ["data odd length", { to: c.launchVault, data: "0x123" }],
    ["to not a string", { to: 5, data: "0x" }],
    ["not a served target", { to: sink, data: "0x" }],
    ["the guard (not served)", { to: c.launchVaultGuard, data: "0x" }],
    ["oversized data (25 KB)", { to: c.batcher, data: "0x" + "ab".repeat(25_000) }],
    ["vault selector, garbage args", { to: c.launchVault, data: "0x" + "00".repeat(4) }],
    ["vault collectFees", { to: c.launchVault, data: encodeFunctionData({ abi: parseAbi(["function collectFees(address)"]), functionName: "collectFees", args: [zeroAddress] }) }],
    ["memo over 8 KB", { to: c.memoBoard, data: encodeFunctionData({ abi: MEMO, functionName: "postMemo", args: [toHex(notes[0].commitment, { size: 32 }), "0x" + "ab".repeat(8193)] }) }],
    ["memo for a made-up payment", { to: c.memoBoard, data: encodeFunctionData({ abi: MEMO, functionName: "postMemo", args: ["0x" + "77".repeat(32), "0x01"] }) }],
    ["escrow call that reverts", { to: c.batcher, data: "0xdeadbeef" }],
  ];
  let allRefused = true;
  for (const [name, body] of bad) {
    const e = await errOf(S.relay(body, { sender: "x" }));
    if (!e || !e.status) {
      allRefused = false;
      console.log(`    ${name}: ${e ? `refused without a status (${e.message})` : "ACCEPTED"}`);
    }
  }
  record("relay-malformed", allRefused, `${bad.length} malformed or hostile payloads ${allRefused ? "all refused with a status" : "not all refused cleanly"}`);
  // cash out to forbidden destinations: proofs bound to each destination
  const forbidden = [["zero address", zeroAddress], ["the vault itself", c.launchVault], ["Gloam's vault", c.gloamVault], ["the memo board", c.memoBoard], ["an escrow (batcher)", c.batcher]];
  let fRefused = 0;
  for (const [name, to] of forbidden) {
    const call = await unshieldCall(A, notes[0], to);
    const e = await errOf(S.relay(call, { sender: "x" }));
    if (e?.status === 400 && /can't go to that address/.test(e.message)) fRefused++;
    else console.log(`    cash out to ${name}: ${e ? e.message : "ACCEPTED"}`);
  }
  record("relay-cashout-dest", fRefused === forbidden.length, `${fRefused}/${forbidden.length} forbidden cash-out destinations refused before simulation`);
  const k1 = await pub.getBalance({ address: keeper.account.address });
  record("relay-refusals-free", k0 === k1, `refused calls cost the relay ${k0 - k1} wei`);

  // ── 2. the same spend fired 6 times at once (interval mining: 2 s blocks) ──
  await rpc(S.rpcUrl, "evm_setAutomine", [false]);
  await rpc(S.rpcUrl, "evm_setIntervalMining", [2]);
  const nonceBefore = await pub.getTransactionCount({ address: keeper.account.address });
  const dup = await unshieldCall(A, notes[1], sink);
  const r6 = await Promise.allSettled(Array.from({ length: 6 }, () => S.relay(dup, { sender: "dup" })));
  await new Promise((r) => setTimeout(r, 5000));
  const nonceAfter = await pub.getTransactionCount({ address: keeper.account.address });
  const sentTx = nonceAfter - nonceBefore;
  const oks = r6.filter((x) => x.status === "fulfilled").length;
  const why = r6.filter((x) => x.status === "rejected").map((x) => x.reason.message.slice(0, 60));
  record("relay-dup-launchvault", sentTx <= 1, `same launch-vault spend x6 at once: ${oks} accepted, ${sentTx} transactions sent by the relay (${[...new Set(why)].join(" | ")})`);

  // the same against Gloam's vault (USDC): Bob needs a USDC note there
  const { GloamCore } = await import("@cloakely/sdk");
  const bob = S.who(2);
  await rpc(S.rpcUrl, "evm_setIntervalMining", [0]);
  await rpc(S.rpcUrl, "evm_setAutomine", [true]);
  const usdcAbi = parseAbi(["function mint(address,uint256)"]);
  await S.dep.wallet.writeContract({ address: c.usdc, abi: usdcAbi, functionName: "mint", args: [bob.account.address, 10_000n * 10n ** 6n] });
  const B = await GloamCore.unlock(bob.wallet, { publicClient: pub, chainId: 99801, pool: c.gloamVault, poolBlock: S.block, payMemo: c.memoBoard, provers: S.provers, submit: S.viaRelay("bob") });
  for (let i = 0; i < 3; i++) await B.shield(bob.wallet, c.usdc, 10n * 10n ** 6n);
  await B.sync();
  const bn = B.ownNotes(c.usdc);
  await rpc(S.rpcUrl, "evm_setAutomine", [false]);
  await rpc(S.rpcUrl, "evm_setIntervalMining", [2]);
  const n2 = await pub.getTransactionCount({ address: keeper.account.address });
  const dupG = await unshieldCall(B, bn[0], sink);
  const g6 = await Promise.allSettled(Array.from({ length: 6 }, () => S.relay(dupG, { sender: "dupg" })));
  await new Promise((r) => setTimeout(r, 5000));
  const sentG = (await pub.getTransactionCount({ address: keeper.account.address })) - n2;
  record("relay-dup-gloamvault", sentG <= 1, `same Gloam-vault spend x6 at once: ${g6.filter((x) => x.status === "fulfilled").length} accepted, ${sentG} transactions sent`);

  // ── 3 and 4. 8 different valid cash outs at once, small budget ──
  // one cash out's cost
  const one = await unshieldCall(A, notes[2], sink);
  const gas = await pub.estimateGas({ account: keeper.account, to: one.to, data: one.data });
  const price = await pub.getGasPrice();
  const cost = gas * price;
  // budget: about 2 cash outs for the whole hour; one sender's exit share is 60% of that (about 1)
  const small = createGloamRelay({ publicClient: pub, walletClient: keeper.wallet, vault: c.gloamVault, launchVault: c.launchVault, memoBoard: c.memoBoard, hourlySpendWei: cost * 2n });
  const calls = [one];
  for (let i = 3; i < 10; i++) calls.push(await unshieldCall(A, notes[i], sink));
  const n3 = await pub.getTransactionCount({ address: keeper.account.address });
  const t = performance.now();
  const r8 = await Promise.allSettled(calls.map((x) => small(x, { sender: "one-ip" })));
  const took = ms(t);
  await new Promise((r) => setTimeout(r, 5000));
  const sent8 = (await pub.getTransactionCount({ address: keeper.account.address })) - n3;
  const st = small.stats();
  const reasons = {};
  for (const x of r8) if (x.status === "rejected") reasons[x.reason.message.slice(0, 70)] = (reasons[x.reason.message.slice(0, 70)] ?? 0) + 1;
  record(
    "relay-budget-race",
    st.baseSpentWei <= st.baseBudgetWei,
    `8 cash outs at once from one sender, budget ~2 cash outs (sender share ~1): ${r8.filter((x) => x.status === "fulfilled").length} succeeded, ${sent8} sent, spent ${(Number(st.baseSpentWei) / Number(cost)).toFixed(2)} cash outs' worth of a ${(Number(st.baseBudgetWei) / Number(cost)).toFixed(2)} budget in ${took} ms. Refusals: ${JSON.stringify(reasons)}`,
  );
  const nonceErrs = r8.filter((x) => x.status === "rejected" && /nonce|replacement|underpriced/i.test(x.reason.message)).length;
  record("relay-nonce-collisions", nonceErrs === 0, `${nonceErrs} of 8 concurrent valid sends failed on a nonce clash (the relay picks 'pending' nonces itself, outside the keeper's serial queue)`);

  // ── 5. 10 concurrent valid sends, roomy budget: how many get through? ──
  const roomy = createGloamRelay({ publicClient: pub, walletClient: keeper.wallet, vault: c.gloamVault, launchVault: c.launchVault, memoBoard: c.memoBoard, hourlySpendWei: parseEther("10") });
  await rpc(S.rpcUrl, "evm_setIntervalMining", [0]);
  await rpc(S.rpcUrl, "evm_setAutomine", [true]);
  await A.sync();
  const left = A.ownNotes(zeroAddress);
  const more = [];
  for (const n of left.slice(0, 4)) more.push(await unshieldCall(A, n, sink));
  await rpc(S.rpcUrl, "evm_setAutomine", [false]);
  await rpc(S.rpcUrl, "evm_setIntervalMining", [2]);
  const t5 = performance.now();
  const r4 = await Promise.allSettled(more.map((x, i) => roomy(x, { sender: `ip${i}` })));
  record("relay-concurrent-throughput", r4.every((x) => x.status === "fulfilled"), `${more.length} different valid cash outs at once (roomy budget, 4 senders): ${r4.filter((x) => x.status === "fulfilled").length} succeeded in ${ms(t5)} ms; failures: ${[...new Set(r4.filter((x) => x.status === "rejected").map((x) => x.reason.message.slice(0, 80)))].join(" | ")}`);

  console.log(`\ntook ${Math.round((performance.now() - t0) / 1000)} s`);
} finally {
  S.stop();
  summary("stress-relay");
}
process.exit(0);
