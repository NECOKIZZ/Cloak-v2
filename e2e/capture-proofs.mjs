// Collect the real Groth16 verifier calls made during a local run (e2e/shared.mjs on the mainnet copy): traces every
// transaction on the local chain, keeps each call into Cloak's verifiers with its exact input, and saves them with
// each verifier's runtime. e2e/check-mainnet.mjs (VERIFY_FILE=…) then replays them on Elysium mainnet itself.
//   DEPLOY_FILE=deployments/elysium-mainnet.fork.json [LOCAL_RPC=http://127.0.0.1:8545] [OUT=…] node e2e/capture-proofs.mjs
import { readFileSync, writeFileSync } from "node:fs";

const RPC = process.env.LOCAL_RPC || "http://127.0.0.1:8545";
const dep = JSON.parse(readFileSync(process.env.DEPLOY_FILE || "deployments/elysium-mainnet.fork.json", "utf8"));
const OUT = process.env.OUT || "deployments/elysium-mainnet.proofs.json";
const rpc = async (method, params) => {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((x) => x.json());
  if (r.error) throw new Error(`${method}: ${r.error.message}`);
  return r.result;
};
const verifiers = { [dep.verifier.toLowerCase()]: "Groth16Verifier (single-asset vaults)", [dep.verifierMA.toLowerCase()]: "Groth16VerifierMA (shared vault)" };
const found = Object.fromEntries(Object.keys(verifiers).map((a) => [a, []]));
const walk = (c, from) => {
  if (!c) return;
  const to = c.to?.toLowerCase();
  // only real verifyProof calls, not the verifier's own deployment (a CREATE frame to the same address)
  if (to && found[to] && (c.type === "STATICCALL" || c.type === "CALL") && found[to].length < 3) found[to].push({ input: c.input, from });
  for (const s of c.calls ?? []) walk(s, from);
};
const last = Number(await rpc("eth_blockNumber", []));
for (let n = 0; n <= last; n++) {
  const b = await rpc("eth_getBlockByNumber", ["0x" + n.toString(16), false]);
  for (const h of b.transactions) walk(await rpc("debug_traceTransaction", [h, { tracer: "callTracer" }]), `tx ${h.slice(0, 10)}…`);
}
const out = { verifiers: [] };
for (const [a, calls] of Object.entries(found)) {
  console.log(`${verifiers[a]}: ${calls.length} real proof${calls.length === 1 ? "" : "s"}`);
  if (calls.length) out.verifiers.push({ name: verifiers[a], address: a, runtime: await rpc("eth_getCode", [a, "latest"]), calls });
}
writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${OUT}`);
