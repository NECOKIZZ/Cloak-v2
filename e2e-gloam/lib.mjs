// Shared helpers for Cloak v2 on Gloam: local chain, Gloam's deploy, the final-key prover, timing and gas logs.
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, "..");
export const GLOAM = join(REPO, "vendor/gloam");
export const GLOAM_CONTRACTS = join(GLOAM, "contracts");
export const OUR_CONTRACTS = join(REPO, "contracts-gloam");
export const CIRCUITS = join(GLOAM, "app/public/circuits");

const FOUNDRY_DIRS = [process.env.FOUNDRY_BIN, "/home/user/tools/foundry", `${process.env.HOME}/.foundry/bin`].filter(Boolean);
export const ENV_PATH = [...FOUNDRY_DIRS, process.env.PATH].join(":");
const toolEnv = (extra = {}) => ({ ...process.env, PATH: ENV_PATH, FOUNDRY_DISABLE_NIGHTLY_WARNING: "1", ...extra });

/** Anvil's well-known dev keys (never real funds). */
export const ANVIL_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
  "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
  "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
  "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
];

/** Elysium testnet's chain id. Local runs use it too, because Gloam's deploy refuses any other. */
export const ELYSIUM_TESTNET_ID = 99801;
export const ELYSIUM_TESTNET_RPC = "https://testnet-rpc.elysium.kinetiq.xyz";
export const ELYSIUM_TESTNET_USDC = "0x7D29d8047B905000459c0E80c34a26CeedcB47b2";
/** The runtime code hash of circomlibjs's PoseidonT3 on every Gloam chain (DEPLOY-ELYSIUM.md, step 3). */
export const POSEIDON_T3_CODEHASH_PREFIX = "0x354b2699";

export function chainFor(rpcUrl, id = ELYSIUM_TESTNET_ID) {
  return defineChain({
    id,
    name: id === ELYSIUM_TESTNET_ID ? "Elysium testnet" : `chain ${id}`,
    nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

export function clients(rpcUrl, pk, id) {
  const chain = chainFor(rpcUrl, id);
  const account = privateKeyToAccount(pk);
  const pub = createPublicClient({ chain, transport: http(rpcUrl), pollingInterval: 50 });
  const wallet = createWalletClient({ chain, account, transport: http(rpcUrl) });
  return { chain, account, pub, wallet };
}

/** Starts anvil as Elysium testnet (chain id 99801). Returns { rpcUrl, stop }. */
export async function startAnvil({ port = 8547, blockTime, forkUrl } = {}) {
  const args = ["--chain-id", String(ELYSIUM_TESTNET_ID), "--port", String(port), "--balance", "1000000", "--silent"];
  if (blockTime) args.push("--block-time", String(blockTime));
  if (forkUrl) args.push("--fork-url", forkUrl);
  const proc = spawn("anvil", args, { env: toolEnv(), stdio: "ignore" });
  const rpcUrl = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 300; i++) {
    try {
      const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
      if (r.ok) return { rpcUrl, stop: () => proc.kill() };
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error("anvil did not start");
}

/** On a local fork only: moves `amount` of `token` from `holder` to `to` by impersonating the holder. */
export async function forkFund(rpcUrl, token, holder, to, amount) {
  const call = (method, params) => fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json());
  await call("anvil_impersonateAccount", [holder]);
  await call("anvil_setBalance", [holder, "0x3635c9adc5dea00000"]);
  const data = "0xa9059cbb" + to.slice(2).toLowerCase().padStart(64, "0") + amount.toString(16).padStart(64, "0");
  const sent = await call("eth_sendTransaction", [{ from: holder, to: token, data, gas: "0x30d40" }]);
  if (sent.error) throw new Error("fork fund: " + sent.error.message);
  const rc = await call("eth_getTransactionReceipt", [sent.result]);
  if (rc.result?.status !== "0x1") throw new Error("fork fund: transfer reverted (holder short of tokens?)");
  await call("anvil_stopImpersonatingAccount", [holder]);
}

/** Gas used per labelled action, written into the report's measurements. */
export const gasLog = [];
export async function sendAndLog(pub, label, hashPromise) {
  const hash = await hashPromise;
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${label} reverted (${hash})`);
  gasLog.push({ label, gas: Number(r.gasUsed) });
  return r;
}

/** Proof times per circuit. */
export const proofLog = [];

/** A snarkjs prover on Gloam's FINAL ceremony keys, read from the pinned repo (SDK 0.6.0 would pick dev keys on 99801). */
export async function finalProver(circuit) {
  const { proveGroth16 } = await import("@gloamtrade/sdk");
  const wasm = join(CIRCUITS, `${circuit}.wasm`);
  const zkey = join(CIRCUITS, `final/${circuit}_final.zkey`);
  if (!existsSync(zkey)) throw new Error(`missing ${zkey}`);
  return async (input) => {
    const t = performance.now();
    const out = await proveGroth16(input, wasm, zkey);
    proofLog.push({ circuit, ms: Math.round(performance.now() - t) });
    return out;
  };
}

/** A prover on Gloam's DEV keys: proofs a final-key vault must refuse. */
export async function devProver(circuit) {
  const { proveGroth16 } = await import("@gloamtrade/sdk");
  return (input) => proveGroth16(input, join(CIRCUITS, `${circuit}.wasm`), join(CIRCUITS, `${circuit}_final.zkey`));
}

/** Deploys circomlibjs's PoseidonT3 (2 inputs), the hasher Gloam's vault calls, and checks its code hash. */
export async function deployPoseidon({ pub, wallet }) {
  const { poseidonContract } = await import("circomlibjs");
  const bytecode = poseidonContract.createCode(2);
  const abi = poseidonContract.generateABI(2);
  const r = await sendAndLog(pub, "deploy PoseidonT3", wallet.deployContract({ abi, bytecode }));
  const code = await pub.getCode({ address: r.contractAddress });
  const hash = keccak256(code);
  if (!hash.startsWith(POSEIDON_T3_CODEHASH_PREFIX)) throw new Error(`PoseidonT3 code hash ${hash} is not Gloam's`);
  return r.contractAddress;
}

/** Runs a forge script from Gloam's own project root, so their contracts compile exactly as upstream. */
export function forgeGloam(scriptPath, contract, rpcUrl, env) {
  const out = execFileSync(
    "forge",
    ["script", `${scriptPath}:${contract}`, "--root", GLOAM_CONTRACTS, "--rpc-url", rpcUrl, "--broadcast", "--slow", "--offline", "-vv"],
    { env: toolEnv(env), encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] },
  );
  return out;
}

/** Pulls `label 0x...` lines out of forge's console output. */
export function addressFromLog(out, label) {
  const m = out.match(new RegExp(`\\b${label}\\s+(0x[0-9a-fA-F]{40})`));
  if (!m) throw new Error(`no ${label} in forge output`);
  return m[1];
}

/** forge build for contracts-gloam, then reads one artifact. */
let built = false;
export function ourArtifact(file, name) {
  if (!built) {
    execFileSync("forge", ["build", "--offline", "--root", OUR_CONTRACTS], { env: toolEnv(), stdio: "ignore" });
    built = true;
  }
  const j = JSON.parse(readFileSync(join(OUR_CONTRACTS, `out/${file}/${name}.json`), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object };
}

/**
 * Gloam's guarded vault (DeployCloakGloam -> MainnetDeploy._deployMainnetGuarded), then the payment-memo board.
 * `assets` is [{ address, perDeposit, total }], address 0 for native HYPE.
 */
export async function deployGloamStack({ rpcUrl, pk, poseidon, assets, feeBps = 50, feeRecipient, controller }) {
  const env = {
    DEPLOYER_PK: pk,
    POSEIDON2: poseidon,
    LIMIT_ASSETS: assets.map((a) => a.address).join(","),
    LIMIT_PER_DEPOSIT: assets.map((a) => String(a.perDeposit)).join(","),
    LIMIT_TOTAL: assets.map((a) => String(a.total)).join(","),
    WITHDRAW_FEE_BPS: String(feeBps),
    FEE_RECIPIENT: feeRecipient,
    GUARD_CONTROLLER: controller,
    GUARD_CONTROLLER_EOA: "1",
  };
  const t = performance.now();
  const out = forgeGloam(join(OUR_CONTRACTS, "gloam-root/DeployCloakGloam.s.sol"), "DeployCloakGloam", rpcUrl, env);
  if (!out.includes("Guard checks passed")) throw new Error("Gloam deploy did not pass its guard checks:\n" + out.slice(-3000));
  if (!out.includes("All checks passed")) throw new Error("Gloam deploy did not pass its key gate:\n" + out.slice(-3000));
  const pool = addressFromLog(out, "ShieldPoolPayments");
  const guard = addressFromLog(out, "VaultOwnerGuard");
  const dual = addressFromLog(out, "DualProofVerifier");
  const shieldVerifier = addressFromLog(out, "ShieldIVerifier");
  const memoOut = forgeGloam(join(GLOAM_CONTRACTS, "script/DeployGloamPayMemo.s.sol"), "DeployGloamPayMemo", rpcUrl, { DEPLOYER_PK: pk });
  const payMemo = (memoOut.match(/(0x[0-9a-fA-F]{40})/g) ?? []).pop();
  return { pool, guard, dual, shieldVerifier, payMemo, deployMs: Math.round(performance.now() - t), forgeLog: out };
}

export const POOL_ABI = parseAbi([
  "function shieldBound(address asset, uint256 amount, bytes32 commitment, bytes proof) payable",
  "function transfer(bytes proof, bytes32 root, bytes32 nullifier, bytes32[2] newCommitments)",
  "function unshield(bytes proof, bytes32 root, bytes32 nullifier, address asset, address to, uint256 amount)",
  "function collectFees(address asset)",
  "function feesOwed(address) view returns (uint256)",
  "function deposited(address) view returns (uint256)",
  "function isSpent(bytes32) view returns (bool)",
  "function currentRoot() view returns (bytes32)",
  "function withdrawFeeBps() view returns (uint16)",
  "function owner() view returns (address)",
  "function setupMode() view returns (bool)",
  "function verifier() view returns (address)",
  "function shieldVerifier() view returns (address)",
  "event Shielded(bytes32 indexed commitment, address indexed asset, uint256 amount, uint256 leafIndex, address indexed from)",
]);

export const ERC20_ABI = parseAbi([
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

/** Writes a measurement file next to the report. */
export function writeMeasurements(name, data) {
  const dir = join(REPO, "measurements");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(data, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
}

export function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok  " + msg);
}

/** Expects a promise to reject; returns the error text. */
export async function rejects(p, msg) {
  try {
    await p;
  } catch (e) {
    console.log("  ok  " + msg);
    return String(e?.shortMessage ?? e?.message ?? e);
  }
  throw new Error("FAIL (did not revert): " + msg);
}

/**
 * A fresh local Gloam stack on anvil (chain 99801): test USDC, PoseidonT3, the guarded vault and the memo board.
 * Returns everything a test needs; call stop() at the end.
 */
export async function localGloam({ port = 8547, blockTime, forkUrl } = {}) {
  const anvil = await startAnvil({ port, blockTime, forkUrl });
  const dep = clients(anvil.rpcUrl, ANVIL_KEYS[0], ELYSIUM_TESTNET_ID);
  const tok = ourArtifact("TestToken.sol", "TestToken");
  const usdc = (await sendAndLog(dep.pub, "deploy test USDC", dep.wallet.deployContract({ ...tok, args: ["Test USDC", "USDC", 6] }))).contractAddress;
  const poseidon = await deployPoseidon(dep);
  const stack = await deployGloamStack({
    rpcUrl: anvil.rpcUrl,
    pk: ANVIL_KEYS[0],
    poseidon,
    assets: [
      { address: "0x0000000000000000000000000000000000000000", perDeposit: 10n ** 21n, total: 10n ** 23n },
      { address: usdc, perDeposit: 500n * 10n ** 6n, total: 25000n * 10n ** 6n },
    ],
    feeBps: 50,
    feeRecipient: clients(anvil.rpcUrl, ANVIL_KEYS[3], ELYSIUM_TESTNET_ID).account.address,
    controller: dep.account.address,
  });
  const poolBlock = await dep.pub.getBlockNumber();
  return { ...anvil, dep, usdc, poseidon, stack, poolBlock, tok };
}
