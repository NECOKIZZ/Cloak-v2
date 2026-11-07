// Protocol fees waiting in the vaults go to the treasury once every two days (OPTIMIZATION.md R1). Launches and drops
// already pay their fee out when they settle; withdrawal fees stay in each vault until someone calls collectFees(),
// which anyone may do because the destination is fixed in CloakConfig (feeRecipient). This only triggers it.
//
// - When it last ran is read back from the chain (the vaults' FeesCollected events), so a restart neither runs it twice
//   nor forgets it.
// - Each collection is simulated first, and skipped when the fee is worth less than a few times its gas.
import { parseAbi } from "viem";

const VAULT = parseAbi(["function feesOwed() view returns (uint256)", "function collectFees()", "event FeesCollected(address indexed to, uint256 amount)"]);
const SHARED = parseAbi(["function feesOwed(address) view returns (uint256)", "function collectFees(address)", "event FeesCollected(address indexed token, address indexed to, uint256 amount)"]);

/**
 * @param o.pub          public client
 * @param o.wallet       wallet client whose writes are already serialized with the keeper's other sends
 * @param o.account      the keeper's address
 * @param o.vaults       async () => [{ pool, token }] every vault with a feesOwed() (token null for HYPE)
 * @param o.shared       the shared vault's address, or undefined
 * @param o.sharedTokens async () => token addresses in the shared vault
 * @param o.valueInHype  async (token, amount) => the amount's worth in HYPE wei, or null when it can't be priced
 * @param o.everyMs      how often (default 48 h); 0 turns it off
 * @param o.minGasMultiple collect only when the fee is worth at least this many times its gas (default 3)
 */
export function startFeeCollector(o) {
  const everyMs = o.everyMs ?? 48 * 3600_000;
  const state = { lastAt: null, lastRun: null, running: false, off: everyMs <= 0 };
  if (state.off) return state;
  const log = o.log ?? console.log;
  const multiple = BigInt(o.minGasMultiple ?? 3);

  /** The newest FeesCollected on any vault inside the window, as a time in ms, or 0 when there is none. */
  async function lastFromChain() {
    const head = await o.pub.getBlock();
    const older = await o.pub.getBlock({ blockNumber: head.number > 10_000n ? head.number - 10_000n : 0n });
    const span = Number(head.number - older.number) || 1;
    const secsPerBlock = Math.max(0.05, Number(head.timestamp - older.timestamp) / span);
    const back = BigInt(Math.ceil((everyMs / 1000) / secsPerBlock));
    const fromBlock = head.number > back ? head.number - back : 0n;
    const vaults = await o.vaults();
    const [a, b] = await Promise.all([
      vaults.length ? o.pub.getLogs({ address: vaults.map((v) => v.pool), event: VAULT[2], fromBlock, toBlock: head.number }) : [],
      o.shared ? o.pub.getLogs({ address: o.shared, event: SHARED[2], fromBlock, toBlock: head.number }) : [],
    ]);
    const newest = [...a, ...b].reduce((m, l) => (l.blockNumber > m ? l.blockNumber : m), -1n);
    if (newest < 0n) return 0;
    return Number((await o.pub.getBlock({ blockNumber: newest })).timestamp) * 1000;
  }

  /** Collect one vault's fees if they're worth the gas. Returns the hash, or a reason it was skipped. */
  async function one(call, token, owed, gasPrice) {
    try {
      const { request } = await o.pub.simulateContract({ ...call, account: o.account });
      const gas = await o.pub.estimateContractGas({ ...call, account: o.account });
      const worth = await o.valueInHype(token, owed).catch(() => null);
      if (worth === null) return "no price";
      if (worth < gas * gasPrice * multiple) return "worth less than the gas";
      return await o.wallet.writeContract(request);
    } catch (e) {
      return `failed: ${e.shortMessage ?? e.message}`;
    }
  }

  async function run() {
    if (state.running) return;
    state.running = true;
    const out = { at: Date.now(), collected: 0, skipped: 0 };
    try {
      const gasPrice = await o.pub.getGasPrice();
      const vaults = await o.vaults();
      const owed = await Promise.all(vaults.map((v) => o.pub.readContract({ address: v.pool, abi: VAULT, functionName: "feesOwed" }).catch(() => 0n)));
      for (const [i, v] of vaults.entries()) {
        if (owed[i] === 0n) continue;
        const r = await one({ address: v.pool, abi: VAULT, functionName: "collectFees" }, v.token, owed[i], gasPrice);
        if (r.startsWith("0x")) out.collected++, log(`collected ${owed[i]} from ${v.pool} ${r}`);
        else out.skipped++, log(`skipped ${v.pool} (${owed[i]}): ${r}`);
      }
      if (o.shared) {
        const tokens = await o.sharedTokens();
        const sOwed = await Promise.all(tokens.map((t) => o.pub.readContract({ address: o.shared, abi: SHARED, functionName: "feesOwed", args: [t] }).catch(() => 0n)));
        for (const [i, t] of tokens.entries()) {
          if (sOwed[i] === 0n) continue;
          const r = await one({ address: o.shared, abi: SHARED, functionName: "collectFees", args: [t] }, t, sOwed[i], gasPrice);
          if (r.startsWith("0x")) out.collected++, log(`collected ${sOwed[i]} of ${t} from the shared vault ${r}`);
          else out.skipped++, log(`skipped ${t} in the shared vault (${sOwed[i]}): ${r}`);
        }
      }
      log(`done: ${out.collected} collected, ${out.skipped} skipped`);
    } catch (e) {
      log(`run failed: ${e.shortMessage ?? e.message}`);
    } finally {
      // a failed run waits for the next window too: fees stay safely in the vaults meanwhile
      state.lastAt = Date.now();
      state.lastRun = out;
      state.running = false;
    }
  }

  (async () => {
    // let the keeper's start-up work go first
    await new Promise((r) => setTimeout(r, o.startDelayMs ?? 5 * 60_000));
    state.lastAt = await lastFromChain().catch((e) => (log(`couldn't read the last collection, assuming none: ${e.shortMessage ?? e.message}`), 0));
    if (state.lastAt) log(`last collected ${new Date(state.lastAt).toISOString()}`);
    for (;;) {
      if (Date.now() - state.lastAt >= everyMs) await run();
      await new Promise((r) => setTimeout(r, Math.min(everyMs, o.checkMs ?? 30 * 60_000)));
    }
  })();
  return state;
}
