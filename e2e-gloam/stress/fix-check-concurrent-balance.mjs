// The site reads every market's balance at once (Promise.all of balance()), so both vaults sync concurrently.
import { parseEther } from "viem";
import { GloamPrivate } from "@cloakely/sdk";
import { createGloamRelay } from "../../services/keeper/gloam.mjs";
import { createGloamLoop } from "../../services/keeper/gloamLoop.mjs";
import { deployCloakGloam } from "../stack.mjs";
import { ANVIL_KEYS, ELYSIUM_TESTNET_ID, clients, finalProver, rpc, sendAndLog, startAnvil } from "../lib.mjs";
const anvil = await startAnvil({ port: 8640 });
const rpcUrl = anvil.rpcUrl;
const who = (i) => clients(rpcUrl, ANVIL_KEYS[i], ELYSIUM_TESTNET_ID);
const [dep, alice, keeper] = [who(0), who(1), who(8)];
const pub = dep.pub;
try {
  const warp = async (s) => (await rpc(rpcUrl, "evm_increaseTime", [s]), await rpc(rpcUrl, "evm_mine"));
  const { contracts: c, block } = await deployCloakGloam({ me: dep, rpcUrl, pk: ANVIL_KEYS[0], warp });
  const relay = createGloamRelay({ publicClient: pub, walletClient: keeper.wallet, vault: c.gloamVault, launchVault: c.launchVault, memoBoard: c.memoBoard, hourlySpendWei: parseEther("5") });
  await createGloamLoop({ publicClient: pub, account: keeper.account, send: async (x) => (await sendAndLog(pub, x.functionName, keeper.wallet.writeContract(x))).transactionHash, launchVault: c.launchVault }).tick();
  const provers = { shield: await finalProver("shield"), transfer: await finalProver("transfer"), unshield: await finalProver("unshield") };
  const store = new Map();
  const cfg = { publicClient: pub, chainId: ELYSIUM_TESTNET_ID, gloamVault: { pool: c.gloamVault, poolBlock: block }, launchVault: { pool: c.launchVault, poolBlock: block }, payMemo: c.memoBoard, provers, submit: (call) => relay({ kind: call.kind, to: call.to, data: call.data }), whype: c.whypeStandIn, pendingStore: (v) => ({ load: () => store.get(v) ?? null, save: (x) => store.set(v, x) }) };
  const A = await GloamPrivate.unlock(alice.wallet, cfg);
  await A.loadMarkets();
  await A.shieldHype(alice.wallet, parseEther("1"));
  const pools = [A.hypeMarket.pool, ...A.markets.map((m) => m.pool), A.hypeMarket.pool, A.hypeMarket.pool];
  const res = await Promise.allSettled(pools.map((p) => A.balance(p)));
  console.log(res.map((r) => (r.status === "fulfilled" ? String(r.value) : "ERR " + (r.reason?.message ?? r.reason))).join("\n"));
} finally {
  anvil.stop();
}
process.exit(0);
