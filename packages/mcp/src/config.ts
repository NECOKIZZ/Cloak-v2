import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defineChain, parseEther, parseUnits, type Address, type Chain, type Hex } from "viem";
import { deploymentFor, elysiumTestnet, type CloakDeployment } from "@cloakely/sdk";

/** Where the server points, and what it may do. Everything comes from environment variables (see README). */
export interface Settings {
  network: string;
  chain: Chain;
  rpcUrl: string;
  deployment: CloakDeployment;
  /** First block to scan for a launch's bids (the factory's deploy block). */
  launchesFromBlock: bigint;
  /** Local circuit files instead of downloading them (hash-checked) from `deployment.circuitsUrl`. */
  circuitsDir?: string;
  privateKey?: Hex;
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

const NETWORKS: Record<string, { chain: Chain; launchesFromBlock: bigint }> = {
  testnet: { chain: elysiumTestnet, launchesFromBlock: 15855986n },
};

/** A deployment file (`CLOAK_DEPLOYMENT_FILE`) for a local chain or a private test deployment. */
interface DeploymentFile extends Omit<CloakDeployment, "routerBlock" | "assets"> {
  rpcUrl: string;
  routerBlock: string | number;
  launchesFromBlock?: string | number;
  assets?: { symbol: string; token: Address; pool: Address; decimals: number; fromBlock: string | number }[];
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
    deployment = { ...f, routerBlock: BigInt(f.routerBlock), assets: f.assets?.map((a) => ({ ...a, fromBlock: BigInt(a.fromBlock) })) };
    launchesFromBlock = BigInt(f.launchesFromBlock ?? 0);
  } else {
    const n = NETWORKS[network];
    if (!n) throw new Error(`unknown CLOAK_NETWORK "${network}" (use testnet)`);
    chain = n.chain;
    deployment = deploymentFor(chain.id);
    launchesFromBlock = n.launchesFromBlock;
    rpcUrl = chain.rpcUrls.default.http[0];
  }
  if (env.CLOAK_RPC_URL) rpcUrl = env.CLOAK_RPC_URL;
  if (env.CLOAK_RELAYER_URL) deployment = { ...deployment, relayerUrl: env.CLOAK_RELAYER_URL };

  let key = env.CLOAK_PRIVATE_KEY?.trim();
  if (!key && env.CLOAK_KEY_FILE) key = readFileSync(env.CLOAK_KEY_FILE, "utf8").trim();
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
    launchesFromBlock,
    circuitsDir: env.CLOAK_CIRCUITS_DIR,
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
