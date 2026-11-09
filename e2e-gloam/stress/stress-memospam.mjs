// Memo-board spam aimed at every account's sync. The board takes posts from anyone (the relay only limits what IT
// pays for). Every account's sync reads every memo and tries to open every sealed ticket in it. Two kinds of junk:
//   - tickets sealed to some other tag: each costs every syncing account a failed open (ECDH + decrypt);
//   - "cloakself1." tickets sealed to a victim's public tag: they open, cost a Poseidon hash each, and stay in the
//     victim's candidate list for the life of the session (they can never match a note in the tree).
// The attacker posts straight to the board and pays the gas; we measure what one fresh sync then costs.
//
//   node e2e-gloam/stress/stress-memospam.mjs          (MEMOS=40 by default)
import * as gloam from "@gloamtrade/sdk";
import { encodeFunctionData, toHex } from "viem";
import { setup, record, summary, ms, GloamPrivate, MEMO, parseEther } from "./common.mjs";
import { gloamKeysFromBytes } from "@cloakely/sdk";

const MEMOS = Number(process.env.MEMOS ?? 40);
const S = await setup({ port: 8618 });
const { pub, c } = S;
try {
  console.log(`stress-memospam: ${MEMOS} junk memos of ~8 KB`);
  const victim = S.who(1);
  const V = await GloamPrivate.unlock(victim.wallet, S.cfgFor(S.viaRelay("v")));
  await V.loadMarkets();
  await V.shieldHype(victim.wallet, parseEther("1"));
  const vtag = (await V.address()).slice("cloak:".length);
  const other = gloamKeysFromBytes(new Uint8Array(32).fill(7)).receiveTag;
  // one memo's worth of tickets, half to someone else, half fake self-tickets to the victim
  const t0 = performance.now();
  const tickets = [];
  let bytes = 0;
  for (let i = 0; bytes < 8000; i++) {
    const t = i % 2 ? await gloam.sealToReceiveTag("cloakself1." + JSON.stringify({ v: 1, n: String(i + 1), a: "0x0000000000000000000000000000000000000000", w: "1", ch: 99801 }), vtag) : await gloam.sealToReceiveTag("x".repeat(40), other);
    if (bytes + t.length + 1 > 8000) break;
    tickets.push(t);
    bytes += t.length + 1;
  }
  const body = toHex(new TextEncoder().encode(tickets.join("\n")));
  console.log(`  ${tickets.length} tickets per 8 KB memo (made in ${ms(t0)} ms)`);
  const atk = S.who(5);
  let gas = 0n;
  for (let i = 0; i < MEMOS; i++) {
    const h = await atk.wallet.sendTransaction({ to: c.memoBoard, data: encodeFunctionData({ abi: MEMO, functionName: "postMemo", args: [toHex(i + 1, { size: 32 }), body] }) });
    const r = await pub.waitForTransactionReceipt({ hash: h });
    gas += r.gasUsed * r.effectiveGasPrice;
  }
  // a fresh device of the victim, and a fresh device of a bystander
  let t = performance.now();
  const V2 = await GloamPrivate.unlock(victim.wallet, S.cfgFor(S.viaRelay("v2")));
  const b = await V2.balance(V2.hypeMarket.pool);
  const victimMs = ms(t);
  t = performance.now();
  const X = await GloamPrivate.unlock(S.who(6).wallet, S.cfgFor(S.viaRelay("x")));
  await X.balance(X.hypeMarket.pool);
  const byMs = ms(t);
  const cand = V2.cores.reduce((a, core) => a + core.candidates.length, 0);
  record("memo-spam-sync", victimMs < 5000 && byMs < 5000, `${MEMOS} memos x ${tickets.length} tickets (${MEMOS * tickets.length} tickets, attacker paid ${(Number(gas) / 1e18).toFixed(4)} HYPE on anvil gas prices): victim's fresh sync ${(victimMs / 1000).toFixed(1)} s (balance still ${b === parseEther("1") ? "right" : "WRONG"}), a bystander's fresh sync ${(byMs / 1000).toFixed(1)} s; the victim's session now holds ${cand} junk candidates, re-checked every sync. Per junk memo: ${(victimMs / MEMOS).toFixed(0)} ms of everyone's first sync, per vault (each GloamCore reads the board)`);
} finally {
  S.stop();
  summary("stress-memospam");
}
process.exit(0);
