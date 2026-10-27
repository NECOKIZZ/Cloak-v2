import type { Address } from "viem";

/** Where Cloak lives on each chain, so integrators never copy addresses by hand. */
export interface CloakDeployment {
  chainId: number;
  config: Address;
  factory: Address;
  router: Address;
  /** Block the router was deployed in: scan private-pool events from here. */
  routerBlock: bigint;
  batcher: Address;
  migrator?: Address;
  hypePool: Address;
  whype: Address;
  /** Hosted relayer (POST /relay, GET /quote). */
  relayerUrl: string;
  /** Hosted circuit artifacts (transaction2x2.wasm and transaction2x2_final.zkey). */
  circuitsUrl: string;
  /** The first deployment: its launches still list, and its private balances move here through `migrator`. */
  legacy?: { factory: Address; router: Address; routerBlock: bigint };
}

export const deployments: Record<number, CloakDeployment> = {
  99801: {
    chainId: 99801,
    config: "0x9d30c7b23fa2d5c40779d3db3bb4292e18c94373",
    factory: "0xc1fc14e84cbbd10f75dad9d91bf50f47c48757fc",
    router: "0xd51e731467c49991496329c2b7979cb1aa220ee2",
    routerBlock: 15856031n,
    batcher: "0xa13ffd763a8cccfea1b868c616291723579ddb77",
    migrator: "0xe54c02fa685f2c95e5ae98e1155547194d04d9ad",
    hypePool: "0x4deFEC0814d11c581e5947020ac4ec41e88B55Df",
    whype: "0xe44b27113D4b947c0B1bDf4a93878D0e115f4bdD",
    relayerUrl: "https://cloak-keeper.onrender.com",
    circuitsUrl: "https://cloak.boblabs.tech/circuits",
    legacy: {
      factory: "0x1dc1ea9837ecbd31ec74f0d558e1db1c303a7e1c",
      router: "0xfa2574cfc3afb8f7d3a0651fa2111ff4e3d2fc41",
      routerBlock: 10973723n,
    },
  },
};

/** The Cloak deployment on `chainId`, or an error naming the chains Cloak is on. */
export function deploymentFor(chainId: number): CloakDeployment {
  const d = deployments[chainId];
  if (!d) throw new Error(`Cloak isn't deployed on chain ${chainId} (available: ${Object.keys(deployments).join(", ")})`);
  return d;
}
