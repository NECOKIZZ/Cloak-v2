// The keeper's loop for Cloak v2 on Gloam: the follow-ups that need no user secret.
//   - admit every settled Cloak launch to the launch vault (CloakLaunchVault.admitLaunch, anyone may call it), so its
//     token can be deposited the moment its launch settles;
//   - collect the launch vault's HYPE fees for the relay's budget (the relay does it on demand too);
//   - register every settled launch's v4 market with CloakGloamBatcherV4 (register, anyone may call it), so its batch
//     rounds can open;
//   - settle each batch round (CloakGloamBatcher and CloakGloamBatcherV4) once it ends, or cancel it once it is past
//     its refund time;
//   - confirm every wallet still eligible in an allocation gate (CloakFundsGate.confirm) once the gate closes, so its
//     owner is free to spend and the creator has a fixed list.
//
// What it can't do: anything that spends or signs for a user. A swap's leftover, a bid's or a batch order's payout all
// need the account's seed, so the app does them on open (finishPending in the SDK).
//
// Every call is simulated first and only sent if it would succeed, so a round that can't settle yet (price moved,
// too much impact) costs nothing and is tried again next time.
import { parseAbi, parseAbiItem } from "viem";
import { logsSplitting, readToHead } from "@cloakely/sdk";

const LV_ABI = parseAbi([
  "function admitLaunch(uint256 launchIndex) returns (address)",
  "function isLaunchToken(address) view returns (bool)",
  "function factory() view returns (address)",
]);
const FACTORY_ABI = parseAbi([
  "function launchesCount() view returns (uint256)",
  "function launches(uint256) view returns (address auction, address token, address creator, address launchpad, uint256 creatorAlloc, address vesting)",
]);
const AUCTION_ABI = parseAbi(["function settled() view returns (bool)", "function pair() view returns (address)"]);
const BATCHER_V4_ABI = parseAbi(["function register(uint256 launchIndex) returns (address)", "function marketOf(address) view returns (address)", "function launchFactory() view returns (address)"]);
const ZERO = "0x0000000000000000000000000000000000000000";
const BATCHER_ABI = parseAbi([
  "function settle(address token, uint64 round)",
  "function cancel(address token, uint64 round)",
  "function roundSecs() view returns (uint256)",
  "function refundAfter() view returns (uint256)",
  "function batches(address, uint64) view returns (uint128 buyHype, uint128 sellTokens, uint128 tokensForBuyers, uint128 hypeForSellers, uint256 spotStart, uint64 settledAt, bool settled, bool cancelled, uint256 cumStart, uint64 tStart)",
  "function settleOpens(address token, uint64 round) view returns (uint256)",
]);
const GATE_ABI = parseAbi([
  "function gatesCount() view returns (uint256)",
  "function gates(uint256) view returns (address creator, address asset, uint128 threshold, uint64 closesAt, uint32 entered, uint32 confirmed)",
  "function wallets(uint256 gateId, uint256 start, uint256 count) view returns (address[])",
  "function isEligible(uint256 gateId, address wallet) view returns (bool)",
  "function isConfirmed(uint256 gateId, address wallet) view returns (bool)",
  "function confirm(uint256 gateId, address wallet)",
]);
const ORDER_PLACED = parseAbiItem("event OrderPlaced(bytes32 indexed id, address indexed token, uint64 indexed round, bool buy, uint256 size, uint256 net)");

/**
 * @param send (call) => Promise<hash>: sends one contract call ({address, abi, functionName, args}) from the keeper's
 *        wallet, one at a time
 * @param launchVault CloakLaunchVault, or omit it
 * @param launchFactory a factory other than the vault's own (for tests); default: the vault's factory()
 * @param batcher CloakGloamBatcher, or omit it; batcherBlock: where to read its orders from
 * @param batcherV4 CloakGloamBatcherV4, or omit it; batcherV4Block: where to read its orders from
 * @param relay the Gloam relay, for collectLaunchFees(); or omit it
 */
export function createGloamLoop({ publicClient, account, send, launchVault, launchFactory, batcher, batcherBlock = 0n, batcherV4, batcherV4Block = 0n, fundsGate, relay, log = () => {} }) {
  let nextLaunch = 0n;
  const gatesDone = new Set(); // gates whose entries are all confirmed or dropped
  let nextRegister = 0n;
  // per batcher: where to read new orders from
  const batchers = [batcher && { address: batcher, from: batcherBlock }, batcherV4 && { address: batcherV4, from: batcherV4Block }].filter(Boolean);
  const open = new Map(); // `${batcher}:${token}:${round}` -> { batcher, token, round }

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

  async function registerMarkets() {
    if (!batcherV4) return [];
    const factory = launchFactory ?? (await publicClient.readContract({ address: batcherV4, abi: BATCHER_V4_ABI, functionName: "launchFactory" }));
    const count = await publicClient.readContract({ address: factory, abi: FACTORY_ABI, functionName: "launchesCount" });
    const registered = [];
    let firstOpen = null;
    for (let i = nextRegister; i < count; i++) {
      const [auction, token] = await publicClient.readContract({ address: factory, abi: FACTORY_ABI, functionName: "launches", args: [i] });
      if ((await publicClient.readContract({ address: batcherV4, abi: BATCHER_V4_ABI, functionName: "marketOf", args: [token] })) !== ZERO) continue;
      if (!(await publicClient.readContract({ address: auction, abi: AUCTION_ABI, functionName: "settled" }))) {
        if (firstOpen === null) firstOpen = i;
        continue;
      }
      const market = await publicClient.readContract({ address: auction, abi: AUCTION_ABI, functionName: "pair" }).catch(() => ZERO);
      if (market === ZERO) continue; // a launch with no market (failed, or from before markets)
      const call = { address: batcherV4, abi: BATCHER_V4_ABI, functionName: "register", args: [i] };
      if (!(await ok(call))) continue;
      registered.push({ index: i, token, market, hash: await send(call) });
      log(`[gloam loop] registered launch ${i} (${token}) for v4 batch rounds`);
    }
    nextRegister = firstOpen ?? count;
    return registered;
  }

  async function settleRounds() {
    if (!batchers.length) return [];
    // up to a fresh head (a cached one would skip new orders for a tick), a few blocks back if a lagging node of the RPC
    // refuses the range (readToHead); the cursor moves only past what was read
    for (const b of batchers) {
      const { to, value: logs } = await readToHead(publicClient, async (to) => (b.from > to ? [] : logsSplitting((x, y) => publicClient.getLogs({ address: b.address, event: ORDER_PLACED, fromBlock: x, toBlock: y }), b.from, to)));
      for (const l of logs) open.set(`${b.address.toLowerCase()}:${l.args.token.toLowerCase()}:${l.args.round}`, { batcher: b.address, token: l.args.token, round: l.args.round });
      if (to + 1n > b.from) b.from = to + 1n;
    }
    if (!open.size) return [];
    const now = (await publicClient.getBlock()).timestamp;
    const timing = new Map();
    const timingOf = async (addr) => {
      if (!timing.has(addr)) {
        const [roundSecs, refundAfter] = await Promise.all([
          publicClient.readContract({ address: addr, abi: BATCHER_ABI, functionName: "roundSecs" }),
          publicClient.readContract({ address: addr, abi: BATCHER_ABI, functionName: "refundAfter" }),
        ]);
        timing.set(addr, { roundSecs, refundAfter });
      }
      return timing.get(addr);
    };
    const done = [];
    for (const [k, { batcher: addr, token, round }] of open) {
      const b = await publicClient.readContract({ address: addr, abi: BATCHER_ABI, functionName: "batches", args: [token, round] });
      if (b[6] || b[7]) {
        open.delete(k);
        continue;
      }
      const { refundAfter } = await timingOf(addr);
      // a round settles once it has ended and its average covers a whole round, within refundAfter of that
      const ends = await publicClient.readContract({ address: addr, abi: BATCHER_ABI, functionName: "settleOpens", args: [token, round] });
      if (now < ends) continue;
      const settle = { address: addr, abi: BATCHER_ABI, functionName: "settle", args: [token, round] };
      if (await ok(settle)) {
        const hash = await send(settle);
        // forgotten only once the chain says so: a settle that reverted (the pool moved in the same block) is tried
        // again next tick, then cancelled in time (review O-07)
        const after = await publicClient.readContract({ address: addr, abi: BATCHER_ABI, functionName: "batches", args: [token, round] });
        if (after[6]) {
          done.push({ batcher: addr, token, round, action: "settled", hash });
          open.delete(k);
          log(`[gloam loop] settled batch round ${round} of ${token}`);
        } else log(`[gloam loop] settle of round ${round} of ${token} didn't take (${hash}), trying again next tick`);
        continue;
      }
      if (now >= ends + refundAfter) {
        const cancel = { address: addr, abi: BATCHER_ABI, functionName: "cancel", args: [token, round] };
        if (await ok(cancel)) {
          const hash = await send(cancel);
          const after = await publicClient.readContract({ address: addr, abi: BATCHER_ABI, functionName: "batches", args: [token, round] });
          if (!after[7]) continue; // didn't take: next tick
          done.push({ batcher: addr, token, round, action: "cancelled", hash });
          open.delete(k);
          log(`[gloam loop] cancelled batch round ${round} of ${token}: it couldn't settle in time, every order is owed its input back`);
        }
      }
    }
    return done;
  }

  async function confirmGates() {
    if (!fundsGate) return [];
    const now = (await publicClient.getBlock()).timestamp;
    const count = await publicClient.readContract({ address: fundsGate, abi: GATE_ABI, functionName: "gatesCount" });
    const out = [];
    for (let id = 0n; id < count; id++) {
      if (gatesDone.has(id)) continue;
      const g = await publicClient.readContract({ address: fundsGate, abi: GATE_ABI, functionName: "gates", args: [id] });
      if (now <= g[3]) continue; // still open
      let open = false;
      for (let start = 0n; ; start += 200n) {
        const ws = await publicClient.readContract({ address: fundsGate, abi: GATE_ABI, functionName: "wallets", args: [id, start, 200n] });
        for (const w of ws) {
          if (await publicClient.readContract({ address: fundsGate, abi: GATE_ABI, functionName: "isConfirmed", args: [id, w] })) continue;
          if (!(await publicClient.readContract({ address: fundsGate, abi: GATE_ABI, functionName: "isEligible", args: [id, w] }))) continue; // dropped out
          const call = { address: fundsGate, abi: GATE_ABI, functionName: "confirm", args: [id, w] };
          if (!(await ok(call))) {
            open = true;
            continue;
          }
          out.push({ gateId: id, wallet: w, hash: await send(call) });
          log(`[gloam loop] confirmed ${w} in gate ${id}`);
        }
        if (ws.length < 200) break;
      }
      if (!open) gatesDone.add(id);
    }
    return out;
  }

  async function tick() {
    const out = { admitted: [], registered: [], rounds: [], confirmed: [], feesCollected: 0n, errors: [] };
    const step = async (name, fn) => {
      try {
        return await fn();
      } catch (e) {
        out.errors.push(`${name}: ${e.shortMessage ?? e.message}`);
        log(`[gloam loop] ${name} failed: ${e.shortMessage ?? e.message}`);
      }
    };
    out.admitted = (await step("admit launches", admitLaunches)) ?? [];
    out.registered = (await step("register v4 markets", registerMarkets)) ?? [];
    out.rounds = (await step("settle rounds", settleRounds)) ?? [];
    out.confirmed = (await step("confirm gates", confirmGates)) ?? [];
    if (relay?.collectLaunchFees) out.feesCollected = (await step("collect fees", () => relay.collectLaunchFees())) ?? 0n;
    return out;
  }

  return { tick, admitLaunches, registerMarkets, settleRounds, confirmGates, pendingRounds: () => [...open.values()] };
}
