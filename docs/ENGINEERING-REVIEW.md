# Engineering review (Nov 10)

A full read of Cloak's own code: `contracts-gloam/src`, `contracts-v4/src`, the keeper, and a pass over the SDK and the site. Nothing in the code was changed. Every finding has a suggested fix, and the three with code are in `docs/patches/review-nov10-proposed-fixes.patch` (not applied).

**Tests as they stand:** `contracts` 119 of 119, `contracts-gloam` 171 of 171, `contracts-v4` 205 of 205. The SDK, MCP, site build and end-to-end runs were not run in this review.

**Short version.** The design holds up: no owner can move user funds, every escrow has a way out, the batcher's pricing fixes from the earlier reviews are in. One new bug can lock a user's money for good (R-01) and should be fixed before the mainnet deploy, since the fix needs new contracts. The rest is small. The bigger risks are operational: one software wallet owns everything, the keeper runs on a free host with its state in memory, and Cloak's contracts have no outside audit yet.

## Findings

| ID | Severity | Where | Checked how |
|---|---|---|---|
| R-01 | Medium | `CloakGloamBatcherBase.place`, `CloakGraduation.enter` | Two failing tests |
| R-02 | Low | `CloakV4Hook.collectFees` | Reading |
| R-03 | Low | Keeper relay | Reading |
| R-04 | Low | `CloakGloamBatcherBase._settle` | Reading |
| R-05 | Low | `CloakGloamBatcherBase._openEscrow` | Reading |
| R-06 | Info | SDK split withdrawals | Reading |
| O-01 to O-04 | Optimization | Keeper | Reading |

### R-01 (Medium): a 1-unit top-up locks a spend that was sent alone

- **What happens.** When an order's spend is sent alone (the unshield lands without `place`), the money waits at the order's one-time escrow, and that address is now public. `place` then refuses anything that arrives above the order's size (`net > k.size` reverts `NotStandard`). So anyone who sends 1 wei (or 1 token unit) to that escrow makes `place` revert every time. The batcher has no other way to open the escrow, so the money stays there for good. `CloakGraduation.enter` has the same check and the same result.
- **Who can do it.** Whoever holds the proof can send the spend alone: the relay, or the sequencer. After that, anyone can do the top-up. This breaks the promise in `SECURITY.md` that the relay "can only refuse or delay".
- **Cost to the attacker.** With a vault fee of 0 (the mainnet plan for Cloak's vaults) it is 1 unit. With Gloam's 0.5% fee on HYPE it is 0.5% of the order plus 1 wei, to lock the other 99.5%.
- **Fix.** Keep the lower bound (it is what stops orders paid from outside, C-07) and clamp the upper one: `if (net > k.size) net = k.size;`. The extra stays in the contract and is the sender's loss. An outsider could already fund an escrow with exactly the size, so the clamp opens nothing new.
- **Tests.** `test_batcher_spentAloneEscrow_toppedUp_stillPlaces` and `test_graduation_spentAloneEscrow_toppedUp_stillEnters` in the patch. Both fail today and pass with the fix, with the whole suite at 173 of 173.
- **Needs a redeploy.** The testnet batcher and graduation contracts carry the bug. Fix it before the mainnet deploy.

### R-02 (Low): a creator that refuses HYPE blocks Cloak's 20% of that pool's fees

- `collectFees` pays the treasury and the creator in one `unlock`. If the creator is a contract that reverts on receiving HYPE, the whole call reverts, and Cloak's share of that launch's trading fees can never be collected. Only the creator's own launch is affected.
- **Fix (next hook).** Pay the treasury first and never let the creator's payment revert the call: on failure, keep the creator's share owed in the hook for a later claim.

### R-03 (Low): the same relayed call sent several times burns the relay's gas

- The relay simulates a call when it arrives, then queues it behind the keeper's other sends. Copies of one escrow call that arrive together all pass the simulation, and all but the first revert on chain. A failed CREATE2 uses nearly the whole gas limit, so each copy is expensive. The per-sender cap on failed sends (10% of the hour's budget) bounds it, per IP.
- **Fix (in the patch, `services/keeper/index.mjs`).** Simulate again when it is the call's turn to send. One that would now revert is refused with a 400 and costs nothing. Not run end to end yet.

### R-04 (Low): silent `uint128` casts in the batcher's settlement

- `b.tokensForBuyers = uint128(b.sellTokens + got)` and the three casts beside it cut off silently above 2^128. Cloak's launch tokens can't reach that, but an ecosystem token with a very large supply could.
- **Fix.** Revert on overflow (a checked cast).

### R-05 (Low): the batcher opens an escrow without checking it was opened before

- `CloakLaunchSwap` and `CloakGraduation` check `code.length` first, so a repeat fails cheaply. The batcher doesn't, so a repeated `place` burns the gas sent to the failed deploy. Add the same check.

### R-06 (Info): `Math.random` picks split-withdrawal sizes and times

- `splitAmount` (`private/common.ts`) and the piece times (`gloamPrivate.ts`) use `Math.random`. These values only shape how a withdrawal looks, so no money is at risk, but they are a privacy feature and a predictable generator is the wrong tool. Use `crypto.getRandomValues`.

### Optimization

- **O-01, `/leaves?pool=` (in the patch).** The site asks for one vault at a time, and the keeper rebuilds and gzips the whole leaf list on every such request. Only the all-vaults answer is cached. On a single thread this stalls relays as the vaults grow. Cache each vault's answer until the next refresh.
- **O-02, the admit and register loops.** `nextLaunch` and `nextRegister` stop at the first launch that isn't settled. One launch that never settles makes every later launch be read again every tick, for good. Keep a set of the unsettled ones instead.
- **O-03, gate confirmation.** One read per wallet, one after another. Group them into one multicall per page of 200.
- **O-04, memory.** The scheduled-piece queue and the memo set have no size limit apart from the rate limit. Cap the queue.

## Operational risks

These matter more than the code findings.

1. **One software wallet owns everything** (both vault guards, the launch rules, the trade fee, the pauser). `MAINNET-DECISIONS.md` accepts this until there is a second person. The timelocks limit what a stolen key can do, but it can still pause, list tokens and queue changes. Use a hardware wallet from day one, and move to a multisig before the caps are lifted.
2. **The keeper keeps its state in memory on a free host.** After a restart or a sleep it forgets the hourly budgets, the per-spend locks, the record of sends still in flight and the queued withdrawal pieces. The site hands pieces back, but only if the user opens it again. For mainnet: a paid instance that doesn't sleep, and the send records and queue on disk.
3. **One keeper, one relay, one key.** If it is down, nothing is revealed, settled or relayed. Funds stay safe and every action can be sent by hand, but the site has no fallback. Run a second keeper (the code says racing is harmless).
4. **No outside audit of Cloak's contracts.** Already stated in `SECURITY.md`. The deposit caps are the only limit on loss until then.
5. **CI runs only by hand or on a pull request, and skips `contracts/`.** The launch contracts (auction, factory, drops) are deployed by this repo for v2 but tested only locally. Add `cd contracts && forge test` to the workflow.

## What is incomplete

**Not built or not done:**
- Mainnet: no filled configs (only the `.example.json` files), no deployment record, and no mainnet entry in the SDK (`deploymentFor(99901)` has nothing to return). Every box in `docs/MAINNET-CHECKLIST.md` is open.
- Source verification on the explorer (waiting on Kinetiq's API).
- Escrows that post their payout's memo in the same transaction (waiting on Gloam's memo board).
- `bidPrivately` answers "coming soon" on a deployment built without the bids contract.

**Decided for "the next factory" and not built:**
- A drand round for the drop tie lottery (CL-01's last gap: the sequencer could grind the block hash).
- A notional floor per tick (CL-02).
- A check that a sealed bid opens to its commitment, if Elysium has EIP-2537 (report 2.1). Nobody has checked yet.
- A cap on the reveal window (W-08): the contracts and the form still accept any length.

**Waiting on a decision or a manual check (`CHECK.md`):**
- W-01 (High): one wallet can fill a launch's deposit cap at the minimum price.
- W-10: the account that wouldn't unlock after a reload mid-withdrawal (seen twice, never reproduced).
- W-11 and W-12: a payment link over the balance hangs; dust links are accepted.
- Every hosted check in `CHECK.md` sections 1 to 3.

**Waiting on others:**
- Gloam: HYPE and KNTQ opening in their vault, the memo board date, the fee share.
- Kinetiq: whether Timeboost is on, and the verification API.

## Suggested order

1. Apply R-01 with its tests, and R-04 and R-05 with it, since all three need the same redeploy.
2. Apply R-03 and O-01 to the keeper, and run parts 3 and 18 of the end-to-end runs.
3. Add `contracts/` to CI.
4. Decide W-01 and W-08 before the mainnet factory is deployed, because both need the factory.
5. Move the keeper to a host that doesn't sleep and put its send records on disk before public launch.
