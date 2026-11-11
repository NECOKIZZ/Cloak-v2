import type { Address, PublicClient } from "viem";
import { cloakFactoryAbi, cloakVestingDeployerAbi, gloakTokenAbi } from "./abis.js";

/**
 * GLOAK, the one private-only token (docs/GLOAK.md). It lives in private vaults: shielding and private trading are
 * free, and every move to a public address burns a surcharge (10%, never raised). These helpers find it and read its
 * rules so an app can warn before a withdrawal, a payment to a wallet, or a router exit.
 */

/** GloakToken's roles (bit flags). */
export const GLOAK_ROLES = { receive: 1, send: 2, feed: 4, swap: 8, vault: 16, payee: 32 } as const;

export interface GloakMeter {
  /** In approved private vaults. */
  inVaults: bigint;
  /** In Uniswap's PoolManager: the pool. */
  inPool: bigint;
  /** In other approved contracts (the auction, routers, the private-bid contract). */
  inContracts: bigint;
  /** At 0x…dEaD: never moves again. */
  atDead: bigint;
  /** In public addresses. */
  inPublic: bigint;
  /** The vaults' share of everything not at 0x…dEaD, in basis points. */
  privateBps: number;
}

export interface GloakInfo {
  token: Address;
  /** The surcharge on moves to public addresses, in basis points (1000 = 10%). */
  surchargeBps: number;
  /** GLOAK burned by surcharges so far. */
  surchargeBurned: bigint;
  totalSupply: bigint;
  /** True until the admin ends setup; after it, new approvals wait 3 days in public. */
  setupMode: boolean;
  meter: GloakMeter;
}

/**
 * The GLOAK token, if `factory`'s launch deployer has used its one-time door, else null. Never throws: a factory or
 * deployer without a door answers null.
 */
export async function findGloak(publicClient: PublicClient, factory: Address): Promise<Address | null> {
  try {
    const deployer = await publicClient.readContract({ address: factory, abi: cloakFactoryAbi, functionName: "vestingDeployer" });
    const t = await publicClient.readContract({ address: deployer, abi: cloakVestingDeployerAbi, functionName: "doorToken" });
    return /^0x0{40}$/i.test(t) ? null : t;
  } catch {
    return null;
  }
}

/** GLOAK's surcharge, totals and privacy meter, read in one go. */
export async function readGloak(publicClient: PublicClient, token: Address): Promise<GloakInfo> {
  const c = { address: token, abi: gloakTokenAbi } as const;
  const [bps, burned, supply, setup, m] = await Promise.all([
    publicClient.readContract({ ...c, functionName: "surchargeBps" }),
    publicClient.readContract({ ...c, functionName: "surchargeBurned" }),
    publicClient.readContract({ ...c, functionName: "totalSupply" }),
    publicClient.readContract({ ...c, functionName: "setupMode" }),
    publicClient.readContract({ ...c, functionName: "meter" }),
  ]);
  const [inVaults, inPool, inContracts, atDead, inPublic, privateBps] = m;
  return {
    token,
    surchargeBps: Number(bps),
    surchargeBurned: burned,
    totalSupply: supply,
    setupMode: setup,
    meter: { inVaults, inPool, inContracts, atDead, inPublic, privateBps: Number(privateBps) },
  };
}

/** What the token burns on a move of `amount` to a public address at `bps` (rounded down, as the token does). */
export function gloakSurcharge(amount: bigint, bps: number): bigint {
  return (amount * BigInt(bps)) / 10_000n;
}

/** What arrives at a public address when `amount` GLOAK is sent there. */
export function gloakArrives(amount: bigint, bps: number): bigint {
  return amount - gloakSurcharge(amount, bps);
}

/**
 * The smallest amount to send so that at least `net` arrives at a public address (to pay someone an exact amount).
 * Throws at a 100% surcharge, where nothing can arrive.
 */
export function gloakGrossFor(net: bigint, bps: number): bigint {
  if (net <= 0n) return 0n;
  if (bps >= 10_000) throw new Error("Nothing arrives at a 100% surcharge.");
  // gross - floor(gross * bps / 10_000) >= net; start from the exact quotient, then step up past rounding
  let gross = (net * 10_000n + BigInt(10_000 - bps) - 1n) / BigInt(10_000 - bps);
  while (gloakArrives(gross, bps) < net) gross += 1n;
  while (gross > 0n && gloakArrives(gross - 1n, bps) >= net) gross -= 1n;
  return gross;
}
