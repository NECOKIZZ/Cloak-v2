import { deployments, elysium, elysiumTestnet, type CloakDeployment } from "@cloakely/sdk";
import type { Address } from "viem";

const env = import.meta.env;
/** VITE_CHAIN_ID picks the network: 99801 (Elysium testnet, the default) or 99901 (Elysium mainnet). */
export const CHAIN_ID = Number(env.VITE_CHAIN_ID ?? 99801);
const BASE = CHAIN_ID === elysium.id ? elysium : elysiumTestnet;
export const RPC_URL: string = env.VITE_RPC_URL ?? BASE.rpcUrls.default.http[0];
/** VITE_RPC_BACKUP: one or more backup RPCs (comma-separated, for example a QuickNode endpoint). Reads move to the next
 *  one when an RPC fails or stops answering, and back when it recovers. */
export const RPC_URLS: string[] = [RPC_URL, ...String(env.VITE_RPC_BACKUP ?? "").split(",").map((u: string) => u.trim()).filter(Boolean)];
export const chain = { ...BASE, rpcUrls: { default: { http: [RPC_URL] } } };
export const EXPLORER: string | undefined = (BASE as { blockExplorers?: { default: { url: string } } }).blockExplorers?.default.url;
export const txLink = (h: string) => (EXPLORER ? `${EXPLORER}/tx/${h}` : undefined);
export const addrLink = (a: string) => (EXPLORER ? `${EXPLORER}/address/${a}` : undefined);

/**
 * Where Cloak v2 lives. Every address comes from the SDK's deployment record; no env var can point the site at other
 * contracts. Cloak v2 runs on Gloam's vaults (Cloak v1, on Cloak's own vaults, is a separate site and repo).
 */
const D: CloakDeployment | undefined = deployments[CHAIN_ID];

export const DEPLOYMENT = D;
/** Cloak v2's launch factory. */
export const FACTORY = (D?.factory || undefined) as Address | undefined;
export const FACTORY_BLOCK = D?.factoryBlock ?? 0n;
/** The v4 hook new launches open their pools with. */
export const V4_HOOK = (D?.v4Hook || undefined) as Address | undefined;
/** The Cloak keeper (status, relay, leaves): VITE_KEEPER_URL from the host's settings, else the SDK's record. */
export const KEEPER_URL: string | undefined = env.VITE_KEEPER_URL || D?.relayerUrl || undefined;
/** Cloak's relay (POST /gloam/relay, /schedule): submits private actions so the user's wallet never appears. */
export const RELAYER_URL: string | undefined = env.VITE_RELAYER_URL || KEEPER_URL;

/** Sealed NFT drops (CloakDropFactory). */
export const DROP_FACTORY = (D?.dropFactory || undefined) as Address | undefined;
export const DROP_FACTORY_BLOCK = D?.dropFactoryBlock ?? 0n;
/** WL spot sales (CloakSpotBook): drops that sell a partner collection's whitelist spots. */
export const ESCROW_DROP_FACTORY = (D?.escrowDropFactory || undefined) as Address | undefined;
export const SPOT_BOOK = (D?.spotBook || undefined) as Address | undefined;
/** Tokens that aren't launches (USDC). On Gloam an asset's pool id is its token. */
export const ASSETS: { symbol: string; token: Address; pool: Address; decimals: number; hop?: { fee: number; tickSpacing: number } }[] = (D?.assets ?? []).map((a) => ({ ...a, pool: a.token, hop: a.pool }));

/** Gloam's vault and Cloak's launch vault and escrows on this chain (the SDK's deployment record). */
export const GLOAM = D?.gloam;
