// Shared setup for the off-chain stress scripts (e2e-gloam/stress/*.mjs): anvil on a port in 8600-8649, Cloak v2's
// full stack (deployCloakGloam, realistic: USDC only in Gloam's vault), final-key provers, a relay, and helpers.
// Local anvil only. Nothing here talks to a live chain.
import { encodeFunctionData, parseAbi, parseEther, zeroAddress } from "viem";
import { GloamCore, GloamPrivate } from "@cloakely/sdk";
import { createGloamRelay } from "../../services/keeper/gloam.mjs";
import { createGloamLoop } from "../../services/keeper/gloamLoop.mjs";
import { deployCloakGloam } from "../stack.mjs";
import { ANVIL_KEYS, ELYSIUM_TESTNET_ID, clients, finalProver, proofLog, rpc, sendAndLog, startAnvil } from "../lib.mjs";

// another tester's forge files under contracts-gloam/test/stress may not compile: leave them out of our builds
process.env.FOUNDRY_SKIP ??= '["test/stress/**"]';

export { ANVIL_KEYS, ELYSIUM_TESTNET_ID, clients, finalProver, proofLog, rpc, sendAndLog, startAnvil, createGloamRelay, createGloamLoop, GloamCore, GloamPrivate };

export const UNSHIELD = parseAbi(["function unshield(bytes proof, bytes32 root, bytes32 nullifier, address asset, address to, uint256 amount)"]);
export const MEMO = parseAbi(["function postMemo(bytes32 paymentCommitment, bytes memo)"]);

/** Results collected by a script, printed as a summary at the end. */
export const results = [];
export function record(id, ok, detail) {
  results.push({ id, ok, detail });
  console.log(`  ${ok ? "HELD" : "BUG "} ${id}: ${detail}`);
}

export const ms = (t) => Math.round(performance.now() - t);
export const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : 0;
};

/**
 * Starts anvil and deploys the stack. Returns everything a stress script needs.
 * @param blockTime seconds per block (undefined = automine, like the e2e parts; a number = a real chain's pace)
 */
export async function setup({ port, blockTime, roundSecs = 60n, seed = { hype: parseEther("50"), tokens: parseEther("50000") }, hourly = "5", relayOpts = {} } = {}) {
  const anvil = await startAnvil({ port });
  const rpcUrl = anvil.rpcUrl;
  const who = (i) => clients(rpcUrl, ANVIL_KEYS[i], ELYSIUM_TESTNET_ID);
  const dep = who(0);
  const keeper = who(8);
  const pub = dep.pub;
  const warp = async (s) => (await rpc(rpcUrl, "evm_increaseTime", [Number(s)]), await rpc(rpcUrl, "evm_mine"));
  const { contracts: c, block } = await deployCloakGloam({ me: dep, rpcUrl, pk: ANVIL_KEYS[0], roundSecs, seed, warp });
  // after deploy, switch to interval mining if asked (deploys are much faster on automine)
  if (blockTime) {
    await rpc(rpcUrl, "evm_setAutomine", [false]);
    await rpc(rpcUrl, "evm_setIntervalMining", [blockTime]);
  }
  const relay = createGloamRelay({ publicClient: pub, walletClient: keeper.wallet, vault: c.gloamVault, launchVault: c.launchVault, memoBoard: c.memoBoard, escrows: [c.launchSwap, c.batcher, c.fundsGate, c.receive], hourlySpendWei: parseEther(hourly), ...relayOpts });
  const loop = createGloamLoop({ publicClient: pub, account: keeper.account, send: async (call) => (await sendAndLog(pub, call.functionName, keeper.wallet.writeContract(call))).transactionHash, launchVault: c.launchVault, batcher: c.batcher, batcherBlock: block, relay });
  await loop.tick(); // admits the launch token
  const provers = { shield: await finalProver("shield"), transfer: await finalProver("transfer"), unshield: await finalProver("unshield") };
  const cfgFor = (submit, records) => ({
    publicClient: pub,
    chainId: ELYSIUM_TESTNET_ID,
    gloamVault: { pool: c.gloamVault, poolBlock: block },
    launchVault: { pool: c.launchVault, poolBlock: block },
    payMemo: c.memoBoard,
    provers,
    submit,
    whype: c.whypeStandIn,
    launchSwap: c.launchSwap,
    batcher: c.batcher,
    receive: c.receive,
    records,
  });
  const viaRelay = (sender = "anon", r = relay) => (call) => r({ kind: call.kind, to: call.to, data: call.data }, { sender });
  const memRecords = () => {
    let saved = [];
    return { load: () => saved, save: (r) => (saved = r) };
  };
  return { anvil, rpcUrl, who, dep, keeper, pub, warp, c, block, relay, loop, provers, cfgFor, viaRelay, memRecords, stop: () => anvil.stop() };
}

/** n launch-vault HYPE notes for a GloamCore-on-the-launch-vault, deposited straight from the wallet. */
export async function launchCore(S, i, submit) {
  const w = S.who(i);
  const core = await GloamCore.unlock(w.wallet, { publicClient: S.pub, chainId: ELYSIUM_TESTNET_ID, pool: S.c.launchVault, poolBlock: S.block, payMemo: S.c.memoBoard, provers: S.provers, submit: submit ?? S.viaRelay(`w${i}`) });
  return { core, w };
}

/** An unshield call (proved, not sent) spending `note` to `to`. */
export async function unshieldCall(core, note, to) {
  const s = await core.spendProof(note, to);
  return { to: core.config.pool, data: encodeFunctionData({ abi: UNSHIELD, functionName: "unshield", args: [s.proof, s.root, s.nullifier, s.asset, to, s.amount] }), nullifier: s.nullifier };
}

export function summary(name) {
  const bugs = results.filter((r) => !r.ok);
  console.log(`\n${name}: ${results.length} checks, ${bugs.length} found a problem`);
  for (const b of bugs) console.log(`  - ${b.id}: ${b.detail}`);
}

export { zeroAddress, parseEther };
