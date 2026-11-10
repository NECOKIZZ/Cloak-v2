// Prints the SDK's deployment entry (packages/sdk/src/deployments.ts) for a chain from its deploy records, so going
// from testnet to mainnet is: run deploy-v2-factory.mjs and deploy-partner.mjs, then paste this script's output.
//
//   node scripts/sdk-entry.mjs deployments/elysium-mainnet-gloam.json deployments/elysium-mainnet-v2-factory.json [relayerUrl]
//
// The gloam record (deploy-partner.mjs) gives the vaults, escrows, router, ecosystem vault and assets (USDC and its
// HYPE pool); the factory record (deploy-v2-factory.mjs) the launch factory, config, hook and PoolManager.
import { readFileSync } from "node:fs";

const [gPath, fPath, relayerUrl = ""] = process.argv.slice(2);
if (!gPath || !fPath) throw new Error("usage: node scripts/sdk-entry.mjs <gloam.json> <factory.json> [relayerUrl]");
const g = JSON.parse(readFileSync(gPath, "utf8"));
const f = JSON.parse(readFileSync(fPath, "utf8"));
if (g.chainId !== f.chainId) throw new Error(`the records are for different chains (${g.chainId}, ${f.chainId})`);
if (g.launchFactory.toLowerCase() !== f.factory.toLowerCase()) throw new Error("the launch vault isn't on this factory");
if (g.poolManager.toLowerCase() !== f.poolManager.toLowerCase() || g.v4Hook.toLowerCase() !== f.v4Hook.toLowerCase()) throw new Error("the records name different PoolManagers or hooks");

const q = (s) => JSON.stringify(s);
const opt = (k, v, suffix = "") => (v === undefined || v === null ? "" : `\n      ${k}: ${typeof v === "number" ? `${v}n` : q(v)}${suffix},`);
const assets = (g.assets ?? []).map((a) => `{ symbol: ${q(a.symbol)}, token: ${q(a.token)}, decimals: ${a.decimals}${a.pool ? `, pool: { fee: ${a.pool.fee}, tickSpacing: ${a.pool.tickSpacing} }` : ""} }`);
console.log(`  ${g.chainId}: {
    chainId: ${g.chainId},
    config: ${q(f.config)},
    factory: ${q(f.factory)},
    factoryBlock: ${f.factoryBlock}n,
    poolManager: ${q(f.poolManager)},
    v4Hook: ${q(f.v4Hook)},
    whype: ${q(g.whype)},
    relayerUrl: ${q(relayerUrl)},${assets.length ? `\n    assets: [${assets.join(", ")}],` : ""}
    gloam: {
      gloamVault: ${q(g.gloamVault)},
      memoBoard: ${q(g.memoBoard)},
      block: ${g.block}n,
      launchVault: ${q(g.launchVault)},${opt("launchSwapV4", g.launchSwapV4)}${opt("router", g.router)}${opt("ecosystemVault", g.ecosystemVault)}${g.ecosystemVault ? `\n      ecosystemVaultBlock: ${g.block}n,` : ""}${opt("batcherV4", g.batcherV4)}${opt("receive", g.receive)}${opt("bids", g.bids)}${opt("graduation", g.graduation)}${opt("fundsGate", g.fundsGate)}${opt("receiptCheck", g.receiptCheck)}
      whype: ${q(g.whype)},
    },
  },`);
