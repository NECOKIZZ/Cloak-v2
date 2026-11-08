// Part 2b: private swaps on Cloak's Uniswap V2 launch pairs through CloakV2PairSwap (Gloam's GloamVaultSwap2 escrow
// base, unchanged, with a V2-pair venue), on a local fork of Elysium testnet with a real launch pair.
//
//   node e2e-gloam/part2-swap-v2.mjs
import { encodeAbiParameters, parseEther, zeroAddress } from "viem";
import { GloamCore, gloamSwap, prepareGloamSwap, swapCalldata, GLOAM_SWAP_ROUTER_ABI, walletCoreSubmitter } from "@cloakely/sdk";
import { rejects, ANVIL_KEYS, ELYSIUM_TESTNET_ID, ELYSIUM_TESTNET_RPC, POOL_ABI, assert, clients, finalProver, gasLog, localGloam, ourArtifact, sendAndLog, writeMeasurements } from "./lib.mjs";

const TOKEN = "0x62bCE62486E495acbFA78fAAF5fc9F644072e240";
const PAIR = "0x9350C4e8Bc60F55cF599a3A679014C3483103A86";
/** A live testnet token that keeps 1% of every transfer: a real hostile token for the venue. */
const TAX_TOKEN = "0xd45AeCd672319899ac81A54932f8AAfD8E78C432";
const V2_FACTORY = "0xb2f8ad730e9d05d333c7861184aad0bff1785dd0";
const WHYPE = "0xCD57F65c2B0e5881CFC2E609F7CD53b746E1F234";

const t0 = performance.now();
const L = await localGloam({ port: 8549, forkUrl: process.env.RPC_URL ?? ELYSIUM_TESTNET_RPC, extraAssets: [{ address: TOKEN, perDeposit: 10n ** 32n, total: 10n ** 34n }, { address: TAX_TOKEN, perDeposit: 10n ** 32n, total: 10n ** 34n }] });
const { rpcUrl, stack, poolBlock } = L;
const pub = L.dep.pub;
const who = (i) => clients(rpcUrl, ANVIL_KEYS[i], ELYSIUM_TESTNET_ID);
const [alice, mallory, relayer] = [who(1), who(6), who(7)];
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
const path = (a, b) => encodeAbiParameters([{ type: "address[]" }], [[a, b]]);
const PAIR_ABI = [
  { type: "function", name: "getReserves", stateMutability: "view", inputs: [], outputs: [{ type: "uint112" }, { type: "uint112" }, { type: "uint32" }] },
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
];
const amountOutFor = async (tokenIn, amountIn) => {
  const [r0, r1] = await pub.readContract({ address: PAIR, abi: PAIR_ABI, functionName: "getReserves" });
  const t0_ = await pub.readContract({ address: PAIR, abi: PAIR_ABI, functionName: "token0" });
  const [rIn, rOut] = t0_.toLowerCase() === tokenIn.toLowerCase() ? [r0, r1] : [r1, r0];
  const x = amountIn * 997n;
  return (x * rOut) / (rIn * 1000n + x);
};

try {
  console.log("Part 2b on a fork of Elysium testnet: a real V2 launch pair through CloakV2PairSwap");
  const art = ourArtifact("CloakV2PairSwap.sol", "CloakV2PairSwap");
  const ROUTER = (await sendAndLog(pub, "deploy CloakV2PairSwap", L.dep.wallet.deployContract({ ...art, args: [stack.pool, treasury, V2_FACTORY, WHYPE] }))).contractAddress;
  const A = await GloamCore.unlock(alice.wallet, cfg);
  await A.shield(alice.wallet, zeroAddress, parseEther("1"));
  await A.sync();
  const deadline = BigInt((await pub.getBlock()).timestamp) + 600n;

  // HYPE note -> launch token note. What arrives is the note less 0.5%; quote on that, keep a 1% price buffer.
  const amountIn = parseEther("0.1");
  const quoted = await amountOutFor(WHYPE, (amountIn * 995n) / 1000n);
  const amountOut = (quoted * 99n) / 100n;
  await time("private swap HYPE -> token on a V2 pair", () => gloamSwap(A, { router: ROUTER, route: path(WHYPE, TOKEN), assetIn: zeroAddress, amountIn, assetOut: TOKEN, amountOut, deadline }));
  await A.sync();
  assert(sum(await A.balances(), TOKEN) === amountOut, "Alice holds exactly the token amount asked, privately");
  const ev = (await pub.getContractEvents({ address: ROUTER, abi: GLOAM_SWAP_ROUTER_ABI, eventName: "VaultSwap", fromBlock: poolBlock }))[0];
  console.log(`      leftover to the router's treasury: ${ev.args.leftover} wei of ${(amountIn * 995n) / 1000n} that arrived (${Number((ev.args.leftover * 10000n) / ((amountIn * 995n) / 1000n)) / 100}%)`);

  // and back
  const back = amountOut / 2n;
  const hypeOut = ((await amountOutFor(TOKEN, (back * 995n) / 1000n)) * 99n) / 100n;
  await time("private swap token -> HYPE on a V2 pair", () => gloamSwap(A, { router: ROUTER, route: path(TOKEN, WHYPE), assetIn: TOKEN, amountIn: back, assetOut: zeroAddress, amountOut: hypeOut, deadline }));
  await A.sync();
  assert(sum(await A.balances(), zeroAddress) === parseEther("0.9") + hypeOut, "selling half back gives a HYPE note of exactly the amount asked");

  // forced refund on this venue too
  const x = await prepareGloamSwap(A, { router: ROUTER, route: path(WHYPE, TOKEN), assetIn: zeroAddress, amountIn: parseEther("0.2"), assetOut: TOKEN, amountOut, deadline });
  await A.post(BigInt(x.d.commitment), x.tickets, () => {});
  for (const t of x.track) A.track(t);
  await sendAndLog(pub, "unshield alone", mallory.wallet.writeContract({ address: stack.pool, abi: POOL_ABI, functionName: "unshield", args: [x.s.proof, x.s.root, x.s.nullifier, x.s.asset, x.escrow, x.s.amount] }));
  await sendAndLog(pub, "refund (anyone)", mallory.wallet.sendTransaction({ to: ROUTER, data: swapCalldata(x) }));
  await A.sync();
  assert(sum(await A.balances(), zeroAddress) === parseEther("0.9") + hypeOut - parseEther("0.2") + x.r.amount, "a spend sent alone comes back as the refund note");

  // a token that skims 1% per transfer: the output arrives short, the whole swap reverts, the note stays
  {
    const before = sum((await A.sync(), await A.balances()), zeroAddress);
    const x2 = await prepareGloamSwap(A, { router: ROUTER, route: path(WHYPE, TAX_TOKEN), assetIn: zeroAddress, amountIn: parseEther("0.05"), assetOut: TAX_TOKEN, amountOut: 10n ** 18n, deadline });
    await rejects(relayer.wallet.sendTransaction({ to: ROUTER, data: swapCalldata(x2), gas: 3_000_000n }).then((h) => pub.waitForTransactionReceipt({ hash: h })).then((rc) => { if (rc.status !== "success") throw new Error("reverted"); }), "a live fee-on-transfer token (ECOSIG7, 1% per transfer) makes the swap revert whole");
    await A.sync();
    assert(sum(await A.balances(), zeroAddress) === before, "and the HYPE note is untouched");
  }

  const med = (v) => v.slice().sort((a, b) => a - b)[Math.floor(v.length / 2)];
  const gas = {};
  for (const g of gasLog) (gas[g.label] ??= []).push(g.gas);
  writeMeasurements("part2-swap-v2-fork", { venue: "Uniswap V2 pair (Elysium testnet factory)", router: "CloakV2PairSwap on GloamVaultSwap2", timingsMs: timings, gas: Object.fromEntries(Object.entries(gas).map(([k, v]) => [k, { n: v.length, median: med(v) }])), wallMs: Math.round(performance.now() - t0) });
  console.log("\ntimings (ms):", timings);
  console.log("gas:", Object.fromEntries(Object.entries(gas).map(([k, v]) => [k, med(v)])));
  console.log(`\nPart 2b passed in ${Math.round((performance.now() - t0) / 1000)} s`);
} finally {
  L.stop();
}
process.exit(0);
