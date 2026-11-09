// Many notes per account, and payments as a weapon.
//   A. 40 notes in one account: a fresh device's first balance, a warm balance, RPC calls per sync, and a send that
//      needs 25 of them
//   B. dust payments: an attacker pays a victim many tiny (and zero) payments; the victim's app sweeps each one on its
//      next sync, one proof and one relayed transfer each, from the victim's own relay share
//
//   node e2e-gloam/stress/stress-sync.mjs
import { createPublicClient, formatEther, http } from "viem";
import { setup, record, summary, ms, createGloamRelay, GloamPrivate, GloamCore, zeroAddress, parseEther } from "./common.mjs";
import { chainFor } from "../lib.mjs";

const S = await setup({ port: 8608, hourly: "100" });
const { pub, c } = S;
const N = Number(process.env.NOTES ?? 40);
try {
  console.log(`stress-sync: ${N} notes, and dust payments`);
  const alice = S.who(1);
  const A = await GloamPrivate.unlock(alice.wallet, S.cfgFor(S.viaRelay("alice")));
  await A.loadMarkets();
  const H = A.hypeMarket.pool;
  const tShield = performance.now();
  for (let i = 0; i < N; i++) await A.shieldHype(alice.wallet, parseEther("0.1"));
  console.log(`  ${N} deposits made in ${Math.round(ms(tShield) / 1000)} s`);

  // a counting client: how many RPC requests one balance() makes
  let calls = 0;
  const counting = createPublicClient({ chain: chainFor(S.rpcUrl), transport: http(S.rpcUrl, { onFetchRequest: () => void calls++ }), pollingInterval: 50 });
  const cold = await GloamPrivate.unlock(alice.wallet, { ...S.cfgFor(S.viaRelay("alice-cold")), publicClient: counting });
  let t = performance.now();
  const b1 = await cold.balance(H);
  const coldMs = ms(t);
  const coldCalls = calls;
  calls = 0;
  t = performance.now();
  await cold.balance(H);
  const warmMs = ms(t);
  const warmCalls = calls;
  record("sync-many-notes", coldMs < 10_000, `${N} notes (${formatEther(b1)} HYPE): fresh device balance() ${coldMs} ms / ${coldCalls} RPC requests; again ${warmMs} ms / ${warmCalls} RPC requests (an isSpent read per note, every sync, and the whole tree re-read)`);
  calls = 0;
  t = performance.now();
  await cold.send(cold.hypeMarket.token, await A.address(), parseEther("2.5"));
  record("send-from-many-notes", true, `a 2.5 HYPE send from ${N} notes of 0.1 took ${Math.round(ms(t) / 1000)} s, ${calls} RPC requests, one transfer per note (25)`);

  // ── B. dust payments ──
  const bob = S.who(2);
  const carol = S.who(3);
  // the victim's relay: a budget where one sender's share is about 6 transfers
  const C = await GloamCore.unlock(carol.wallet, { publicClient: pub, chainId: 99801, pool: c.launchVault, poolBlock: S.block, payMemo: c.memoBoard, provers: S.provers, submit: S.viaRelay("carol") });
  await C.shield(carol.wallet, zeroAddress, parseEther("1"));
  await C.sync();
  const first = await C.send(zeroAddress, (await A.address()).slice(6), 1n);
  const tr = await pub.getTransactionReceipt({ hash: first.txHashes[0] });
  const transferCost = tr.gasUsed * tr.effectiveGasPrice;
  const victimRelay = createGloamRelay({ publicClient: pub, walletClient: S.keeper.wallet, vault: c.gloamVault, launchVault: c.launchVault, memoBoard: c.memoBoard, escrows: [c.launchSwap, c.batcher], hourlySpendWei: (transferCost * 10n * 100n) / 60n, shares: { memo: 50n } });
  const B = await GloamPrivate.unlock(bob.wallet, S.cfgFor((call) => victimRelay({ kind: call.kind, to: call.to, data: call.data }, { sender: "bob" })));
  await B.shieldHype(bob.wallet, parseEther("1"));
  const bTag = (await B.address()).slice("cloak:".length);
  const DUST = 12;
  t = performance.now();
  for (let i = 0; i < DUST; i++) await C.send(zeroAddress, bTag, 1n);
  const attackS = Math.round(ms(t) / 1000);
  // a zero-amount payment, made by calling the core's transfer step directly (the SDK's send refuses 0)
  await C.sync();
  let zero = "made";
  await C.transferOne(C.ownNotes(zeroAddress)[0], 0n, bTag, () => {}).catch((e) => (zero = `refused: ${e.message.slice(0, 80)}`));
  t = performance.now();
  let berr = null;
  const bb = await B.balance(H).catch((e) => ((berr = e), null));
  const victimMs = ms(t);
  record("dust-sweep-dos", !berr, `attacker paid the victim ${DUST} payments of 1 wei (took the attacker ${attackS} s) and a zero payment (${zero}); the victim's next balance() ${berr ? `THREW after ${Math.round(victimMs / 1000)} s: "${berr.message.slice(0, 90)}"` : `took ${Math.round(victimMs / 1000)} s and read ${formatEther(bb)}`}, with the victim's relay share set to ~6 transfers`);
  let again = null;
  await B.balance(H).catch((e) => (again = e));
  record("dust-sweep-dos-sticks", !again, `and again: ${again ? `throws "${again.message.slice(0, 60)}" (the victim can't read or spend anything until the relay's hour rolls over)` : "works"}`);
} finally {
  S.stop();
  summary("stress-sync");
}
process.exit(0);
