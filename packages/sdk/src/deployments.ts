import type { Address } from "viem";

/**
 * Where Cloak v2 lives on each chain, so integrators never copy addresses by hand. Cloak v2 runs on Gloam's vaults and
 * keys; Cloak v1 (Cloak's own vaults) is a separate deployment in Cloak v1's repo.
 */
export interface CloakDeployment {
  chainId: number;
  /** Cloak v2's CloakConfig: the launch fee, the treasury and the bid caps its launches use. */
  config: Address;
  /** Cloak v2's launch factory (sealed-bid launches that open a Uniswap v4 pool through CloakV4Hook). */
  factory: Address;
  /** Block the factory was deployed in: scan launch events from here. */
  factoryBlock: bigint;
  /** Uniswap v4's PoolManager (on testnet, Cloak's deployment of Uniswap's exact build; on mainnet, Uniswap's own). */
  poolManager: Address;
  /** CloakV4Hook: seeds and looks after every v2 launch's pool. */
  v4Hook: Address;
  /** WHYPE, the token pages use for HYPE. */
  whype: Address;
  /** Cloak's keeper and relay (POST /gloam/relay, /schedule, /leaves). */
  relayerUrl: string;
  /** CloakDropFactory: sealed NFT drops (wallet bids, shared with Cloak v1). */
  dropFactory?: Address;
  /** Block the drop factory was deployed in: scan drop events from here. */
  dropFactoryBlock?: bigint;
  /** CloakSpotBook: WL spot sales on top of drops; winners name the wallets to whitelist. */
  spotBook?: Address;
  /** CloakEscrowDropFactory: sealed auctions of NFTs that already exist (listed with the drops). */
  escrowDropFactory?: Address;
  /**
   * Tokens that aren't launches (USDC): private balances in Gloam's vault. `pool` is the asset's plain native-HYPE
   * Uniswap v4 pool (no hook): with gloam.router set, the asset trades privately against HYPE, and through HYPE against
   * every launch token and outside token in one swap.
   */
  assets?: { symbol: string; token: Address; decimals: number; pool?: { fee: number; tickSpacing: number } }[];
  /** Gloam's vault and Cloak's launch vault and escrows on it. */
  gloam: GloamDeployment;
}

/** Where Cloak v2 on Gloam lives on a chain (deployments/<chain>-gloam.json). */
export interface GloamDeployment {
  /** Gloam's vault, or Cloak's own instance of Gloam's guarded deploy until Gloam's is live on this chain. */
  gloamVault: Address;
  memoBoard: Address;
  /** CloakLaunchVault: Gloam's code and keys, launch tokens admitted when their launch settles. */
  launchVault: Address;
  /** First block to scan Gloam's vault from (and the launch vault, unless launchVaultBlock is set). */
  block: bigint;
  /** First block to scan the launch vault from, when it was deployed later than Gloam's vault. */
  launchVaultBlock?: bigint;
  launchSwap?: Address;
  /** CloakLaunchSwapV4: private swaps through Cloak launches' own Uniswap v4 pools. */
  launchSwapV4?: Address;
  /**
   * CloakRouterV4. When set, HYPE lives in Gloam's vault and launch tokens in the launch vault: buys and sells go through
   * it. Unset, HYPE stays in the launch vault and trades through launchSwapV4.
   */
  router?: Address;
  /** CloakEcosystemVault: admitted outside tokens (KNTQ, ...), traded through `router`; and its deploy block. */
  ecosystemVault?: Address;
  ecosystemVaultBlock?: bigint;
  /** CloakGloamBatcher: batch rounds through Uniswap V2 pairs. */
  batcher?: Address;
  /** CloakGloamBatcherV4: batch rounds through launches' own v4 pools; the keeper registers each settled launch. */
  batcherV4?: Address;
  /** CloakGloamReceive: receive addresses. */
  receive?: Address;
  /** CloakGloamBids on the launch vault: sealed bids from the private balance. */
  bids?: Address;
  fundsGate?: Address;
  receiptCheck?: Address;
  /** The WHYPE the launch swap trades through. */
  whype: Address;
  /** True while any of these are test stand-ins (launch factory, WHYPE, V2 pool), as in the Nov 8 live run. */
  standIns?: boolean;
}

export const deployments: Record<number, CloakDeployment> = {
  // Cloak v2 on Elysium testnet: deployments/elysium-testnet-gloam.json and deployments/elysium-testnet-v2-factory.json
  99801: {
    chainId: 99801,
    // v2's own launch factory and hook (Nov 9, deploy-v2-factory.mjs), apart from Cloak v1's: on Uniswap's PoolManager
    // build, every launch opens a v4 pool (native HYPE / token) at its clearing price; the hook keeps the liquidity for
    // good, pays trading fees to the creator and charges an anti-snipe fee for 5 minutes after listing
    config: "0xfedf1050af9e96dcfef9c098fcbc122d907f4f1e",
    factory: "0x59d2cd703747a47288518c7380efa95879295784",
    factoryBlock: 26707681n,
    poolManager: "0x51027076df8416e42ea8438b27a0c433d9662e68",
    v4Hook: "0xC6296320cDFAB6074Fc650f1d788608b16fa2A80",
    whype: "0xe44b27113D4b947c0B1bDf4a93878D0e115f4bdD",
    relayerUrl: "",
    // sealed NFT drops (Nov 3): GTD, then a sealed auction with the creator's price as the floor and a WL bid boost
    dropFactory: "0x2afb7d9a5baa02a2d72a7c761521fc66dce9d783",
    dropFactoryBlock: 22329730n,
    spotBook: "0x91806d96814cc205d4b642e280023a1c7b361fc8",
    escrowDropFactory: "0x5f3efbfd5d15440947abfbfce7f2fcfffff71079",
    // Elysium testnet USDC (bridged from Circle's USDC on HyperEVM)
    assets: [{ symbol: "USDC", token: "0x7D29d8047B905000459c0E80c34a26CeedcB47b2", decimals: 6 }],
    gloam: {
      gloamVault: "0x8D15BA46071D5AB2e59d746c22d51C906281cB44",
      memoBoard: "0xf6816854b68CC4B67213289927d8e44050BA62D3",
      block: 26230337n,
      // the launch vault and every escrow on v2's own factory (Nov 9, deploy-partner.mjs), with the stress-test fixes
      launchVault: "0x13050b9a0abece56f80d30da107c3f3fad33288f",
      launchVaultBlock: 26707908n,
      launchSwapV4: "0xc4b6ce66f12733e6737cda6cc1a882ea05bf99ce",
      receive: "0xa462e810b985029b28b5cee49866760a7f8767bb",
      bids: "0xb3f6f2142439f1b4f088ea24569cc73726dcea32",
      // batch rounds through launches' own v4 pools: time-weighted price, 0.5% settle band, 4% per side, real notes only
      batcherV4: "0xbd4a41301b3c0ba2ca07677fd9ba3ba4640d28f8",
      fundsGate: "0x79aafd041a283c334421a17c781b12e353093210",
      receiptCheck: "0xb0a8fcbd75f4d6d2ce5a0121e8607aa353990304",
      whype: "0xe44b27113D4b947c0B1bDf4a93878D0e115f4bdD",
    },
  },
};

/** The Cloak deployment on `chainId`, or an error naming the chains Cloak is on. */
export function deploymentFor(chainId: number): CloakDeployment {
  const d = deployments[chainId];
  if (!d) throw new Error(`Cloak isn't deployed on chain ${chainId} (available: ${Object.keys(deployments).join(", ")})`);
  return d;
}
