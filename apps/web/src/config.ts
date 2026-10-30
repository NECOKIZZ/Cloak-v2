import { anvilLocal, elysiumTestnet } from "@cloakely/sdk";
import type { Address } from "viem";

const env = import.meta.env;
export const CHAIN_ID = Number(env.VITE_CHAIN_ID ?? 99801);
export const IS_LOCAL = CHAIN_ID === 31337;
export const RPC_URL: string = env.VITE_RPC_URL ?? (IS_LOCAL ? "http://127.0.0.1:8545" : elysiumTestnet.rpcUrls.default.http[0]);
export const chain = {
  ...(IS_LOCAL ? anvilLocal : elysiumTestnet),
  rpcUrls: { default: { http: [RPC_URL] } },
};
export const FACTORY = (env.VITE_FACTORY || undefined) as Address | undefined;
export const KEEPER_URL: string | undefined = env.VITE_KEEPER_URL || undefined;
export const EXPLORER = IS_LOCAL ? undefined : elysiumTestnet.blockExplorers.default.url;
export const txLink = (h: string) => (EXPLORER ? `${EXPLORER}/tx/${h}` : undefined);
export const addrLink = (a: string) => (EXPLORER ? `${EXPLORER}/address/${a}` : undefined);
export const ROUTER = (env.VITE_ROUTER || undefined) as Address | undefined;
export const ROUTER_BLOCK = BigInt(env.VITE_ROUTER_BLOCK || 0);
/** Cloak keeper with `/relay` (submits private trades so the trader's wallet never appears). */
export const RELAYER_URL: string | undefined = env.VITE_RELAYER_URL || env.VITE_KEEPER_URL || undefined;
export const BATCHER = (env.VITE_BATCHER || undefined) as Address | undefined;
/**
 * Earlier Cloak deployments, newest first (VITE_PREVIOUS, a JSON list): their launches still list, their history still
 * counts on the Volume page, and `migrator` moves their private balances here. Version 1 accounts came from a plain
 * signed message; later ones from an EIP-712 signature bound to their router.
 */
export interface PreviousDeployment {
  version: number;
  factory: Address;
  router: Address;
  routerBlock: bigint;
  batcher?: Address;
  migrator?: Address;
}
export const PREVIOUS: PreviousDeployment[] = (() => {
  try {
    const raw = JSON.parse(env.VITE_PREVIOUS || "[]") as (Omit<PreviousDeployment, "routerBlock"> & { routerBlock: string | number })[];
    return raw.map((p) => ({ ...p, routerBlock: BigInt(p.routerBlock || 0) }));
  } catch {
    return [];
  }
})();

/** Shielded pools for existing tokens (USDC): private sends and withdrawals, registered on the private client. */
export const ASSETS: { symbol: string; token: Address; pool: Address; decimals: number; fromBlock: bigint }[] =
  env.VITE_USDC && env.VITE_USDC_POOL
    ? [{ symbol: "USDC", token: env.VITE_USDC as Address, pool: env.VITE_USDC_POOL as Address, decimals: 6, fromBlock: BigInt(env.VITE_USDC_BLOCK || 0) }]
    : [];
