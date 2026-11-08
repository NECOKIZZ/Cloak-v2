// Part 3b: the keeper's Gloam relay (services/keeper/gloam.mjs) carrying GloamCore's calls, and refusing abuse.
//
//   node e2e-gloam/part3-relay.mjs
import { encodeFunctionData, parseAbi, parseEther, zeroAddress } from "viem";
import { GloamCore } from "@cloakely/sdk";
import { createGloamRelay } from "../services/keeper/gloam.mjs";
import { ANVIL_KEYS, ELYSIUM_TESTNET_ID, assert, clients, finalProver, localGloam, rejects } from "./lib.mjs";

const t0 = performance.now();
const L = await localGloam({ port: 8554 });
const { rpcUrl, stack, poolBlock } = L;
const pub = L.dep.pub;
const who = (i) => clients(rpcUrl, ANVIL_KEYS[i], ELYSIUM_TESTNET_ID);
const [alice, bob, keeper] = [who(1), who(2), who(8)];
try {
  console.log("Part 3b on anvil (chain 99801): the keeper's Gloam relay");
  const relay = createGloamRelay({ publicClient: pub, walletClient: keeper.wallet, vault: stack.pool, memoBoard: stack.payMemo, hourlySpendWei: parseEther("0.05") });
  const submit = (call) => relay({ kind: call.kind, to: call.to, data: call.data });
  const provers = { shield: await finalProver("shield"), transfer: await finalProver("transfer"), unshield: await finalProver("unshield") };
  const cfg = { publicClient: pub, chainId: ELYSIUM_TESTNET_ID, pool: stack.pool, poolBlock, payMemo: stack.payMemo, provers, submit };
  const A = await GloamCore.unlock(alice.wallet, cfg);
  const B = await GloamCore.unlock(bob.wallet, cfg);
  await A.shield(alice.wallet, zeroAddress, parseEther("2"));
  const sent = await A.send(zeroAddress, await B.address(), parseEther("1"));
  await B.sync();
  assert((await B.balances()).get(zeroAddress) === parseEther("1"), "a private send and Bob's sweep go through the keeper's relay");
  const tx = await pub.getTransaction({ hash: sent.txHashes[0] });
  assert(tx.from.toLowerCase() === keeper.account.address.toLowerCase(), "the keeper is the sender");

  await rejects(relay({ to: alice.account.address, data: "0x" }), "an address the relay doesn't serve is refused");
  await rejects(relay({ to: stack.pool, data: encodeFunctionData({ abi: parseAbi(["function collectFees(address)"]), functionName: "collectFees", args: [zeroAddress] }) }), "a vault function other than transfer and unshield is refused");
  // a call that would revert (a made-up proof) is refused at simulation and costs the keeper nothing
  const before = await pub.getBalance({ address: keeper.account.address });
  const bad = encodeFunctionData({ abi: parseAbi(["function unshield(bytes proof, bytes32 root, bytes32 nullifier, address asset, address to, uint256 amount)"]), functionName: "unshield", args: ["0x" + "11".repeat(256), "0x" + "22".repeat(32), "0x" + "33".repeat(32), zeroAddress, alice.account.address, 1n] });
  await rejects(relay({ to: stack.pool, data: bad }), "a call that would revert is refused before sending");
  assert((await pub.getBalance({ address: keeper.account.address })) === before, "and cost the keeper no gas");
  // memo spam: a memo for a commitment in no served vault is refused before sending, so it costs the keeper nothing
  const spamBefore = await pub.getBalance({ address: keeper.account.address });
  let refusedCount = 0;
  for (let i = 0; i < 20; i++) {
    try {
      await relay({ to: stack.payMemo, data: encodeFunctionData({ abi: parseAbi(["function postMemo(bytes32,bytes)"]), functionName: "postMemo", args: ["0x" + (i + 1).toString(16).padStart(64, "0"), "0x" + "ab".repeat(4000)] }) });
    } catch (e) {
      if (e.status === 400) refusedCount++;
    }
  }
  assert(refusedCount === 20 && (await pub.getBalance({ address: keeper.account.address })) === spamBefore, "memo spam for made-up payments is refused (400) and costs the keeper nothing");
  // the hourly budget: once it is spent, the relay answers 429 and the user can still send it themselves
  const spent = createGloamRelay({ publicClient: pub, walletClient: keeper.wallet, vault: stack.pool, memoBoard: stack.payMemo, hourlySpendWei: 0n });
  let hit = null;
  try {
    await spent({ to: stack.pool, data: bad });
  } catch (e) {
    hit = e;
  }
  assert(hit?.status === 429, "a relay whose hourly budget is spent answers 429");
  // the budget is shared as Gloam's relay shares its own: new sends stop at 80%, refunds and exits may use the rest,
  // and one sender gets at most 60%. A private send's cost sets the budgets below. Fresh accounts, so each send is one
  // note (one transfer and its memo).
  const sendTx = await pub.getTransactionReceipt({ hash: sent.txHashes[0] });
  const c = sendTx.gasUsed * sendTx.effectiveGasPrice;
  const via = (r, sender) => ({ ...cfg, submit: (call) => r({ kind: call.kind, to: call.to, data: call.data }, { sender }) });
  const out9 = who(9).account.address;
  {
    // the 80% line on its own (no per-sender cap): spent after one send and two memos is about 87% of this budget
    const r = createGloamRelay({ publicClient: pub, walletClient: keeper.wallet, vault: stack.pool, memoBoard: stack.payMemo, hourlySpendWei: (c * 130n) / 100n, shares: { sender: 100n } });
    const D = await GloamCore.unlock(who(4).wallet, via(r, "d"));
    await D.shield(who(4).wallet, zeroAddress, parseEther("2"));
    await D.sync();
    await D.send(zeroAddress, await B.address(), parseEther("0.5"));
    let e = null;
    await D.send(zeroAddress, await B.address(), parseEther("0.5")).catch((x) => (e = x));
    assert(/keeping its last gas for refunds and cash outs/.test(String(e?.message)), "past 80% of the hour's budget a new send is refused (429)");
    const before = await pub.getBalance({ address: out9 });
    await D.withdraw(zeroAddress, out9, parseEther("1.5")); // the whole change note: one cash out
    assert((await pub.getBalance({ address: out9 })) > before, "but a cash out still goes through on the reserved top of the budget");
  }
  {
    // the 60% per-sender cap: one sender's second send is cut off, another sender still gets through
    const r = createGloamRelay({ publicClient: pub, walletClient: keeper.wallet, vault: stack.pool, memoBoard: stack.payMemo, hourlySpendWei: c * 3n });
    const E = await GloamCore.unlock(who(5).wallet, via(r, "1.1.1.1"));
    const F = await GloamCore.unlock(who(6).wallet, via(r, "2.2.2.2"));
    await E.shield(who(5).wallet, zeroAddress, parseEther("2"));
    await E.sync();
    await E.send(zeroAddress, await B.address(), parseEther("0.5"));
    let e = null;
    await E.send(zeroAddress, await B.address(), parseEther("0.5")).catch((x) => (e = x));
    assert(/your share of the relay's gas/.test(String(e?.message)), "one sender past 60% of the budget is refused (429)");
    await F.shield(who(6).wallet, zeroAddress, parseEther("0.3"));
    await F.sync();
    const before = await pub.getBalance({ address: out9 });
    await F.withdraw(zeroAddress, out9, parseEther("0.3"));
    assert((await pub.getBalance({ address: out9 })) > before, "while another sender still gets through");
  }
  console.log(`\nPart 3b passed in ${Math.round((performance.now() - t0) / 1000)} s`);
} finally {
  L.stop();
}
process.exit(0);
