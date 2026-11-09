// The real keeper process (services/keeper/index.mjs) over HTTP, Gloam relay and schedule routes:
//   1. X-Forwarded-For decides "who" a caller is, for the per-IP rate limit and the relay's per-sender budget share
//   2. concurrent valid relays through the real keeper (its serial send queue + the relay's own nonce pick)
//   3. malformed / oversized bodies, and how relay failures are reported
//   4. /schedule abuse: non-unshield calls, far-future pieces, tampered pieces, the same nullifier twice, 5 pieces
// Anvil on 8602, keeper HTTP on 8603. The keeper is pointed at http://127.1:8602 so it uses chain 99801 (a
// "127.0.0.1" URL would make it pick the anvil chain id 31337).
//
//   node e2e-gloam/stress/stress-http.mjs
import { spawn } from "node:child_process";
import { encodeFunctionData, parseAbi } from "viem";
import { setup, launchCore, unshieldCall, record, summary, ms, rpc, ANVIL_KEYS, zeroAddress, parseEther, UNSHIELD } from "./common.mjs";
import { REPO, clients, ELYSIUM_TESTNET_ID } from "../lib.mjs";

const t0 = performance.now();
const S = await setup({ port: 8602 });
const { pub, c } = S;
const KEEPER = 7;
const keeperAddr = clients(S.rpcUrl, ANVIL_KEYS[KEEPER], ELYSIUM_TESTNET_ID).account.address;
const sink = S.who(9).account.address;
let URL_ = "http://127.0.0.1:8603";
let proc;
const post = async (path, body, headers = {}) => {
  const r = await fetch(URL_ + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) }).catch((e) => ({ status: "conn-error", json: async () => ({ error: e.cause?.code ?? e.message }) }));
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
try {
  console.log("stress-http: the keeper process over HTTP");
  // one cash out's cost sets the relay's budget: about 2.5 cash outs an hour
  const { core: A, w: alice } = await launchCore(S, 1);
  for (let i = 0; i < 12; i++) await A.shield(alice.wallet, zeroAddress, parseEther("0.1"));
  await A.sync();
  const notes = A.ownNotes(zeroAddress);
  const probe = await unshieldCall(A, notes[0], sink);
  const cost = (await pub.estimateGas({ account: keeperAddr, to: probe.to, data: probe.data })) * (await pub.getGasPrice());
  const budget = (cost * 25n) / 10n;
  // the keeper reads through Multicall3 at its canonical address (Elysium has it): plant its code on anvil, read once
  // from the testnet RPC (a read, no transaction)
  const mc = "0xcA11bde05977b3631167028862bE2a173976CA11";
  const code = await fetch("https://testnet-rpc.elysium.kinetiq.xyz", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [mc, "latest"] }) }).then((r) => r.json());
  await rpc(S.rpcUrl, "anvil_setCode", [mc, code.result]);
  const lines = [];
  const startKeeper = async (hourlyWei, port) => {
  URL_ = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, [`${REPO}/services/keeper/index.mjs`], {
    cwd: `${REPO}/services/keeper`,
    env: {
      PATH: process.env.PATH,
      KEEPER_PK: ANVIL_KEYS[KEEPER],
      FACTORY: c.factoryStandIn,
      RPC_URL: "http://127.1:8602",
      PORT: String(port),
      SNAPSHOT: "0",
      GLOAM_MEMO: c.memoBoard,
      GLOAM_VAULT: c.gloamVault,
      GLOAM_LAUNCH_VAULT: c.launchVault,
      GLOAM_ESCROWS: [c.launchSwap, c.batcher, c.receive].join(","),
      GLOAM_RELAY_HOURLY_SPEND: (Number(hourlyWei) / 1e18).toFixed(18),
      GLOAM_LOOP_SECS: "3600",
      RELAY_PER_MIN: "20",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => lines.push(String(d)));
  proc.stderr.on("data", (d) => lines.push(String(d)));
  for (let i = 0; i < 100; i++) {
    const ok = await fetch(URL_ + "/health").then((r) => r.ok, () => false);
    if (ok) break;
    await new Promise((r) => setTimeout(r, 200));
    if (i === 99) throw new Error("keeper didn't start:\n" + lines.join(""));
  }
  };
  await startKeeper(budget, 8603);

  // ── 1. X-Forwarded-For ──
  let limited = 0;
  for (let i = 0; i < 25; i++) if ((await post("/gloam/relay", "{}", { "x-forwarded-for": "1.1.1.1" })).status === 429) limited++;
  let limitedSpoof = 0;
  for (let i = 0; i < 25; i++) if ((await post("/gloam/relay", "{}", { "x-forwarded-for": `9.9.9.${i}` })).status === 429) limitedSpoof++;
  record("http-xff-ratelimit", limitedSpoof > 0, `25 requests from one X-Forwarded-For: ${limited} rate-limited; 25 with a new made-up X-Forwarded-For each: ${limitedSpoof} rate-limited (the first entry of the header is trusted)`);
  // the per-sender budget share follows the same header
  const calls = [];
  for (let i = 1; i < 5; i++) calls.push(await unshieldCall(A, notes[i], sink));
  const a1 = await post("/gloam/relay", calls[0], { "x-forwarded-for": "2.2.2.2" });
  const a2 = await post("/gloam/relay", calls[1], { "x-forwarded-for": "2.2.2.2" });
  const a3 = await post("/gloam/relay", calls[2], { "x-forwarded-for": "2.2.2.2" });
  const a4 = await post("/gloam/relay", calls[2], { "x-forwarded-for": "3.3.3.3" });
  record(
    "http-xff-share",
    !(a3.status === 429 && a4.status === 200),
    `budget ~2.5 cash outs, one sender's exit share 60%: same header -> ${a1.status}, ${a2.status}, ${a3.status} (${a3.body.error ?? "ok"}); the refused call again with another header -> ${a4.status}`,
  );

  // ── 3. malformed and oversized bodies ──
  const j = await post("/gloam/relay", "{not json");
  const big = await post("/gloam/relay", JSON.stringify({ to: c.launchVault, data: "0x" + "ab".repeat(40_000) }));
  record("http-malformed", j.status === 400, `bad JSON -> ${j.status} ${JSON.stringify(j.body)}; an 80 KB body -> ${big.status} ${JSON.stringify(big.body)}`);

  // ── 2. concurrent valid relays through the real keeper (2 s blocks): a fresh keeper with a roomy budget ──
  proc.kill();
  await startKeeper(parseEther("10"), 8604);
  await rpc(S.rpcUrl, "evm_setAutomine", [false]);
  await rpc(S.rpcUrl, "evm_setIntervalMining", [2]);
  const conc = [];
  for (let i = 5; i < 9; i++) conc.push(await unshieldCall(A, notes[i], sink));
  const t = performance.now();
  const rs = await Promise.all(conc.map((x, i) => post("/gloam/relay", x, { "x-forwarded-for": `5.5.5.${i}` })));
  record("http-concurrent", rs.every((r) => r.status === 200), `4 valid cash outs at once (4 senders) in ${ms(t)} ms: ${rs.map((r) => `${r.status} ${r.body.error ?? "ok"}`).join(" | ")}`);
  await rpc(S.rpcUrl, "evm_setIntervalMining", [0]);
  await rpc(S.rpcUrl, "evm_setAutomine", [true]);

  // ── 4. /schedule abuse ──
  // the keeper's queue runs on the keeper's own clock (Date.now), while the SDK plans pieces on the chain's clock; this
  // anvil chain was moved 3 days ahead by the stack's listing timelock, so use the keeper's clock here
  const chainNow = Number((await pub.getBlock()).timestamp);
  const now = Math.floor(Date.now() / 1000);
  const chainPiece = await post("/schedule", { pieces: [{ call: { kind: "gloamUnshield", to: c.launchVault, data: (await unshieldCall(A, notes[10], sink)).data }, notBefore: chainNow + 600 }] });
  console.log(`    a piece timed by the chain's clock (${Math.round((chainNow - now) / 3600)} h ahead of the keeper's): ${chainPiece.status} ${JSON.stringify(chainPiece.body)}`);
  const n9 = notes[9];
  const piece = await unshieldCall(A, n9, sink);
  const gp = (call, notBefore = now + 600) => ({ call: { kind: "gloamUnshield", to: call.to, data: call.data }, notBefore });
  const out = {};
  out.memoAsPiece = await post("/schedule", { pieces: [{ call: { kind: "gloamUnshield", to: c.memoBoard, data: encodeFunctionData({ abi: parseAbi(["function postMemo(bytes32,bytes)"]), functionName: "postMemo", args: ["0x" + "11".repeat(32), "0x01"] }) }, notBefore: now + 60 }] });
  out.transferAsPiece = await post("/schedule", { pieces: [{ call: { kind: "gloamUnshield", to: c.launchVault, data: encodeFunctionData({ abi: parseAbi(["function transfer(bytes,bytes32,bytes32,bytes32[2])"]), functionName: "transfer", args: ["0x01", "0x" + "11".repeat(32), "0x" + "22".repeat(32), ["0x" + "33".repeat(32), "0x" + "44".repeat(32)]] }) }, notBefore: now + 60 }] });
  out.farFuture = await post("/schedule", { pieces: [gp(piece, now + 49 * 3600)] });
  out.nanTime = await post("/schedule", { pieces: [{ call: { kind: "gloamUnshield", to: piece.to, data: piece.data }, notBefore: "soon" }] });
  out.fivePieces = await post("/schedule", { pieces: [gp(piece), gp(piece), gp(piece), gp(piece), gp(piece)] });
  // tampered: the same proof with a different recipient
  const d = (await import("viem")).decodeFunctionData({ abi: UNSHIELD, data: piece.data });
  const tampered = encodeFunctionData({ abi: UNSHIELD, functionName: "unshield", args: [d.args[0], d.args[1], d.args[2], d.args[3], S.who(5).account.address, d.args[5]] });
  out.tampered = await post("/schedule", { pieces: [gp({ to: piece.to, data: tampered })] });
  // to the wrong vault (Gloam's): the nullifier isn't there, proof fails
  out.wrongVault = await post("/schedule", { pieces: [gp({ to: c.gloamVault, data: piece.data })] });
  out.ok1 = await post("/schedule", { pieces: [gp(piece)] });
  out.sameAgain = await post("/schedule", { pieces: [gp(piece, now + 3000)] });
  // the same piece with trailing junk bytes: still the same nullifier, so the same id?
  out.trailing = await post("/schedule", { pieces: [gp({ to: piece.to, data: piece.data + "00".repeat(32) })] });
  // the same piece with the vault address in another case
  out.mixedCase = await post("/schedule", { pieces: [gp({ to: piece.to.toUpperCase().replace("0X", "0x"), data: piece.data })] });
  console.log(`    first schedule: ${JSON.stringify(out.ok1)}`);
  const refusedOk = [out.memoAsPiece, out.transferAsPiece, out.farFuture, out.nanTime, out.fivePieces, out.tampered, out.wrongVault].every((r) => r.status === 400);
  const sameId = out.ok1.body.ids?.[0] && out.sameAgain.body.ids?.[0] === out.ok1.body.ids[0];
  record("http-schedule-abuse", refusedOk && sameId, `memo/transfer as a piece, 49 h ahead, NaN time, 5 pieces, tampered recipient, wrong vault: ${[out.memoAsPiece, out.transferAsPiece, out.farFuture, out.nanTime, out.fivePieces, out.tampered, out.wrongVault].map((r) => r.status).join(",")}; queued then queued again: same id ${!!sameId}`);
  record("http-schedule-variants", out.trailing.body.ids?.[0] === out.ok1.body.ids?.[0] || out.trailing.status === 400, `the same piece with 32 junk bytes appended -> ${out.trailing.status} ${JSON.stringify(out.trailing.body).slice(0, 120)}; vault address upper-cased -> ${out.mixedCase.status} same id: ${out.mixedCase.body.ids?.[0] === out.ok1.body.ids?.[0]}`);
  // every schedule request uses one shared relay sender ("schedule") for the budget: see stress-schedule.mjs
  const stats = await fetch(URL_ + "/gloam/relay/stats").then((r) => r.json());
  console.log(`  relay stats (public, no auth): ${JSON.stringify(stats)}`);
  if (process.env.DEBUG) console.log(lines.join("").slice(-4000));
  console.log(`\ntook ${Math.round((performance.now() - t0) / 1000)} s`);
} finally {
  proc?.kill();
  S.stop();
  summary("stress-http");
}
process.exit(0);
