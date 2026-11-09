// Timings of every GloamPrivate user action with real final-key proofs, through the keeper's relay, on anvil
// (automine, so "tx" time is the relay's checks + simulation + RPC, not block time: add the chain's block time per
// transaction for a live estimate). Each action runs RUNS times; proof time is the sum of the Groth16 proofs it made.
//
//   node e2e-gloam/stress/stress-timings.mjs            (RUNS=3 by default)
import { join } from "node:path";
import { formatEther, parseAbi } from "viem";
import { gloamLinkAddress, gloamLinkKeys, newLinkSecret } from "@cloakely/sdk";
import { setup, median, proofLog, GloamPrivate, zeroAddress, parseEther } from "./common.mjs";
import { writeFileSync } from "node:fs";
import { CIRCUITS, HERE } from "../lib.mjs";

const RUNS = Number(process.env.RUNS ?? 3);
const snarkjs = await import("snarkjs");
const S = await setup({ port: 8616, hourly: "1000" });
const { pub, c } = S;
const rows = new Map();
async function timed(name, fn, note = "") {
  const p0 = proofLog.length;
  const t = performance.now();
  const extra = { proofMs: 0 };
  const r = await fn(extra);
  const total = performance.now() - t;
  const proofs = proofLog.slice(p0);
  const proofMs = proofs.reduce((a, x) => a + x.ms, 0) + extra.proofMs;
  const row = rows.get(name) ?? { name, totals: [], proofs: [], nProofs: [], txs: [], note };
  row.totals.push(Math.round(total));
  row.proofs.push(Math.round(proofMs));
  row.nProofs.push(proofs.length + (extra.proofMs ? 1 : 0));
  rows.set(name, row);
  return r;
}
let nonceBase;
const relayTxs = async () => (await pub.getTransactionCount({ address: S.keeper.account.address })) - nonceBase;
try {
  console.log(`stress-timings: ${RUNS} runs per action`);
  const usdcAbi = parseAbi(["function mint(address,uint256)"]);
  for (let run = 0; run < RUNS; run++) {
    const aw = S.who(1 + run * 2);
    const bw = S.who(2 + run * 2);
    await S.dep.wallet.writeContract({ address: c.usdc, abi: usdcAbi, functionName: "mint", args: [aw.account.address, 1000n * 10n ** 6n] });
    const A = await GloamPrivate.unlock(aw.wallet, S.cfgFor(S.viaRelay(`a${run}`), S.memRecords()));
    const B = await GloamPrivate.unlock(bw.wallet, S.cfgFor(S.viaRelay(`b${run}`), S.memRecords()));
    await A.loadMarkets();
    await B.loadMarkets();
    A.addAsset({ symbol: "USDC", token: c.usdc, decimals: 6 });
    const H = A.hypeMarket.pool;
    nonceBase = await pub.getTransactionCount({ address: S.keeper.account.address });

    await timed("shield HYPE (launch vault)", () => A.shieldHype(aw.wallet, parseEther("5")), "1 shield proof, deposit from the wallet, memo by relay");
    await timed("shield USDC (Gloam's vault)", () => A.shieldToken(aw.wallet, c.usdc, 100n * 10n ** 6n), "approve + deposit from the wallet, memo by relay");
    await timed("balance (warm)", () => A.balance(H));
    await timed("send 0.5 HYPE privately", async () => A.send(A.hypeMarket.token, await B.address(), parseEther("0.5")), "1 transfer + memo");
    await timed("receive: payee's next balance (sweep)", () => B.balance(H), "the payee's sync sweeps the payment: 1 transfer + memo");
    await timed("withdraw 0.3 HYPE", () => A.unshieldHype(`0x00000000000000000000000000000000000a${String(run).padStart(4, "0")}`, parseEther("0.3")), "split (transfer + memo) then unshield");
    await timed("withdraw USDC exact note (max)", () => A.sweep(c.usdc, `0x00000000000000000000000000000000000a${String(run).padStart(4, "0")}`), "1 unshield, no split");
    const buy = await timed("instant buy 0.2 HYPE", () => A.buy(c.launchToken, parseEther("0.2")), "split, out-note deposit proof, spend proof, swap, buffer claim (deposit proof)");
    await timed("instant sell (tokens)", () => A.sell(c.launchToken, buy.amountOut / 2n), "same shape as a buy");
    await timed("batch order 0.07 HYPE (2 orders)", () => A.batch(c.launchToken, "buy", parseEther("0.07")), "per order: split + spend proof + place");
    const info = await A.roundInfo();
    await S.warp(info.roundSecs * 2 + 1);
    await S.loop.tick();
    await timed("batch payout (finishPending)", () => A.finishPending(), "per order: deposit proof + claim + memo");
    const secret = newLinkSecret();
    const lk = await gloamLinkKeys(secret);
    await timed("payment link: make (0.1 HYPE)", () => A.send(A.hypeMarket.token, gloamLinkAddress(lk), parseEther("0.1")), "a private send to the link's account");
    const L = new GloamPrivate({ ...S.cfgFor(S.viaRelay(`l${run}`)), spendReceived: true }, lk);
    await L.loadMarkets();
    await timed("payment link: claim into a private balance", async () => L.sweep(L.hypeMarket.token, await B.address(), () => {}, {}), "link account spends the note to the claimant (transfer + memo)");
    const lk2 = await gloamLinkKeys(newLinkSecret(), "passcode words");
    await timed("payment link: make, locked (scrypt)", () => A.send(A.hypeMarket.token, gloamLinkAddress(lk2), parseEther("0.1")));
    await timed("payment link: open locked (scrypt only)", () => gloamLinkKeys(secret, "passcode words"), "N=2^15 scrypt, on device");
    const L2 = new GloamPrivate({ ...S.cfgFor(S.viaRelay(`m${run}`)), spendReceived: true }, lk2);
    await L2.loadMarkets();
    await timed("payment link: claim to a fresh wallet", () => L2.sweep(L2.hypeMarket.token, `0x00000000000000000000000000000000000b${String(run).padStart(4, "0")}`), "unshield from the link account");
    const box = await A.receiveAddress(run);
    await S.dep.wallet.sendTransaction({ to: box, value: parseEther("0.25") });
    await timed("receive address: collect 0.25 HYPE", () => A.collectReceived(run), "deposit proof + shield via relay + memo");
    await timed("split withdraw plan (3 pieces, 1.5 HYPE)", () => A.planSplitWithdraw(A.hypeMarket.token, `0x00000000000000000000000000000000000c${String(run).padStart(4, "0")}`, parseEther("1.5"), { pieces: 3 }), "3 splits + 3 unshield proofs, nothing sent but the splits");
    const prover = async (input) => snarkjs.groth16.fullProve(input, join(CIRCUITS, "funds.wasm"), join(CIRCUITS, "final/funds_final.zkey"));
    await timed("proveFunds (>= 1 HYPE)", (x) => A.proveFunds(A.hypeMarket.token, parseEther("1"), { label: "Landlord", expiresAt: Math.floor(Date.now() / 1000) + 86400, prover: async (i) => { const t = performance.now(); const r = await prover(i); x.proofMs += performance.now() - t; return r; } }), "funds circuit, off chain");
    console.log(`  run ${run + 1}: relay sent ${await relayTxs()} transactions; A's HYPE ${formatEther(await A.balance(H))}`);
  }
  const table = [...rows.values()].map((r) => ({
    action: r.name,
    medianMs: median(r.totals),
    worstMs: Math.max(...r.totals),
    medianProofMs: median(r.proofs),
    proofs: median(r.nProofs),
    medianOtherMs: median(r.totals.map((t, i) => t - r.proofs[i])),
    note: r.note,
  }));
  console.log("\n| action | median | worst | proofs (n, median ms) | rest (relay, RPC, waits) | notes |\n|---|---|---|---|---|---|");
  for (const r of table) console.log(`| ${r.action} | ${(r.medianMs / 1000).toFixed(2)} s | ${(r.worstMs / 1000).toFixed(2)} s | ${r.proofs}, ${(r.medianProofMs / 1000).toFixed(2)} s | ${(r.medianOtherMs / 1000).toFixed(2)} s | ${r.note} |`);
  const per = {};
  for (const p of proofLog) (per[p.circuit] ??= []).push(p.ms);
  console.log("\nper circuit: " + Object.entries(per).map(([k, v]) => `${k} median ${median(v)} ms worst ${Math.max(...v)} ms (n=${v.length})`).join("; "));
  const writeMeasurements = (n, d) => writeFileSync(join(HERE, "stress", `results-${n}.json`), JSON.stringify(d, null, 2) + "\n");
  writeMeasurements("timings", { runs: RUNS, table, perCircuit: Object.fromEntries(Object.entries(per).map(([k, v]) => [k, { median: median(v), worst: Math.max(...v), n: v.length }])) });
} finally {
  S.stop();
}
process.exit(0);
