// Part 3b: the keeper's Gloam relay (services/keeper/gloam.mjs) carrying GloamCore's calls, and refusing abuse.
//
//   node e2e-gloam/part3-relay.mjs
import { encodeFunctionData, parseAbi, parseEther, zeroAddress } from "viem";
import { GloamCore } from "@cloakely/sdk";
import { createGloamRelay } from "../services/keeper/gloam.mjs";
import { ANVIL_KEYS, ELYSIUM_TESTNET_ID, assert, clients, finalProver, localGloam, rejects } from "./lib.mjs";

const t0 = performance.now();
const L = await localGloam({ port: 8554 });
const { rpcUrl, stack, poolBlock } = L;
const pub = L.dep.pub;
const who = (i) => clients(rpcUrl, ANVIL_KEYS[i], ELYSIUM_TESTNET_ID);
const [alice, bob, keeper] = [who(1), who(2), who(8)];
try {
  console.log("Part 3b on anvil (chain 99801): the keeper's Gloam relay");
  const relay = createGloamRelay({ publicClient: pub, walletClient: keeper.wallet, vault: stack.pool, memoBoard: stack.payMemo, hourlySpendWei: parseEther("0.05") });
  const submit = (call) => relay({ kind: call.kind, to: call.to, data: call.data });
  const provers = { shield: await finalProver("shield"), transfer: await finalProver("transfer"), unshield: await finalProver("unshield") };
  const cfg = { publicClient: pub, chainId: ELYSIUM_TESTNET_ID, pool: stack.pool, poolBlock, payMemo: stack.payMemo, provers, submit };
  const A = await GloamCore.unlock(alice.wallet, cfg);
  const B = await GloamCore.unlock(bob.wallet, cfg);
  await A.shield(alice.wallet, zeroAddress, parseEther("2"));
  const sent = await A.send(zeroAddress, await B.address(), parseEther("1"));
  await B.sync();
  assert((await B.balances()).get(zeroAddress) === parseEther("1"), "a private send and Bob's sweep go through the keeper's relay");
  const tx = await pub.getTransaction({ hash: sent.txHashes[0] });
  assert(tx.from.toLowerCase() === keeper.account.address.toLowerCase(), "the keeper is the sender");

  await rejects(relay({ to: alice.account.address, data: "0x" }), "an address the relay doesn't serve is refused");
  await rejects(relay({ to: stack.pool, data: encodeFunctionData({ abi: parseAbi(["function collectFees(address)"]), functionName: "collectFees", args: [zeroAddress] }) }), "a vault function other than transfer and unshield is refused");
  // a call that would revert (a made-up proof) is refused at simulation and costs the keeper nothing
  const before = await pub.getBalance({ address: keeper.account.address });
  const bad = encodeFunctionData({ abi: parseAbi(["function unshield(bytes proof, bytes32 root, bytes32 nullifier, address asset, address to, uint256 amount)"]), functionName: "unshield", args: ["0x" + "11".repeat(256), "0x" + "22".repeat(32), "0x" + "33".repeat(32), zeroAddress, alice.account.address, 1n] });
  await rejects(relay({ to: stack.pool, data: bad }), "a call that would revert is refused before sending");
  assert((await pub.getBalance({ address: keeper.account.address })) === before, "and cost the keeper no gas");
  // the hourly budget: after it, the relay answers 429 and the user can still send it themselves
  let hit = null;
  for (let i = 0; i < 400 && !hit; i++) {
    try {
      await relay({ to: stack.payMemo, data: encodeFunctionData({ abi: parseAbi(["function postMemo(bytes32,bytes)"]), functionName: "postMemo", args: ["0x" + (i + 1).toString(16).padStart(64, "0"), "0x" + "ab".repeat(4000)] }) });
    } catch (e) {
      hit = e;
    }
  }
  assert(hit?.status === 429, "memo spam runs into the hourly gas budget (429), then stops costing the keeper");
  console.log(`\nPart 3b passed in ${Math.round((performance.now() - t0) / 1000)} s`);
} finally {
  L.stop();
}
process.exit(0);
