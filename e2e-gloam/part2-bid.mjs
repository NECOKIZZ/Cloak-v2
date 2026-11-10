// Part 2c: a sealed bid on a real Cloak launch, paid from a Gloam private balance, on a local fork of Elysium testnet.
//
//   NODE_USE_ENV_PROXY=1 node e2e-gloam/part2-bid.mjs     (the drand beacon is read over the network)
//
// Cloak's live v4 launch factory on the fork creates a launch; the launch token is queued for listing in the vault in
// the same minute (finding 3.5, option 1); Alice bids from her private balance through CloakGloamBids; the bid is
// revealed from its drand timelock and settled; three days on, the listing lands and the tokens and refund come back
// into her private balance. Checks that the auction sees only the one-time account as the bidder.
import { encodeFunctionData, parseAbi, parseEther, zeroAddress } from "viem";
import { Cloak, GloamCore, cloakAuctionAbi, drandRoundTime, deployments, gloamBid, gloamFinishBid, walletCoreSubmitter } from "@cloakely/sdk";
import { ANVIL_KEYS, ELYSIUM_TESTNET_ID, ELYSIUM_TESTNET_RPC, assert, clients, finalProver, gasLog, localGloam, ourArtifact, rpc, sendAndLog, writeMeasurements } from "./lib.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = performance.now();
const L = await localGloam({ port: 8550, forkUrl: process.env.RPC_URL ?? ELYSIUM_TESTNET_RPC });
const { rpcUrl, stack, poolBlock } = L;
const pub = L.dep.pub;
const who = (i) => clients(rpcUrl, ANVIL_KEYS[i], ELYSIUM_TESTNET_ID);
const [creatorC, alice, relayer] = [who(4), who(1), who(7)];
const fresh = who(9).account.address;
const mine = () => rpc(rpcUrl, "evm_mine");
const relaySubmit = walletCoreSubmitter(pub, relayer.wallet);
const submit = async (call) => {
  const hash = await relaySubmit(call);
  gasLog.push({ label: `relayed ${call.kind}`, gas: Number((await pub.getTransactionReceipt({ hash })).gasUsed) });
  return hash;
};
const provers = { shield: await finalProver("shield"), transfer: await finalProver("transfer"), unshield: await finalProver("unshield") };
const cfg = { publicClient: pub, chainId: ELYSIUM_TESTNET_ID, pool: stack.pool, poolBlock, payMemo: stack.payMemo, provers, submit };
const sum = (m, a) => m.get(a) ?? 0n;
const GUARD_ABI = parseAbi(["function queueChange(bytes call) returns (bytes32, uint256)", "function executeChange(bytes call)"]);
const SET_LIMIT = parseAbi(["function setDepositLimit(address asset, uint128 perDeposit, uint128 total)"]);
const waitChainTime = async (t) => {
  for (;;) {
    const b = await pub.getBlock();
    if (Number(b.timestamp) >= t) return;
    await mine();
    await sleep(1000);
  }
};

try {
  console.log("Part 2c on a fork of Elysium testnet: a private bid on a real Cloak launch");
  const bidsArt = ourArtifact("CloakGloamBids.sol", "CloakGloamBids");
  const BIDS = (await sendAndLog(pub, "deploy CloakGloamBids", L.dep.wallet.deployContract({ ...bidsArt, args: [stack.pool, zeroAddress] }))).contractAddress;

  // a launch on Cloak's live v4 factory (on the fork)
  const creator = new Cloak(pub, creatorC.wallet, deployments[99801].factory);
  const now = Number((await pub.getBlock()).timestamp);
  const unit = 10n ** 9n;
  const l = await creator.createLaunch({ name: "Gloam Test", symbol: "GTEST", saleSupply: 1_000_000n * 10n ** 18n, minPrice: unit, tickSize: unit, numTicks: 50, commitEnd: now + 40, revealEnd: now + 340, lpBps: 8000 }); // v2's factory needs a reveal window of 5 minutes or more
  console.log("  launch", l.auction, "token", l.token);

  // queue the token's listing at once: it can land 3 days later, after settlement
  const listCall = encodeFunctionData({ abi: SET_LIMIT, functionName: "setDepositLimit", args: [l.token, 10n ** 30n, 10n ** 32n] });
  await sendAndLog(pub, "queue listing (guard)", L.dep.wallet.writeContract({ address: stack.guard, abi: GUARD_ABI, functionName: "queueChange", args: [listCall] }));

  // Alice bids 0.3 of her private HYPE
  const A = await GloamCore.unlock(alice.wallet, cfg);
  await A.shield(alice.wallet, zeroAddress, parseEther("1"));
  await A.sync();
  const s = await creator.getAuction(l.auction);
  const quantity = 100_000n * 10n ** 18n;
  const q = creator.quoteBid(s, unit * 20n, quantity);
  const amount = (q.cost * 10_000n) / 9_950n + 1n; // what arrives after the 0.5% fee covers the cost
  const rec = await gloamBid(A, { bids: BIDS, auction: l.auction, tick: q.tick, quantity, tlockRound: s.tlockRound, amount, fallbackTo: fresh, exitAfter: BigInt(now + 30 * 86400) });
  const bid = await pub.readContract({ address: l.auction, abi: cloakAuctionAbi, functionName: "getBid", args: [0n] });
  assert(bid.bidder.toLowerCase() === rec.account.toLowerCase(), "the auction's bidder is the one-time bid account");
  const placeTx = await pub.getTransaction({ hash: rec.txHash });
  assert(placeTx.from.toLowerCase() === relayer.account.address.toLowerCase(), "the bid was sent by the relayer: Alice's wallet appears nowhere");
  assert(bid.deposit >= q.cost, `the deposit (${bid.deposit}) covers the bid's cost (${q.cost})`);

  // reveal from the drand timelock, settle
  await waitChainTime(s.commitEnd);
  const round = s.tlockRound;
  while (Date.now() / 1000 < drandRoundTime(round) + 1) await sleep(500);
  await creator.revealAll(l.auction, { fromBlock: l.block });
  // the bid is open, so skip the rest of the reveal window on the fork's clock
  await rpc(rpcUrl, "evm_setNextBlockTimestamp", [s.revealEnd + 1]);
  await mine();
  await waitChainTime(s.revealEnd);
  await mine();
  await creator.settle(l.auction);
  const [tokens, refund] = await pub.readContract({ address: l.auction, abi: cloakAuctionAbi, functionName: "allocationOf", args: [0n] });
  assert(tokens > 0n, `Alice's bid wins ${tokens} tokens, refund ${refund} wei`);

  // three days on the listing lands, and the bid comes back into the private balance
  await rpc(rpcUrl, "evm_increaseTime", [3 * 86400 + 60]);
  await mine();
  await sendAndLog(pub, "execute listing (guard)", L.dep.wallet.writeContract({ address: stack.guard, abi: GUARD_ABI, functionName: "executeChange", args: [listCall] }));
  await gloamFinishBid(A, rec, [{ asset: l.token, amount: tokens }, { asset: zeroAddress, amount: refund }]);
  await A.sync();
  assert(sum(await A.balances(), l.token) === tokens, "the won tokens are in Alice's private balance");
  assert(sum(await A.balances(), zeroAddress) === parseEther("1") - amount + refund, "and the refund is back as private HYPE");

  const med = (v) => v.slice().sort((a, b) => a - b)[Math.floor(v.length / 2)];
  const gas = {};
  for (const g of gasLog) (gas[g.label] ??= []).push(g.gas);
  writeMeasurements("part2-bid-fork", { auction: "CloakAuction from Cloak's live v4 factory (on a fork)", escrow: "CloakGloamBids", gas: Object.fromEntries(Object.entries(gas).map(([k, v]) => [k, { n: v.length, median: med(v) }])), wallMs: Math.round(performance.now() - t0) });
  console.log("gas:", Object.fromEntries(Object.entries(gas).map(([k, v]) => [k, med(v)])));
  console.log(`\nPart 2c passed in ${Math.round((performance.now() - t0) / 1000)} s`);
} finally {
  L.stop();
}
process.exit(0);
