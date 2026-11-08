// Part 1b: claim links on GloamCore, on anvil (99801).
//
//   node e2e-gloam/part1-links.mjs
import { parseEther, zeroAddress } from "viem";
import { GloamCore, walletCoreSubmitter } from "@cloakely/sdk";
import { ANVIL_KEYS, ELYSIUM_TESTNET_ID, assert, clients, finalProver, localGloam, rejects, writeMeasurements } from "./lib.mjs";

const t0 = performance.now();
const L = await localGloam({ port: 8553 });
const { rpcUrl, stack, poolBlock } = L;
const pub = L.dep.pub;
const who = (i) => clients(rpcUrl, ANVIL_KEYS[i], ELYSIUM_TESTNET_ID);
const [alice, bob, relayer] = [who(1), who(2), who(7)];
const provers = { shield: await finalProver("shield"), transfer: await finalProver("transfer"), unshield: await finalProver("unshield") };
const cfg = { publicClient: pub, chainId: ELYSIUM_TESTNET_ID, pool: stack.pool, poolBlock, payMemo: stack.payMemo, provers, submit: walletCoreSubmitter(pub, relayer.wallet) };
const sum = (m, a) => m.get(a) ?? 0n;
const timings = {};
const time = async (label, f) => {
  const t = performance.now();
  const r = await f();
  timings[label] = Math.round(performance.now() - t);
  return r;
};

try {
  console.log("Part 1b on anvil (chain 99801): claim links");
  const A = await GloamCore.unlock(alice.wallet, cfg);
  await A.shield(alice.wallet, zeroAddress, parseEther("2"));
  const { link } = await time("create a claim link", () => A.createClaimLink(zeroAddress, parseEther("0.5")));
  assert(link.startsWith("gloam1."), "the link is Gloam's own note package (Gloam's app can open it too)");
  const B = await GloamCore.unlock(bob.wallet, cfg);
  await time("claim a link", () => B.claimLink(`https://cloak.example/claim#${link}`));
  assert(sum(await B.balances(), zeroAddress) === parseEther("0.5"), "Bob claims 0.5 HYPE into his own note");
  await rejects(A.claimLink(link), "a claimed link can't be claimed again, not even by its maker");
  await A.sync();
  assert((await A.links()).every((l) => !l.open), "Alice's device shows the link as claimed");

  // an unclaimed link, taken back from another device of Alice's
  await A.createClaimLink(zeroAddress, parseEther("0.25"));
  const A2 = await GloamCore.unlock(alice.wallet, cfg);
  await A2.sync();
  const open = (await A2.links()).filter((l) => l.open);
  assert(open.length === 1 && open[0].amount === parseEther("0.25"), "a second device of Alice's sees the open link (from the memo board)");
  await A2.claimLink(open[0].link);
  assert(sum(await A2.balances(), zeroAddress) === parseEther("1.5"), "and takes it back: nothing lost");
  await rejects(B.claimLink(open[0].link), "after which Bob can't claim it");

  writeMeasurements("part1-links-anvil", { timingsMs: timings, wallMs: Math.round(performance.now() - t0) });
  console.log("\ntimings (ms):", timings);
  console.log(`\nPart 1b passed in ${Math.round((performance.now() - t0) / 1000)} s`);
} finally {
  L.stop();
}
process.exit(0);
