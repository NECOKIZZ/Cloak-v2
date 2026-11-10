// Redeploys the escrows changed by the Nov 9 stress-test fixes on the live Cloak v2 on Gloam testnet deployment:
// CloakGloamBatcherV4 (registered for every settled v4 launch), CloakGloamBids, CloakGloamReceive and CloakGraduation.
// None has an owner, and the vaults stay as they are, so nobody's balance moves; old escrows keep working for what's
// already in them. Updates deployments/elysium-testnet-gloam.json (and keeps the old addresses under `previous`).
//
//   node e2e-gloam/deploy-escrows-update.mjs --fork        # rehearsal, writes nothing
//   NODE_USE_ENV_PROXY=1 node e2e-gloam/deploy-escrows-update.mjs
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatEther, zeroAddress } from "viem";
import { createGloamLoop } from "../services/keeper/gloamLoop.mjs";
import { ANVIL_KEYS, ELYSIUM_TESTNET_ID, ELYSIUM_TESTNET_RPC, REPO, clients, ourArtifact, sendAndLog, startAnvil } from "./lib.mjs";

const FORK = process.argv.includes("--fork");
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
  anvil = await startAnvil({ port: 8573, forkUrl: rpcUrl });
  rpcUrl = anvil.rpcUrl;
  pk = ANVIL_KEYS[0];
}
if (!pk) throw new Error("set GLOAM_TESTNET_PK in .env");
const me = clients(rpcUrl, pk, ELYSIUM_TESTNET_ID);
const pub = me.pub;
const deploy = async (label, art, args = []) => (await sendAndLog(pub, `deploy ${label}`, me.wallet.deployContract({ ...art, args }))).contractAddress;
try {
  const start = await pub.getBalance({ address: me.account.address });
  console.log(`Updating Cloak v2's escrows on ${FORK ? "a fork of " : ""}Elysium testnet from ${me.account.address} (${formatEther(start)} HYPE)`);
  const r = rec.batcherV4Rounds ?? { roundSecs: 60, maxSlippageBps: 200, refundAfter: 600 };
  const batcherV4 = await deploy("CloakGloamBatcherV4", ourArtifact("CloakGloamBatcherV4.sol", "CloakGloamBatcherV4"), [rec.launchVault, zeroAddress, rec.launchFactory, BigInt(r.roundSecs), BigInt(r.maxSlippageBps), BigInt(r.refundAfter)]);
  const bids = await deploy("CloakGloamBids", ourArtifact("CloakGloamBids.sol", "CloakGloamBids"), [rec.launchVault, zeroAddress]);
  const receive = await deploy("CloakGloamReceive", ourArtifact("CloakGloamReceive.sol", "CloakGloamReceive"), [rec.gloamVault, rec.launchVault]);
  const graduation = await deploy("CloakGraduation", ourArtifact("CloakGraduation.sol", "CloakGraduation"), [rec.launchVault, rec.gloamVault, 3600n]);
  const block = await pub.getBlockNumber();
  const send = async (x) => (await sendAndLog(pub, x.functionName, me.wallet.writeContract(x))).transactionHash;
  const reg = await createGloamLoop({ publicClient: pub, account: me.account, send, batcherV4, batcherV4Block: block }).registerMarkets();
  console.log(`  registered ${reg.length} launches for batch rounds`);
  const cost = start - (await pub.getBalance({ address: me.account.address }));
  const next = { ...rec, batcherV4, batcherV4Block: Number(block), bids, receive, graduation, escrowsUpdatedAt: "Nov 9 (stress-test fixes)", previous: { ...(rec.previous ?? {}), nov8: { batcherV4: rec.batcherV4, bids: rec.bids, receive: rec.receive, graduation: rec.graduation } } };
  console.log(JSON.stringify({ batcherV4, bids, receive, graduation, block: Number(block), cost: formatEther(cost) }, null, 1));
  if (!FORK) writeFileSync(FILE, JSON.stringify(next, null, 2) + "\n");
} finally {
  anvil?.stop();
}
process.exit(0);
