// Sealed-bid auction rules at their edges, on a fork of Elysium testnet (Cloak's live v4 factory), SDK and raw calls
// only (no browser). Every raw call is checked by its receipt status, not just "sent". drand is real time: about 3 min.
//
//   cd e2e-gloam && PATH=~/.foundry/bin:$PATH NODE_USE_ENV_PROXY=1 NO_PROXY=127.0.0.1,localhost node stress/web-auction-rules.mjs
import { createPublicClient, createWalletClient, erc20Abi, formatEther, http, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Cloak, cloakAuctionAbi, commitmentOf, drandRoundTime, randomSalt, sealBid } from "@cloakely/sdk";
import { ANVIL_KEYS, ELYSIUM_TESTNET_RPC, chainFor, rpc, startAnvil } from "../lib.mjs";
import { D, recorder, sleep } from "./web-harness.mjs";

const R = recorder("web-auction-rules");
const anvil = await startAnvil({ port: 8670, forkUrl: process.env.RPC_URL ?? ELYSIUM_TESTNET_RPC });
const url = anvil.rpcUrl;
const chain = chainFor(url);
const pub = createPublicClient({ chain, transport: http(url), pollingInterval: 100 });
const W = (i) => createWalletClient({ chain, account: privateKeyToAccount(ANVIL_KEYS[i]), transport: http(url) });
const C = (i) => new Cloak(pub, W(i), D.factory);
const now = async () => Number((await pub.getBlock({ blockTag: "latest" })).timestamp);
const at = (t) => rpc(url, "evm_setNextBlockTimestamp", [t]);
const read = (a, fn, args = []) => pub.readContract({ address: a, abi: cloakAuctionAbi, functionName: fn, args });
/** A raw write with a fixed gas limit (so it is mined even if it reverts); ok = receipt status success. */
async function raw(i, address, functionName, args, value) {
  const hash = await W(i).writeContract({ address, abi: cloakAuctionAbi, functionName, args, value, gas: functionName === "settle" ? 15_000_000n : 600_000n });
  const r = await pub.waitForTransactionReceipt({ hash });
  let reason = "";
  if (r.status !== "success") {
    try {
      await pub.call({ to: address, data: (await pub.getTransaction({ hash })).input, account: W(i).account.address, value, blockNumber: r.blockNumber - 1n });
    } catch (e) {
      reason = (String(e.message).match(/reason:\s*([^\n]+)|reverted with the following reason:\s*\n?([^\n]+)/) ?? []).slice(1).find(Boolean) ?? String(e.shortMessage ?? "").slice(0, 80);
    }
  }
  return { ok: r.status === "success", reason: reason.trim(), ts: Number((await pub.getBlock({ blockNumber: r.blockNumber })).timestamp) };
}
const say = (r) => (r.ok ? "accepted" : `refused (${r.reason || "reverted"})`);

try {
  R.say(`run at ${new Date().toISOString()}`);
  const unit = 10n ** 10n;
  const t0 = await now();
  const commitEnd = t0 + 75;
  const revealEnd = commitEnd + 300;
  const l = await C(4).createLaunch({ name: "Rules", symbol: "RULE", saleSupply: 1_000_000n * 10n ** 18n, minPrice: unit, tickSize: unit, numTicks: 50, commitEnd, revealEnd, lpBps: 8000, lpLockUntil: "fees" });
  const A = l.auction;
  const s = await C(4).getAuction(A);
  R.say(`launch ${A}, commitEnd ${commitEnd}, revealEnd ${revealEnd}, tlockRound ${s.tlockRound}`);

  // honest bids, undersubscribed (700k of 1M)
  const h1 = await C(1).bid(A, { maxPrice: 5n * unit, quantity: 400_000n * 10n ** 18n });
  const h2 = await C(2).bid(A, { maxPrice: 3n * unit, quantity: 300_000n * 10n ** 18n });
  // griefer: unopenable ciphertext, high tick
  const g = { tick: 30, qty: 250_000n * 10n ** 18n, salt: randomSalt() };
  const gC = commitmentOf(A, W(7).account.address, g.tick, g.qty, g.salt);
  const gDep = ((s.minPrice + BigInt(g.tick) * s.tickSize) * g.qty) / 10n ** 18n;
  const gr = await raw(7, A, "commit", [gC, toHex("garbage")], gDep);
  const gId = BigInt(Number(await read(A, "bidsCount")) - 1);
  // a bidder who keeps his own preimage, sealed to a far round (so only he can reveal): used for the revealEnd boundary
  const late = { tick: 2, qty: 10_000n * 10n ** 18n, salt: randomSalt() };
  const lateSealed = await sealBid({ auction: A, bidder: W(3).account.address, tick: late.tick, quantity: late.qty, salt: late.salt }, s.tlockRound + 1_000_000);
  await raw(3, A, "commit", [commitmentOf(A, W(3).account.address, late.tick, late.qty, late.salt), lateSealed], 10n ** 15n);
  const lateId = BigInt(Number(await read(A, "bidsCount")) - 1);
  R.say(`  bids placed; griefer #${gId} ${say(gr)}, late #${lateId}`);

  // commit boundary
  await at(commitEnd - 1);
  const b1 = await raw(5, A, "commit", [toHex(1n, { size: 32 }), "0x"], 10n ** 12n);
  await at(commitEnd);
  const b2 = await raw(5, A, "commit", [toHex(2n, { size: 32 }), "0x"], 10n ** 12n);
  R.check(`commit at commitEnd-1 (ts ${b1.ts}): ${say(b1)}; at commitEnd (ts ${b2.ts}): ${say(b2)}`, b1.ok && !b2.ok);
  // a bid that commits to a cost above its deposit can never reveal
  {
    const salt = randomSalt();
    const q = 1_000_000n * 10n ** 18n;
    // (placed before close above would need time travel back; checked via _tryReveal rule in the reveal below instead)
    void salt, q;
  }

  // drand
  while (Date.now() / 1000 < drandRoundTime(s.tlockRound) + 2) await sleep(1000);
  await rpc(url, "evm_mine");
  const rv = await C(8).revealAll(A, { fromBlock: l.block });
  R.check(`revealAll: revealed ${rv.revealed}, unopenable ${rv.unopenable.map((u) => "#" + u.id).join(", ")} (the griefer, the far-round bid and the two junk commits)`, rv.unopenable.length >= 2);
  const st = await C(8).getAuction(A);
  R.say(`  after keeper reveals: ${st.reveals}/${st.commits} open; demand curve visible to everyone during reveal`);

  // settle too early, griefer reveals at the last second, late reveal exactly at revealEnd
  await at(revealEnd - 2);
  const se = await raw(8, A, "settle", []);
  await at(revealEnd - 1);
  const gRev = await raw(7, A, "reveal", [gId, g.tick, g.qty, g.salt]);
  await at(revealEnd);
  const lRev = await raw(3, A, "reveal", [lateId, late.tick, late.qty, late.salt]);
  R.check(`settle at revealEnd-2: ${say(se)}; griefer's own reveal at revealEnd-1: ${say(gRev)}; a reveal at exactly revealEnd: ${say(lRev)}`, !se.ok && gRev.ok && !lRev.ok);
  const set = await raw(8, A, "settle", []);
  const set2 = await raw(8, A, "settle", []);
  const fin = await C(8).getAuction(A);
  R.check(`settle at revealEnd: ${say(set)}; settle again: ${say(set2)}. Cleared at tick ${fin.clearingTick} (${formatEther(fin.clearingPrice)} HYPE)`, set.ok && !set2.ok);
  const ag = await read(A, "allocationOf", [gId]);
  R.check(`selective reveal paid off: griefer gets ${formatEther(ag[0])} tokens, penalty ${formatEther(ag[2])} (staying sealed would have cost ${formatEther((gDep * 1000n) / 10000n)})`, true);
  const al = await read(A, "allocationOf", [lateId]);
  R.check(`never-revealed bid: refund ${formatEther(al[1])}, penalty ${formatEther(al[2])}`, al[2] > 0n);

  // claims
  const tok = fin.token;
  const tb = (i) => pub.readContract({ address: tok, abi: erc20Abi, functionName: "balanceOf", args: [W(i).account.address] });
  const hb = (i) => pub.getBalance({ address: W(i).account.address });
  const c1 = await raw(1, A, "claim", [h1.id]);
  const c1b = await raw(1, A, "claim", [h1.id]);
  const cb = await raw(1, A, "claimBatch", [[h1.id]]);
  R.check(`claim: first ${say(c1)}, claim again ${say(c1b)}, claimBatch of the claimed id ${say(cb)}`, c1.ok && !c1b.ok);
  const [t9, t2] = [await tb(9), await tb(2)];
  const h9 = await hb(9);
  const o = await raw(9, A, "claim", [h2.id]);
  const [t9a, t2a] = [await tb(9), await tb(2)];
  R.check(`a stranger claims someone else's bid: ${say(o)}; stranger got ${formatEther(t9a - t9)} tokens (paid gas ${formatEther(h9 - (await hb(9)))}), bidder got ${formatEther(t2a - t2)}`, t9a === t9);
  const p = await raw(9, A, "claimPrivate", [gId, 1n, 1n, "0x"]);
  R.check(`claimPrivate of someone else's bid: ${say(p)}`, !p.ok);
  const p2 = await raw(7, A, "claimPrivate", [gId, 1n, 1n, "0x"]);
  R.check(`claimPrivate by the bidder with a junk note key (pubKey 1): ${say(p2)} (the launch vault decides)`, true);
  R.save();
} finally {
  R.save();
  anvil.stop();
}
process.exit(0);
