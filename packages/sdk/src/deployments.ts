import type { Address } from "viem";

/** An earlier deployment on the same chain: its launches still list, and `migrator` moves its private balances here. */
export interface PreviousDeployment {
  version: number;
  factory: Address;
  router: Address;
  routerBlock: bigint;
  batcher?: Address;
  /** Moves this deployment's private balances into the current one (`CloakPrivate.migrateFrom(…, { migrator })`). */
  migrator?: Address;
}

/** Where Cloak lives on each chain, so integrators never copy addresses by hand. */
export interface CloakDeployment {
  chainId: number;
  /** Which Cloak deployment this is (3 on Elysium testnet). */
  version: number;
  config: Address;
  factory: Address;
  /** Block the factory was deployed in: scan launch events from here. */
  factoryBlock: bigint;
  router: Address;
  /** Block the router was deployed in: scan private-pool events from here. */
  routerBlock: bigint;
  batcher: Address;
  /** The migrator from the newest earlier deployment (each one in `previous` has its own). */
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
  // Cloak v3 (Oct 30): deployments/elysium-testnet-v3.json
  99801: {
    chainId: 99801,
    version: 3,
    config: "0x9d30c7b23fa2d5c40779d3db3bb4292e18c94373",
    factory: "0xd0f4aacf339f07211a9155194925b2f94e250e29",
    factoryBlock: 19096456n,
    router: "0x78319bee7c21ca411166acc67c750aca10280e86",
    routerBlock: 19096485n,
    batcher: "0x9902d86c5be81f6c6ce059acf4c89193d06069c4",
    migrator: "0x295f816aa6dac1901bd793120248d8f9cbbd5eec",
    hypePool: "0x786886a61Dd77581ef03787c5939fC44B004064d",
    whype: "0xe44b27113D4b947c0B1bDf4a93878D0e115f4bdD",
    relayerUrl: "https://cloak-keeper.onrender.com",
    circuitsUrl: "https://cloak.boblabs.tech/circuits",
    assets: [
      // Elysium testnet USDC (bridged from Circle's USDC on HyperEVM): private sends and withdrawals
      { symbol: "USDC", token: "0x7D29d8047B905000459c0E80c34a26CeedcB47b2", pool: "0x61de30970e3c53665ce5a89323284e7ab379fa08", decimals: 6, fromBlock: 18329466n },
    ],
    previous: [
      {
        version: 2,
        factory: "0xc1fc14e84cbbd10f75dad9d91bf50f47c48757fc",
        router: "0xd51e731467c49991496329c2b7979cb1aa220ee2",
        routerBlock: 15856031n,
        batcher: "0xa13ffd763a8cccfea1b868c616291723579ddb77",
        migrator: "0x295f816aa6dac1901bd793120248d8f9cbbd5eec",
      },
      {
        version: 1,
        factory: "0x1dc1ea9837ecbd31ec74f0d558e1db1c303a7e1c",
        router: "0xfa2574cfc3afb8f7d3a0651fa2111ff4e3d2fc41",
        routerBlock: 10973723n,
        batcher: "0xf6582cc5a84fccf74e571e652fb7b603a2c25812",
        migrator: "0x5f3d82a6aa1b20ba9d0f58a98d1c4933c115a0da",
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
