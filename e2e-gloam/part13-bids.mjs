// Part 13: a sealed bid from the private balance on Cloak v2 on Gloam (GloamPrivate.bidPrivately, CloakGloamBids on
// Cloak's launch vault), on a real Cloak launch from Cloak's live v4 factory, on a fork of Elysium testnet. The bid is
// sealed to drand, revealed and settled; the keeper loop admits the token the moment the launch settles, and the next
// app open brings the won tokens and the refund back as private notes, with no 3-day wait.
//
//   NODE_USE_ENV_PROXY=1 node e2e-gloam/part13-bids.mjs     (drand is fetched over the network)
import { formatEther, parseEther, zeroAddress } from "viem";
import { Cloak, GloamPrivate, deployments, drandRoundTime } from "@cloakely/sdk";
import { createGloamRelay } from "../services/keeper/gloam.mjs";
import { createGloamLoop } from "../services/keeper/gloamLoop.mjs";
import { LV_ABI, checkLaunchVault } from "./stack.mjs";
import { ANVIL_KEYS, ELYSIUM_TESTNET_ID, ELYSIUM_TESTNET_RPC, ELYSIUM_TESTNET_USDC, assert, clients, deployGloamStack, deployPoseidon, finalProver, gloamArtifact, ourArtifact, rpc, sendAndLog, startAnvil, writeMeasurements } from "./lib.mjs";

const D = deployments[ELYSIUM_TESTNET_ID];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = performance.now();
const anvil = await startAnvil({ port: 8566, forkUrl: process.env.RPC_URL ?? ELYSIUM_TESTNET_RPC });
const rpcUrl = anvil.rpcUrl;
const who = (i) => clients(rpcUrl, ANVIL_KEYS[i], ELYSIUM_TESTNET_ID);
const [dep, alice, creatorC, keeper] = [who(0), who(1), who(4), who(8)];
const pub = dep.pub;
const mine = () => rpc(rpcUrl, "evm_mine");
const waitChainTime = async (t) => {
  for (;;) {
    if (Number((await pub.getBlock()).timestamp) >= t) return;
    await mine();
    await sleep(1000);
  }
};
const write = (address, abi, functionName, args = []) => sendAndLog(pub, functionName, dep.wallet.writeContract({ address, abi, functionName, args }));
const deploy = async (label, art, args = []) => (await sendAndLog(pub, `deploy ${label}`, dep.wallet.deployContract({ ...art, args }))).contractAddress;
try {
  console.log("Part 13 on a fork of Elysium testnet: a sealed bid from the private balance, back with no 3-day wait");
  const addr = dep.account.address;
  const poseidon = await deployPoseidon(dep);
  const stack = await deployGloamStack({ rpcUrl, pk: ANVIL_KEYS[0], poseidon, assets: [{ address: ELYSIUM_TESTNET_USDC, perDeposit: 500n * 10n ** 6n, total: 25_000n * 10n ** 6n }, { address: zeroAddress, perDeposit: parseEther("0.003"), total: parseEther("100") }], feeBps: 50, feeRecipient: addr, controller: addr });
  const caps = [parseEther("1000000000"), parseEther("100000000000")];
  const lv = await deploy("CloakLaunchVault", ourArtifact("CloakLaunchVault.sol", "CloakLaunchVault"), [poseidon, stack.dual, D.factory, ...caps, addr]);
  await write(lv, LV_ABI, "setShieldVerifier", [stack.shieldVerifier]);
  await write(lv, LV_ABI, "setWithdrawFee", [50, addr]);
  await write(lv, LV_ABI, "turnOnDepositLimits");
  // mainnet's model: HYPE lives in Gloam's vault, the launch vault holds launch tokens only
  await write(lv, LV_ABI, "endSetup");
  const guardArt = gloamArtifact("VaultOwnerGuard.sol", "VaultOwnerGuard");
  const guard = await deploy("VaultOwnerGuard", guardArt, [lv, addr]);
  await write(lv, LV_ABI, "transferOwnership", [guard]);
  await write(guard, guardArt.abi, "acceptVaultOwnership");
  await checkLaunchVault(pub, lv, { guard, dual: stack.dual, shieldVerifier: stack.shieldVerifier, factory: D.factory, feeRecipient: addr, pauser: addr, caps });
  const bids = await deploy("CloakGloamBids", ourArtifact("CloakGloamBids.sol", "CloakGloamBids"), [lv, stack.pool]);
  const block = await pub.getBlockNumber();

  const relay = createGloamRelay({ publicClient: pub, walletClient: keeper.wallet, vault: stack.pool, launchVault: lv, memoBoard: stack.payMemo, escrows: [bids], hourlySpendWei: parseEther("5") });
  const loop = createGloamLoop({ publicClient: pub, account: keeper.account, send: async (x) => (await sendAndLog(pub, x.functionName, keeper.wallet.writeContract(x))).transactionHash, launchVault: lv });
  await loop.tick(); // the launches already settled
  let saved = [];
  const provers = { shield: await finalProver("shield"), transfer: await finalProver("transfer"), unshield: await finalProver("unshield") };
  const A = await GloamPrivate.unlock(alice.wallet, { publicClient: pub, chainId: ELYSIUM_TESTNET_ID, gloamVault: { pool: stack.pool, poolBlock: block }, launchVault: { pool: lv, poolBlock: block }, payMemo: stack.payMemo, provers, submit: (call) => relay({ kind: call.kind, to: call.to, data: call.data }), whype: D.whype, bids, logChunk: 5_000n, records: { load: () => saved, save: (x) => (saved = x) } });
  await A.loadMarkets();
  // HYPE at 0.003 per deposit here (Gloam's mainnet vault: 12), so 0.01 HYPE goes in as four deposits
  await A.shieldHype(alice.wallet, parseEther("0.01"));
  const gCore = A.cores.find((c) => c.config.pool.toLowerCase() === stack.pool.toLowerCase());
  const lCore = A.cores.find((c) => c.config.pool.toLowerCase() === lv.toLowerCase());
  const held = async (c, asset) => (await c.sync(), c.ownNotes(asset).reduce((a, n) => a + n.amount, 0n));
  assert((await held(gCore, zeroAddress)) === parseEther("0.01") && gCore.ownNotes(zeroAddress).length === 4 && (await held(lCore, zeroAddress)) === 0n, "Alice's 0.01 HYPE went into Gloam's vault as 4 deposits under its cap (the launch vault takes no HYPE)");

  // a new launch on Cloak's live v4 factory (on the fork)
  const creator = new Cloak(pub, creatorC.wallet, D.factory);
  const now = Number((await pub.getBlock()).timestamp);
  const unit = 10n ** 9n;
  const l = await creator.createLaunch({ name: "Gloam Bid Test", symbol: "GBID", saleSupply: 1_000_000n * 10n ** 18n, minPrice: unit, tickSize: unit, numTicks: 50, commitEnd: now + 40, revealEnd: now + 340, lpBps: 8000 }); // v2's factory needs a reveal window of 5 minutes or more
  console.log("  launch", l.auction, "token", l.token);

  // the launch page's private bid: maxPrice 20 units, 100,000 tokens
  const quantity = 100_000n * 10n ** 18n;
  // a deposit above the bid's cost (0.002 HYPE), so the refund comes back as HYPE
  const r = await A.bidPrivately(l.auction, { maxPrice: unit * 20n, quantity, deposit: parseEther("0.005") });
  const s = await creator.getAuction(l.auction);
  const placed = await pub.getTransaction({ hash: r.fundTx });
  assert(placed.from.toLowerCase() === keeper.account.address.toLowerCase(), "the bid was sent by the relay: Alice's wallet appears nowhere");
  const ws = await A.bidWallets(l.auction);
  assert((r.bids ?? 1) >= 2 && ws.length === r.bids && ws[0].address === r.bidWallet, `no note holds 0.005 HYPE, so the bid went in as ${r.bids} sealed bids at the same price, one note each; the launch page lists each one-time account`);
  const hypeAfterBid = await A.balance(A.hypeMarket.pool);
  assert((await held(gCore, zeroAddress)) < parseEther("0.01"), "the bid's HYPE came out of Gloam's vault");

  // reveal from the drand timelock, settle
  await waitChainTime(s.commitEnd);
  while (Date.now() / 1000 < drandRoundTime(s.tlockRound) + 1) await sleep(500);
  await creator.revealAll(l.auction, { fromBlock: l.block });
  // the bid is open, so skip the rest of the reveal window on the fork's clock
  await rpc(rpcUrl, "evm_setNextBlockTimestamp", [s.revealEnd + 1]);
  await mine();
  await waitChainTime(s.revealEnd);
  await mine();
  await creator.settle(l.auction);

  // the keeper loop admits the token at settlement; the next app open brings the bid back
  const t = await loop.tick();
  assert(t.admitted.some((x) => x.token.toLowerCase() === l.token.toLowerCase()), "the keeper loop admitted the new launch's token at settlement");
  await A.loadMarkets();
  const res = await A.finishPending();
  assert(res.done.length === r.bids && res.errors.length === 0, `the next open finished all ${r.bids} bids: ${res.done[0]?.outcome}`);
  const won = await A.balance(l.token);
  assert(won > 0n, `${formatEther(won)} GBID won, in the private balance at once (no 3-day wait)`);
  const refundBack = (await A.balance(A.hypeMarket.pool)) - hypeAfterBid;
  assert(refundBack > 0n, `and ${formatEther(refundBack)} HYPE of refund back as a note`);
  assert((await held(lCore, l.token)) === won && (await held(lCore, zeroAddress)) === 0n, "the won tokens are in the launch vault, and the refund in Gloam's vault (none in the launch vault)");

  writeMeasurements("part13-bids", { won: formatEther(won), refund: formatEther(refundBack), seconds: Math.round((performance.now() - t0) / 1000) });
  console.log(`\nPart 13 passed in ${Math.round((performance.now() - t0) / 1000)} s`);
} finally {
  anvil.stop();
}
process.exit(0);
