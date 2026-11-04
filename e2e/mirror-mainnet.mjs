// Copy the official Uniswap v4 contracts (and Permit2) from Elysium mainnet onto a local anvil at their real
// addresses: their exact runtime bytecode plus their first storage slots (owner, fee controller, next id). The public
// mainnet relay is too slow to serve a forked chain, and our flows never read anyone else's pools, so this is as good as
// a fork for testing Cloak against Uniswap's own deployment.
// Mainnet's WHYPE isn't copied: it's an upgradeable proxy, and Cloak deploys its own (docs/MAINNET.md).
//   anvil --chain-id 31337 & ; node e2e/mirror-mainnet.mjs [LOCAL_RPC=http://127.0.0.1:8545]
const SRC = process.env.MAINNET_RPC || "https://rpc-live.elysp.com";
const DST = process.env.LOCAL_RPC || "http://127.0.0.1:8545";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rpc = async (url, method, params) => {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((x) => x.json());
      if (r.error) throw new Error(r.error.message);
      return r.result;
    } catch (e) {
      if (i > 15) throw e;
      await sleep(1500 * (i + 1));
    }
  }
};
export const MAINNET = {
  poolManager: "0xe2e105d3f7209a9da11f83ccf3e7398a753823f1",
  universalRouter: "0x1b341fdd55d56f8e08409a2c25ddfad93eb03c1a",
  quoter: "0x379f556c5a748bd7cc9baf0f7a344094ac1814f5",
  stateView: "0x27ed73ae0652fdcf71d6793412a7525f32be9dfe",
  positionManager: "0x1d1c51b9d07fd27d36412a2b66cc23d19eb3e518",
  permit2: "0x000000000022d473030f116ddee9f6b43ac78ba3",
  // the Universal Router hands v4 swaps to this contract (found by tracing a router swap)
  universalRouterV4: "0xdcd9f4e8972f619b325b0c3109412dfc4d184734",
};
const block = await rpc(SRC, "eth_blockNumber", []);
for (const [name, a] of Object.entries(MAINNET)) {
  const code = await rpc(SRC, "eth_getCode", [a, block]);
  if (code.length < 4) throw new Error(`no code for ${name} on mainnet`);
  await rpc(DST, "anvil_setCode", [a, code]);
  for (let s = 0; s < 12; s++) {
    const slot = "0x" + s.toString(16).padStart(64, "0");
    const v = await rpc(SRC, "eth_getStorageAt", [a, slot, block]);
    if (BigInt(v) !== 0n) await rpc(DST, "anvil_setStorageAt", [a, slot, v]);
  }
  const mine = await rpc(DST, "eth_getCode", [a, "latest"]);
  if (mine !== code) throw new Error(`${name} copy differs`);
  console.log(`  ✓ ${name} ${a} · ${(code.length - 2) / 2} bytes, mainnet block ${Number(block)}`);
}
