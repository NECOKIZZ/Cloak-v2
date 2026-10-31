import { anvilLocal, deployments, elysiumTestnet, type CloakDeployment } from "@cloakely/sdk";
import type { Address } from "viem";

const env = import.meta.env;
export const CHAIN_ID = Number(env.VITE_CHAIN_ID ?? 99801);
export const IS_LOCAL = CHAIN_ID === 31337;
export const RPC_URL: string = env.VITE_RPC_URL ?? (IS_LOCAL ? "http://127.0.0.1:8545" : elysiumTestnet.rpcUrls.default.http[0]);
export const chain = {
  ...(IS_LOCAL ? anvilLocal : elysiumTestnet),
  rpcUrls: { default: { http: [RPC_URL] } },
};
export const EXPLORER = IS_LOCAL ? undefined : elysiumTestnet.blockExplorers.default.url;
export const txLink = (h: string) => (EXPLORER ? `${EXPLORER}/tx/${h}` : undefined);
export const addrLink = (a: string) => (EXPLORER ? `${EXPLORER}/address/${a}` : undefined);

/**
 * Where Cloak lives. On a public chain every address comes from the SDK's deployment record, which the deploy script
 * writes from CloakConfig's registry; no env var can point the site at other contracts. A local chain (31337) takes
 * them from VITE_* variables, for development against a fresh anvil deployment.
 */
const local = (): CloakDeployment => ({
  chainId: 31337,
  version: 4,
  config: env.VITE_CONFIG as Address,
  vaults: (env.VITE_VAULTS || undefined) as Address | undefined,
  vaultsBlock: BigInt(env.VITE_VAULTS_BLOCK || env.VITE_ROUTER_BLOCK || 0),
  factory: env.VITE_FACTORY as Address,
  factoryBlock: 0n,
  router: env.VITE_ROUTER as Address,
  routerBlock: BigInt(env.VITE_ROUTER_BLOCK || 0),
  batcher: env.VITE_BATCHER as Address,
  migrator: (env.VITE_MIGRATOR || undefined) as Address | undefined,
  hypePool: "0x0000000000000000000000000000000000000000",
  whype: "0x0000000000000000000000000000000000000000",
  relayerUrl: env.VITE_RELAYER_URL ?? "",
  circuitsUrl: "/circuits",
  previous: [],
});
const D: CloakDeployment | undefined = IS_LOCAL ? local() : deployments[CHAIN_ID];

export const DEPLOYMENT = D;
export const VERSION = D?.version ?? 0;
export const FACTORY = (D?.factory || undefined) as Address | undefined;
export const ROUTER = (D?.router || undefined) as Address | undefined;
export const ROUTER_BLOCK = D?.routerBlock ?? 0n;
/** First block of the permanent vaults: private notes are scanned from here, whichever router is current. */
export const VAULTS_BLOCK = D?.vaultsBlock ?? ROUTER_BLOCK;
export const VAULTS = D?.vaults;
export const BATCHER = (D?.batcher || undefined) as Address | undefined;
/** Moves balances from every earlier deployment into the permanent vaults. */
export const MIGRATOR = D?.migrator;
export const KEEPER_URL: string | undefined = env.VITE_KEEPER_URL || D?.relayerUrl || undefined;
/** Cloak keeper with `/relay` (submits private trades so the trader's wallet never appears). */
export const RELAYER_URL: string | undefined = env.VITE_RELAYER_URL || KEEPER_URL;

/**
 * Earlier Cloak deployments, newest first: their launches still list, their history still counts on the Volume page,
 * and the migrator moves their private balances into the permanent vaults. v1 accounts came from a plain signed
 * message; v2 and v3 accounts from an EIP-712 signature bound to their router.
 */
export type PreviousDeployment = NonNullable<CloakDeployment["previous"]>[number];
export const PREVIOUS: PreviousDeployment[] = D?.previous ?? [];

/** Vaults for existing tokens (USDC): private sends and withdrawals. The router also lists them; these load faster. */
export const ASSETS: { symbol: string; token: Address; pool: Address; decimals: number; fromBlock: bigint }[] = D?.assets ?? [];
