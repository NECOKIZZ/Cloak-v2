import { hexToString, type Address, type Hex, type PublicClient } from "viem";
import { cloakConfigAbi } from "./abis.js";

/** One contract in CloakConfig's registry. */
export interface RegistryEntry {
  kind: string; // "vaults", "router", "batcher", "migrator", "factory", "pool"
  addr: Address;
  version: number;
  startBlock: bigint;
}

/** An earlier deployment, rebuilt from the registry: what's needed to list its launches and move its balances. */
export interface RegistryVersion {
  version: number;
  router?: Address;
  routerBlock?: bigint;
  batcher?: Address;
  batcherBlock?: bigint;
  factory?: Address;
  factoryBlock?: bigint;
  /** Standalone vaults of that deployment, outside its router (v2's USDC vault). */
  pools: { addr: Address; startBlock: bigint }[];
}

/** Everything Cloak has deployed on a chain, read from CloakConfig, so apps only need that one address. */
export interface CloakRegistry {
  config: Address;
  entries: RegistryEntry[];
  /** Factories whose launches the vaults may list, oldest first. */
  launchFactories: Address[];
  /** The current version (the newest router's). */
  version: number;
  vaults?: Address;
  /** First block of the permanent vaults: scan private notes from here, whichever router is current. */
  vaultsBlock?: bigint;
  router: Address;
  routerBlock: bigint;
  batcher?: Address;
  batcherBlock?: bigint;
  migrator?: Address;
  factory: Address;
  factoryBlock: bigint;
  /** Earlier deployments, newest first. */
  previous: RegistryVersion[];
}

const kindOf = (k: Hex) => hexToString(k, { size: 32 }).replace(/\0+$/, "");

/** Read CloakConfig's registry. Throws if it has no router or factory yet. */
export async function readRegistry(publicClient: PublicClient, config: Address): Promise<CloakRegistry> {
  const c = { address: config, abi: cloakConfigAbi } as const;
  const [n, nf] = await Promise.all([
    publicClient.readContract({ ...c, functionName: "registryCount" }),
    publicClient.readContract({ ...c, functionName: "launchFactoriesCount" }),
  ]);
  const [rows, launchFactories] = await Promise.all([
    Promise.all(Array.from({ length: Number(n) }, (_, i) => publicClient.readContract({ ...c, functionName: "registry", args: [BigInt(i)] }))),
    Promise.all(Array.from({ length: Number(nf) }, (_, i) => publicClient.readContract({ ...c, functionName: "launchFactories", args: [BigInt(i)] }))),
  ]);
  const entries: RegistryEntry[] = rows.map(([kind, addr, version, startBlock]) => ({ kind: kindOf(kind), addr, version: Number(version), startBlock: BigInt(startBlock) }));
  const newest = (kind: string, version?: number) => [...entries].reverse().find((e) => e.kind === kind && (version === undefined || e.version === version));
  const router = newest("router");
  const factory = newest("factory");
  if (!router || !factory) throw new Error(`CloakConfig ${config} has no router or factory registered yet`);
  const batcher = newest("batcher", router.version);
  const versions = [...new Set(entries.map((e) => e.version))].filter((v) => v < router.version).sort((a, b) => b - a);
  return {
    config,
    entries,
    launchFactories,
    version: router.version,
    vaults: newest("vaults")?.addr,
    vaultsBlock: newest("vaults")?.startBlock,
    router: router.addr,
    routerBlock: router.startBlock,
    batcher: batcher?.addr,
    batcherBlock: batcher?.startBlock,
    migrator: newest("migrator", router.version)?.addr,
    factory: factory.addr,
    factoryBlock: factory.startBlock,
    previous: versions.map((v) => {
      const r = newest("router", v);
      const b = newest("batcher", v);
      const f = newest("factory", v);
      return {
        version: v,
        router: r?.addr,
        routerBlock: r?.startBlock,
        batcher: b?.addr,
        batcherBlock: b?.startBlock,
        factory: f?.addr,
        factoryBlock: f?.startBlock,
        pools: entries.filter((e) => e.kind === "pool" && e.version === v).map((e) => ({ addr: e.addr, startBlock: e.startBlock })),
      };
    }),
  };
}
