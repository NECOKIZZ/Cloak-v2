# Responses to outside reviews (Nov 8)

## Report 1: Haider Ali's AI-assisted review (Nov 7)

All 12 findings were handled in Cloak v1 on Nov 7 (v1's `SECURITY.md`). The contracts they touch are **byte-identical in this repo** (`contracts/src`, checked file by file against v1's `main`), and v1's regression suite passes here (274 of 274). What each one means for v2, which runs on Gloam's vault:

| ID | v1 outcome (same code here) | On v2's Gloam path |
|---|---|---|
| CL-01 drop tie lottery steerable | Fixed: the draw also takes the hash of the block after settlement, which nobody knows while bids can still be opened | Same drops. Residual: Elysium's single sequencer could in principle grind that hash. Bidders can't. A drand round after the reveal deadline would remove even that, so we propose it for the next drop factory. |
| CL-02 dust bid sets an undersubscribed price | By design: the uniform-price rule, in RULES.md, and the creator sets the minimum price | Same. Report 2 raises the same last-look, and the keeper now publishes unopenable bids. **Decision for Bob:** a notional floor per tick, as the reviewer suggests, would close it in the next factory. |
| CL-03 one actor fills the deposit cap | Accepted: the caps are temporary until the audit | Same for launches. Also check v2's own caps: the launch vault's HYPE total (1,000 on testnet) and Gloam's 25,000 USDC can be filled the same way. That only blocks new deposits and moves nobody's money. |
| CL-04 creator shill ladder | Mitigated: unopened drop bids lose 25% (was 10%) | Same drops |
| CL-05 `createPool` locks a token out of the shared vault | Fixed (`CloakVaults` refuses Uniswap launches) | Cloak's own vaults only. The v2 analogue, `CloakLaunchVault.admitLaunch`, is permissionless and one-shot, gives every factory launch the same fixed caps, and has no second path to lock a token out. |
| CL-06 one huge order stops a batch round | Fixed in v1's batchers (each side at most 4% of depth) | **Was present in v2's Gloam batcher. Fixed now:** `CloakGloamBatcherBase.MAX_SIDE_BPS = 400` (`RoundFull`). The SDK sizes orders to the room left (`batchRoom`) and keeps the rest in the balance. Tests: `test_CL06_a_whale_order_cant_stop_the_round`, and a full side still settles inside the 5% impact cap. On a fork, a 0.3 HYPE buy against a 0.43 HYPE pool went in as 0.017 and settled. |
| CL-07 no minimum naming window | Fixed: at least one day | Same spot book |
| CL-08 v4 sell proceeds refused by `PrivateRouter` | Fixed | Cloak's own router only. v2's `CloakLaunchSwapV4` takes HYPE from the PoolManager during its own swap, tested on the real PoolManager. |
| CL-09 withdraw fee skipped via the relayer fee | Fixed (the relayer fee pays the same protocol fee) | Cloak's own vaults only. Gloam's proofs carry no relayer fee, and their vault charges every cash out. |
| A-1 WHYPE donation forces the V2 fallback | Documented (testnet only; mainnet launches use the v4 hook) | n/a: v2 trades v4 launches |
| A-2 dirty `ownerOf` bricks escrow claims | Fixed (whole word compared) | Same |
| A-3 escrow rotation steerable | Fixed as CL-01 | Same |

**Not covered by the review, and still open for v2:**
- The reviewer didn't check the compiled circuits against the verifying keys. For v2 this is Gloam's circuits and final keys, covered by Gloam's own process and their `CheckCeremonyKeys`.
- Our escrows and `CloakLaunchVault` weren't in scope. They go to Gloam's partner-escrow review and an outside review.

## Report 2: the auction's sealed bids, and the batcher's price window

### 2.1 `CloakAuction`: nothing checks that a sealed bid's ciphertext opens to its commitment

**Valid. Partly by design, now made visible.**
- The chain can't check a drand timelock ciphertext. It's BLS12-381 identity-based encryption, and verifying an opening needs BLS12-381 pairings. The EVM only has those with EIP-2537, and Elysium hasn't confirmed it has them.
- So a bidder can commit junk and keep the choice of revealing their own preimage until the end of the reveal window, after every other reveal has landed.
- **What prices that option:** an unrevealed bid loses its no-reveal penalty, burned. The minimum is 10% (`MIN_NO_REVEAL_PENALTY_BPS`, which a creator can't go under), and a creator can set up to 50%.
- **Where it matters:**
  - In an undersubscribed launch, a low bid revealed honestly lowers the price for everyone anyway, so withholding adds no power there.
  - The real abuse is visible deposits as fake demand during bidding, then withheld. That costs the penalty on the whole deposit.
- **Done now:** the keeper's reveal pass already found these bids ("cannot unseal") but only logged them. `revealAll` now returns them (`unopenable`), and the keeper publishes them at `GET /unopenable?auction=0x…` from the moment the drand round passes. A launch page can then show "N sealed bids can't be opened by the beacon, only their bidders can reveal them", while the reveal window is still open.
- **Proposed for the next factory (Cloak v1's repo, not changed here):**
  1. A higher default no-reveal penalty for new launches (for example 25%).
  2. Check whether Elysium has EIP-2537. If it does, a reveal can carry the drand signature for its round, and the contract can check that the ciphertext opens to the commitment. A commit that doesn't open then can't be revealed at all, which removes the option.
- **Who orders transactions on Elysium:** it's an Arbitrum Orbit chain with a single sequencer, run through Conduit, that orders first come first served. There's no public mempool and no priority-fee auction. We still need to ask Kinetiq whether Timeboost (an express lane) is on.

### 2.2 The batcher's price window: the first order sets `cumStart`/`spotStart`, and the window runs until whoever calls `settle`

**Valid, and worse in Cloak v2's batcher than in v1's. Fixed in v2.**

- **v1's `PrivateBatcher`:** it crosses at a time-weighted price from the first order to `settle`, clamped to ±2% of `spotStart`. `spotStart` is the instant spot when the first order landed, so pushing the pool in that block pins the clamp. The settler also picks when the window ends. This is held with v1's other batcher fixes (B1 and B3), unless the Gloam test is a no-go.
- **v2's `CloakGloamBatcherBase` before the fix:** it crossed at the **instant spot when `settle` was called** (anyone can call it), within ±2% of the same pinnable `spotStart`. One transaction could push the pool up to 2%, settle and push back.
- **v2 now (`contracts-gloam/src/CloakGloamBatcher.sol`):**
  1. Rounds cross at the market's **time-weighted average price**. It comes from Uniswap V2's cumulative prices or `CloakV4Hook`'s accumulator, both of which count a price only for the time it was held. It runs from the round's first order to settlement.
  2. The window always covers **at least one whole round** (`settleOpens`). A last-second first order can't shrink it to a moment.
  3. A round can settle only within `refundAfter` of that, then only be cancelled (`TooLate`). So the settler can't stretch the window indefinitely.
  4. The pool must be within `maxSlippageBps` of the average when the net trades (`Slipped`), and the net trade within 5% of it (`Impact`).
  5. `spotStart` is no longer priced on. A push in the first order's block counts for no time.
- **Tests:**
  - `contracts-gloam`, 121 of 121, with 4 new tests: a 1.5% push in the settling transaction doesn't set the price; a push in the first order's block doesn't pin it; a real move held through the round does set it; the window always covers a whole round. Plus the earlier 10% push refused, then cancelled, with `TooLate` after the window.
  - `contracts-v4`, 65 of 65.
  - The fork run on real launches (`part14-batch-v4.mjs`) and parts 5, 7 and 16 pass.
- **One effect to know:** on a thin pool, a round that lands right after another round's net trade waits until its own average catches up with the new pool price. The keeper retries every tick, so it can take a few minutes, or the round is refunded after `refundAfter`.

### Draft reply to the reviewer

> Thanks, both are real. On the sealed bids: the chain can't verify a drand ciphertext without BLS12-381 pairings, so the no-reveal penalty (10% floor, up to 50%) is what prices the option. The keeper now publishes bids it can't open the moment the drand round passes, so a launch page can show them during the reveal window. We're checking whether Elysium has EIP-2537 so a reveal can prove the ciphertext opens to the commitment. On the batcher: agreed. In our new batcher, rounds now cross at a time-weighted average over at least a full round, with a fixed time limit to settle. Spot must sit within the slippage band of that average when the net trades, and the first order's spot no longer anchors anything. Tests cover a push in the settling transaction, a push in the first order's block and a real move held through the round. Elysium is an Orbit chain with a single sequencer that orders first come first served, and no public mempool.
