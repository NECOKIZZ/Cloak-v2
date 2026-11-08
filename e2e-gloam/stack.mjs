// Deploys the whole Cloak v2 on Gloam stack for a run: Gloam's guarded vault and memo board (Cloak's instance, HYPE
// and a test launch token listed at deploy), CloakLaunchVault on the same final-key verifiers, CloakLaunchSwap with a
// V2 pool stand-in, CloakGraduation, CloakGloamBatcher, CloakFundsGate, CloakReceiptCheck. The launch is a stand-in
// (FakeFactory and FakeAuction). Used by live-elysium.mjs (live and --anvil) and part7-adapter.mjs.
import { parseAbi, parseEther, zeroAddress } from "viem";
import { deployGloamStack, deployPoseidon, ourArtifact, sendAndLog } from "./lib.mjs";

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
]);

/**
 * @param me clients() for the funded deployer, who is also every fee recipient and the guard's controller
 * @param seed { hype, tokens }: what the V2 pool starts with (default 0.2 HYPE and 200 tokens: 1 HYPE = 1000 tokens)
 * @param roundSecs graduation and batch rounds
 */
export async function deployCloakGloam({ me, rpcUrl, pk, seed = { hype: parseEther("0.2"), tokens: parseEther("200") }, roundSecs = 60n }) {
  const pub = me.pub;
  const wallet = me.wallet;
  const addr = me.account.address;
  const write = (address, abi, functionName, args = [], value) => sendAndLog(pub, functionName, wallet.writeContract({ address, abi, functionName, args, value }));
  const deploy = async (label, art, args = []) => (await sendAndLog(pub, `deploy ${label}`, wallet.deployContract({ ...art, args }))).contractAddress;

  const tok = ourArtifact("TestToken.sol", "TestToken");
  const launch = await deploy("launch token", tok, ["Cloak Live Test", "CLT", 18]);
  const poseidon = await deployPoseidon(me);
  const stack = await deployGloamStack({
    rpcUrl,
    pk,
    poseidon,
    assets: [
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

  const lv = await deploy("CloakLaunchVault", ourArtifact("CloakLaunchVault.sol", "CloakLaunchVault"), [poseidon, stack.dual, factory, parseEther("1000000"), parseEther("100000000")]);
  await write(lv, LV_ABI, "setShieldVerifier", [stack.shieldVerifier]);
  await write(lv, LV_ABI, "setWithdrawFee", [50, addr]);
  await write(lv, LV_ABI, "turnOnDepositLimits");
  await write(lv, LV_ABI, "setDepositLimit", [zeroAddress, parseEther("10"), parseEther("100")]);
  await write(lv, LV_ABI, "endSetup");
  const router = await deploy("CloakLaunchSwap", ourArtifact("CloakLaunchSwap.sol", "CloakLaunchSwap"), [lv, v2, weth]);
  const graduation = await deploy("CloakGraduation", ourArtifact("CloakGraduation.sol", "CloakGraduation"), [lv, stack.pool, roundSecs]);
  const batcher = await deploy("CloakGloamBatcher", ourArtifact("CloakGloamBatcher.sol", "CloakGloamBatcher"), [lv, v2, weth, roundSecs, 200n, 600n]);
  const fv = await deploy("GloamFundsVerifierFinal", ourArtifact("GloamFundsVerifierFinal.sol", "GloamFundsVerifierFinal"));
  const rv = await deploy("GloamReceiptVerifierFinal", ourArtifact("GloamReceiptVerifierFinal.sol", "GloamReceiptVerifierFinal"));
  const gate = await deploy("CloakFundsGate", ourArtifact("CloakFundsGate.sol", "CloakFundsGate"), [fv, stack.pool, lv]);
  const receipts = await deploy("CloakReceiptCheck", ourArtifact("CloakReceiptCheck.sol", "CloakReceiptCheck"), [rv, stack.pool, lv]);
  const block = await pub.getBlockNumber();
  const contracts = { gloamVault: stack.pool, guard: stack.guard, memoBoard: stack.payMemo, poseidon, dual: stack.dual, shieldVerifier: stack.shieldVerifier, launchVault: lv, launchSwap: router, graduation, batcher, fundsGate: gate, receiptCheck: receipts, fundsVerifier: fv, receiptVerifier: rv, launchToken: launch, factoryStandIn: factory, auctionStandIn: auction, whypeStandIn: weth, v2FactoryStandIn: v2, pair };
  return { contracts, block, stack };
}
