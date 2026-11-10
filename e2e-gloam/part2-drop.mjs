// Part 2d: a sealed NFT drop bid paid from a Gloam private balance, on a local fork of Elysium testnet (Cloak's live
// drop factory). The NFT can't go into Gloam's vault (it holds fungible assets only), so the owner key moves it to a
// fresh wallet; the HYPE refund comes back as a private note.
//
//   NODE_USE_ENV_PROXY=1 node e2e-gloam/part2-drop.mjs
import { encodeFunctionData, parseAbi, parseEther, zeroAddress } from "viem";
import { CloakDrops, GloamCore, cloakDropAbi, deployments, drandRoundTime, dropBidCall, gloamBid, gloamBidOwnerCall, gloamFinishBid, walletCoreSubmitter } from "@cloakely/sdk";
import { ANVIL_KEYS, ELYSIUM_TESTNET_ID, ELYSIUM_TESTNET_RPC, assert, clients, finalProver, gasLog, localGloam, ourArtifact, rpc, sendAndLog, writeMeasurements } from "./lib.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = performance.now();
const L = await localGloam({ port: 8551, forkUrl: process.env.RPC_URL ?? ELYSIUM_TESTNET_RPC });
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
const waitChainTime = async (t) => {
  for (;;) {
    if (Number((await pub.getBlock()).timestamp) >= t) return;
    await mine();
    await sleep(1000);
  }
};

try {
  console.log("Part 2d on a fork of Elysium testnet: a private bid on a real Cloak drop");
  const BIDS = (await sendAndLog(pub, "deploy CloakGloamBids", L.dep.wallet.deployContract({ ...ourArtifact("CloakGloamBids.sol", "CloakGloamBids"), args: [stack.pool, zeroAddress] }))).contractAddress;
  const creator = new CloakDrops(pub, creatorC.wallet, deployments[99801].dropFactory);
  const { drop } = await creator.create({ name: "Gloam Drop", symbol: "GDROP", baseURI: "ipfs://gloam-test/", supply: 10, floor: parseEther("0.01"), biddingSecs: 40, revealSecs: 40 });
  console.log("  drop", drop);
  let s = await creator.get(drop);
  await waitChainTime(Number(s.gtdEnd));

  const A = await GloamCore.unlock(alice.wallet, cfg);
  await A.shield(alice.wallet, zeroAddress, parseEther("1"));
  await A.sync();
  const price = parseEther("0.02");
  const tick = CloakDrops.tickFor(s, price);
  const cost = CloakDrops.priceAt(s, tick) * 2n;
  const amount = (cost * 10_000n) / 9_950n + parseEther("0.001"); // covers the cost after the 0.5% fee, a little over
  const rec = await gloamBid(A, { bids: BIDS, auction: drop, tick, quantity: 2n, tlockRound: s.tlockRound, amount, fallbackTo: fresh, exitAfter: BigInt(Math.floor(Date.now() / 1000) + 30 * 86400), bidCall: dropBidCall });
  const bid = await pub.readContract({ address: drop, abi: cloakDropAbi, functionName: "getBid", args: [0n] });
  assert(bid.bidder.toLowerCase() === rec.account.toLowerCase(), "the drop's bidder is the one-time bid account");

  s = await creator.get(drop);
  await waitChainTime(Number(s.commitEnd));
  while (Date.now() / 1000 < drandRoundTime(s.tlockRound) + 1) await sleep(500);
  await creator.revealAll(drop);
  await waitChainTime(Number(s.revealEnd));
  await mine();
  await creator.settle(drop);
  const [nfts, , refund] = await pub.readContract({ address: drop, abi: cloakDropAbi, functionName: "allocationOf", args: [0n] });
  assert(nfts === 2, `the bid wins ${nfts} NFTs, refund ${refund} wei`);
  await sendAndLog(pub, "claim (anyone)", relayer.wallet.writeContract({ address: drop, abi: cloakDropAbi, functionName: "claim", args: [0n] }));

  // the refund back as a private note; the NFTs out to a fresh wallet by the owner key
  await gloamFinishBid(A, rec, [{ asset: zeroAddress, amount: refund }]);
  const minted = await pub.getContractEvents({ address: drop, abi: parseAbi(["event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"]), eventName: "Transfer", args: { to: rec.account }, fromBlock: poolBlock });
  for (const ev of minted) {
    await gloamBidOwnerCall(A, rec, { target: drop, data: encodeFunctionData({ abi: parseAbi(["function transferFrom(address from, address to, uint256 tokenId)"]), functionName: "transferFrom", args: [rec.account, fresh, ev.args.tokenId] }) });
  }
  for (const ev of minted) {
    const owner = await pub.readContract({ address: drop, abi: parseAbi(["function ownerOf(uint256) view returns (address)"]), functionName: "ownerOf", args: [ev.args.tokenId] });
    assert(owner.toLowerCase() === fresh.toLowerCase(), `NFT #${ev.args.tokenId} is in the fresh wallet`);
  }
  await A.sync();
  assert(sum(await A.balances(), zeroAddress) === parseEther("1") - amount + refund, "the HYPE refund is back in the private balance");

  const med = (v) => v.slice().sort((a, b) => a - b)[Math.floor(v.length / 2)];
  const gas = {};
  for (const g of gasLog) (gas[g.label] ??= []).push(g.gas);
  writeMeasurements("part2-drop-fork", { drop: "CloakDrop from Cloak's live drop factory (on a fork)", escrow: "CloakGloamBids", gas: Object.fromEntries(Object.entries(gas).map(([k, v]) => [k, { n: v.length, median: med(v) }])), wallMs: Math.round(performance.now() - t0) });
  console.log("gas:", Object.fromEntries(Object.entries(gas).map(([k, v]) => [k, med(v)])));
  console.log(`\nPart 2d passed in ${Math.round((performance.now() - t0) / 1000)} s`);
} finally {
  L.stop();
}
process.exit(0);
