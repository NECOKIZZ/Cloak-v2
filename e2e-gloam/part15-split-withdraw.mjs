// Part 15: spread-out withdrawals on Cloak v2 on Gloam. The app splits a HYPE balance into 3 exact notes privately,
// proves each piece's cash out now (recipient and amount fixed by the proof), and hands the pieces to the keeper's
// schedule queue. The queue checks each through the Gloam relay (a dry run), holds it, and sends it once it's due.
// Gloam's vault keeps every root valid, so proofs made before later deposits still go through. A piece whose note the
// owner spends first is dropped, and the queue refuses anything that isn't a vault cash out.
// Anvil (chain 99801), Gloam's final keys.
//
//   node e2e-gloam/part15-split-withdraw.mjs
import { encodeFunctionData, parseAbi, parseEther } from "viem";
import { GloamPrivate } from "@cloakely/sdk";
import { createGloamRelay } from "../services/keeper/gloam.mjs";
import { createGloamLoop } from "../services/keeper/gloamLoop.mjs";
import { startSchedule } from "../services/keeper/schedule.mjs";
import { deployCloakGloam } from "./stack.mjs";
import { ANVIL_KEYS, ELYSIUM_TESTNET_ID, assert, clients, finalProver, rejects, rpc, sendAndLog, startAnvil, writeMeasurements } from "./lib.mjs";

const t0 = performance.now();
const anvil = await startAnvil({ port: 8567 });
const rpcUrl = anvil.rpcUrl;
const who = (i) => clients(rpcUrl, ANVIL_KEYS[i], ELYSIUM_TESTNET_ID);
const [dep, alice, bob, keeper] = [who(0), who(1), who(2), who(8)];
const pub = dep.pub;
const out = {};
try {
  console.log("Part 15 on anvil (chain 99801): spread-out withdrawals");
  const warp = async (s) => (await rpc(rpcUrl, "evm_increaseTime", [s]), await rpc(rpcUrl, "evm_mine"));
  const { contracts: c, block } = await deployCloakGloam({ me: dep, rpcUrl, pk: ANVIL_KEYS[0], warp });
  const relay = createGloamRelay({ publicClient: pub, walletClient: keeper.wallet, vault: c.gloamVault, launchVault: c.launchVault, memoBoard: c.memoBoard, hourlySpendWei: parseEther("5") });
  await createGloamLoop({ publicClient: pub, account: keeper.account, send: async (x) => (await sendAndLog(pub, x.functionName, keeper.wallet.writeContract(x))).transactionHash, launchVault: c.launchVault }).tick();
  const provers = { shield: await finalProver("shield"), transfer: await finalProver("transfer"), unshield: await finalProver("unshield") };
  const cfg = { publicClient: pub, chainId: ELYSIUM_TESTNET_ID, gloamVault: { pool: c.gloamVault, poolBlock: block }, launchVault: { pool: c.launchVault, poolBlock: block }, payMemo: c.memoBoard, provers, submit: (call) => relay({ kind: call.kind, to: call.to, data: call.data }), whype: c.whypeStandIn };
  const A = await GloamPrivate.unlock(alice.wallet, cfg);
  await A.loadMarkets();

  // the keeper's queue, on the chain's clock, ticked by hand
  let chainNow = 0;
  const clock = () => chainNow;
  const syncClock = async () => (chainNow = Number((await pub.getBlock()).timestamp));
  const gloamPiece = (call) => ({ to: call.to, data: call.data });
  const q = startSchedule({
    check: async () => { throw new Error("no Cloak relay here"); },
    send: async () => { throw new Error("no Cloak relay here"); },
    gloam: { check: (call) => relay(gloamPiece(call), { dryRun: true, sender: "schedule" }), send: (call) => relay(gloamPiece(call), { sender: "schedule" }) },
    now: clock,
    tickMs: 0,
  });
  await syncClock();

  await A.shieldHype(alice.wallet, parseEther("5"));
  const dest = "0x000000000000000000000000000000000000beef";
  const amount = parseEther("3");
  const pieces = await A.planSplitWithdraw(A.hypeMarket.token, dest, amount, { pieces: 3, windowSecs: 3600 });
  out.pieces = pieces.map((p) => p.amount.toString());
  assert(pieces.length === 3 && pieces.reduce((a, p) => a + p.amount, 0n) === amount, `3 pieces of different sizes add up to 3 HYPE (${pieces.map((p) => Number(p.amount) / 1e18).join(", ")})`);
  assert(new Set(pieces.map((p) => p.amount)).size === 3, "every piece is a different size");
  assert(pieces.every((p, i) => i === 0 || p.notBefore >= pieces[i - 1].notBefore) && pieces[0].notBefore > chainNow, "spread over the window, in order, none right away");
  assert(pieces.every((p) => p.call.kind === "gloamUnshield" && p.call.to.toLowerCase() === c.launchVault.toLowerCase()), "each is a cash out from the launch vault, where the HYPE is");

  // the device's balance still shows the pieces until they go: the notes are just set aside
  assert((await A.balance(A.hypeMarket.pool)) === parseEther("5"), "nothing left the vault yet: the split was private sends to self");

  const ids = await q.add({ pieces });
  assert(ids.length === 3 && q.status(ids).every((s) => s.state === "waiting"), "the keeper checked all 3 (a dry run through the relay) and holds them");
  const again = await q.add({ pieces });
  assert(again.join() === ids.join(), "handing the same pieces again (after a keeper restart) queues nothing twice");

  // the queue refuses what isn't a vault cash out
  const notUnshield = { ...pieces[0], call: { ...pieces[0].call, data: encodeFunctionData({ abi: parseAbi(["function isSpent(bytes32) view returns (bool)"]), functionName: "isSpent", args: [pieces[0].call.nullifier] }) } };
  await rejects(q.add({ pieces: [notUnshield] }), "a call that isn't a vault cash out is refused");
  const otherDest = { ...pieces[0], call: { ...pieces[0].call, data: pieces[0].call.data.replace(dest.slice(2).toLowerCase(), "000000000000000000000000000000000000dead") } };
  // on a queue that hasn't seen the real piece (on this one the same note maps to the queued original, left untouched)
  const q2 = startSchedule({ check: async () => {}, send: async () => {}, gloam: { check: (call) => relay(gloamPiece(call), { dryRun: true }), send: async () => {} }, now: clock, tickMs: 0 });
  await rejects(q2.add({ pieces: [otherDest] }), "a piece with its recipient changed fails its proof check and is refused");
  assert(q.status([ids[0]])[0].state === "waiting", "and the queued original is untouched");

  // Bob deposits meanwhile: the tree moves on, the pieces' roots stay valid (Gloam keeps every root)
  const B = await GloamPrivate.unlock(bob.wallet, cfg);
  await B.loadMarkets();
  await B.shieldHype(bob.wallet, parseEther("1"));

  // Alice spends the third piece's note first: she cancels it
  const third = pieces[2];
  const lvCore = A.cores.find((x) => x.config.pool.toLowerCase() === c.launchVault.toLowerCase());
  const cancelNote = lvCore.ownNotes("0x0000000000000000000000000000000000000000").find((n) => `0x${n.nullifier.toString(16).padStart(64, "0")}` === third.call.nullifier.toLowerCase());
  assert(!!cancelNote, "the third piece's note is in Alice's balance");

  // nothing goes before its time
  await q.tick();
  assert(q.status(ids).every((s) => s.state === "waiting"), "before their times, nothing is sent");

  // the first two come due
  await warp(pieces[1].notBefore - chainNow + 1);
  await syncClock();
  await q.tick();
  const st = q.status(ids);
  assert(st[0].state === "sent" && st[1].state === "sent" && st[2].state === "waiting", "at their times the first two went out, the third still waits");
  const got = await pub.getBalance({ address: dest });
  const expect = ((pieces[0].amount + pieces[1].amount) * 9950n) / 10000n;
  out.arrived = got.toString();
  assert(got >= expect - 2n && got <= pieces[0].amount + pieces[1].amount, `the recipient got ${Number(got) / 1e18} HYPE (the two pieces less the vault's 0.5% fee)`);
  const tx = await pub.getTransaction({ hash: st[0].txHash });
  assert(tx.from.toLowerCase() === keeper.account.address.toLowerCase(), "the keeper sent them: Alice's wallet never appears");

  // Alice spends the third piece's note before it's due (a private send to herself): that piece is cancelled
  await lvCore.transferOne(cancelNote, cancelNote.amount / 2n, undefined, () => {});
  await warp(third.notBefore - (await syncClock()) + 1);
  await syncClock();
  await q.tick();
  const st3 = q.status([ids[2]])[0];
  out.cancelled = st3;
  assert(st3.state === "dropped", `the keeper dropped the third piece once its note was spent (${st3.state}${st3.error ? `, ${st3.error}` : ""})`);
  assert((await pub.getBalance({ address: dest })) === got, "and nothing more reached the recipient");

  writeMeasurements("part15-split-withdraw", { ...out, seconds: Math.round((performance.now() - t0) / 1000) });
  console.log(`\nPart 15 passed in ${Math.round((performance.now() - t0) / 1000)} s`);
} finally {
  anvil.stop();
}
process.exit(0);
