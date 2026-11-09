// The keeper's schedule queue (services/keeper/schedule.mjs) with Gloam cash-out pieces.
//   1. scale: 160 queued pieces (stand-in relay that takes 250 ms a send, as a receipt wait would): add, status, and how
//      long one tick takes to send everything due
//   2. the shared "schedule" sender: every user's pieces draw on one relay share (60% of the hour for exits). A few
//      pieces fill it, everyone else's get 429, retry, and are dropped after 8 tries (about 28 minutes)
//
//   node e2e-gloam/stress/stress-schedule.mjs
import { encodeFunctionData, keccak256, toHex } from "viem";
import { startSchedule } from "../../services/keeper/schedule.mjs";
import { setup, launchCore, unshieldCall, record, summary, ms, createGloamRelay, UNSHIELD, zeroAddress, parseEther } from "./common.mjs";

// ── 1. scale, with a stand-in relay ──
{
  let clock = 1_000_000;
  const sent = [];
  const fake = { check: async () => {}, send: async (call) => (await new Promise((r) => setTimeout(r, 250)), sent.push(call), "0x" + "ab".repeat(32)) };
  const q = startSchedule({ check: async () => {}, send: async () => {}, gloam: fake, now: () => clock, tickMs: 0 });
  const piece = (i) => ({ call: { kind: "gloamUnshield", to: "0x" + "11".repeat(20), data: encodeFunctionData({ abi: UNSHIELD, functionName: "unshield", args: ["0x01", "0x" + "22".repeat(32), keccak256(toHex(i)), zeroAddress, "0x" + "33".repeat(20), 1n] }) }, notBefore: clock + 60 });
  const N = 160;
  let t = performance.now();
  const ids = [];
  for (let i = 0; i < N; i += 4) ids.push(...(await q.add({ pieces: [piece(i), piece(i + 1), piece(i + 2), piece(i + 3)] })));
  const addMs = ms(t);
  const mem = process.memoryUsage().heapUsed;
  clock += 61;
  t = performance.now();
  await q.tick();
  const tickMs = ms(t);
  const st = q.status(ids.slice(0, 20));
  record("schedule-scale", tickMs < 60_000, `${N} pieces queued in ${addMs} ms (no cap on the queue's size); one tick sent ${sent.length} due pieces one after another in ${Math.round(tickMs / 1000)} s (at 250 ms a send: the last one goes out ${Math.round(tickMs / 1000)} s after its time, and the 20 s timer starts overlapping ticks); heap ${Math.round(mem / 1e6)} MB; status of 20 ids: ${[...new Set(st.map((s) => s.state))].join(",")}`);
  q.stop();
}

// ── 2. the shared "schedule" sender share, real relay and real pieces ──
const S = await setup({ port: 8610 });
const { pub, c } = S;
try {
  const { core: A, w: alice } = await launchCore(S, 1);
  for (let i = 0; i < 4; i++) await A.shield(alice.wallet, zeroAddress, parseEther("0.1"));
  await A.sync();
  const notes = A.ownNotes(zeroAddress);
  const sink = S.who(9).account.address;
  const pieces = [];
  for (const n of notes) pieces.push(await unshieldCall(A, n, sink));
  const cost = (await pub.estimateGas({ account: S.keeper.account, to: pieces[0].to, data: pieces[0].data })) * (await pub.getGasPrice());
  // an hour's budget of ~3 cash outs: the shared "schedule" sender gets 60% for exits, about 2
  const relay = createGloamRelay({ publicClient: pub, walletClient: S.keeper.wallet, vault: c.gloamVault, launchVault: c.launchVault, memoBoard: c.memoBoard, hourlySpendWei: cost * 3n });
  const gp = (call) => ({ to: call.to, data: call.data });
  let clock = Number((await pub.getBlock()).timestamp);
  const q = startSchedule({
    check: async () => {},
    send: async () => {},
    gloam: { check: (call) => relay(gp(call), { dryRun: true, sender: "schedule" }), send: (call) => relay(gp(call), { sender: "schedule" }) },
    now: () => clock,
    tickMs: 0,
  });
  // three pieces from "someone else", then the honest user's piece, all due in a minute
  const mk = (p) => ({ call: { kind: "gloamUnshield", to: p.to, data: p.data }, notBefore: clock + 60 });
  const other = await q.add({ pieces: pieces.slice(0, 3).map(mk) });
  const [honest] = await q.add({ pieces: [mk(pieces[3])] });
  clock += 61;
  await q.tick();
  const first = q.status([...other, honest]);
  // retries: the queue waits 60 s x tries between attempts, and drops a piece after 8 failures
  let ticks = 0;
  while (q.status([honest])[0].state === "waiting" && ticks < 20) {
    clock += 60 * 8;
    await q.tick();
    ticks++;
  }
  const end = q.status([honest])[0];
  record("schedule-shared-share", end.state !== "dropped", `budget ~3 cash outs/h: after the first tick the pieces read ${first.map((s) => s.state).join(",")}; the honest user's piece ended "${end.state}" (${end.error ?? ""}) after ${ticks} more ticks, while its note is still unspent: ${!(await pub.readContract({ address: c.launchVault, abi: [{ type: "function", name: "isSpent", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }] }], functionName: "isSpent", args: [pieces[3].nullifier] }))}`);
  q.stop();
} finally {
  S.stop();
  summary("stress-schedule");
}
process.exit(0);
