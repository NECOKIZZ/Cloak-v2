// Deploys the whole Cloak v2 on Gloam stack for a run: Gloam's guarded vault and memo board (Cloak's instance, HYPE
// and a test launch token listed at deploy), CloakLaunchVault on the same final-key verifiers, CloakLaunchSwap with a
// V2 pool stand-in, CloakGraduation, CloakGloamBatcher, CloakFundsGate, CloakReceiptCheck. The launch is a stand-in
// (FakeFactory and FakeAuction). Used by live-elysium.mjs (live and --anvil) and part7-adapter.mjs.
import { encodeFunctionData, parseAbi, parseEther, zeroAddress } from "viem";
import { deployGloamStack, deployPoseidon, gloamArtifact, ourArtifact, sendAndLog } from "./lib.mjs";

const FAKE_ABI = parseAbi(["function add(address auction, address token) returns (uint256)", "function settle()"]);
const TOKEN_ABI = parseAbi(["function mint(address to, uint256 amount)", "function transfer(address to, uint256 amount) returns (bool)", "function deposit() payable"]);
const PAIR_ABI = parseAbi(["function create(address a, address b) returns (address)", "function getPair(address, address) view returns (address)", "function sync()"]);
export const LV_ABI = parseAbi([
  "function setShieldVerifier(address)",
  "function setWithdrawFee(uint16 bps, address recipient)",
  "function turnOnDepositLimits()",
  "function setDepositLimit(address asset, uint128 perDeposit, uint128 total)",
  "function endSetup()",
  "function feesOwed(address) view returns (uint256)",
  "function transferOwnership(address)",
]);

const READS = parseAbi([
  "function owner() view returns (address)",
  "function setupMode() view returns (bool)",
  "function verifier() view returns (address)",
  "function shieldVerifier() view returns (address)",
  "function withdrawFeeBps() view returns (uint16)",
  "function feeRecipient() view returns (address)",
  "function depositLimitsOn() view returns (bool)",
  "function factory() view returns (address)",
  "function launchPauser() view returns (address)",
  "function launchPerDeposit() view returns (uint128)",
  "function launchTotal() view returns (uint128)",
  "function sealedSwapVerifier() view returns (address)",
  "function vault() view returns (address)",
  "function controller() view returns (address)",
]);

/** Reads every setting of a deployed launch vault back, as Gloam's guarded deploy reads theirs. Throws on a mismatch. */
export async function checkLaunchVault(pub, lv, want) {
  const r = (address, functionName) => pub.readContract({ address, abi: READS, functionName });
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  const checks = [
    ["owned by its guard", same(await r(lv, "owner"), want.guard)],
    ["the guard guards this vault", same(await r(want.guard, "vault"), lv)],
    ["setup has ended", (await r(lv, "setupMode")) === false],
    ["Gloam's final-key verifier", same(await r(lv, "verifier"), want.dual)],
    ["Gloam's final-key shield verifier", same(await r(lv, "shieldVerifier"), want.shieldVerifier)],
    ["no sealed swap", same(await r(lv, "sealedSwapVerifier"), zeroAddress)],
    ["deposit limits on", (await r(lv, "depositLimitsOn")) === true],
    ["0.5% fee", Number(await r(lv, "withdrawFeeBps")) === 50],
    ["fee to Cloak", same(await r(lv, "feeRecipient"), want.feeRecipient)],
    ["Cloak's factory", same(await r(lv, "factory"), want.factory)],
    ["the launch pauser", same(await r(lv, "launchPauser"), want.pauser)],
    ["launch caps", (await r(lv, "launchPerDeposit")) === want.caps[0] && (await r(lv, "launchTotal")) === want.caps[1]],
  ];
  const bad = checks.filter(([, ok]) => !ok).map(([n]) => n);
  if (bad.length) throw new Error(`launch vault read-back failed: ${bad.join(", ")}`);
  return checks.length;
}

/**
 * @param gloamAssets what Cloak's instance of Gloam's vault lists:
 *   "realistic" (default): as Gloam's Elysium vault will, USDC only at their mainnet caps (500 per deposit, 25,000 in
 *     total), and the launch token listed later through the guard's 3-day timelock (`warp` moves the clock on anvil);
 *   "open": HYPE and the launch token listed at deploy, for the live testnet run, which can't wait 3 days.
 * @param warp (seconds) => moves the chain's clock (anvil); without it a realistic listing is only queued
 * @param me clients() for the funded deployer, who is also every fee recipient and the guard's controller
 * @param seed { hype, tokens }: what the V2 pool starts with (default 0.2 HYPE and 200 tokens: 1 HYPE = 1000 tokens)
 * @param roundSecs graduation and batch rounds
 */
export async function deployCloakGloam({ me, rpcUrl, pk, seed = { hype: parseEther("0.2"), tokens: parseEther("200") }, roundSecs = 60n, gloamAssets = "realistic", warp, pauser }) {
  pauser ??= me.account.address; // the launch pauser (Cloak's multisig in production)
  const pub = me.pub;
  const wallet = me.wallet;
  const addr = me.account.address;
  const write = (address, abi, functionName, args = [], value) => sendAndLog(pub, functionName, wallet.writeContract({ address, abi, functionName, args, value }));
  const deploy = async (label, art, args = []) => (await sendAndLog(pub, `deploy ${label}`, wallet.deployContract({ ...art, args }))).contractAddress;

  const tok = ourArtifact("TestToken.sol", "TestToken");
  const launch = await deploy("launch token", tok, ["Cloak Live Test", "CLT", 18]);
  const poseidon = await deployPoseidon(me);
  const realistic = gloamAssets === "realistic";
  const usdc = realistic ? await deploy("test USDC", tok, ["Test USDC", "USDC", 6]) : null;
  const stack = await deployGloamStack({
    rpcUrl,
    pk,
    poseidon,
    assets: realistic
      ? [{ address: usdc, perDeposit: 500n * 10n ** 6n, total: 25_000n * 10n ** 6n }]
      : [
          { address: zeroAddress, perDeposit: parseEther("10"), total: parseEther("100") },
          { address: launch, perDeposit: parseEther("1000000"), total: parseEther("100000000") },
        ],
    feeBps: 50,
    feeRecipient: addr,
    controller: addr,
  });
  const auction = await deploy("auction stand-in", ourArtifact("CloakLaunchVault.t.sol", "FakeAuction"));
  const factory = await deploy("factory stand-in", ourArtifact("CloakLaunchVault.t.sol", "FakeFactory"));
  await write(factory, FAKE_ABI, "add", [auction, launch]);
  await write(auction, FAKE_ABI, "settle");
  const weth = await deploy("WHYPE stand-in", ourArtifact("CloakV2PairSwap.t.sol", "WETH9"));
  const v2 = await deploy("V2 factory stand-in", ourArtifact("CloakV2PairSwap.t.sol", "V2Factory"));
  await write(v2, PAIR_ABI, "create", [weth, launch]);
  const pair = await pub.readContract({ address: v2, abi: PAIR_ABI, functionName: "getPair", args: [weth, launch] });
  await write(weth, TOKEN_ABI, "deposit", [], seed.hype);
  await write(weth, TOKEN_ABI, "transfer", [pair, seed.hype]);
  await write(launch, TOKEN_ABI, "mint", [pair, seed.tokens]);
  await write(pair, PAIR_ABI, "sync");

  // Cloak's launch vault, deployed the way Gloam's guarded deploy deploys their vault (MainnetDeploy._deployMainnetGuarded,
  // which is hardcoded to ShieldPoolPayments): the same final-key verifiers, setup, end of setup, ownership handed to a
  // VaultOwnerGuard and accepted by its controller, then every setting read back
  const lvCaps = [parseEther("1000000"), parseEther("100000000")];
  const lv = await deploy("CloakLaunchVault", ourArtifact("CloakLaunchVault.sol", "CloakLaunchVault"), [poseidon, stack.dual, factory, ...lvCaps, pauser]);
  await write(lv, LV_ABI, "setShieldVerifier", [stack.shieldVerifier]);
  await write(lv, LV_ABI, "setWithdrawFee", [50, addr]);
  await write(lv, LV_ABI, "turnOnDepositLimits");
  await write(lv, LV_ABI, "setDepositLimit", [zeroAddress, parseEther("10"), parseEther("100")]);
  await write(lv, LV_ABI, "endSetup");
  const guardArt = gloamArtifact("VaultOwnerGuard.sol", "VaultOwnerGuard");
  const lvGuard = await deploy("VaultOwnerGuard for the launch vault", guardArt, [lv, addr]);
  await write(lv, LV_ABI, "transferOwnership", [lvGuard]);
  await write(lvGuard, guardArt.abi, "acceptVaultOwnership");
  await checkLaunchVault(pub, lv, { guard: lvGuard, dual: stack.dual, shieldVerifier: stack.shieldVerifier, factory, feeRecipient: addr, pauser, caps: lvCaps });
  const router = await deploy("CloakLaunchSwap", ourArtifact("CloakLaunchSwap.sol", "CloakLaunchSwap"), [lv, v2, weth]);
  const graduation = await deploy("CloakGraduation", ourArtifact("CloakGraduation.sol", "CloakGraduation"), [lv, stack.pool, roundSecs]);
  const batcher = await deploy("CloakGloamBatcher", ourArtifact("CloakGloamBatcher.sol", "CloakGloamBatcher"), [lv, v2, weth, roundSecs, 200n, 600n]);
  const fv = await deploy("GloamFundsVerifierFinal", ourArtifact("GloamFundsVerifierFinal.sol", "GloamFundsVerifierFinal"));
  const rv = await deploy("GloamReceiptVerifierFinal", ourArtifact("GloamReceiptVerifierFinal.sol", "GloamReceiptVerifierFinal"));
  const gate = await deploy("CloakFundsGate", ourArtifact("CloakFundsGate.sol", "CloakFundsGate"), [fv, stack.pool, lv]);
  const receive = await deploy("CloakGloamReceive", ourArtifact("CloakGloamReceive.sol", "CloakGloamReceive"), [stack.pool, lv]);
  const receipts = await deploy("CloakReceiptCheck", ourArtifact("CloakReceiptCheck.sol", "CloakReceiptCheck"), [rv, stack.pool, lv]);
  // realistic: Gloam lists the launch token the only way it can after setup, through the guard's 3-day timelock
  let listing = null;
  if (realistic) {
    const GUARD_ABI = parseAbi(["function queueChange(bytes call) returns (bytes32, uint256)", "function executeChange(bytes call)"]);
    const call = encodeFunctionData({ abi: parseAbi(["function setDepositLimit(address asset, uint128 perDeposit, uint128 total)"]), functionName: "setDepositLimit", args: [launch, parseEther("1000000"), parseEther("100000000")] });
    await write(stack.guard, GUARD_ABI, "queueChange", [call]);
    listing = { queued: true, listed: false };
    if (warp) {
      await warp(3 * 86_400 + 1);
      await write(stack.guard, GUARD_ABI, "executeChange", [call]);
      listing.listed = true;
    }
  }
  const block = await pub.getBlockNumber();
  const contracts = { usdc, launchVaultGuard: lvGuard, gloamVault: stack.pool, guard: stack.guard, memoBoard: stack.payMemo, poseidon, dual: stack.dual, shieldVerifier: stack.shieldVerifier, launchVault: lv, launchSwap: router, receive, graduation, batcher, fundsGate: gate, receiptCheck: receipts, fundsVerifier: fv, receiptVerifier: rv, launchToken: launch, factoryStandIn: factory, auctionStandIn: auction, whypeStandIn: weth, v2FactoryStandIn: v2, pair };
  return { contracts, block, stack, listing };
}
