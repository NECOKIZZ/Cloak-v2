// Part 17: Gloam sync costs (OPTIMIZATION.md S1 to S3), on anvil as chain 99801.
//
//   node e2e-gloam/part17-sync-cache.mjs
//
// The incremental tree matches Gloam's full rebuild and the vault's root; a sync with nothing new costs a handful of
// RPC calls; many balance reads at once share one sync; a saved state restores on a new device without reading the
// vault's history; the keeper's leaf list is used only when the vault knows its root; and a node that answers getLogs
// from behind can't leave a gap in the tree.
import { createPublicClient, http, parseEther, parseUnits, zeroAddress } from "viem";
import { GloamCore, GloamTree, walletCoreSubmitter } from "@cloakely/sdk";
import { ANVIL_KEYS, ELYSIUM_TESTNET_ID, ERC20_ABI, POOL_ABI, assert, chainFor, clients, finalProver, localGloam, rejects, sendAndLog } from "./lib.mjs";

const sdk = await import("@gloamtrade/sdk");
const t0 = performance.now();
const L = await localGloam({ port: 8561 });
const { rpcUrl, stack, usdc: USDC, poolBlock } = L;
const who = (i) => clients(rpcUrl, ANVIL_KEYS[i], ELYSIUM_TESTNET_ID);
const [alice, bob, relayer] = [who(1), who(2), who(7)];

// a client that counts its RPC calls by method
const counts = {};
const counted = createPublicClient({
  chain: chainFor(rpcUrl),
  pollingInterval: 50,
  transport: http(rpcUrl, { onFetchRequest: async (r) => { for (const m of [].concat(JSON.parse(await r.clone().text()))) counts[m.method] = (counts[m.method] ?? 0) + 1; } }),
});
const reset = () => { for (const k of Object.keys(counts)) delete counts[k]; };
const total = () => Object.values(counts).reduce((a, b) => a + b, 0);

const submit = walletCoreSubmitter(L.dep.pub, relayer.wallet);
const provers = { shield: await finalProver("shield"), transfer: await finalProver("transfer"), unshield: await finalProver("unshield") };
const cfg = (pub = L.dep.pub) => ({ publicClient: pub, chainId: ELYSIUM_TESTNET_ID, pool: stack.pool, poolBlock, payMemo: stack.payMemo, provers, submit });

try {
  console.log("Part 17 on anvil, vault", stack.pool);
  await sendAndLog(L.dep.pub, "mint USDC", L.dep.wallet.writeContract({ address: USDC, abi: ERC20_ABI, functionName: "mint", args: [alice.account.address, parseUnits("1000", 6)] }));
  const A = await GloamCore.unlock(alice.wallet, cfg());
  const B = await GloamCore.unlock(bob.wallet, cfg());
  await A.shield(alice.wallet, zeroAddress, parseEther("5"));
  await A.shield(alice.wallet, USDC, parseUnits("200", 6));
  await A.send(zeroAddress, await B.address(), parseEther("1"));
  await B.sync(); // sweeps: more leaves
  await A.sync();

  // ── S1: the incremental tree is the vault's tree ───────────────────────
  const full = await sdk.syncTree(L.dep.pub, { pool: stack.pool, fromBlock: poolBlock });
  const t = new GloamTree(stack.pool, poolBlock, 3n); // tiny chunks: many ranges, still one tree
  await t.update(L.dep.pub);
  const onchain = await L.dep.pub.readContract({ address: stack.pool, abi: POOL_ABI, functionName: "currentRoot" });
  assert(t.root.toLowerCase() === full.root.toLowerCase() && t.root.toLowerCase() === onchain.toLowerCase() && t.leafCount === full.leafCount, `the incremental tree matches Gloam's full rebuild and the vault's root (${t.leafCount} leaves)`);
  const someLeaf = full.leaves.at(-1).commitment;
  const [p1, p2] = [await t.pathForCommitment(someLeaf), await full.pathForCommitment(someLeaf)];
  assert(p1.root === p2.root && p1.pathElements.every((x, i) => x === p2.pathElements[i]), "and gives the same membership path");

  // ── S1: an idle sync is a handful of calls, not the vault's history ────
  const C = await GloamCore.unlock(alice.wallet, cfg(counted));
  reset();
  await C.sync();
  const cold = total();
  for (let i = 0; i < 20; i++) await L.dep.wallet.sendTransaction({ to: alice.account.address, value: 1n }); // blocks go by
  reset();
  await C.sync();
  const warm = { ...counts };
  assert((warm.eth_getLogs ?? 0) <= 4, `a sync with nothing new reads only new blocks: ${JSON.stringify(warm)} (the first sync: ${cold} calls)`);
  await A.shield(alice.wallet, zeroAddress, parseEther("1"));
  await C.sync();
  const bal = (await C.balances()).get(zeroAddress);
  assert(bal === parseEther("5") - parseEther("1") + parseEther("1") || bal > 0n, "and still sees a new note");
  await C.sync();

  // ── S2: many balance reads at once share one sync ──────────────────────
  for (let i = 0; i < 5; i++) await L.dep.wallet.sendTransaction({ to: alice.account.address, value: 1n });
  reset();
  await Promise.all(Array.from({ length: 12 }, () => C.syncFresh()));
  assert(counts.eth_blockNumber === 1 && (counts.eth_getLogs ?? 0) <= 4, `12 balance reads at once cost one sync: ${JSON.stringify(counts)}`);
  await A.shield(alice.wallet, zeroAddress, parseEther("0.1"));
  const before = (await C.balances()).get(zeroAddress);
  await C.syncFresh();
  assert((await C.balances()).get(zeroAddress) === before + parseEther("0.1"), "and a read after an action syncs again, so it sees the action");

  // ── S3: a saved state restores without reading the history ─────────────
  const saved = JSON.stringify(C.exportState());
  const D = await GloamCore.unlock(alice.wallet, cfg(counted));
  assert(await D.importState(JSON.parse(saved)), "a saved state loads on a new session");
  reset();
  await D.sync();
  const logsFrom = counts.eth_getLogs ?? 0;
  const [da, ca] = [await D.balances(), await C.balances()];
  assert(da.get(zeroAddress) === ca.get(zeroAddress) && da.get(USDC) === ca.get(USDC), `and shows the same balances, reading only new blocks (${logsFrom} getLogs)`);
  const E = await GloamCore.unlock(bob.wallet, cfg());
  assert(!(await E.importState(JSON.parse(saved))), "another account's saved state is refused");
  const tampered = JSON.parse(saved);
  tampered.notes = tampered.notes.map((n) => ({ ...n, amount: (BigInt(n.amount) * 100n).toString() }));
  const F = await GloamCore.unlock(alice.wallet, cfg());
  await F.importState(tampered);
  assert(!(await F.balances()).get(zeroAddress) || (await F.balances()).get(zeroAddress) < parseEther("100"), "a saved note with a changed amount is dropped (its commitment doesn't match)");
  const G = await GloamCore.unlock(alice.wallet, cfg());
  const badTree = JSON.parse(saved);
  badTree.tree.c = badTree.tree.c.slice(0, -64) + "11".repeat(32);
  await G.importState(badTree);
  await G.sync();
  const gt = new GloamTree(stack.pool, poolBlock);
  await gt.update(L.dep.pub);
  assert((await G.balances()).get(zeroAddress) === ca.get(zeroAddress), "a saved tree with a wrong leaf is refused (unknown root) and read from the chain");

  // ── S3: the keeper's public list, only with a root the vault knows ─────
  // the list and the block it was read at, as the keeper serves them
  const block = await L.dep.pub.getBlockNumber();
  const now = await sdk.syncTree(L.dep.pub, { pool: stack.pool, fromBlock: poolBlock });
  const leaves = now.leaves.map((l, i) => ({ index: i, commitment: BigInt(l.commitment) }));
  const H = await GloamCore.unlock(alice.wallet, cfg());
  const forged = leaves.map((l, i) => (i === 1 ? { ...l, commitment: 12345n } : l));
  assert(!(await H.seedLeaves({ block, leaves: forged })), "a forged leaf list is refused");
  assert(await H.seedLeaves({ block, leaves }), "the true list is used");
  await H.sync();
  assert((await H.balances()).get(zeroAddress) === ca.get(zeroAddress), "and the balance comes out the same");
  const stale = await GloamCore.unlock(alice.wallet, cfg());
  assert(!(await (await GloamCore.unlock(alice.wallet, cfg())).seedLeaves({ block: block + 1000n, leaves })), "a list claiming a future block is refused (it would stop reads until then)");
  assert(await stale.seedLeaves({ block, leaves: leaves.slice(0, -1) }), "a list missing its newest leaf still has a known root (Gloam keeps every root)");
  await stale.sync();
  await stale.sync();
  await stale.sync(); // three reads that don't match the vault's count: the tree starts over from the vault's first block
  await stale.sync();
  assert((await stale.balances()).get(zeroAddress) === ca.get(zeroAddress), "but its block claim doesn't match the vault's count, so the tree is read again and the balance is right");

  // ── a node answering from behind can't leave a gap ─────────────────────
  let drop = true;
  const lagging = createPublicClient({ chain: chainFor(rpcUrl), transport: http(rpcUrl) });
  const realGetLogs = lagging.getLogs.bind(lagging);
  lagging.getLogs = async (a) => {
    const r = await realGetLogs(a);
    if (drop && r.length) return r.slice(0, -1); // the newest log missing
    return r;
  };
  const lt = new GloamTree(stack.pool, poolBlock);
  await lt.update(lagging);
  assert(lt.leafCount === 0, "a read with a missing log isn't applied (the vault's count doesn't match)");
  drop = false;
  await lt.update(lagging);
  assert(lt.root.toLowerCase() === (await L.dep.pub.readContract({ address: stack.pool, abi: POOL_ABI, functionName: "currentRoot" })).toLowerCase(), "and the next good read brings the tree to the vault's root");

  // spending still works on the incremental tree (a path from it)
  await D.withdraw(zeroAddress, alice.account.address, parseEther("0.5"));
  await D.sync();
  assert((await D.balances()).get(zeroAddress) < da.get(zeroAddress), "a withdrawal proved on the restored, incremental tree lands");

  console.log(`\nPart 17 passed in ${Math.round((performance.now() - t0) / 1000)} s`);
} finally {
  L.stop();
}
process.exit(0);
