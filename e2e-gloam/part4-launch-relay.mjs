// Part 4: Cloak's launch vault (CloakLaunchVault) on Gloam's real final verifiers, driven by GloamCore through the
// keeper's relay, and the relay paid from the launch vault's fee.
//
//   node e2e-gloam/part4-launch-relay.mjs
import { encodeFunctionData, parseAbi, parseAbiItem, parseEther, zeroAddress } from "viem";
import { GloamCore } from "@cloakely/sdk";
import { createGloamRelay } from "../services/keeper/gloam.mjs";
import { ANVIL_KEYS, ELYSIUM_TESTNET_ID, assert, clients, finalProver, localGloam, ourArtifact, sendAndLog, writeMeasurements } from "./lib.mjs";

const LV_ABI = parseAbi([
  "function setShieldVerifier(address)",
  "function setWithdrawFee(uint16 bps, address recipient)",
  "function turnOnDepositLimits()",
  "function setDepositLimit(address asset, uint128 perDeposit, uint128 total)",
  "function endSetup()",
  "function admitLaunch(uint256 launchIndex) returns (address)",
  "function isLaunchToken(address) view returns (bool)",
  "function feesOwed(address) view returns (uint256)",
  "function deposited(address) view returns (uint256)",
  "function setupMode() view returns (bool)",
]);
/** The relay's refusal, with its HTTP status. */
async function refused(p, msg) {
  try {
    await p;
  } catch (e) {
    console.log(`  ok  ${msg} (${e.status} ${e.message})`);
    return e;
  }
  throw new Error("FAIL (not refused): " + msg);
}
const FAKE_ABI = parseAbi(["function add(address auction, address token) returns (uint256)", "function settle()"]);

const t0 = performance.now();
const L = await localGloam({ port: 8555 });
const { rpcUrl, stack } = L;
const pub = L.dep.pub;
const who = (i) => clients(rpcUrl, ANVIL_KEYS[i], ELYSIUM_TESTNET_ID);
const [alice, bob, keeper] = [who(1), who(2), who(8)];
const dep = L.dep.wallet;
const write = (address, abi, functionName, args = []) => sendAndLog(pub, functionName, dep.writeContract({ address, abi, functionName, args }));
try {
  console.log("Part 4 on anvil (chain 99801): Cloak's launch vault on Gloam's final verifiers, through the relay");

  // a settled Cloak launch (stand-ins for CloakFactory and CloakAuction, the same launches() and settled())
  const launch = (await sendAndLog(pub, "deploy launch token", dep.deployContract({ ...L.tok, args: ["Launch", "LNCH", 18] }))).contractAddress;
  const auction = (await sendAndLog(pub, "deploy auction", dep.deployContract({ ...ourArtifact("CloakLaunchVault.t.sol", "FakeAuction") }))).contractAddress;
  const factory = (await sendAndLog(pub, "deploy factory", dep.deployContract({ ...ourArtifact("CloakLaunchVault.t.sol", "FakeFactory") }))).contractAddress;
  await write(factory, FAKE_ABI, "add", [auction, launch]);
  await write(auction, FAKE_ABI, "settle");

  // Cloak's launch vault, wired to the same final-key verifiers Gloam's deploy made (stateless, so shared)
  const lvArt = ourArtifact("CloakLaunchVault.sol", "CloakLaunchVault");
  const lv = (await sendAndLog(pub, "deploy CloakLaunchVault", dep.deployContract({ ...lvArt, args: [L.poseidon, stack.dual, factory, 10n ** 24n, 10n ** 26n, zeroAddress] }))).contractAddress;
  await write(lv, LV_ABI, "setShieldVerifier", [stack.shieldVerifier]);
  await write(lv, LV_ABI, "setWithdrawFee", [50, keeper.account.address]); // Cloak's fee, paid to the relay's wallet
  await write(lv, LV_ABI, "turnOnDepositLimits");
  await write(lv, LV_ABI, "setDepositLimit", [zeroAddress, 10n ** 21n, 10n ** 23n]); // HYPE, listed in setup
  await write(lv, LV_ABI, "endSetup");
  assert(!(await pub.readContract({ address: lv, abi: LV_ABI, functionName: "setupMode" })), "setup ended: from here every change waits 3 days");
  await sendAndLog(pub, "admitLaunch", bob.wallet.writeContract({ address: lv, abi: LV_ABI, functionName: "admitLaunch", args: [0n] }));
  assert(await pub.readContract({ address: lv, abi: LV_ABI, functionName: "isLaunchToken", args: [launch] }), "anyone admits a settled launch at once");
  const lvBlock = await pub.getBlockNumber();

  const relay = createGloamRelay({
    publicClient: pub,
    walletClient: keeper.wallet,
    vault: stack.pool,
    launchVault: lv,
    memoBoard: stack.payMemo,
    hourlySpendWei: parseEther("1"),
    feeCollectWei: parseEther("0.004"),
    log: (m) => console.log("  " + m),
  });
  const submit = (call) => relay({ kind: call.kind, to: call.to, data: call.data });
  const provers = { shield: await finalProver("shield"), transfer: await finalProver("transfer"), unshield: await finalProver("unshield") };
  const cfg = { publicClient: pub, chainId: ELYSIUM_TESTNET_ID, pool: lv, poolBlock: lvBlock, payMemo: stack.payMemo, provers, submit };
  const A = await GloamCore.unlock(alice.wallet, cfg);
  const B = await GloamCore.unlock(bob.wallet, cfg);

  // 1. Gloam's SDK and final keys work unchanged on Cloak's vault
  await A.shield(alice.wallet, zeroAddress, parseEther("3"));
  await A.sync();
  assert((await A.balances()).get(zeroAddress) === parseEther("3"), "a deposit into Cloak's launch vault with a final-key shield proof");
  const sent = await A.send(zeroAddress, await B.address(), parseEther("1"));
  const tx = await pub.getTransaction({ hash: sent.txHashes[0] });
  assert(tx.from.toLowerCase() === keeper.account.address.toLowerCase(), "a private send in the launch vault, sent by the relay");
  await B.sync();
  assert((await B.balances()).get(zeroAddress) === parseEther("1"), "Bob's sweep goes through, on final-key transfer proofs");
  const bobWallet = bob.account.address;
  const beforeBob = await pub.getBalance({ address: bobWallet });
  await B.withdraw(zeroAddress, bobWallet, parseEther("1"));
  const gotBob = (await pub.getBalance({ address: bobWallet })) - beforeBob;
  assert(gotBob === parseEther("0.995"), `a relayed cash out pays Bob 0.995 HYPE (got ${gotBob}), Bob pays no gas`);
  const owed = await pub.readContract({ address: lv, abi: LV_ABI, functionName: "feesOwed", args: [zeroAddress] });
  assert(owed === parseEther("0.005"), "the launch vault holds Cloak's 0.5% fee");

  // 2. memos only for payments in a served vault, once each
  const memoLogs = await pub.getLogs({ address: stack.payMemo, event: parseAbiItem("event PaymentMemo(bytes32 indexed paymentCommitment, bytes memo)"), fromBlock: lvBlock });
  assert(memoLogs.length >= 1, "the send's memo went through the relay");
  const memo = (c) => encodeFunctionData({ abi: parseAbi(["function postMemo(bytes32,bytes)"]), functionName: "postMemo", args: [c, "0x" + "ab".repeat(64)] });
  const e1 = await refused(relay({ to: stack.payMemo, data: memo(memoLogs[0].args.paymentCommitment) }), "a second memo for the same payment is refused");
  assert(e1.status === 409, "with 409");
  const e2 = await refused(relay({ to: stack.payMemo, data: memo("0x" + "77".repeat(32)) }), "a memo for a payment in no served vault is refused");
  assert(e2.status === 400, "with 400, so memo spam costs the relay nothing");

  // 3. paid from the fee: a relay whose base budget is spent still serves the launch vault from fee income
  const broke = createGloamRelay({ publicClient: pub, walletClient: keeper.wallet, vault: stack.pool, launchVault: lv, memoBoard: stack.payMemo, hourlySpendWei: 0n, feeCollectWei: parseEther("0.004"), log: (m) => console.log("  " + m) });
  const cfgBroke = { ...cfg, submit: (call) => broke({ kind: call.kind, to: call.to, data: call.data }) };
  const A2 = await GloamCore.unlock(alice.wallet, cfgBroke);
  await A2.sync();
  const keeperBefore = await pub.getBalance({ address: keeper.account.address });
  await A2.send(zeroAddress, await B.address(), parseEther("0.5"));
  const st = broke.stats();
  assert(st.feeIncomeWei > 0n && st.feeSpentWei > 0n, `the relay collected the launch vault's fee (${st.feeIncomeWei} wei after gas) and paid the send from it (${st.feeSpentWei} wei)`);
  assert(st.baseSpentWei === 0n, "and spent none of its own budget");
  const keeperAfter = await pub.getBalance({ address: keeper.account.address });
  console.log(`  keeper wallet change over the fee-paid send: ${keeperAfter - keeperBefore} wei (fees in minus gas out)`);
  const unshield = encodeFunctionData({ abi: parseAbi(["function unshield(bytes proof, bytes32 root, bytes32 nullifier, address asset, address to, uint256 amount)"]), functionName: "unshield", args: ["0x" + "11".repeat(256), await pub.readContract({ address: stack.pool, abi: parseAbi(["function currentRoot() view returns (bytes32)"]), functionName: "currentRoot" }), "0x" + "33".repeat(32), zeroAddress, alice.account.address, 1n] });
  const e3 = await refused(broke({ to: stack.pool, data: unshield }), "a call to Gloam's vault can't use Cloak's fee income");
  assert(e3.status === 429, "it answers 429 once the base budget is spent");

  writeMeasurements("part4-launch-relay", { feeOwedAfterCashOut: owed.toString(), feeIncomeWei: st.feeIncomeWei.toString(), feeSpentWei: st.feeSpentWei.toString(), seconds: Math.round((performance.now() - t0) / 1000) });
  console.log(`\nPart 4 passed in ${Math.round((performance.now() - t0) / 1000)} s`);
} finally {
  L.stop();
}
process.exit(0);
