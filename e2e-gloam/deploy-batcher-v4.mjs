// Adds CloakGloamBatcherV4 (batch rounds through Cloak launches' own v4 pools) to the live Cloak v2 on Gloam testnet
// deployment. The batcher has no owner and needs nothing from the launch vault's owner: it spends notes through the
// vault's own escrow pattern and pays back through shieldBound, like any user. So any funded testnet key can add it.
// Then the keeper loop's registration runs once, so every settled launch with a v4 pool can batch at once.
// Adds `batcherV4` and `batcherV4Block` to deployments/elysium-testnet-gloam.json.
//
//   node e2e-gloam/deploy-batcher-v4.mjs --fork                       # rehearsal on a local fork, writes nothing
//   NODE_USE_ENV_PROXY=1 node e2e-gloam/deploy-batcher-v4.mjs         # live: GLOAM_TESTNET_PK from ../.env
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatEther } from "viem";
import { createGloamLoop } from "../services/keeper/gloamLoop.mjs";
import { ANVIL_KEYS, ELYSIUM_TESTNET_ID, ELYSIUM_TESTNET_RPC, REPO, clients, ourArtifact, sendAndLog, startAnvil } from "./lib.mjs";

const FORK = process.argv.includes("--fork");
const ROUND = 60n; // seconds per round
const MAX_SLIPPAGE_BPS = 200n; // the crossing price stays within 2% of the round's opening price
const REFUND_AFTER = 600n; // a round that can't settle is refunded 10 minutes after it ends
const FILE = join(REPO, "deployments/elysium-testnet-gloam.json");
const rec = JSON.parse(readFileSync(FILE, "utf8"));
function envKey() {
  if (process.env.GLOAM_TESTNET_PK) return process.env.GLOAM_TESTNET_PK;
  const p = join(REPO, ".env");
  const m = existsSync(p) && readFileSync(p, "utf8").match(/^GLOAM_TESTNET_PK=(0x[0-9a-fA-F]{64})\s*$/m);
  return m ? m[1] : null;
}
let anvil;
let rpcUrl = process.env.RPC_URL ?? ELYSIUM_TESTNET_RPC;
let pk = envKey();
if (FORK) {
  anvil = await startAnvil({ port: 8570, forkUrl: rpcUrl });
  rpcUrl = anvil.rpcUrl;
  pk = ANVIL_KEYS[0];
}
if (!pk) throw new Error("set GLOAM_TESTNET_PK in .env (fresh testnet key only)");
const me = clients(rpcUrl, pk, ELYSIUM_TESTNET_ID);
const pub = me.pub;
try {
  const start = await pub.getBalance({ address: me.account.address });
  console.log(`Adding CloakGloamBatcherV4 on ${FORK ? "a fork of " : ""}Elysium testnet from ${me.account.address} (${formatEther(start)} HYPE)`);
  const r = await sendAndLog(pub, "deploy CloakGloamBatcherV4", me.wallet.deployContract({ ...ourArtifact("CloakGloamBatcherV4.sol", "CloakGloamBatcherV4"), args: [rec.launchVault, rec.launchFactory, ROUND, MAX_SLIPPAGE_BPS, REFUND_AFTER] }));
  const batcherV4 = r.contractAddress;
  const send = async (x) => (await sendAndLog(pub, x.functionName, me.wallet.writeContract(x))).transactionHash;
  const t = await createGloamLoop({ publicClient: pub, account: me.account, send, batcherV4, batcherV4Block: r.blockNumber }).registerMarkets();
  console.log(`  registered ${t.length} launches: ${t.map((x) => x.index).join(", ")}`);
  const cost = start - (await pub.getBalance({ address: me.account.address }));
  console.log(`  batcherV4 ${batcherV4}, from block ${r.blockNumber}, cost ${formatEther(cost)} HYPE`);
  if (!FORK) {
    writeFileSync(FILE, JSON.stringify({ ...rec, batcherV4, batcherV4Block: Number(r.blockNumber), batcherV4Rounds: { roundSecs: Number(ROUND), maxSlippageBps: Number(MAX_SLIPPAGE_BPS), refundAfter: Number(REFUND_AFTER) } }, null, 2) + "\n");
    console.log(`  written to ${FILE}; add batcherV4 to the SDK's deployment record (gloam) and GLOAM_BATCHER_V4 / GLOAM_ESCROWS to the keeper`);
  }
} finally {
  anvil?.stop();
}
process.exit(0);
