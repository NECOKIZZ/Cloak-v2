// Part 2a: private swaps on Cloak's Uniswap v4 launch pools through Gloam's own router (GloamVaultSwapV4c, unchanged),
// on a local fork of Elysium testnet: real PoolManager, real CloakV4Hook, a real launch (FRTN).
//
//   node e2e-gloam/part2-swap.mjs
//
// Happy path (HYPE note -> FRTN note, and back), the forced refund (the spend sent alone, then anyone calls the swap
// and the money goes back in as the refund note), the exit (the exit key signs it out to a fresh address), an
// expired swap (refused, the note stays), a copied call with a changed output (refused by the vault), replay.
import { encodeAbiParameters, keccak256, parseEther, zeroAddress, encodeFunctionData } from "viem";
import { GloamCore, gloamSwap, prepareGloamSwap, swapCalldata, swapExitCalldata, v4Route, GLOAM_SWAP_ROUTER_ABI, walletCoreSubmitter } from "@cloakely/sdk";
import { ANVIL_KEYS, ELYSIUM_TESTNET_ID, ELYSIUM_TESTNET_RPC, POOL_ABI, assert, clients, finalProver, gasLog, gloamArtifact, localGloam, proofLog, rejects, rpc, sendAndLog, writeMeasurements } from "./lib.mjs";

const FRTN = "0xa7cD1Abd22921c91bB87404e7ae20174eC504B9b";
const HOOK = "0xcDC11340C5ce0b3dCbD9A5e8f7838E8A8bBaaA80";
const POOL_MANAGER = "0x51027076df8416e42ea8438b27a0c433d9662e68";
const WHYPE = "0xe44b27113D4b947c0B1bDf4a93878D0e115f4bdD";
const KEY = { currency0: zeroAddress, currency1: FRTN, fee: 0x800000, tickSpacing: 60, hooks: HOOK };

const t0 = performance.now();
const L = await localGloam({ port: 8548, forkUrl: process.env.RPC_URL ?? ELYSIUM_TESTNET_RPC, extraAssets: [{ address: FRTN, perDeposit: 10n ** 30n, total: 10n ** 32n }] });
const { rpcUrl, stack, poolBlock } = L;
const pub = L.dep.pub;
const who = (i) => clients(rpcUrl, ANVIL_KEYS[i], ELYSIUM_TESTNET_ID);
const [alice, mallory, relayer] = [who(1), who(6), who(7)];
const fresh = who(9).account.address;
const treasury = who(3).account.address;
const timings = {};
const time = async (label, f) => {
  const t = performance.now();
  const r = await f();
  timings[label] = Math.round(performance.now() - t);
  return r;
};
const relaySubmit = walletCoreSubmitter(pub, relayer.wallet);
const submit = async (call) => {
  const hash = await relaySubmit(call);
  gasLog.push({ label: `relayed ${call.kind}`, gas: Number((await pub.getTransactionReceipt({ hash })).gasUsed) });
  return hash;
};
const provers = { shield: await finalProver("shield"), transfer: await finalProver("transfer"), unshield: await finalProver("unshield") };
const cfg = { publicClient: pub, chainId: ELYSIUM_TESTNET_ID, pool: stack.pool, poolBlock, payMemo: stack.payMemo, provers, submit };
const sum = (m, a) => m.get(a) ?? 0n;

try {
  console.log("Part 2a on a fork of Elysium testnet: FRTN/HYPE v4 pool through Gloam's router");
  const art = gloamArtifact("GloamVaultSwapV4c.sol", "GloamVaultSwapV4c");
  const r = await sendAndLog(pub, "deploy GloamVaultSwapV4c", L.dep.wallet.deployContract({ ...art, args: [stack.pool, treasury, POOL_MANAGER, WHYPE, L.dep.account.address, [KEY]] }));
  const ROUTER = r.contractAddress;
  console.log("  router", ROUTER);

  // price from the pool: slot0's sqrtPriceX96 (PoolManager.extsload of pools[id].slot0)
  const poolId = keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }], [KEY.currency0, KEY.currency1, KEY.fee, KEY.tickSpacing, KEY.hooks]));
  const slot = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [poolId, 6n]));
  const word = await pub.readContract({ address: POOL_MANAGER, abi: [{ type: "function", name: "extsload", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bytes32" }] }], functionName: "extsload", args: [slot] });
  const sqrtP = BigInt(word) & ((1n << 160n) - 1n);
  assert(sqrtP > 0n, "the FRTN pool is live on the fork");
  const tokensFor = (hypeIn) => (hypeIn * sqrtP * sqrtP) >> 192n; // currency1 per currency0
  const route = v4Route([KEY]);

  const A = await GloamCore.unlock(alice.wallet, cfg);
  await A.shield(alice.wallet, zeroAddress, parseEther("1"));
  await A.sync();

  // ── happy path: 0.1 HYPE note -> FRTN note ─────────────────────────────
  const amountIn = parseEther("0.1");
  // what arrives is amountIn less 0.5%; pool fee up to 30% while anti-snipe decays; ask for 60% of spot to be safe
  const amountOut = (tokensFor(amountIn) * 60n) / 100n;
  const deadline = BigInt((await pub.getBlock()).timestamp) + 600n;
  const tr0 = await pub.readContract({ address: FRTN, abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }], functionName: "balanceOf", args: [treasury] });
  const { txHashes } = await time("private swap HYPE -> FRTN (split, prove x4, swap, memo)", () => gloamSwap(A, { router: ROUTER, route, assetIn: zeroAddress, amountIn, assetOut: FRTN, amountOut, deadline }));
  await A.sync();
  assert(sum(await A.balances(), FRTN) === amountOut, `Alice holds exactly ${amountOut} FRTN privately after the swap`);
  assert(sum(await A.balances(), zeroAddress) === parseEther("0.9"), "and 0.9 HYPE (the split's change)");
  const swapTx = await pub.getTransaction({ hash: txHashes.at(-1) });
  assert(swapTx.from.toLowerCase() === relayer.account.address.toLowerCase(), "the swap comes from the relayer, Alice's address is nowhere in it");
  const swapLog = (await pub.getContractEvents({ address: ROUTER, abi: GLOAM_SWAP_ROUTER_ABI, eventName: "VaultSwap", fromBlock: poolBlock }))[0];
  console.log(`      public on chain: ${swapLog.args.amountIn} wei HYPE in, ${swapLog.args.amountOut} FRTN out, leftover ${swapLog.args.leftover} wei to the router's treasury`);
  const tr1 = await pub.getBalance({ address: treasury });
  void tr0;
  void tr1;

  // ── and back: FRTN note -> HYPE note ───────────────────────────────────
  const back = amountOut / 2n;
  const hypeBack = ((back << 192n) / (sqrtP * sqrtP)) * 50n / 100n;
  await time("private swap FRTN -> HYPE", () => gloamSwap(A, { router: ROUTER, route, assetIn: FRTN, amountIn: back, assetOut: zeroAddress, amountOut: hypeBack, deadline }));
  await A.sync();
  assert(sum(await A.balances(), zeroAddress) === parseEther("0.9") + hypeBack && sum(await A.balances(), FRTN) === amountOut - back, "selling half the FRTN back gives a new HYPE note of exactly the amount asked");

  // ── forced refund: the spend lands alone, then anyone finishes it as a refund ─
  {
    const x = await prepareGloamSwap(A, { router: ROUTER, route, assetIn: zeroAddress, amountIn: parseEther("0.2"), assetOut: FRTN, amountOut, deadline });
    await A.post(BigInt(x.d.commitment), x.tickets, () => {});
    for (const t of x.track) A.track(t);
    // Mallory copies the spend out of the (public) swap call and sends the unshield alone: the money waits at the escrow
    await sendAndLog(pub, "unshield alone (griefing)", mallory.wallet.writeContract({ address: stack.pool, abi: POOL_ABI, functionName: "unshield", args: [x.s.proof, x.s.root, x.s.nullifier, x.s.asset, x.escrow, x.s.amount] }));
    assert((await pub.getBalance({ address: x.escrow })) === parseEther("0.199"), "the money waits at the escrow (0.2 HYPE less the 0.5% fee), not stuck: no one but the router can open it");
    // a copy that changes the new note gets a different escrow, so it can't open this one
    const evil = { ...x, d: { ...x.d, amount: x.d.amount * 2n } };
    await rejects(relayer.wallet.sendTransaction({ to: ROUTER, data: swapCalldata(evil), gas: 3_000_000n }).then((h) => pub.waitForTransactionReceipt({ hash: h })).then((rc) => { if (rc.status !== "success") throw new Error("reverted"); }), "a copied swap call with a changed output can't touch the escrow");
    // anyone (here Mallory) sends the original call: it sees the note spent and deposits the refund note
    await sendAndLog(pub, "refund (anyone)", mallory.wallet.sendTransaction({ to: ROUTER, data: swapCalldata(x) }));
    await A.sync();
    assert(sum(await A.balances(), zeroAddress) === parseEther("0.9") + hypeBack - parseEther("0.2") + x.r.amount, `the refund note (${x.r.amount} wei, the amount less the 1% worst-case fee) is Alice's again`);
    await rejects(relayer.wallet.sendTransaction({ to: ROUTER, data: swapCalldata(x), gas: 3_000_000n }).then((h) => pub.waitForTransactionReceipt({ hash: h })).then((rc) => { if (rc.status !== "success") throw new Error("reverted"); }), "replay: the same call can't run twice");
  }

  // ── exit: when even a refund can't land, the exit key signs it out ─────
  {
    const x = await prepareGloamSwap(A, { router: ROUTER, route, assetIn: zeroAddress, amountIn: parseEther("0.1"), assetOut: FRTN, amountOut, deadline });
    await sendAndLog(pub, "unshield alone", mallory.wallet.writeContract({ address: stack.pool, abi: POOL_ABI, functionName: "unshield", args: [x.s.proof, x.s.root, x.s.nullifier, x.s.asset, x.escrow, x.s.amount] }));
    const data = await swapExitCalldata(A, x, fresh);
    const before = await pub.getBalance({ address: fresh });
    await sendAndLog(pub, "exit", mallory.wallet.sendTransaction({ to: ROUTER, data }));
    assert((await pub.getBalance({ address: fresh })) - before === parseEther("0.0995"), "the exit pays the fresh address straight from the escrow (0.0995 HYPE)");
    const bad = await swapExitCalldata(A, x, mallory.account.address);
    await rejects(mallory.wallet.sendTransaction({ to: ROUTER, data: bad.replace(mallory.account.address.slice(2).toLowerCase(), fresh.slice(2).toLowerCase()), gas: 2_000_000n }).then((h) => pub.waitForTransactionReceipt({ hash: h })).then((rc) => { if (rc.status !== "success") throw new Error("reverted"); }), "an exit signature can't be pointed at another address, and the escrow opens once");
  }

  // ── expiry: a late swap is refused and the note stays in the vault ─────
  {
    const before = sum((await A.sync(), await A.balances()), zeroAddress);
    const x = await prepareGloamSwap(A, { router: ROUTER, route, assetIn: zeroAddress, amountIn: parseEther("0.05"), assetOut: FRTN, amountOut: 1n, deadline: BigInt((await pub.getBlock()).timestamp) + 5n });
    await rpc(rpcUrl, "evm_increaseTime", [60]);
    await rpc(rpcUrl, "evm_mine");
    await rejects(relayer.wallet.sendTransaction({ to: ROUTER, data: swapCalldata(x), gas: 3_000_000n }).then((h) => pub.waitForTransactionReceipt({ hash: h })).then((rc) => { if (rc.status !== "success") throw new Error("reverted"); }), "a swap after its deadline is refused");
    await A.sync();
    assert(sum(await A.balances(), zeroAddress) === before, "and the note it named is still Alice's, unspent");
  }

  const med = (v) => v.slice().sort((a, b) => a - b)[Math.floor(v.length / 2)];
  const gas = {};
  for (const g of gasLog) (gas[g.label] ??= []).push(g.gas);
  writeMeasurements("part2-swap-fork", { venue: "Uniswap v4 (Cloak's PoolManager and CloakV4Hook, FRTN)", router: "GloamVaultSwapV4c (Gloam, unchanged)", timingsMs: timings, gas: Object.fromEntries(Object.entries(gas).map(([k, v]) => [k, { n: v.length, median: med(v) }])), proofs: proofLog.length, wallMs: Math.round(performance.now() - t0) });
  console.log("\ntimings (ms):", timings);
  console.log("gas:", Object.fromEntries(Object.entries(gas).map(([k, v]) => [k, med(v)])));
  console.log(`\nPart 2a passed in ${Math.round((performance.now() - t0) / 1000)} s`);
} finally {
  L.stop();
}
process.exit(0);
