# Cloak v2 on Gloam: test report

Status: **in progress** (Parts 0 and 1 done on a local chain and a fork of Elysium testnet, Parts 2 to 4 open). Every
number here comes from a script in this repo and its output in `measurements/`. The verdict at the end is provisional
until the live testnet run and the escrows are done.

Pinned versions: Gloam repo `cryptoduke01/gloam` at `16dac34` (`vendor/gloam`, a submodule, unmodified),
`@gloamtrade/sdk@0.6.0` from npm, Foundry 1.5.1, solc 0.8.24, Node 22.

## 1. What was built

| Piece | Where | State |
|---|---|---|
| Cloak's own Gloam instance (guarded `ShieldPoolPayments`, final-key verifiers, memo board) | `contracts-gloam/gloam-root/DeployCloakGloam.s.sol` | done on anvil and on a fork of Elysium testnet. Live testnet deploy waits for a funded testnet key |
| Part 0 run (their SDK end to end, measured) | `e2e-gloam/part0.mjs` (`--fork`, `--live`) | passes, 14 checks |
| `PrivateCore` seam, `CloakCore`, `GloamCore` | `packages/sdk/src/core/` | done |
| Part 1 run (GloamCore end to end) | `e2e-gloam/part1.mjs` | passes, 20 checks |
| Cloak baseline (gas and proof times of today's private layer) | `e2e/private.mjs` with `GAS_OUT` | passes, 21 checks |
| Escrows (swap, bid, batch, drop) | `contracts-gloam/src/` | not started |
| Site pages, keeper, MCP on the seam | | not started |

How the deploy stays "their audited contract": the deploy script compiles from Gloam's own project root
(`forge script --root vendor/gloam/contracts`), so the vault, verifiers and guard build from the same paths and
settings as upstream. The only Cloak line is `_deployMainnetGuarded(99801, true)`, which also lists native HYPE (their
Elysium testnet script lists USDC only). Their key gate runs inside the deploy: the verifiers must accept final-key
proofs and refuse dev-key proofs, or no vault is created. On top, `part0.mjs` sends a dev-key deposit proof to the
live vault and checks it is refused.

Their own forge suite at that commit: 490 of 491 pass. The one failure (`DeployBase.t.sol`, an exact deployer nonce)
looks like a Foundry version difference and does not touch the Elysium path (`DeployElysium.t.sol` passes).

## 2. Measurements so far

Machine: 4 vCPU Intel Xeon 2.3 GHz, Node 22. "One core" is the same run pinned with `taskset -c 0`, a rough stand-in
for a phone (a recent phone core is close to one of these; an older phone is slower). Proving is in Node with snarkjs
0.7.5; the browser (wasm, web workers) is usually slower than Node, so a phone figure in the browser still needs
measuring on a real phone.

### Proof time (median, ms)

| Proof | Cloak today (`transaction2x2`) | Gloam shield | Gloam send (1 in, 2 out) | Gloam cash out |
|---|---|---|---|---|
| 4 cores | 1,090 | 119 | 489 | 448 |
| 1 core | 3,680 | 280 | 1,534 | 1,392 |

Gloam's proofs are smaller (one input, depth 20) and about 2 to 2.5 times faster. But some Gloam actions need two
proofs where Cloak needs one (a partial withdrawal is a split then a cash out; a received payment is swept), so per
user action the gap narrows (see 2.3).

### Gas per action (anvil; L1 data cost of the Orbit chain not included)

| Action | Cloak today | Gloam |
|---|---|---|
| Shield (deposit) | 939,551 | 1,141,759 (HYPE), 1,139,220 (USDC) |
| Private send | 1,695,346 | 1,787,636, plus 57,370 for the memo |
| Receive (secure the payment) | 0 | 1,782,446 (sweep) plus memo |
| Withdraw, whole note | 1,785,841 | 313,599 |
| Withdraw, partial | 1,785,841 | 1,787,636 (split) + 340,520 (cash out) + memo |
| Collect fees | n/a | 69,546 |

At Elysium testnet's 0.1 gwei a private send is about 0.00018 HYPE of gas, so gas is not the deciding cost on Elysium.

### Time per user action with GloamCore (4 cores, anvil, prove plus every transaction)

| Action | ms |
|---|---|
| Unlock from one signature | 36 |
| Shield HYPE (prove, deposit, memo) | 722 |
| Restore on a new device (cold sync, small chain) | 13 |
| Private send | 779 |
| Receive and sweep | 731 |
| Send 35 USDC from five 10 USDC notes (4 pieces) | 2,980 |
| Recipient secures those 4 pieces | 3,022 |
| Withdraw 1 HYPE (split, then cash out) | 1,401 |
| Withdraw max over 4 notes | 2,191 |

## 3. Findings

### 3.1 Notes are bearer notes (privacy and safety, important)

Gloam's note is `Poseidon(secret, amount, asset)` with no owner key. A payer makes the payee's secret. Until the payee
moves the note, the payer can spend it back, and the payer can compute its nullifier, so the payer sees on chain
when the payee spends it. `part0.mjs` shows the first: a payer cashes out a payment it sent before the payee swept it.

Cloak's notes today are owned by a key (`pubKey` in the commitment): a payer can never spend what it sent and cannot
see when it is spent.

What GloamCore does about it: every received payment is swept into a note only the payee knows during `sync`, before
it counts as balance (`pending()` shows it until then). The cost is a second 1.78M gas transfer and about 0.7 s per
received payment, and the window between payment and sweep stays open while the payee is offline. Payment links and
x402 have the same window (Gloam's own SDK says so in `sweep.ts`).

Privacy left after the sweep: the payer still knows the payment's nullifier and sees it spent (by the sweep). That
tells the payer the payee came online, nothing about where the money went next.

### 3.2 One note in per send

A balance spread over k notes pays out in up to k separate payments (35 USDC from five 10 USDC notes arrives as 4
payments, each with its own memo and its own sweep on the other side). Cloak's 2-in circuit merges as it goes. The
number of pieces leaks to the recipient, and costs grow with fragmentation. A 2-in circuit needs a new circuit and
ceremony (founder, Nov 7), so this stays.

### 3.3 Restore needs a memo per note

Gloam has no owner key in a note, so finding your own notes on a new device needs something on chain. GloamCore
posts every note it makes for itself as a ticket sealed to its own receive key on Gloam's memo board (57k gas per
memo) and makes its own secrets from the account seed (so a ticket can't be forged into a spendable note). A second
device restores from the one signature. If a memo post fails after its transfer, the note is still spendable from
the device that made it but would not restore elsewhere: the memo has to be retried.

### 3.4 The cash-out fee applies to every escrow action

Gloam's swap router takes the input out of the vault with `unshield` to a one-time escrow, so the 0.5% cash-out fee
is charged on every swap, and on any Cloak bid, batch order or drop bid built the same way. Today Cloak charges
0.25% on cash outs and private swaps. Deposits back into the vault are free.

### 3.5 New assets wait 3 days, in any ShieldPoolPayments vault

`ShieldPoolPayments` refuses a deposit of an asset with no deposit limit, deposit limits can't be switched off, and
after setup a new limit is a timelocked change (3 days). This holds in a Cloak-owned instance too, because the guard
and the timelock are in the vault, not in who owns it. So open problem 1 (a launch token trading privately at
settlement) can't be solved by owning an instance. Options:

1. Queue the token's listing when the launch is created. The token exists at `createLaunch`, so the keeper can queue
   `setDepositLimit` in the same block, and it lands 3 days later. Works for launches that last 3 days or more. For
   shorter ones private trading opens at creation plus 3 days. Gloam's v4 router has the same 3-day queue for a new
   pool (`POOL_DELAY`), and the pool key is also known at creation.
2. A vault change (an admission adapter for Cloak's factory). That is no longer the audited contract.
3. Keep launch tokens in Cloak's own vaults (today's code) until they are listed, and move to Gloam after.

### 3.6 SDK gaps

- `@gloamtrade/sdk@0.6.0` on npm does not know Elysium at all (no `elysium.ts`; the repo's `main` has it under the
  same version number 0.6.0). The same version label covers two different codebases.
- `circuitArtifactUrls(circuit, 99801)` returns the **dev** keys, because 0.6.0 treats an unknown chain as a dev-key
  testnet. A proof made that way is refused by a final-key vault (fails safe), but every partner on Elysium has to
  pass the final keys by hand until a release knows the chain. GloamCore and the e2e scripts do.
- `buildTransferWitness` draws the change note's secret at random, so a partner that wants recoverable notes (as
  Cloak does) builds the circuit input itself. GloamCore does (same field layout, checked by the vault accepting it).

### 3.7 Things that worked as promised

- Final ceremony keys work on chain 99801 (key gate passes, dev-key proofs refused on chain).
- Kinetiq's test USDC on Elysium works in the vault (no transfer fee, plain `transferFrom`).
- The guard owns the vault, the verifiers can't be swapped, setup is closed.
- Fees: exactly 0.5% kept per cash out, collectable by anyone to the fixed recipient.
- Deposit limits enforce per deposit.
- The memo board does not emit the poster, and with a relayer submitting, no user address appears next to a private
  send, sweep, cash out or memo.

## 4. Feature table (filled in as each part lands)

| Feature | Verdict so far | Reason |
|---|---|---|
| Unlock from one signature, restore on another device | works with changes | GloamCore derives Gloam keys from Cloak's signature. Restore needs a self-memo per note (3.3) |
| Shield HYPE, USDC | works the same | HYPE needs listing in the shared vault (Gloam's Elysium plan says USDC only so far) |
| Shield CLOAK, launch tokens | works with changes | 3-day listing (3.5) |
| Private send, amount and token hidden | works with changes | bearer window and sweep (3.1), pieces (3.2) |
| Send to `.ely` name | not tested yet | |
| Withdraw, withdraw max, split cash-outs | works with changes | partial needs a split first, max is one cash out per note, fee 0.5% |
| Fast first sync | works the same on a small chain | to be measured on testnet history |
| Balance over many small notes | works with changes | k pieces (3.2) |
| Private swaps v2 and v4 | not built yet | their v4 router can take our PoolManager. Fee 0.5% (3.4), pool queue (3.5) |
| Batch rounds, sealed bids from private balance, drop bids | not built yet | |
| Claim and request links | not built yet | |
| Receive addresses that auto-shield | not built yet | |
| Proof of funds | not built yet | |
| MCP, keeper, relayer | not built yet | |

## 5. Decisions taken on my own (the safer option, per the brief)

- **No Claude attribution in git.** The user asked for it; commits are authored as NECOKIZZ with no co-author line,
  which replaces section 9's commit rule.
- **Workflows removed in cloak-v2:** npm publish (SDK, MCP) and the live keeper ping, so this repo can never publish
  or touch the live keeper.
- **Fee recipient on Cloak's test instance** is a test address of ours, not Gloam's treasury, so fee collection can
  be checked end to end. Same 0.5% rate.
- **HYPE listed** in Cloak's instance (their Elysium testnet script lists USDC only), since the founder said HYPE goes
  in the shared vault and Cloak's balances are mostly HYPE.
- **Fork funding:** on a local fork only, test USDC is borrowed from Cloak's USDC vault by impersonation. Nothing is
  sent on the real chain.
- **Gloam's Elysium testnet vault** is not deployed yet (no code at `0x39E2...0194` on 99801 on Nov 8), so all runs
  use Cloak's own instance.

## 6. Open questions for the Gloam founder (collected so far)

1. Launch tokens and the 3-day listing: is queueing the listing at launch creation (3.5, option 1) acceptable for the
   shared vault, or should launch tokens always go in Cloak's own instance? Is any admission path without the delay
   possible without leaving the audited contract?
2. Their Elysium testnet vault: when, and its addresses. Will it list native HYPE?
3. Interface fee: how is it charged and sent privately? Every escrow action already pays the 0.5% cash-out fee
   (3.4). Can an escrow's leftover or a fee note be the interface fee?
4. Their relayer on Elysium testnet: URL, limits, and does it relay calls to partner escrows and memo posts?
5. Fees: 0.5% per swap and cash out (plus an interface fee) against Cloak's 0.25% today. The split for volume.
6. New: an SDK release that knows Elysium testnet (final keys for 99801), and a version bump when `main` changes
   (npm 0.6.0 and repo 0.6.0 differ).
7. New: is a recipient-keyed note (owner key in the commitment) on the roadmap? It would close the bearer window
   (3.1) without a sweep.
