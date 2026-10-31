import type { Address, PublicClient } from "viem";
import { privateRouterAbi } from "./abis.js";
import { readRegistry } from "./registry.js";

/** An earlier deployment on the same chain: its launches still list, and the migrator moves its private balances here. */
export interface PreviousDeployment {
  version: number;
  factory: Address;
  router: Address;
  routerBlock: bigint;
  batcher?: Address;
  /** Moved its balances into v3 (v1 and v2 only; from v4 on, the current deployment's `migrator` moves every version). */
  migrator?: Address;
  /** Standalone vaults outside its router (v2's USDC vault), moved too. */
  pools?: { pool: Address; fromBlock: bigint }[];
}

/** Where Cloak lives on each chain, so integrators never copy addresses by hand. */
export interface CloakDeployment {
  chainId: number;
  /** Which Cloak deployment this is (4 on Elysium testnet). */
  version: number;
  /** CloakConfig: the rules and the registry of every Cloak contract. `liveDeployment` reads the current ones from it. */
  config: Address;
  /** CloakVaults: the permanent vaults (v4 on). */
  vaults?: Address;
  /** First block of the permanent vaults: scan private notes from here, whichever router is current. */
  vaultsBlock?: bigint;
  factory: Address;
  /** Block the factory was deployed in: scan launch events from here. */
  factoryBlock: bigint;
  router: Address;
  /** Block the router was deployed in: scan private-pool events from here. */
  routerBlock: bigint;
  batcher: Address;
  /** Moves balances from every earlier deployment into the permanent vaults. */
  migrator?: Address;
  hypePool: Address;
  whype: Address;
  /** Hosted relayer (POST /relay, GET /quote). */
  relayerUrl: string;
  /** Hosted circuit artifacts (transaction2x2.wasm and transaction2x2_final.zkey). */
  circuitsUrl: string;
  /** Shielded pools for existing tokens (USDC): register them with `CloakPrivate.addAsset`. */
  assets?: { symbol: string; token: Address; pool: Address; decimals: number; fromBlock: bigint }[];
  /** Earlier deployments, newest first. */
  previous?: PreviousDeployment[];
}

export const deployments: Record<number, CloakDeployment> = {
  // Cloak v4 (Oct 31), the permanent vaults: deployments/elysium-testnet-v4.json. CloakConfig's registry lists all of it;
  // liveDeployment() reads the current contracts from there.
  99801: {
    chainId: 99801,
    version: 4,
    config: "0x9fdf166f0671166148ea98cdd3ef0118d256167f",
    vaults: "0x24bc1d369aab3a2d741a48f8cac1af5dfd9f3d43",
    vaultsBlock: 19485039n,
    factory: "0xa88df63d7d44acc66052e5cbe5ba9503bf940993",
    factoryBlock: 19484794n,
    router: "0x343ab9a7aac93cee28321410510ea24417cc6386",
    routerBlock: 19485063n,
    batcher: "0xc69e4bca18020ae93bc9f17093985bfb139a3203",
    migrator: "0x86c5d8035224493f10938aaa07b179be316dadf4",
    hypePool: "0x3ACB22829bb422446caaDd8546e65ab530A53031",
    whype: "0xe44b27113D4b947c0B1bDf4a93878D0e115f4bdD",
    relayerUrl: "https://cloak-keeper.onrender.com",
    circuitsUrl: "https://cloak.boblabs.tech/circuits",
    assets: [
      // Elysium testnet USDC (bridged from Circle's USDC on HyperEVM): private sends and withdrawals
      { symbol: "USDC", token: "0x7D29d8047B905000459c0E80c34a26CeedcB47b2", pool: "0x3d5cB722490D9908a118f8B3151f83fcE943E4F0", decimals: 6, fromBlock: 19485039n },
    ],
    previous: [
      {
        version: 3,
        factory: "0xd0f4aacf339f07211a9155194925b2f94e250e29",
        router: "0x78319bee7c21ca411166acc67c750aca10280e86",
        routerBlock: 19096485n,
        batcher: "0x9902d86c5be81f6c6ce059acf4c89193d06069c4",
        pools: [
          { pool: "0x61de30970e3c53665ce5a89323284e7ab379fa08", fromBlock: 18329466n },
        ],
      },
      {
        version: 2,
        factory: "0xc1fc14e84cbbd10f75dad9d91bf50f47c48757fc",
        router: "0xd51e731467c49991496329c2b7979cb1aa220ee2",
        routerBlock: 15856031n,
        batcher: "0xa13ffd763a8cccfea1b868c616291723579ddb77",
        pools: [
          { pool: "0x61de30970e3c53665ce5a89323284e7ab379fa08", fromBlock: 18329466n },
        ],
      },
      {
        version: 1,
        factory: "0x1dc1ea9837ecbd31ec74f0d558e1db1c303a7e1c",
        router: "0xfa2574cfc3afb8f7d3a0651fa2111ff4e3d2fc41",
        routerBlock: 10973723n,
        batcher: "0xf6582cc5a84fccf74e571e652fb7b603a2c25812",
      },
    ],
  },
};

/** The Cloak deployment on `chainId`, or an error naming the chains Cloak is on. */
export function deploymentFor(chainId: number): CloakDeployment {
  const d = deployments[chainId];
  if (!d) throw new Error(`Cloak isn't deployed on chain ${chainId} (available: ${Object.keys(deployments).join(", ")})`);
  return d;
}

/**
 * `base` with the current factory, router, batcher, migrator and vaults read from CloakConfig's registry, so a router or
 * batcher added on-chain is picked up without a new SDK. Earlier deployments keep what `base` knows about them.
 */
export async function liveDeployment(publicClient: PublicClient, base: CloakDeployment): Promise<CloakDeployment> {
  const reg = await readRegistry(publicClient, base.config).catch(() => undefined);
  if (!reg) return base;
  const [hypePool, whype] = await Promise.all([
    publicClient.readContract({ address: reg.router, abi: privateRouterAbi, functionName: "hypePool" }),
    publicClient.readContract({ address: reg.router, abi: privateRouterAbi, functionName: "whype" }),
  ]);
  const known = new Map((base.previous ?? []).map((p) => [p.version, p]));
  return {
    ...base,
    version: reg.version,
    vaults: reg.vaults ?? base.vaults,
    vaultsBlock: reg.vaultsBlock ?? base.vaultsBlock,
    factory: reg.factory,
    factoryBlock: reg.factoryBlock,
    router: reg.router,
    routerBlock: reg.routerBlock,
    batcher: reg.batcher ?? base.batcher,
    migrator: reg.migrator ?? base.migrator,
    hypePool,
    whype,
    previous: reg.previous.length
      ? reg.previous.map((p) => {
          const k = known.get(p.version);
          return {
            version: p.version,
            factory: p.factory ?? k?.factory ?? ("0x" + "0".repeat(40)) as Address,
            router: p.router ?? k?.router ?? ("0x" + "0".repeat(40)) as Address,
            routerBlock: p.routerBlock ?? k?.routerBlock ?? 0n,
            batcher: p.batcher ?? k?.batcher,
            migrator: k?.migrator,
            pools: p.pools.length ? p.pools.map((x) => ({ pool: x.addr, fromBlock: x.startBlock })) : k?.pools,
          };
        })
      : base.previous,
  };
}

