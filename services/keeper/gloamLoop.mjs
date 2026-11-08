// The keeper's loop for Cloak v2 on Gloam: the follow-ups that need no user secret.
//   - admit every settled Cloak launch to the launch vault (CloakLaunchVault.admitLaunch, anyone may call it), so its
//     token can be deposited the moment its launch settles;
//   - collect the launch vault's HYPE fees for the relay's budget (the relay does it on demand too);
//   - settle each batch round (CloakGloamBatcher.settle) once it ends, or cancel it once it is past its refund time.
//
// What it can't do: anything that spends or signs for a user. A swap's leftover, a graduation's exit, a bid's or batch
// order's payout all need the account's seed, so the app does them on open (finishPending in the SDK). A graduation's
// 30-day timeout exit needs the entry's key, which only the app has.
//
// Every call is simulated first and only sent if it would succeed, so a round that can't settle yet (price moved,
// too much impact) costs nothing and is tried again next time.
import { parseAbi, parseAbiItem } from "viem";

const LV_ABI = parseAbi([
  "function admitLaunch(uint256 launchIndex) returns (address)",
  "function isLaunchToken(address) view returns (bool)",
  "function factory() view returns (address)",
]);
const FACTORY_ABI = parseAbi([
  "function launchesCount() view returns (uint256)",
  "function launches(uint256) view returns (address auction, address token, address creator, address launchpad, uint256 creatorAlloc, address vesting)",
]);
const AUCTION_ABI = parseAbi(["function settled() view returns (bool)"]);
const BATCHER_ABI = parseAbi([
  "function settle(address token, uint64 round)",
  "function cancel(address token, uint64 round)",
  "function roundSecs() view returns (uint256)",
  "function refundAfter() view returns (uint256)",
  "function batches(address, uint64) view returns (uint128 buyHype, uint128 sellTokens, uint128 tokensForBuyers, uint128 hypeForSellers, uint256 spotStart, uint64 settledAt, bool settled, bool cancelled)",
]);
const ORDER_PLACED = parseAbiItem("event OrderPlaced(bytes32 indexed id, address indexed token, uint64 indexed round, bool buy, uint256 size, uint256 net)");

/**
 * @param send (call) => Promise<hash>: sends one contract call ({address, abi, functionName, args}) from the keeper's
 *        wallet, one at a time
 * @param launchVault CloakLaunchVault, or omit it
 * @param launchFactory a factory other than the vault's own (for tests); default: the vault's factory()
 * @param batcher CloakGloamBatcher, or omit it; batcherBlock: where to read its orders from
 * @param relay the Gloam relay, for collectLaunchFees(); or omit it
 */
export function createGloamLoop({ publicClient, account, send, launchVault, launchFactory, batcher, batcherBlock = 0n, relay, log = () => {} }) {
  let nextLaunch = 0n;
  let ordersFrom = batcherBlock;
  const open = new Map(); // `${token}:${round}` -> { token, round }

  const ok = async (call) => {
    try {
      await publicClient.simulateContract({ ...call, account });
      return true;
    } catch {
      return false;
    }
  };

  async function admitLaunches() {
    if (!launchVault) return [];
    const factory = launchFactory ?? (await publicClient.readContract({ address: launchVault, abi: LV_ABI, functionName: "factory" }));
    const count = await publicClient.readContract({ address: factory, abi: FACTORY_ABI, functionName: "launchesCount" });
    const admitted = [];
    let firstOpen = null;
    for (let i = nextLaunch; i < count; i++) {
      const [auction, token] = await publicClient.readContract({ address: factory, abi: FACTORY_ABI, functionName: "launches", args: [i] });
      if (await publicClient.readContract({ address: launchVault, abi: LV_ABI, functionName: "isLaunchToken", args: [token] })) continue;
      if (!(await publicClient.readContract({ address: auction, abi: AUCTION_ABI, functionName: "settled" }))) {
        if (firstOpen === null) firstOpen = i; // come back to it
        continue;
      }
      const call = { address: launchVault, abi: LV_ABI, functionName: "admitLaunch", args: [i] };
      if (!(await ok(call))) continue; // the owner already gave it limits (AlreadyLimited): nothing to do
      const hash = await send(call);
      admitted.push({ index: i, token, hash });
      log(`[gloam loop] admitted launch ${i} (${token}) to the launch vault`);
    }
    nextLaunch = firstOpen ?? count;
    return admitted;
  }

  async function settleRounds() {
    if (!batcher) return [];
    const head = await publicClient.getBlockNumber();
    if (ordersFrom <= head) {
      const logs = await publicClient.getLogs({ address: batcher, event: ORDER_PLACED, fromBlock: ordersFrom, toBlock: head });
      for (const l of logs) open.set(`${l.args.token.toLowerCase()}:${l.args.round}`, { token: l.args.token, round: l.args.round });
      ordersFrom = head + 1n;
    }
    if (!open.size) return [];
    const now = (await publicClient.getBlock()).timestamp;
    const roundSecs = await publicClient.readContract({ address: batcher, abi: BATCHER_ABI, functionName: "roundSecs" });
    const refundAfter = await publicClient.readContract({ address: batcher, abi: BATCHER_ABI, functionName: "refundAfter" });
    const done = [];
    for (const [k, { token, round }] of open) {
      const b = await publicClient.readContract({ address: batcher, abi: BATCHER_ABI, functionName: "batches", args: [token, round] });
      if (b[6] || b[7]) {
        open.delete(k);
        continue;
      }
      const ends = (BigInt(round) + 1n) * roundSecs;
      if (now < ends) continue;
      const settle = { address: batcher, abi: BATCHER_ABI, functionName: "settle", args: [token, round] };
      if (await ok(settle)) {
        done.push({ token, round, action: "settled", hash: await send(settle) });
        open.delete(k);
        log(`[gloam loop] settled batch round ${round} of ${token}`);
        continue;
      }
      if (now >= ends + refundAfter) {
        const cancel = { address: batcher, abi: BATCHER_ABI, functionName: "cancel", args: [token, round] };
        if (await ok(cancel)) {
          done.push({ token, round, action: "cancelled", hash: await send(cancel) });
          open.delete(k);
          log(`[gloam loop] cancelled batch round ${round} of ${token}: it couldn't settle in time, every order is owed its input back`);
        }
      }
    }
    return done;
  }

  async function tick() {
    const out = { admitted: [], rounds: [], feesCollected: 0n, errors: [] };
    const step = async (name, fn) => {
      try {
        return await fn();
      } catch (e) {
        out.errors.push(`${name}: ${e.shortMessage ?? e.message}`);
        log(`[gloam loop] ${name} failed: ${e.shortMessage ?? e.message}`);
      }
    };
    out.admitted = (await step("admit launches", admitLaunches)) ?? [];
    out.rounds = (await step("settle rounds", settleRounds)) ?? [];
    if (relay?.collectLaunchFees) out.feesCollected = (await step("collect fees", () => relay.collectLaunchFees())) ?? 0n;
    return out;
  }

  return { tick, admitLaunches, settleRounds, pendingRounds: () => [...open.values()] };
}
