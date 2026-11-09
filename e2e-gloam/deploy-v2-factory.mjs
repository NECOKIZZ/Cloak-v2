// Cloak v2's own launch factory: a CloakConfig for v2 (launch fee, treasury, bid caps), CloakV4Hook at a flagged
// address on Uniswap's PoolManager, and a CloakFactory whose seeder is the hook. v2's launches then live apart from
// Cloak v1's: v2's keeper handles only these, and v1's keeper only v1's.
//
// Built from this repo's compiled contracts (contracts/out, contracts-v4/out: run forge build in both first), so the
// auctions carry the fixes made after the SDK's stored bytecode (the 5-minute minimum reveal window, the 2-minute
// drand margin).
//
//   node e2e-gloam/deploy-v2-factory.mjs --rehearse     # a fork of Elysium testnet, writes nothing
//   NODE_USE_ENV_PROXY=1 node e2e-gloam/deploy-v2-factory.mjs   # Elysium testnet, writes deployments/elysium-testnet-v2-factory.json
//
// Env: DEPLOYER_PK, or GLOAM_TESTNET_PK from ../.env. POOL_MANAGER (default: the testnet PoolManager Cloak's v4
// launches use; on mainnet Uniswap's 0xe2e105d3f7209a9da11f83ccf3e7398a753823f1). TREASURY (default: the deploy
// wallet, testnet only; on mainnet the Safe). COPY_FROM: a CloakConfig to copy the launch fee and bid caps from
// (default: Cloak v1's testnet config).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatEther } from "viem";
import { deployV2Factory } from "./v2factory.mjs";
import { ANVIL_KEYS, ELYSIUM_TESTNET_RPC, REPO, clients, startAnvil } from "./lib.mjs";

const REHEARSE = process.argv.includes("--rehearse");
const POOL_MANAGER = process.env.POOL_MANAGER ?? "0x51027076df8416e42ea8438b27a0c433d9662e68";
const COPY_FROM = process.env.COPY_FROM ?? "0x9fdf166f0671166148ea98cdd3ef0118d256167f";
const t = JSON.parse(readFileSync(join(REPO, "deployments/elysium-testnet-gloam.json"), "utf8"));

function envKey() {
  if (process.env.DEPLOYER_PK) return process.env.DEPLOYER_PK;
  const p = join(REPO, ".env");
  const m = existsSync(p) && readFileSync(p, "utf8").match(/^GLOAM_TESTNET_PK=(0x[0-9a-fA-F]{64})\s*$/m);
  return m ? m[1] : null;
}

let anvil;
let rpcUrl = process.env.RPC_URL ?? ELYSIUM_TESTNET_RPC;
let pk = envKey();
if (REHEARSE) {
  anvil = await startAnvil({ port: 8581, forkUrl: rpcUrl });
  rpcUrl = anvil.rpcUrl;
  pk = ANVIL_KEYS[0];
}
if (!pk) throw new Error("set DEPLOYER_PK (or GLOAM_TESTNET_PK in .env)");
const me = clients(rpcUrl, pk, 99801);
const pub = me.pub;
const addr = me.account.address;
const treasury = process.env.TREASURY ?? addr;
try {
  const start = await pub.getBalance({ address: addr });
  console.log(`Cloak v2's launch factory, from ${addr} (${formatEther(start)} HYPE)${REHEARSE ? " on a fork" : ""}`);

  const { config, factory, factoryBlock, hook, vestingDeployer: vd, launchFeeBps, perBid, total, capsOn } = await deployV2Factory({ pub, wallet: me.wallet, treasury, copyFrom: COPY_FROM, poolManager: POOL_MANAGER, vaultVerifier: t.verifier });

  const end = await pub.getBalance({ address: addr });
  const out = {
    chainId: 99801,
    note: "Cloak v2's own launch factory (v2's launches, apart from Cloak v1's). CloakConfig v2 holds the launch fee, treasury and bid caps; its verifier field names Gloam's verifier and is unused (v2 has no Cloak vaults).",
    config,
    factory,
    factoryBlock: Number(factoryBlock),
    v4Hook: hook,
    poolManager: POOL_MANAGER,
    vestingDeployer: vd,
    launchFeeBps: Number(launchFeeBps),
    auctionLimit: { perBid: String(perBid), total: String(total), on: capsOn },
    treasury,
    hookAdmin: addr,
    costHype: formatEther(start - end),
  };
  console.log(JSON.stringify(out, null, 1));
  if (!REHEARSE) writeFileSync(join(REPO, "deployments/elysium-testnet-v2-factory.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(`\ndeployed for ${formatEther(start - end)} HYPE${REHEARSE ? " (rehearsal, nothing written)" : ""}`);
} finally {
  anvil?.stop();
}
process.exit(0);
