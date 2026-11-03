// The PoolManager Cloak deploys on testnet must be the one on Elysium mainnet: build it with Uniswap's settings
// (cd contracts-v4 && FOUNDRY_PROFILE=uniswap forge build) and compare its runtime with mainnet's, byte for byte,
// apart from the one immutable (the contract's own address, for its no-delegatecall guard).
//   node e2e/check-v4-bytecode.mjs [address on testnet to compare too]
import { readFileSync } from "node:fs";
const MAINNET_RPC = process.env.MAINNET_RPC || "https://rpc-live.elysp.com";
const MAINNET_PM = "0xe2e105d3f7209a9da11f83ccf3e7398a753823f1";
const art = JSON.parse(readFileSync(new URL("../contracts-v4/out-uniswap/PoolManager.sol/PoolManager.json", import.meta.url)));
const imm = Object.values(art.deployedBytecode.immutableReferences ?? {}).flat();
const mask = (hex) => {
  const b = Buffer.from(hex.replace(/^0x/, ""), "hex");
  for (const r of imm) b.fill(0, r.start, r.start + r.length);
  return b;
};
async function code(rpc, address) {
  for (let i = 0; i < 8; i++) {
    const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [address, "latest"] }) }).then((x) => x.json()).catch(() => ({}));
    if (r.result && r.result !== "0x") return r.result;
    await new Promise((s) => setTimeout(s, 3000));
  }
  throw new Error(`no code at ${address}`);
}
const built = mask(art.deployedBytecode.object);
const main = mask(await code(MAINNET_RPC, MAINNET_PM));
const same = built.equals(main);
console.log(`built ${built.length} B · mainnet ${main.length} B · identical apart from its own address: ${same}`);
if (process.argv[2]) {
  const t = mask(await code(process.env.RPC_URL || "https://testnet-rpc.elysium.kinetiq.xyz", process.argv[2]));
  console.log(`testnet ${process.argv[2]}: identical to mainnet's: ${t.equals(main)}`);
  if (!t.equals(main)) process.exit(1);
}
if (!same) process.exit(1);
