import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPublicClient, defineChain, http, parseEther, parseUnits, type Address, type Chain, type Hex, type PublicClient } from "viem";
import { deploymentFor, elysiumTestnet, type CloakDeployment, type GloamDeployment } from "@cloakely/sdk";

/** The agent wallet's key file that `setup` creates and the server uses when no key is configured. */
export const defaultKeyFile = () => join(homedir(), ".cloak-agent-key");

/** Where the server points, and what it may do. Everything comes from environment variables (see README). */
export interface Settings {
  network: string;
  chain: Chain;
  rpcUrl: string;
  deployment: CloakDeployment;
  /** First block to scan for a launch's bids (the factory's deploy block). */
  launchesFromBlock: bigint;
  privateKey?: Hex;
  /** Gloam's circuit files on disk (their wasm and final/ zkeys), instead of downloading them (hash-checked). */
  gloamCircuitsDir?: string;
  dryRun: boolean;
  stateDir: string;
  limits: Limits;
}

export interface Limits {
  hypePerTx: bigint;
  hypePerDay: bigint;
  usdcPerTx: bigint;
  usdcPerDay: bigint;
  launchesPerDay: number;
}

const NETWORKS: Record<string, { chain: Chain }> = {
  testnet: { chain: elysiumTestnet },
};

/** A deployment file (`CLOAK_DEPLOYMENT_FILE`) for a local chain or a private test deployment. */
interface DeploymentFile extends Omit<CloakDeployment, "factoryBlock" | "dropFactoryBlock" | "gloam"> {
  rpcUrl: string;
  factoryBlock?: string | number;
  dropFactoryBlock?: string | number;
  launchesFromBlock?: string | number;
  gloam: Omit<GloamDeployment, "block" | "launchVaultBlock" | "ecosystemVaultBlock"> & { block: string | number; launchVaultBlock?: string | number; ecosystemVaultBlock?: string | number };
}

export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const network = env.CLOAK_NETWORK ?? (env.CLOAK_DEPLOYMENT_FILE ? "custom" : "testnet");
  let chain: Chain;
  let deployment: CloakDeployment;
  let launchesFromBlock: bigint;
  let rpcUrl: string;
  if (network === "mainnet") {
    if (env.CLOAK_ALLOW_MAINNET !== "1") throw new Error("CLOAK_NETWORK=mainnet needs CLOAK_ALLOW_MAINNET=1 as well. Mainnet moves real money.");
    throw new Error("Cloak mainnet isn't live yet. Use CLOAK_NETWORK=testnet.");
  } else if (network === "custom") {
    if (!env.CLOAK_DEPLOYMENT_FILE) throw new Error("CLOAK_NETWORK=custom needs CLOAK_DEPLOYMENT_FILE");
    const f = JSON.parse(readFileSync(env.CLOAK_DEPLOYMENT_FILE, "utf8")) as DeploymentFile;
    rpcUrl = f.rpcUrl;
    chain = defineChain({ id: f.chainId, name: `Cloak custom (${f.chainId})`, nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } }, testnet: true });
    launchesFromBlock = BigInt(f.launchesFromBlock ?? f.factoryBlock ?? 0);
    deployment = {
      ...f,
      factoryBlock: launchesFromBlock,
      dropFactoryBlock: f.dropFactoryBlock === undefined ? undefined : BigInt(f.dropFactoryBlock),
      gloam: { ...f.gloam, block: BigInt(f.gloam.block), launchVaultBlock: f.gloam.launchVaultBlock === undefined ? undefined : BigInt(f.gloam.launchVaultBlock), ecosystemVaultBlock: f.gloam.ecosystemVaultBlock === undefined ? undefined : BigInt(f.gloam.ecosystemVaultBlock) },
    };
  } else {
    const n = NETWORKS[network];
    if (!n) throw new Error(`unknown CLOAK_NETWORK "${network}" (use testnet)`);
    chain = n.chain;
    deployment = deploymentFor(chain.id);
    launchesFromBlock = deployment.factoryBlock;
    rpcUrl = chain.rpcUrls.default.http[0];
  }
  if (env.CLOAK_RPC_URL) rpcUrl = env.CLOAK_RPC_URL;
  if (env.CLOAK_RELAYER_URL) deployment = { ...deployment, relayerUrl: env.CLOAK_RELAYER_URL };

  let key = env.CLOAK_PRIVATE_KEY?.trim();
  if (!key && env.CLOAK_KEY_FILE) key = readFileSync(env.CLOAK_KEY_FILE, "utf8").trim();
  // the wallet `npx @cloakely/mcp setup` made, when nothing else is configured
  else if (!key && existsSync(defaultKeyFile())) key = readFileSync(defaultKeyFile(), "utf8").trim();
  if (key && !key.startsWith("0x")) key = `0x${key}`;
  if (key && !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("the private key must be 32 bytes of hex");

  const num = (name: string, fallback: string) => {
    const v = env[name] ?? fallback;
    if (!/^\d+(\.\d+)?$/.test(v)) throw new Error(`${name} must be a number, got "${v}"`);
    return v;
  };
  return {
    network,
    chain,
    rpcUrl,
    deployment,
    gloamCircuitsDir: env.GLOAM_CIRCUITS_DIR,
    launchesFromBlock,
    privateKey: key as Hex | undefined,
    dryRun: env.CLOAK_DRY_RUN === "1",
    stateDir: env.CLOAK_STATE_DIR ?? join(homedir(), ".cloak-mcp"),
    limits: {
      hypePerTx: parseEther(num("CLOAK_MAX_HYPE_PER_TX", "1")),
      hypePerDay: parseEther(num("CLOAK_MAX_HYPE_PER_DAY", "10")),
      usdcPerTx: parseUnits(num("CLOAK_MAX_USDC_PER_TX", "100"), 6),
      usdcPerDay: parseUnits(num("CLOAK_MAX_USDC_PER_DAY", "1000"), 6),
      launchesPerDay: Number(num("CLOAK_MAX_LAUNCHES_PER_DAY", "3")),
    },
  };
}
