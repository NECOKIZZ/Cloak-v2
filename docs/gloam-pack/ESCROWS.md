# Cloak's escrows on Gloam (for review, and for Gloam's relay)

Every escrow follows Gloam's pattern: a note leaves a vault by an unshield proof whose `to` is a one-time address made (CREATE2) from a key that binds everything about the action, so a copied call that changes anything gets another address and the proof fails. What comes back goes into a vault as a note the owner's app made and its one-time owner key signed. None of them has an owner, an admin, a fee of its own or an upgrade path. Each has a timeout exit, so money never waits forever.

Source: `contracts-gloam/src` in this repo, solc 0.8.24 like Gloam's. Tests: `contracts-gloam/test` (117 forge tests) and `contracts-v4/test` (65, on the real Uniswap v4 PoolManager and real Cloak launches). Addresses: `deployments/elysium-testnet-gloam.json`.

"Launch vault" is `CloakLaunchVault` (see LAUNCH-VAULT-DIFF.md). "Gloam's vault" is Cloak's instance of Gloam's guarded deploy for now.

## CloakLaunchSwapV4 · `0xc4b6ce66f12733e6737cda6cc1a882ea05bf99ce`

Private swaps between notes in the launch vault, through Cloak launches' own Uniswap v4 pools. Swap logic is Gloam's `GloamVaultSwapV4c` (route walk, up to 3 hops, exact output from the last hop, settle by sync and transfer, callbacks only from the PoolManager). The one difference: a pool is usable at once if its hook is none or `CloakV4Hook` (immutable), instead of a 3-day allowlist. The route is bound into the escrow key.

| Call | Who | What it moves |
|---|---|---|
| `swap(s, d, route, ownerKey, deadline)` | anyone (relay) | the spent note, through the route, into the new note `d` in the launch vault; the price buffer is owed back to the swap |
| `claim(id, d, signature)` | anyone, owner key signs | the owed buffer into the launch vault as one note |
| `exit(id, to, signature)` | anyone, owner key signs | the owed buffer to an address the owner names (never the PoolManager, a vault or the token) |
| `rescue(k)` | anyone, after the deadline | a spend that landed alone: the whole input is owed back |
| `unlockCallback(data)` | PoolManager only, during a swap | nothing outside the swap |

## CloakGloamBatcherV4 · not on testnet yet (and V2 `CloakGloamBatcher`)

Batch rounds. Standard-size orders (1, 2, 5 x 10^n) collect into rounds per token. At the end, buys and sells cross and only the net trades, through the launch's `CloakV4Market` (V2 venue: the Uniswap V2 pair).
- **The price:** the market's time-weighted average (CloakV4Hook's accumulator, or V2's cumulative prices) from the round's first order, over at least one whole round (`settleOpens`).
- **Guards:** the pool must be within 2% of that average when the net trades, and the net trade within 5% impact of it.
- **Sizes:** each side holds at most 4% of the pool (`RoundFull`), so a round always settles.
- **Deadline:** a round settles within `refundAfter` of `settleOpens` (`TooLate`), otherwise it's cancelled and refunded.

| Call | Who | What it moves |
|---|---|---|
| `place(s, k)` | anyone (relay) | the spent note into the batcher, via Gloam's one-time `SwapEscrow2` |
| `settle(token, round)` | anyone (keeper), from `settleOpens` until `refundAfter` later | the round's net through the market at the time-weighted average; refused past the impact or slippage guard |
| `cancel(token, round)` | anyone, `refundAfter` after `settleOpens` | nothing moves; every order is owed its input back |
| `claim(k, d, signature)` | anyone, owner key signs | an order's payout into the launch vault as a note of exactly what is owed |
| `exitAfterTimeout(k)` | anyone, 30 days after the round | an unclaimed payout to the order's fallback address |
| `register(launchIndex)` | anyone (V4 venue only) | nothing; records a settled launch's market |

## CloakGloamBids · `0xb3f6f2142439f1b4f088ea24569cc73726dcea32`

Sealed bids on Cloak launches and drops from a private balance. One note leaves the launch vault to a one-time bid account (CREATE2 from the bid's key) that the auction sees as the bidder.

| Call | Who | What it moves |
|---|---|---|
| `place(s, k, bidCall, signature)` | anyone (relay), owner key signs the bid | the note into the bid account, which bids with it |
| `finish(k, ds, signature)` | anyone, owner key signs | after settlement: claims from the auction and puts tokens and refund back into the vault as notes |
| `exit(k, to, tokens, signature)` | anyone, owner key signs | what the account holds to an address the owner names |
| `ownerCall(k, target, value, data, signature)` | anyone, owner key signs | one signed call from the account, for what can't go into a vault (a drop's NFTs); never to a vault, once per nonce |
| `exitAfterTimeout(k, tokens)` | anyone, after the key's timeout | everything in the account to the fallback address |

## CloakGraduation · `0xfd0e96dec9c1edd885e86044790e50e48c1a6268`

Moves a launch token from the launch vault into Gloam's vault in rounds of standard sizes, once Gloam lists it.

| Call | Who | What it moves |
|---|---|---|
| `enter(s, k)` | anyone (relay) | a standard-size note out of the launch vault into the round |
| `leave(k, toVault, d, signature)` | anyone, owner key signs | after the round: exactly what arrived, into Gloam's vault (or back into the launch vault if Gloam's refuses) |
| `exitAfterTimeout(k)` | anyone, after 30 days | an unclaimed entry to its fallback address |

## CloakGloamReceive · `0xa462e810b985029b28b5cee49866760a7f8767bb`

Receive addresses. Each owner key and number has a fixed `ReceiveBox` address anyone can pay. Only this factory can move a box's funds, and only into a vault as a note the box's owner key signed for.

| Call | Who | What it moves |
|---|---|---|
| `shield(ownerKey, n, vault, asset, amount, commitment, proof, signature)` | anyone (relay), owner key signs | what the box holds into the named vault as that note; a refused deposit reverts whole and the money stays |

## CloakFundsGate · `0x79aafd041a283c334421a17c781b12e353093210` and CloakReceiptCheck · `0xb0a8fcbd75f4d6d2ce5a0121e8607aa353990304`

Read-only checks on Gloam's funds and receipt proofs (verifiers exported from Gloam's final zkeys, GPL-3.0 headers kept). They move no money.

| Call | Who | What it does |
|---|---|---|
| `createGate(asset, threshold, closesAt)` | a launch creator | opens an allocation gate |
| `enter(gateId, vault, wallet, proof...)` | a holder | records that a wallet proved it holds at least the threshold, privately |
| `confirm(gateId, wallet)` | anyone (keeper) | after close, fixes the list |

## For the relay

Exits to whitelist in their relay's exit share: `claim`, `exit`, `rescue`, `cancel`, `exitAfterTimeout`, `leave`, `finish`. New sends: `swap`, `place`, `enter`, `shield`. Our relay (`services/keeper/gloam.mjs`) already classifies them this way by selector.
