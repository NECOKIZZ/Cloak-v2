# Off-chain stress test: relay, keeper, SDK, MCP (Cloak v2 on Gloam)

Nov 8, on local anvil chains (chain id 99801) and one fork of Elysium testnet. No transaction went to a live chain. Every number below comes from a script in `e2e-gloam/stress/`. No existing file was changed.

Machine: 4 cores, Node 22. Proofs are Gloam's final ceremony keys (snarkjs in Node). Anvil runs with automine unless noted, so "rest" times below are the relay's checks, simulation and RPC round trips, not block time. On Elysium add about one block per relayed transaction.

## 1. Timings (GloamPrivate, real final-key proofs, through the relay)

3 runs per action (`stress-timings.mjs`, raw numbers in `e2e-gloam/stress/results-timings.json`).

| action | median | worst | proofs (count, median time) | rest (relay, RPC) | notes |
|---|---|---|---|---|---|
| shield HYPE (launch vault) | 0.65 s | 0.94 s | 1, 0.30 s | 0.34 s | deposit from the wallet, memo through the relay |
| shield USDC (Gloam's vault) | 0.42 s | 0.48 s | 1, 0.23 s | 0.19 s | approve + deposit, memo |
| balance (warm) | 0.19 s | 0.42 s | 0 | 0.19 s | 2 vaults |
| private send 0.5 HYPE | 1.42 s | 1.80 s | 1, 0.90 s | 0.52 s | 1 transfer + memo |
| receive: payee's next balance (sweep) | 1.26 s | 2.27 s | 1, 0.90 s | 0.47 s | the payee's sync sweeps the payment |
| withdraw 0.3 HYPE (needs a split) | 1.93 s | 2.97 s | 2, 1.37 s | 0.67 s | transfer + memo, then unshield |
| withdraw USDC (exact note) | 1.32 s | 1.54 s | 1, 0.95 s | 0.36 s | 1 unshield |
| instant buy 0.2 HYPE | 3.89 s | 4.47 s | 4, 2.19 s | 1.39 s | split, out-note proof, spend proof, swap, buffer claim |
| instant sell | 3.77 s | 3.98 s | 4, 2.22 s | 1.23 s | same shape |
| batch order 0.07 HYPE (2 orders) | 5.62 s | 6.04 s | 4, 3.74 s | 1.71 s | per order: split + spend proof + place |
| batch payout (finishPending, 2 orders) | 0.91 s | 0.95 s | 2, 0.47 s | 0.46 s | deposit proof + claim + memo per order |
| payment link: make 0.1 HYPE | 1.60 s | 1.81 s | 1, 0.75 s | 0.81 s | a private send to the link's account |
| payment link: make, locked | 1.73 s | 1.94 s | 1, 1.01 s | 0.72 s | |
| payment link: open locked (scrypt only) | 0.15 s | 0.17 s | 0 | 0.15 s | N=2^15, on device |
| payment link: claim into a private balance | 1.94 s | 2.31 s | 1, 0.71 s | 1.02 s | transfer + memo from the link account |
| payment link: claim to a fresh wallet | 1.83 s | 1.84 s | 1, 0.96 s | 0.60 s | unshield from the link account |
| receive address: collect 0.25 HYPE | 0.51 s | 0.57 s | 1, 0.23 s | 0.28 s | deposit proof + relayed shield + memo |
| split withdraw plan (3 pieces, 1.5 HYPE) | 7.50 s | 11.60 s | 6, 4.60 s | 2.90 s | 3 splits + 3 unshield proofs |
| proveFunds (>= 1 HYPE) | 3.08 s | 5.37 s | 1, 2.97 s | 0.35 s | funds circuit, off chain |
| bid privately (fork of Elysium testnet, 3 bidders) | 2.29 s | 3.46 s | 1-2, 1.24 s | 1.05 s | split + spend proof, relayed to CloakGloamBids, on a real v4 launch |
| bid back after settle (finishPending, fork) | 0.55 s | 0.56 s | 1, 0.17 s | 0.38 s | auction claim + tokens back as a note |

Per circuit (all runs): shield median 232 ms (worst 501), transfer median 904 ms (worst 1594), unshield median 884 ms (worst 1661), funds about 3 s.

Proofs are roughly half of every action. The other half is RPC: every sync re-reads the whole tree and does one `isSpent` read per note, and every proof re-reads the tree again (`pathOf`). That is cheap on local anvil and will dominate on a rate-limited public RPC (see O-14).

The bid rows come from `stress-bid-fork.mjs`: a real launch on Cloak's live v4 factory on a fork, drand reveal, settle, the keeper loop admits the token, and all 3 bids came back as notes on the next open.

## 2. Stress results

| load | what happened | script |
|---|---|---|
| 40 notes in one account | fresh device `balance()` 0.22 s and 51 RPC requests, warm 0.10 s and 48 requests (one `isSpent` per note, every sync). A 2.5 HYPE send from 40 notes of 0.1 took 47 s: 25 transfers, 385 RPC requests, and the payee gets 25 separate payments | `stress-sync.mjs` |
| 12 dust payments (1 wei) and a zero payment to a victim | the attacker spent 16 s. The victim's next `balance()` spent 13 s proving sweeps, then **threw**, and kept throwing for the rest of the relay's hour (O-08). A zero-amount payment note is accepted by Gloam's circuit | `stress-sync.mjs` |
| the same spend sent 6 times at once | Gloam's vault: 1 send. Launch vault: **4 sends, 3 reverted on chain** at the relay's cost (O-04) | `stress-relay.mjs` |
| 8 different cash outs at once, budget for 2 | **3.74 cash outs' worth spent of a 2.0 budget** (O-05). 4 of the 8 failed on nonce clashes (O-06) | `stress-relay.mjs` |
| 4 valid cash outs at once through the real keeper process (HTTP, 2 s blocks) | **2 of 4 failed**, reported to the user as "malformed request" (O-06) | `stress-http.mjs` |
| 50 relay requests, made-up X-Forwarded-For each | none rate-limited (20/min limit), and a sender refused for its share got through with another header value (O-03) | `stress-http.mjs` |
| relay budget exhausted, then recovery | refusals are 429 with clear text; a sender's refund share still works after its send share is used (part3 covers this). Recovery only at the hour roll; nothing persists across a restart, so a restart resets every budget | `stress-relay.mjs`, `stress-http.mjs` |
| 160 queued scheduled pieces (stand-in relay, 250 ms a send) | queued in 28 ms, no cap on the queue; one tick sends due pieces one after another, so the 160th went out 40 s late and ticks start overlapping (guarded per piece, so no double send) | `stress-schedule.mjs` |
| 3 scheduled pieces fill the shared "schedule" sender share | the 4th user's piece got 429, retried, and was **dropped after 8 tries** with its note still unspent (O-10) | `stress-schedule.mjs` |
| 12 open batch rounds, keeper restarted (state lost), 10% of RPC reads failing | the fresh loop re-read every order from the batcher's start block: 9 settled, 3 cancelled (past their window), all in 4 ticks; every payout came back on the next `finishPending` | `stress-loop.mjs` |
| a settle that passes simulation and reverts on chain (pool moved in the same block) | the loop **reported it settled and forgot the round**: past the refund time it never cancelled it (O-07) | `stress-loop.mjs` |
| 40 junk 8 KB memos on the board (360 sealed tickets, 9 per memo) | a fresh sync took 0.7 s (victim) and 0.9 s (bystander), about 18 ms per junk memo; the victim keeps 321 junk candidates in memory (O-13) | `stress-memospam.mjs` |
| 4 parallel MCP withdraws of 0.9 HYPE, 2 HYPE daily limit | **all 4 went through (3.6 HYPE)** (O-09) | `stress-mcp.mjs` |
| relayed call lands, app is told it failed | the change note, the payee's note, swap output and batch payouts are **lost for good** (O-01, O-02) | `stress-lostnote.mjs` |

## 3. Findings

| ID | severity | where | what | repro | suggested fix |
|---|---|---|---|---|---|
| O-01 | **High** | `packages/sdk/src/core/gloam.ts` `GloamCore.transferOne`, `shield`; `launchVault.ts` `launchSwap`, `finishSwap`, `finishBatchOrder`, `finishGraduation`; `gloamPrivate.ts` `collectReceived`, `batch` | New notes get a random nonce, and are tracked and announced (memo) only after `submit()` returns. When the call lands but `submit()` throws (a dropped HTTP response, a keeper restart mid-request, the relay's receipt wait failing on a flaky RPC, which the relay reports as "malformed request"), the notes can never be found again on any device. Measured: a 0.1 HYPE send from a 1 HYPE note lost the whole 1 HYPE (0.9 change and Bob's 0.1); a buy lost its tokens and its buffer (no swap record was saved); a batch payout claim landed and the next open reported "already paid" with nothing in the balance | `stress-lostnote.mjs` (cases 1 to 3) | Save each new note (nonce or secret, commitment, asset, amount) in the records store before `submit()`, and resolve it on every sync by looking for the commitment in the tree. Better, make the nonces deterministic from the seed and the spent nullifier, so a tree scan always finds them. On a submit error, check `isSpent(nullifier)` before treating the call as failed. Save the `launchSwap` record before sending, as `batch()` already does |
| O-02 | **High** | `gloam.ts` `transferOne` and `shield` (`post` is not wrapped); `services/keeper/gloam.mjs` memo budget | A memo refusal after the transfer or deposit landed throws the same way, and loses the notes. The memo budget is 8% of the hour, shared by everyone, and anyone can use it up: commitments are free to make (relayed transfers) and the per-sender memo share is evadable (O-03). Measured with the memo budget used up: a send lost the whole 1 HYPE note; a shield took 1 HYPE from the wallet and left a private balance of 0 | `stress-lostnote.mjs` (cases 4 and 5) | Treat the memo as best effort, as `announce()` in `launchVault.ts` already does: track the note first, then post the memo, and retry an unposted memo on the next open. Never throw after a transfer or deposit landed |
| O-03 | Medium | `services/keeper/index.mjs` `clientIp` | The first `X-Forwarded-For` entry is trusted, and the caller sets it. The per-IP rate limit (20/min) and the relay's per-sender shares (60% sends, 60% exits, memo share) are bypassed with a made-up header. One client can take everything up to the 80% new-send line, the whole exit budget and the whole memo budget (which turns O-02 into an attack) | `stress-http.mjs` | Use the address the host's proxy appends (the right-most entry on Render, or a configured count of trusted hops). Fall back to the socket address |
| O-04 | Medium | `services/keeper/gloam.mjs` `relay` (spend lock) | The lock is checked, then several awaits happen (`collectLaunchFees` reads `feeRecipient` for every launch-vault call), then it's set. The same launch-vault spend fired 6 times at once went out 4 times: 3 reverted on chain at the relay's cost. Gloam's vault (no await in between) held at 1 | `stress-relay.mjs` | Set `inflight` right after the `has` check, before any await, and drop it in `finally` on the same rules |
| O-05 | Medium | `gloam.mjs` `relay` (budgets) | The budget and share checks read spend that is counted only after the receipt. Concurrent calls all pass: 8 cash outs at once against a budget for 2 spent 3.74. The fee-income path also skips the base checks and charges any overflow to the base budget unchecked (code reading) | `stress-relay.mjs` | Reserve the estimated cost (gas estimate x price x 1.2) against the budget and share at check time, and settle it to the real cost after the receipt |
| O-06 | Medium | `gloam.mjs` `relay` (nonce) with `index.mjs`'s serial send queue | The relay reads the `pending` nonce itself and passes it in, but the keeper's wallet sends through a serial queue that waits for each receipt. Two relays at once (or a relay and a loop send) pick the same nonce: 2 of 4 concurrent valid cash outs failed through the real keeper, and the user saw "malformed request". Nothing was lost (the tx never went out), but any two users in the same block can collide | `stress-relay.mjs`, `stress-http.mjs` | Don't pass `nonce`: let the serialized sender pick it. In `index.mjs`, map errors without a status to 503 "try again", not "malformed request" |
| O-07 | Medium | `services/keeper/gloamLoop.mjs` `settleRounds` | After `send(settle)` or `send(cancel)` the round leaves `open` without checking the receipt. The keeper's `writeContract` returns the hash even when the call reverted. A settle that reverts (pool moved in the same block) is reported settled and forgotten, so the round is never cancelled. Its orders wait for a keeper restart, or the 30-day exit to the one-time address | `stress-loop.mjs` | Remove a round from `open` only once `batches()` reads settled or cancelled (or the receipt is success) |
| O-08 | Medium | `gloam.ts` `GloamCore.sync` (autoSweep) | Every received payment is swept during sync: one proof and one relayed transfer each, from the victim's own relay share, and any sweep failure makes `sync()` and so `balance()` throw. 12 one-wei payments made the victim's app prove for 13 s, then throw on every call until the relay's hour rolled over: the victim couldn't see or spend anything. Zero-amount payments are accepted by the circuit and swept too | `stress-sync.mjs` | Never let a sweep failure fail sync (leave it pending). Skip zero and dust payments under a threshold, and cap sweeps per sync |
| O-09 | Medium | `packages/mcp/src/server.ts` (every write tool) with `limits.ts` | `spending.check` runs before the `exclusive` queue and `record` after the action, so parallel tool calls all pass the check. 4 parallel 0.9 HYPE withdraws under a 2 HYPE daily limit all went through (3.6 HYPE). An agent issuing parallel calls (or a prompt injection that asks it to) beats the limit | `stress-mcp.mjs` | Check and reserve inside `exclusive` (or re-check there), and release the reservation on failure |
| O-10 | Low | `services/keeper/schedule.mjs` with `index.mjs` (`sender: "schedule"`) | Every user's scheduled pieces share one relay sender. Once that share is used, other due pieces get 429, count it as a failed try, and are dropped after 8 tries (about 28 minutes). The site shows "dropped" and doesn't resend. Funds stay in the private balance, but the withdrawal silently doesn't happen | `stress-schedule.mjs` | Give scheduled exits their own budget, or key them by the original requester. Treat 429 as "wait", not a try |
| O-11 | Low | `packages/mcp/src/server.ts` (dry runs, read tools) | A dry run isn't side-effect free: a dry-run withdraw of "max" read the balance, whose sync swept a waiting payment (2 relayed transactions). Read tools like `private_balance` do the same, outside `exclusive`, so they can run during a write | `stress-mcp.mjs` | Sync without autoSweep in dry runs and read tools, or say so in the tool text. Put any sweeping sync inside `exclusive` |
| O-12 | Low | `packages/mcp/src/server.ts` `amountOf`, `withdraw`, `private_send` dry runs | A dry run approves a withdrawal to the zero address or to the launch vault (the relay refuses them only at send time), and a private send to a made-up `cloak:gloamr1.AAAA`. A USDC amount with 7 decimals rounds up (0.0000009 becomes 0.000001) | `stress-mcp.mjs` | Run the relay's destination rule and `isReceiveTag` in the dry run. Refuse amounts with more decimals than the asset has |
| O-13 | Low | `gloam.ts` `GloamCore.sync` / `tryTicket` | Anyone can post 8 KB junk memos straight to the board (paying gas). Each costs every account's fresh sync about 18 ms per vault (9 tickets per memo). Fake self-tickets sealed to a victim's public tag stay in its candidate list for the session. Cheap to absorb today, linear in board size | `stress-memospam.mjs` | Cap and age out candidates that never appear in the tree. Long term, a board scan that starts from a saved cursor |
| O-14 | Low | `gloam.ts` `sync`, `pathOf` | One `isSpent` RPC per note per sync, the whole tree re-read on every sync and every proof, and many syncs per action (a send syncs 2 or 3 times). 40 notes: 51 RPC requests per balance; one 25-note send: 385 requests. The Elysium public RPC answered "Rate Limit Exceeded" to a single wide `eth_getLogs` while testing | `stress-sync.mjs` | Batch `isSpent` in a multicall, keep the tree and extend it from the last block, and sync once per action |
| O-15 | Info | `schedule.mjs` (`clock`), `gloamPrivate.ts` `planSplitWithdraw` | The SDK times pieces by the chain's clock, the keeper checks "at most 48 h" by its own. Only matters if the two drift apart (the anvil stack, moved 3 days ahead, had every piece refused). The queue has no size cap, and sends due pieces one at a time inside a 20 s timer | `stress-http.mjs`, `stress-schedule.mjs` | Check the window against the chain's clock, and cap pieces per queue and per caller |
| O-16 | Info | `e2e-gloam/part13-bids.mjs` | Fails now: the SDK refuses a reveal window under 5 minutes, and part 13 uses 40 s. The copy here uses a 310 s window | `stress-bid-fork.mjs` | Lengthen part 13's reveal window |

How bad, in plain terms: O-01 and O-02 are the ones to fix before real money. Both lose user funds with no attacker at all (a phone dropping a response is enough), and O-02 can be caused on purpose, more cheaply through O-03. O-03 to O-09 are availability and budget problems: no funds are taken, but the relay pays more than intended, or users are blocked or see wrong errors. O-09 matters for agent safety.

## 4. What held up

- **Hostile relay payloads:** 13 malformed or hostile payloads were all refused with a status: null, array, non-hex or odd-length data, a non-string `to`, unserved targets (including the guard), 25 KB data, a vault selector with junk, vault `collectFees`, a memo over 8 KB, a memo for a made-up payment, and an escrow call that reverts. None cost the relay any gas.
- **Cash-out destinations:** all 5 forbidden ones were refused before simulation (zero address, the vault itself, Gloam's vault, the memo board, an escrow).
- **Locks and replays on Gloam's vault:** the same spend fired 6 times at once went out once. A replay after success is refused as spent.
- **HTTP layer:** bad JSON gives 400. An 80 KB body has its connection dropped.
- **Schedule abuse:** all of these were refused (400): a memo or transfer passed as a piece, a piece 49 h ahead, a NaN time, 5 pieces in one request, a tampered recipient (the proof fails), and the wrong vault. The same note always maps to one id, even with 32 junk bytes appended or the vault address upper-cased, so it can't queue twice.
- **Keeper loop:**
  - after a restart it rebuilt its state from chain logs;
  - with 10% of RPC reads failing it still finished every round within 4 ticks;
  - rounds past their window were cancelled, and every payout came back on the next open.
- **Fee collection racing itself:** `collectFees` reverts when nothing is owed, and a reverted collect is credited 0, so income isn't double counted.
- **MCP amount parsing:** these are all refused: `-1`, `0`, `1e3`, `0x10`, `1,5`, `NaN`, `Infinity`, an empty amount, and a 19-decimal HYPE amount. Huge amounts and "max" stop at the spending limit. Bad addresses (`0x123`, `vitalik.eth`, a `cloak:` tag as a withdraw target) are refused.
- **Many notes:** 40 notes still sync in about 0.2 s locally, and a fragmented 25-note send arrives in full.
- **Memo spam:** about 18 ms per junk memo for a fresh sync, and balances stay right.
- **Proof times:** about 0.9 s per transfer or unshield and 0.23 s per shield on 4 cores, steady across runs.

## 5. Commands to rerun

From `e2e-gloam/`, with Foundry on the PATH (`export PATH=$HOME/.foundry/bin:$PATH`). Each script starts its own anvil on a port in 8600-8620 and kills it at the end. Each prints `HELD` or `BUG` per check and a summary.

```
node stress/stress-timings.mjs                 # section 1 (RUNS=3), writes stress/results-timings.json
node stress/stress-relay.mjs                   # O-04, O-05, O-06 and the hostile payloads
NODE_USE_ENV_PROXY=1 NO_PROXY=127.0.0.1,localhost,127.1 node stress/stress-http.mjs   # O-03, O-06, schedule abuse (reads Multicall3's code from the testnet RPC once)
node stress/stress-lostnote.mjs                # O-01, O-02
NOTES=40 node stress/stress-sync.mjs           # many notes, O-08, O-14
node stress/stress-schedule.mjs                # 160 pieces, O-10
ROUNDS=12 FAIL=0.1 node stress/stress-loop.mjs # restart, flaky RPC, O-07
node stress/stress-mcp.mjs                     # O-09, O-11, O-12
MEMOS=40 node stress/stress-memospam.mjs       # O-13
NODE_USE_ENV_PROXY=1 NO_PROXY=127.0.0.1,localhost node stress/stress-bid-fork.mjs     # bid timings on a testnet fork (needs drand)
```

Notes:
- `stress/common.mjs` sets `FOUNDRY_SKIP=["test/stress/**"]`, so another tester's forge files under `contracts-gloam/test/stress/` that don't compile yet can't break the build these scripts run.
- `stress-http.mjs` points the keeper at `http://127.1:<port>`. With a `127.0.0.1` URL, `index.mjs` picks anvil's chain id 31337, while the stack runs as 99801.
