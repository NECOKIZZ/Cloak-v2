// Part 5: the app's follow-ups on Cloak's launch vault, on Gloam's final keys, through the relay.
//   - a private launch swap (CloakLaunchSwap) whose price buffer comes back as a note on the next app open
//   - a graduation (CloakGraduation) that finishPending() moves into Gloam's vault once its round ends, where a
//     GloamCore pointed at Gloam's vault finds it
//
//   node e2e-gloam/part5-launch-auto.mjs
import { encodeFunctionData, parseAbi, parseEther, zeroAddress } from "viem";
import { GloamCore, finishPending, graduate, launchRoute, launchSwap } from "@cloakely/sdk";
import { createGloamRelay } from "../services/keeper/gloam.mjs";
import { createGloamLoop } from "../services/keeper/gloamLoop.mjs";
import { ANVIL_KEYS, ELYSIUM_TESTNET_ID, assert, clients, finalProver, localGloam, ourArtifact, rpc, sendAndLog, writeMeasurements } from "./lib.mjs";

const LV_ABI = parseAbi([
  "function setShieldVerifier(address)",
  "function setWithdrawFee(uint16 bps, address recipient)",
  "function turnOnDepositLimits()",
  "function setDepositLimit(address asset, uint128 perDeposit, uint128 total)",
  "function endSetup()",
  "function admitLaunch(uint256 launchIndex) returns (address)",
  "function deposited(address) view returns (uint256)",
]);
const FAKE_ABI = parseAbi(["function add(address auction, address token) returns (uint256)", "function settle()"]);
const TOKEN_ABI = parseAbi(["function mint(address to, uint256 amount)", "function transfer(address to, uint256 amount) returns (bool)", "function deposit() payable"]);
const PAIR_ABI = parseAbi(["function create(address a, address b) returns (address)", "function getPair(address, address) view returns (address)", "function sync()"]);

const t0 = performance.now();
const L = await localGloam({ port: 8556 });
const { rpcUrl, stack } = L;
const pub = L.dep.pub;
const who = (i) => clients(rpcUrl, ANVIL_KEYS[i], ELYSIUM_TESTNET_ID);
const [alice, keeper] = [who(1), who(8)];
const dep = L.dep.wallet;
const write = (address, abi, functionName, args = [], value) => sendAndLog(pub, functionName, dep.writeContract({ address, abi, functionName, args, value }));
const ROUND = 120n;
/** A balance by asset, whatever the address's letter case. */
const bal = (m, asset) => [...m].filter(([a]) => a.toLowerCase() === asset.toLowerCase()).reduce((x, [, v]) => x + v, 0n);
try {
  console.log("Part 5 on anvil (chain 99801): the app's follow-ups on Cloak's launch vault");
  const launch = (await sendAndLog(pub, "deploy launch token", who(5).wallet.deployContract({ ...L.tok, args: ["Launch", "LNCH", 18] }))).contractAddress;
  // Gloam lists it the only way it can after setup: through its guard's 3-day timelock (skipped forward on anvil)
  const GUARD_ABI = parseAbi(["function queueChange(bytes call) returns (bytes32, uint256)", "function executeChange(bytes call)"]);
  const listCall = encodeFunctionData({ abi: parseAbi(["function setDepositLimit(address asset, uint128 perDeposit, uint128 total)"]), functionName: "setDepositLimit", args: [launch, 10n ** 24n, 10n ** 26n] });
  await write(stack.guard, GUARD_ABI, "queueChange", [listCall]);
  await rpc(rpcUrl, "evm_increaseTime", [3 * 86_400 + 1]);
  await rpc(rpcUrl, "evm_mine");
  await write(stack.guard, GUARD_ABI, "executeChange", [listCall]);

  // a settled launch, with a WHYPE/launch V2 pool at 1 HYPE = 1000 tokens
  const auction = (await sendAndLog(pub, "deploy auction", dep.deployContract({ ...ourArtifact("CloakLaunchVault.t.sol", "FakeAuction") }))).contractAddress;
  const factory = (await sendAndLog(pub, "deploy factory", dep.deployContract({ ...ourArtifact("CloakLaunchVault.t.sol", "FakeFactory") }))).contractAddress;
  await write(factory, FAKE_ABI, "add", [auction, launch]);
  await write(auction, FAKE_ABI, "settle");
  const weth = (await sendAndLog(pub, "deploy WHYPE", dep.deployContract({ ...ourArtifact("CloakV2PairSwap.t.sol", "WETH9") }))).contractAddress;
  const v2 = (await sendAndLog(pub, "deploy V2 factory", dep.deployContract({ ...ourArtifact("CloakV2PairSwap.t.sol", "V2Factory") }))).contractAddress;
  await write(v2, PAIR_ABI, "create", [weth, launch]);
  const pair = await pub.readContract({ address: v2, abi: PAIR_ABI, functionName: "getPair", args: [weth, launch] });
  await write(weth, TOKEN_ABI, "deposit", [], parseEther("100"));
  await write(weth, TOKEN_ABI, "transfer", [pair, parseEther("100")]);
  await sendAndLog(pub, "mint", who(5).wallet.writeContract({ address: launch, abi: TOKEN_ABI, functionName: "mint", args: [pair, parseEther("100000")] }));
  await write(pair, PAIR_ABI, "sync");

  // Cloak's launch vault on Gloam's final-key verifiers, its swap router and the graduation escrow
  const lv = (await sendAndLog(pub, "deploy CloakLaunchVault", dep.deployContract({ ...ourArtifact("CloakLaunchVault.sol", "CloakLaunchVault"), args: [L.poseidon, stack.dual, factory, 10n ** 24n, 10n ** 26n] }))).contractAddress;
  await write(lv, LV_ABI, "setShieldVerifier", [stack.shieldVerifier]);
  await write(lv, LV_ABI, "setWithdrawFee", [50, keeper.account.address]);
  await write(lv, LV_ABI, "turnOnDepositLimits");
  await write(lv, LV_ABI, "setDepositLimit", [zeroAddress, 10n ** 21n, 10n ** 23n]);
  await write(lv, LV_ABI, "endSetup");
  const router = (await sendAndLog(pub, "deploy CloakLaunchSwap", dep.deployContract({ ...ourArtifact("CloakLaunchSwap.sol", "CloakLaunchSwap"), args: [lv, v2, weth] }))).contractAddress;
  const graduation = (await sendAndLog(pub, "deploy CloakGraduation", dep.deployContract({ ...ourArtifact("CloakGraduation.sol", "CloakGraduation"), args: [lv, stack.pool, ROUND] }))).contractAddress;
  const batcher = (await sendAndLog(pub, "deploy CloakGloamBatcher", dep.deployContract({ ...ourArtifact("CloakGloamBatcher.sol", "CloakGloamBatcher"), args: [lv, v2, weth, ROUND, 200n, 600n] }))).contractAddress;
  const lvBlock = await pub.getBlockNumber();

  // the keeper's loop admits the settled launch: nobody had to ask
  const loop = createGloamLoop({ publicClient: pub, account: keeper.account, send: async (call) => (await sendAndLog(pub, call.functionName, keeper.wallet.writeContract(call))).transactionHash, launchVault: lv, batcher, batcherBlock: lvBlock, log: (m) => console.log("  " + m) });
  const t1 = await loop.tick();
  assert(t1.admitted.length === 1 && t1.admitted[0].token.toLowerCase() === launch.toLowerCase() && !t1.errors.length, "the keeper loop admitted the settled launch to the launch vault");
  assert((await loop.tick()).admitted.length === 0, "and does nothing the second time");

  const relay = createGloamRelay({ publicClient: pub, walletClient: keeper.wallet, vault: stack.pool, launchVault: lv, memoBoard: stack.payMemo, escrows: [router, graduation, batcher], hourlySpendWei: parseEther("1"), log: (m) => console.log("  " + m) });
  const submit = (call) => relay({ kind: call.kind, to: call.to, data: call.data });
  const provers = { shield: await finalProver("shield"), transfer: await finalProver("transfer"), unshield: await finalProver("unshield") };
  const A = await GloamCore.unlock(alice.wallet, { publicClient: pub, chainId: ELYSIUM_TESTNET_ID, pool: lv, poolBlock: lvBlock, payMemo: stack.payMemo, provers, submit });
  await A.shield(alice.wallet, zeroAddress, parseEther("5"));
  await A.sync();

  // 1. a private swap: 2 HYPE for exactly 1000 tokens, the buffer owed back
  const now = async () => (await pub.getBlock()).timestamp;
  const swapRec = await launchSwap(A, { router, route: launchRoute([weth, launch]), assetIn: zeroAddress, amountIn: parseEther("2"), assetOut: launch, amountOut: parseEther("1000"), deadline: (await now()) + 600n });
  await A.sync();
  assert(bal(await A.balances(), launch) === parseEther("1000"), "the swap's 1000 tokens are a note in the launch vault");
  const hypeBefore = (await A.balances()).get(zeroAddress) ?? 0n;

  // 2. the next app open takes the buffer back as a note
  let records = [swapRec];
  let res = await finishPending(A, records);
  assert(res.done.length === 1 && res.errors.length === 0, `finishPending finished the swap: ${res.done[0]?.outcome}`);
  await A.sync();
  const buffer = ((await A.balances()).get(zeroAddress) ?? 0n) - hypeBefore;
  assert(buffer > parseEther("0.9"), `the price buffer came back privately (${buffer} wei of HYPE), where Gloam's base would send it to a treasury`);

  // 3. graduation: 1000 tokens enter a round; finishPending waits for the round, then moves them into Gloam's vault
  const gradRec = await graduate(A, { graduation, token: launch, size: parseEther("1000"), fallbackTo: alice.account.address });
  records = [gradRec];
  res = await finishPending(A, records, { minRoundEntries: 1n });
  assert(res.waiting.length === 1 && res.done.length === 0, "before the round ends the graduation waits");
  await rpc(rpcUrl, "evm_increaseTime", [Number(ROUND) + 1]);
  await rpc(rpcUrl, "evm_mine");
  res = await finishPending(A, records, { minRoundEntries: 1n });
  assert(res.done.length === 1 && res.errors.length === 0, `after it, finishPending moves it: ${res.done[0]?.outcome}`);

  const G = await GloamCore.unlock(alice.wallet, { publicClient: pub, chainId: ELYSIUM_TESTNET_ID, pool: stack.pool, poolBlock: L.poolBlock, payMemo: stack.payMemo, provers, submit });
  await G.sync();
  assert(bal(await G.balances(), launch) === parseEther("995"), "the same account sees 995 tokens in Gloam's vault (1000 less the launch vault's 0.5%)");
  await A.sync();
  assert(bal(await A.balances(), launch) === 0n, "and none left in the launch vault");

  // 4. the graduated note is spendable in Gloam's vault
  await G.withdraw(launch, alice.account.address, parseEther("995"));
  await G.sync();
  assert(bal(await G.balances(), launch) === 0n, "and cashes out of Gloam's vault with a final-key proof");

  // 5. a batch round the keeper loop settles: one private buy order of 1 HYPE
  const BATCH_ABI = parseAbi([
    "function place((bytes proof, bytes32 root, bytes32 nullifier, address asset, uint256 amount) s, (bytes32 nullifier, address token, bool buy, uint128 size, address ownerKey, address fallbackTo) k) returns (bytes32)",
    "function escrowFor((bytes32 nullifier, address token, bool buy, uint128 size, address ownerKey, address fallbackTo) k) view returns (address)",
    "function batches(address, uint64) view returns (uint128, uint128, uint128, uint128, uint256, uint64, bool settled, bool cancelled)",
    "function currentRound() view returns (uint64)",
  ]);
  const note = await A.exactNote(zeroAddress, parseEther("1"));
  const nullifier = `0x${note.nullifier.toString(16).padStart(64, "0")}`;
  const k = { nullifier, token: launch, buy: true, size: parseEther("1"), ownerKey: alice.account.address, fallbackTo: alice.account.address };
  const escrow = await pub.readContract({ address: batcher, abi: BATCH_ABI, functionName: "escrowFor", args: [k] });
  const s = await A.spendProof(note, escrow);
  const round = await pub.readContract({ address: batcher, abi: BATCH_ABI, functionName: "currentRound" });
  await relay({ to: batcher, data: encodeFunctionData({ abi: BATCH_ABI, functionName: "place", args: [s, k] }) });
  assert((await loop.tick()).rounds.length === 0, "the loop leaves a round alone until it ends");
  await rpc(rpcUrl, "evm_increaseTime", [Number(ROUND) + 1]);
  await rpc(rpcUrl, "evm_mine");
  const t2 = await loop.tick();
  assert(t2.rounds.length === 1 && t2.rounds[0].action === "settled", "once it ends, the keeper loop settles the batch round");
  const b = await pub.readContract({ address: batcher, abi: BATCH_ABI, functionName: "batches", args: [launch, round] });
  assert(b[6] === true, "and the round is settled on chain");

  writeMeasurements("part5-launch-auto", { bufferBackWei: buffer.toString(), seconds: Math.round((performance.now() - t0) / 1000) });
  console.log(`\nPart 5 passed in ${Math.round((performance.now() - t0) / 1000)} s`);
} finally {
  L.stop();
}
process.exit(0);
