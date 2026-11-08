// Part 3a: proof of funds on Gloam's funds circuit (final keys), checked on chain by GloamFundsCheck, on anvil (99801).
//
//   node e2e-gloam/part3-funds.mjs
import { join } from "node:path";
import { parseEther, toHex, zeroAddress } from "viem";
import { GloamCore, walletCoreSubmitter } from "@cloakely/sdk";
import { ANVIL_KEYS, CIRCUITS, ELYSIUM_TESTNET_ID, assert, clients, finalProver, localGloam, ourArtifact, sendAndLog, writeMeasurements } from "./lib.mjs";

const sdk = await import("@gloamtrade/sdk");
const snarkjs = await import("snarkjs");
const t0 = performance.now();
const L = await localGloam({ port: 8552 });
const { rpcUrl, stack, poolBlock } = L;
const pub = L.dep.pub;
const who = (i) => clients(rpcUrl, ANVIL_KEYS[i], ELYSIUM_TESTNET_ID);
const [alice, relayer] = [who(1), who(7)];
const provers = { shield: await finalProver("shield"), transfer: await finalProver("transfer"), unshield: await finalProver("unshield") };
const cfg = { publicClient: pub, chainId: ELYSIUM_TESTNET_ID, pool: stack.pool, poolBlock, payMemo: stack.payMemo, provers, submit: walletCoreSubmitter(pub, relayer.wallet) };
const CHECK_ABI = [{ type: "function", name: "check", stateMutability: "view", inputs: [{ type: "uint256[2]" }, { type: "uint256[2][2]" }, { type: "uint256[2]" }, { type: "uint256[8]" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }], outputs: [{ type: "bool" }] }];
const timings = {};

try {
  console.log("Part 3a on anvil (chain 99801): proof of funds");
  const verifier = (await sendAndLog(pub, "deploy GloamFundsVerifierFinal", L.dep.wallet.deployContract({ ...ourArtifact("GloamFundsVerifierFinal.sol", "GloamFundsVerifierFinal") }))).contractAddress;
  const CHECK = (await sendAndLog(pub, "deploy GloamFundsCheck", L.dep.wallet.deployContract({ ...ourArtifact("GloamFundsCheck.sol", "GloamFundsCheck"), args: [stack.pool, verifier] }))).contractAddress;

  const A = await GloamCore.unlock(alice.wallet, cfg);
  for (const x of ["1", "1", "1", "0.5", "0.5"]) await A.shield(alice.wallet, zeroAddress, parseEther(x));
  await A.sync();

  const context = sdk.proofContext({ kind: "funds", chainId: ELYSIUM_TESTNET_ID, pool: stack.pool, verifier: "Cloak launch allowlist #1", expiresAt: Math.floor(Date.now() / 1000) + 86400 });
  async function prove(notes, threshold) {
    const inputs = [];
    for (const n of notes) inputs.push({ secretHex: toHex(n.secret, { size: 32 }), amount: n.amount, path: await A.pathOf(n.commitment) });
    const w = await sdk.buildFundsWitness({ asset: zeroAddress, threshold, context, notes: inputs });
    if (w.blocker) throw new Error(w.blocker);
    const t = performance.now();
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(w.circomInput, join(CIRCUITS, "funds.wasm"), join(CIRCUITS, "final/funds_final.zkey"));
    timings.fundsProofMs = Math.round(performance.now() - t);
    const cd = JSON.parse("[" + (await snarkjs.groth16.exportSolidityCallData(proof, publicSignals)) + "]");
    return cd;
  }
  const check = (cd, threshold, ctx = context) => pub.readContract({ address: CHECK, abi: CHECK_ABI, functionName: "check", args: [...cd, zeroAddress, threshold, ctx] });

  const three = A.ownNotes(zeroAddress).slice(0, 3);
  const cd = await prove(three, parseEther("2.5"));
  assert(await check(cd, parseEther("2.5")), "a proof that 3 notes hold at least 2.5 HYPE passes on chain");
  assert(await check(cd, parseEther("2")), "and passes a lower bar");
  assert(!(await check(cd, parseEther("3"))), "but not a higher one than it proved");
  assert(!(await check(cd, parseEther("2.5"), context + 1n)), "a proof made for another reader or expiry fails");

  // the tree moves on: the proof is pinned to the root it was made at, and stays good while its notes are unspent
  await A.shield(alice.wallet, zeroAddress, parseEther("0.1"));
  assert(await check(cd, parseEther("2.5")), "later deposits don't break it (every past root stays known)");
  await A.send(zeroAddress, await (await GloamCore.unlock(who(2).wallet, cfg)).address(), parseEther("0.2"));
  await A.sync();
  const stillUnspent = three.every((n) => A.ownNotes(zeroAddress).some((m) => m.commitment === n.commitment));
  if (stillUnspent) {
    // spend one of the proven notes on purpose
    await A.withdraw(zeroAddress, who(9).account.address, three[0].amount);
  }
  assert(!(await check(cd, parseEther("2.5"))), "once one of its notes is spent the proof fails");

  // a balance in more than four notes can't be proven in full with one proof
  await A.sync();
  const notes = A.ownNotes(zeroAddress);
  let refused = false;
  try {
    await sdk.buildFundsWitness({ asset: zeroAddress, threshold: 1n, context, notes: notes.map((n) => ({ secretHex: toHex(n.secret, { size: 32 }), amount: n.amount, path: { root: 0n, pathElements: [], pathIndices: [], leaf: 0n } })) }).then((w) => {
      if (w.blocker) throw new Error(w.blocker);
    });
  } catch {
    refused = true;
  }
  assert(notes.length > 4 && refused, `${notes.length} notes: one proof covers at most 4 (Cloak's covers 3), so a fragmented balance proves only its 4 largest notes`);

  writeMeasurements("part3-funds-anvil", { circuit: "funds (Gloam, final keys)", timingsMs: timings, wallMs: Math.round(performance.now() - t0) });
  console.log("\ntimings (ms):", timings);
  console.log(`\nPart 3a passed in ${Math.round((performance.now() - t0) / 1000)} s`);
} finally {
  L.stop();
}
process.exit(0);
