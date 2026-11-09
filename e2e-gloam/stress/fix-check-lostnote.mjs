// A relayed call that lands on chain while the app is told it failed (an HTTP timeout, a dropped connection, a keeper
// restart mid-request, or the relay's own receipt wait failing on a flaky RPC). GloamCore and launchVault.ts make the
// new notes' secrets from a random nonce, post the sealed memo only after submit() returns, and track the note only
// after submit() returns. So when submit() throws after the transaction landed, the change note (and the payee's
// note) can never be found again, on this device or any other.
//
//   node e2e-gloam/stress/stress-lostnote.mjs
import { formatEther } from "viem";
import { setup, record, summary, GloamPrivate, createGloamRelay, zeroAddress, parseEther } from "./common.mjs";

const S = await setup({ port: 8606 });
const { pub, c } = S;
try {
  console.log("stress-lostnote: submit() fails after the transaction landed");
  const alice = S.who(1);
  const bob = S.who(2);
  // a submitter that relays for real, then reports a failure for the next call of a given kind (as a dropped HTTP
  // response would): the transaction is on chain, the app sees an error
  let failNext = null;
  const flaky = (call) =>
    S.relay({ kind: call.kind, to: call.to, data: call.data }, { sender: "alice" }).then((h) => {
      if (failNext === call.kind) {
        failNext = null;
        throw new Error("fetch failed (connection reset)");
      }
      return h;
    });
  const recs = S.memRecords();
  const A = await GloamPrivate.unlock(alice.wallet, S.cfgFor(flaky, recs));
  const B = await GloamPrivate.unlock(bob.wallet, S.cfgFor(S.viaRelay("bob")));
  await A.loadMarkets();
  const H = A.hypeMarket.pool;
  await A.shieldHype(alice.wallet, parseEther("1"));
  console.log(`  Alice: ${formatEther(await A.balance(H))} HYPE`);

  // 1. a private send of 0.1 whose transfer lands but whose response is lost
  failNext = "transfer";
  let err = null;
  await A.send(A.hypeMarket.token, await B.address(), parseEther("0.1")).catch((e) => (err = e));
  const vaultSaw = await pub.getBalance({ address: c.launchVault });
  const aSame = await A.balance(H);
  const A2 = await GloamPrivate.unlock(alice.wallet, S.cfgFor(S.viaRelay("alice2"))); // another device, same wallet
  const aOther = await A2.balance(H);
  const bGot = await B.balance(H);
  record("lost-change-note", aSame + aOther > 0n, `send 0.1 of a 1 HYPE note, transfer landed but submit threw ("${err?.message}"): Alice's balance this device ${formatEther(aSame)}, another device ${formatEther(aOther)}, Bob got ${formatEther(bGot)}; the vault still holds ${formatEther(vaultSaw)} HYPE nobody can find`);

  // 2. an instant buy whose swap lands but whose response is lost: the bought tokens' note and the buffer
  await A.shieldHype(alice.wallet, parseEther("1"));
  const before = await A.balance(H);
  failNext = "escrow";
  err = null;
  await A.buy(c.launchToken, parseEther("0.2")).catch((e) => (err = e));
  const tokNow = await A.balance(A.market(c.launchToken).pool);
  await A.finishPending();
  const recLeft = recs.load().length;
  const A3 = await GloamPrivate.unlock(alice.wallet, S.cfgFor(S.viaRelay("alice3")));
  const tokOther = await A3.balance(c.launchToken);
  record("lost-swap-output", tokNow + tokOther > 0n, `buy with 0.2 HYPE, swap landed but submit threw ("${err?.message}"): HYPE ${formatEther(before)} -> ${formatEther(await A.balance(H))}, tokens this device ${formatEther(tokNow)}, another device ${formatEther(tokOther)}, swap records kept for finishPending: ${recLeft} (the buffer stays owed to an escrow whose record was never saved)`);

  // 3. a batch payout claim whose transaction lands but whose response is lost: finishPending sees "already paid"
  await A.shieldHype(alice.wallet, parseEther("1"));
  await A.batch(c.launchToken, "buy", parseEther("0.05"));
  const info = await A.roundInfo();
  await S.warp(info.roundSecs * 2 + 1);
  const t = await S.loop.tick();
  const settled = t.rounds.some((x) => x.action === "settled");
  const tokBefore = await A.balance(c.launchToken);
  failNext = "escrow";
  const r1 = await A.finishPending();
  const r2 = await A.finishPending();
  const tokAfter = await A.balance(c.launchToken);
  const A4 = await GloamPrivate.unlock(alice.wallet, S.cfgFor(S.viaRelay("alice4")));
  const tokOther4 = await A4.balance(c.launchToken);
  record("lost-batch-payout", tokAfter > tokBefore || tokOther4 > tokOther, `round settled: ${settled}; payout claim landed but submit threw (${r1.errors.map((e) => e.error).join(",")}), next open says "${r2.done.map((d) => d.outcome).join(",")}"; tokens ${formatEther(tokBefore)} -> ${formatEther(tokAfter)} (another device ${formatEther(tokOther4)})`);

  // 4. the relay's memo budget (8% of the hour, shared by every user) is used up: the transfer is relayed, its memo is
  //    refused (429), and GloamCore.transferOne throws after the transfer landed
  const memoless = createGloamRelay({ publicClient: pub, walletClient: S.keeper.wallet, vault: c.gloamVault, launchVault: c.launchVault, memoBoard: c.memoBoard, hourlySpendWei: parseEther("1"), shares: { memo: 0n } });
  const D = await GloamPrivate.unlock(S.who(4).wallet, S.cfgFor(S.viaRelay("dave")));
  await D.loadMarkets();
  await D.shieldHype(S.who(4).wallet, parseEther("1"));
  const Dm = await GloamPrivate.unlock(S.who(4).wallet, S.cfgFor((call) => memoless({ kind: call.kind, to: call.to, data: call.data }, { sender: "dave" })));
  err = null;
  await Dm.send(Dm.hypeMarket.token, await B.address(), parseEther("0.1")).catch((e) => (err = e));
  const dOther = await (await GloamPrivate.unlock(S.who(4).wallet, S.cfgFor(S.viaRelay("dave2")))).balance(H);
  record("memo-budget-same-device", (await Dm.balance(H)) > 0n, `same device right after: ${formatEther(await Dm.balance(H))}`);
  record("lost-on-memo-budget", dOther > 0n, `memo budget used up: send 0.1 of 1 HYPE -> "${err?.message?.slice(0, 70)}"; Dave's balance afterwards ${formatEther(dOther)} (the transfer landed, change and payment unfindable)`);
  {
    const Dr = Dm; // the same device later, once the relay takes memos again
    Dr.cfg.submit; // (unchanged object)
    for (const c of Dm.cores) c.cfg.submit = (call) => S.viaRelay("dave")(call);
    await Dm.syncAll();
    const dLater = await (await GloamPrivate.unlock(S.who(4).wallet, S.cfgFor(S.viaRelay("dave3")))).balance(H);
    record("memo-retried-later", dLater > 0n, `after the relay takes memos again and Dave's device syncs, another device sees ${formatEther(dLater)}`);
  }
  // and a deposit: the deposit lands from the wallet, its memo is refused, shield() throws before tracking the note
  const E = await GloamPrivate.unlock(S.who(5).wallet, S.cfgFor((call) => memoless({ kind: call.kind, to: call.to, data: call.data }, { sender: "erin" })));
  await E.loadMarkets();
  const w0 = await pub.getBalance({ address: S.who(5).account.address });
  err = null;
  await E.shieldHype(S.who(5).wallet, parseEther("1")).catch((e) => (err = e));
  const w1 = await pub.getBalance({ address: S.who(5).account.address });
  record("deposit-memo-same-device", (await E.balance(H)) > 0n, `same device right after: ${formatEther(await E.balance(H))}`);
  const eOther = await (await GloamPrivate.unlock(S.who(5).wallet, S.cfgFor(S.viaRelay("erin2")))).balance(H);
  record("lost-deposit-on-memo-budget", eOther > 0n, `memo budget used up: shield 1 HYPE -> "${err?.message?.slice(0, 70)}"; wallet paid ${formatEther(w0 - w1)} HYPE, private balance afterwards ${formatEther(eOther)}`);
} finally {
  S.stop();
  summary("stress-lostnote");
}
process.exit(0);
