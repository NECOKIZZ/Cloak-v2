// Is Elysium mainnet (chain 99901) ready for Cloak? Read-only: eth_calls against the live chain, spends nothing.
//   1. the chain runs what our contracts need: the BN254 precompiles Groth16 verifiers call (add, mul, pairing),
//      modexp and sha256, and the opcodes our builds use (PUSH0 for shanghai, TSTORE/TLOAD and MCOPY for cancun),
//   2. the tools our deploy and apps use are there: the CREATE2 deployer (the v4 hook is mined through it),
//      Multicall3 (viem batches reads through it) and Permit2,
//   3. the official Uniswap v4 contracts are there and wired to one PoolManager, and that PoolManager is
//      Uniswap's build (byte-identical to ours apart from its own address),
//   4. optionally (VERIFY_FILE=<json from e2e/capture-proofs.mjs>), real Cloak proofs verify on mainnet: our verifier
//      runtime is placed at a scratch address with a state override and called with proofs made in a real run.
//   [MAINNET_RPC=…] node e2e/check-mainnet.mjs
import { readFileSync, existsSync } from "node:fs";
import { createPublicClient, encodeFunctionData, http, parseAbi } from "viem";

const RPC = process.env.MAINNET_RPC || "https://rpc-live.elysp.com";
const pub = createPublicClient({ transport: http(RPC, { retryCount: 8, retryDelay: 1500 }) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0, n = 0;
const ok = (c, m) => { n++; console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) fails++; };
// the public relay rate-limits: one request at a time, with a pause, retried when it says it's busy
const rpc = async (method, params) => {
  for (let i = 0; ; i++) {
    await sleep(400);
    const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((x) => x.json());
    if (r.error && /rate|busy/i.test(r.error.message) && i < 12) { await sleep(2000 * (i + 1)); continue; }
    if (r.error) throw new Error(`${method}: ${r.error.message}`);
    return r.result;
  }
};
const call = (to, data, override) => rpc("eth_call", [{ to, data }, "latest", ...(override ? [override] : [])]);
const word = (x) => BigInt(x).toString(16).padStart(64, "0");
const SCRATCH = "0x00000000000000000000000000000000000c0de1";

console.log(`chain ${Number(await rpc("eth_chainId", []))} · ${await rpc("web3_clientVersion", [])}`);
const block = await rpc("eth_getBlockByNumber", ["latest", false]);
console.log(`block ${Number(block.number)} · gas limit ${BigInt(block.gasLimit)} · base fee ${Number(BigInt(block.baseFeePerGas ?? 0)) / 1e9} gwei`);
ok(Number(await rpc("eth_chainId", [])) === 99901, "this is chain 99901 (Elysium mainnet)");
ok(BigInt(block.gasLimit) >= 30_000_000n, "a block holds a full proof verification and our biggest deploys (gas limit ≥ 30M)");

console.log("1 · precompiles and opcodes");
const P = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const G2 = [11559732032986387107991004021392285783925812861821192530917403151452391805634n, 10857046999023057135944570762232829481370756359578518086990519993285655852781n, 4082367875863433681332203403145435568316851327593401208105741076214120093531n, 8495653923123431417604973247489272438418190587263600148770280649306958101930n];
const TWO_G = "030644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd315ed738c0e0a7c92e7845f96b2ae9c0a68a6a449e3538fc7ff3ebf7a5a18a2c4";
ok((await call("0x0000000000000000000000000000000000000006", "0x" + word(1) + word(2) + word(1) + word(2))).slice(2) === TWO_G, "BN254 add (0x06): G + G = 2G");
ok((await call("0x0000000000000000000000000000000000000007", "0x" + word(1) + word(2) + word(2))).slice(2) === TWO_G, "BN254 mul (0x07): 2 · G = 2G");
const pairing = (y) => "0x" + word(1) + word(2) + G2.map(word).join("") + word(1) + word(y) + G2.map(word).join("");
ok(BigInt(await call("0x0000000000000000000000000000000000000008", pairing(P - 2n))) === 1n, "BN254 pairing (0x08): e(G, H) · e(−G, H) = 1");
ok(BigInt(await call("0x0000000000000000000000000000000000000008", pairing(2n))) === 0n, "BN254 pairing (0x08): e(G, H) · e(G, H) ≠ 1");
ok(BigInt(await call("0x0000000000000000000000000000000000000005", "0x" + word(1) + word(1) + word(1) + "03" + "05" + "07")) === 5n, "modexp (0x05): 3^5 mod 7 = 5");
ok((await call("0x0000000000000000000000000000000000000002", "0x")) === "0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "sha256 (0x02)");
// PUSH1 7, PUSH1 1, TSTORE, PUSH1 1, TLOAD, PUSH0, MSTORE, MCOPY(32 ← 0, 32 bytes), RETURN(32, 32)
ok(BigInt(await call(SCRATCH, "0x", { [SCRATCH]: { code: "0x600760015d60015c5f5260205f60205e60206020f3" } })) === 7n, "PUSH0, TSTORE/TLOAD and MCOPY run (shanghai and cancun builds work)");

console.log("2 · tools our deploy and apps use");
const code = async (a) => ((await rpc("eth_getCode", [a, "latest"])).length - 2) / 2;
ok((await code("0x4e59b44847b379578588920ca78fbf26c0b4956c")) === 69, "CREATE2 deployer 0x4e59…956c (the v4 hook is mined through it)");
ok((await code("0xcA11bde05977b3631167028862bE2a173976CA11")) > 0, "Multicall3 0xcA11…CA11");
ok((await code("0x000000000022D473030F116dDEE9F6B43aC78BA3")) > 0, "Permit2 0x0000…8BA3 (Universal Router sells)");

console.log("3 · official Uniswap v4");
const PM = "0xe2e105d3f7209a9da11f83ccf3e7398a753823f1";
const pmAbi = parseAbi(["function poolManager() view returns (address)", "function owner() view returns (address)", "function WETH9() view returns (address)", "function protocolFeeController() view returns (address)"]);
const read = async (to, fn) => {
  const r = await call(to, encodeFunctionData({ abi: pmAbi, functionName: fn }));
  return "0x" + r.slice(-40);
};
for (const [name, a] of [["Universal Router", "0x1b341fdd55d56f8e08409a2c25ddfad93eb03c1a"], ["V4 Quoter", "0x379f556c5a748bd7cc9baf0f7a344094ac1814f5"], ["StateView", "0x27ed73ae0652fdcf71d6793412a7525f32be9dfe"], ["PositionManager", "0x1d1c51b9d07fd27d36412a2b66cc23d19eb3e518"]]) {
  ok((await read(a, "poolManager")) === PM, `${name} ${a.slice(0, 6)}…${a.slice(-4)} uses the PoolManager`);
}
const live = await rpc("eth_getCode", [PM, "latest"]);
const art = new URL("../contracts-v4/out-uniswap/PoolManager.sol/PoolManager.json", import.meta.url);
if (existsSync(art)) {
  const j = JSON.parse(readFileSync(art, "utf8"));
  const imm = Object.values(j.deployedBytecode.immutableReferences ?? {}).flat();
  const mask = (hex) => { const b = Buffer.from(hex.replace(/^0x/, ""), "hex"); for (const x of imm) b.fill(0, x.start, x.start + x.length); return b; };
  ok(mask(live).equals(mask(j.deployedBytecode.object)), "the PoolManager is Uniswap's build, the same one Cloak tests against (apart from its own address)");
} else console.log("  · build contracts-v4 with FOUNDRY_PROFILE=uniswap to compare the PoolManager byte for byte");
const weth = await read("0x1d1c51b9d07fd27d36412a2b66cc23d19eb3e518", "WETH9");
console.log(`  · PositionManager's WETH9 (mainnet WHYPE): ${weth} · PoolManager owner ${await read(PM, "owner")} · fee controller ${await read(PM, "protocolFeeController")}`);

// 4. real proofs on the real chain
const VF = process.env.VERIFY_FILE;
if (VF) {
  console.log("4 · real Cloak proofs, verified by mainnet");
  const cap = JSON.parse(readFileSync(VF, "utf8"));
  for (const v of cap.verifiers) {
    for (const [i, c] of v.calls.entries()) {
      const r = await call(SCRATCH, c.input, { [SCRATCH]: { code: v.runtime } });
      ok(BigInt(r) === 1n, `${v.name} accepts real proof ${i + 1} (${c.from})`);
      // flip one bit of the first proof element: must be refused
      const bad = c.input.slice(0, 10) + (BigInt("0x" + c.input.slice(10, 74)) ^ 1n).toString(16).padStart(64, "0") + c.input.slice(74);
      const rb = await call(SCRATCH, bad, { [SCRATCH]: { code: v.runtime } }).catch(() => "0x0");
      ok(BigInt(rb || "0x0") === 0n, `${v.name} refuses that proof with one bit changed`);
    }
  }
}
console.log(`\n${n - fails}/${n} checks passed${fails ? ` · ${fails} FAILED` : ""}`);
process.exit(fails ? 1 : 0);
