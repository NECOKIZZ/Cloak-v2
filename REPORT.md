# Cloak v2 on Gloam: test report

**Status:** Parts 0 to 2 are built and tested, and Part 3 is partly done. The plan in section 16 (Cloak's launch vault,
graduation, launch swaps, the fee-paid relay, app follow-ups, allocation gates and receipts) is built and ran live on
Elysium testnet on Nov 8 (16.8). **Not done yet:** the site pages and the MCP tools on the seam, and receive addresses. Every number here comes from a script in this
repo, and its raw output is in `measurements/`. The verdict in section 9 is provisional until those parts are done.

**Pinned versions:**

- Gloam: `cryptoduke01/gloam` at `16dac34`, as `vendor/gloam` (a git submodule, unmodified)
- `@gloamtrade/sdk@0.6.0` from npm
- Foundry 1.5.1, solc 0.8.24, Node 22, snarkjs 0.7.5

## 1. Summary

Gloam's vault does what its founder said. It works on chain 99801 with the final ceremony keys and refuses dev-key
proofs. It takes Kinetiq's test USDC and native HYPE. It also works with Cloak's existing markets: Gloam's own
Uniswap v4 router swapped a real Cloak launch (FRTN) on a fork of Elysium testnet without a single change to their
code. Every Cloak action that spends a private balance was rebuilt in Gloam's escrow shape and tested hard:

- swaps on v4 and v2 pools
- sealed bids on launches
- drop bids
- batch rounds

In every case the money is always either a note or sitting in an escrow that has an exit.

Cloak would lose three things that matter:

1. **Notes are bearer notes.** A payer can take back a payment until the payee sweeps it (3.1).
2. **A new asset waits 3 days.** This applies to any `ShieldPoolPayments` vault, including one Cloak owns, so a
   launch token can't trade privately at settlement unless its launch runs for 3 days or more (3.5).
3. **Every action pays a 0.5% fee.** Swaps, bids and orders all leave the vault through a cash out (3.4), against
   Cloak's 0.25% today.

Provisional verdict: **go with changes** (section 9).

## 2. What was built

| Piece | Where | Tests |
|---|---|---|
| Cloak's own Gloam instance: Gloam's guarded `ShieldPoolPayments`, final-key verifiers, memo board | `contracts-gloam/gloam-root/DeployCloakGloam.s.sol` | `e2e-gloam/part0.mjs` (anvil, `--fork`, `--live`) |
| `PrivateCore` seam, `CloakCore`, `GloamCore` | `packages/sdk/src/core/` | `part1.mjs` (20 checks), `part1-links.mjs` (7) |
| v4 swaps through Gloam's `GloamVaultSwapV4c`, deployed unchanged on Cloak's PoolManager | `core/gloamSwap.ts` | `part2-swap.mjs` (fork, real FRTN pool, 13 checks) |
| v2 swaps: `CloakV2PairSwap`, a venue on Gloam's `GloamVaultSwap2` base | `contracts-gloam/src/CloakV2PairSwap.sol` | 20 forge tests, `part2-swap-v2.mjs` (fork, real pair) |
| Sealed bids on launches and drops: `CloakGloamBids` | `src/CloakGloamBids.sol`, `core/gloamBids.ts` | 17 forge tests, `part2-bid.mjs` and `part2-drop.mjs` (fork, Cloak's live factories) |
| Batch rounds: `CloakGloamBatcher` | `src/CloakGloamBatcher.sol` | 14 forge tests |
| Proof of funds, checked on chain | `src/GloamFundsVerifierFinal.sol` (exported from Gloam's final `funds_final.zkey`), `src/GloamFundsCheck.sol` | `part3-funds.mjs` (7 checks) |
| Claim links | `GloamCore.createClaimLink`, `claimLink`, `links` | `part1-links.mjs` |
| Cloak baseline (today's gas and proof times) | `e2e/private.mjs` with `GAS_OUT` | 21 checks |

CI (`.github/workflows/ci.yml`, job `gloam`) builds Gloam and runs every forge test, then Part 0, Part 1, the claim
links and the funds run. The fork runs need the Elysium RPC and are run by hand.

**Their audited contract stays theirs.** The deploy compiles from Gloam's own project root, so the vault, the
verifiers and the guard build from the same paths and settings as upstream. The only Cloak line in the deploy is
`_deployMainnetGuarded(99801, true)`, which lists native HYPE as well as USDC. Their key gate runs inside the deploy:
no vault is created unless the verifiers accept final-key proofs and refuse dev-key proofs. Part 0 also sends a
dev-key deposit to the live vault and checks that it is refused.

**Escrows reuse Gloam's code where it exists.**

- v4 swaps use Gloam's own router, unchanged.
- v2 swaps inherit Gloam's `GloamVaultSwap2`, which supplies the escrow, the refund, the exit, the deadline and the
  reentrancy lock. Only the 80-line venue is new.
- The batcher opens Gloam's own one-time escrow, `SwapEscrow2`.
- Only `CloakGloamBids` and the batcher's round logic are new code. These would be the "partner escrows" audit scope.

## 3. Findings

### 3.1 Notes are bearer notes (privacy and safety, the biggest change)

A Gloam note is `Poseidon(secret, amount, asset)`, with no owner key in it. The payer makes the payee's secret. So
until the payee moves the note, two things are true:

- the payer can spend it back (Part 0 shows this happening);
- the payer can work out its nullifier, and so sees on chain when the payee spends it.

Cloak's notes today belong to a key, so a payer can never spend what it sent.

**What GloamCore does about it.** Every received payment is swept into a note only the payee knows, during `sync` and
before it counts as balance. Until then it shows in `pending()`. Each sweep costs:

- another 1.78M gas transfer;
- about 0.7 s;
- a memo.

The window stays open while the payee is offline. Claim links, receive addresses and x402 payments have the same
window. After the sweep, the payer only learns that the payee came online.

### 3.2 One note in per send

A balance spread over k notes pays out in up to k separate payments. In Part 1, 35 USDC from five 10 USDC notes
arrived as 4 payments, each with its own memo and its own sweep. Cloak's 2-in circuit merges notes as it goes.

The effects:

- the recipient learns how many pieces there were;
- costs grow as a balance fragments;
- a proof of funds covers at most 4 notes, so a fragmented balance can't be proven in full.

A 2-in circuit needs a new circuit and ceremony (founder, Nov 7).

### 3.3 Restoring on a new device needs a memo per note

With no owner key in a note, a second device needs something on chain to find its notes. GloamCore makes its own
secrets from the account seed, so a forged ticket can't turn into a spendable note. It also posts every note it makes
for itself on Gloam's memo board, sealed to its own receive key (about 57k to 92k gas). A second device then restores
from the one signature (Part 1).

If a memo post fails after its transfer, the note can still be spent from the device that made it, but it won't
restore elsewhere until the memo is retried. Swaps and bids post their memo before the action, so a note that lands
can always be found.

### 3.4 The 0.5% cash-out fee applies to every escrow action

Gloam's escrow pattern takes the input out of the vault with `unshield`, so the vault's cash-out fee is charged on
every swap, bid and batch order (Parts 2a to 2d). Today Cloak charges 0.25% on cash outs and private swaps. Deposits
back into the vault are free. Two more costs come on top:

- **The swap leftover.** Gloam's router buys an exact output, so the price buffer a user leaves goes to the router's
  treasury, not back to the user. In the runs it was 1.09% (v2, a 1% buffer) and 30% (v4, while the launch's
  anti-snipe fee was high and I asked for 60% of spot). The SDK needs a tight quote: the v4 PoolManager's spot price
  and the hook's current fee.
- **The refund reserve.** A refund note keeps a 1% worst-case fee reserve, which also goes to the treasury.

### 3.5 New assets wait 3 days, in any `ShieldPoolPayments` vault

`ShieldPoolPayments` has these rules:

- it refuses a deposit of any asset with no deposit limit;
- deposit limits can't be switched off;
- after setup, a new limit is a timelocked change of 3 days.

This holds in a Cloak-owned instance too. The guard and the timelock are part of the vault, not of who owns it, so
owning an instance doesn't solve open problem 1.

What works: queue the listing when the launch is created. The token exists at `createLaunch`. Part 2c does this on
Cloak's live v4 factory: the listing is queued in the same minute, the launch settles, the listing lands 3 days later,
and the won tokens go into the private balance. So:

- a launch that runs 3 days or more trades privately at settlement;
- a shorter launch trades privately from creation plus 3 days. Until then its tokens can sit in Cloak's own vaults
  (today's code), or the bid's account holds them (the bid escrow waits, with its exits).

Gloam's v4 router has the same 3-day queue for a new pool. My v2 venue has no allowlist: a pair is valid when the
factory reports it, so a pair is usable the moment it exists.

### 3.6 SDK gaps (all fail safe)

- **npm and the repo differ under one version number.** npm's `@gloamtrade/sdk@0.6.0` has no `elysium.ts` and no
  `shortLink.ts`. The repo's `main` has both, also labelled 0.6.0.
- **The wrong keys for 99801.** `circuitArtifactUrls(circuit, 99801)` returns the **dev** keys, because 0.6.0 treats
  an unknown chain as a dev-key testnet. A final-key vault refuses those proofs, but partners have to pass the final
  keys by hand until a release knows the chain.
- **Random change secrets.** `buildTransferWitness` draws the change note's secret at random, so a partner that wants
  recoverable notes has to build the circuit input itself (GloamCore does).
- **No request links on 99801.** `buildPaymentRequestLink` only knows Gloam's own networks.
- **No funds verifier.** Gloam deploys no on-chain verifier for proofs of funds. I exported one from their final
  `funds_final.zkey` with snarkjs.

### 3.7 Proof of funds

This works the same as Cloak's, with one difference in capacity.

- **Same.** Both circuits publish the nullifiers of the notes they cover, so whoever holds the proof sees when those
  notes are spent. Both are pinned to a point in time: Gloam's vault keeps every past root.
- **On chain.** `GloamFundsCheck` checks that the root is known, that no proven note is spent, and the asset,
  threshold and context. A proof passes at or below its threshold. It fails above it, for another reader or expiry,
  and once a proven note is spent. Later deposits don't break it.
- **Capacity.** A proof covers at most 4 notes; Cloak's covers 3. A proof takes 1.8 s to make.

### 3.8 Batch rounds: one more step for the trader

Orders are public standard sizes, as in Cloak today, and who placed which stays hidden. What changes is the payout.
Cloak's vault can mint a note of any amount for a one-time key. Gloam's vault needs a proof for the exact amount, and
a payout is only known at settlement. So each trader comes back once to claim, with an owner-signed deposit. After 30
days anyone can push an unclaimed payout to the order's fallback address, in the clear. The same applies to bids: the
tokens and refund come back after settlement with a second relayed call.

### 3.9 Hostile and live tokens

- **A fee-on-transfer token.** Elysium testnet already has one: ECOSIG7 keeps 1% of every transfer. A swap into it
  arrives short and reverts as a whole, and the note stays in the vault (Part 2b).
- **A token that freezes the router.** The swap reverts. A forced refund also can't pass through the router, but the
  exit pays straight from the escrow, past the frozen router (forge).
- **A token that freezes a bid account or the batcher.** That token's payouts wait until the issuer lets go, and the
  HYPE side still pays. `CloakAuction.claim` pays tokens and the refund together, so the refund waits too. No contract
  that holds a token can do better than this against its issuer.
- **A treasury that can't receive.** It never blocks a swap.

### 3.10 Relayer economics without a relayer fee

Gloam's proofs carry no fee for whoever submits them. Cloak's do today, and that fee pays the keeper's gas and earns
Cloak an income. On Gloam the relay pays gas from its own wallet, so it has to protect itself.
`services/keeper/gloam.mjs` serves only known targets and functions and simulates every call first. Even so, a
spammer can post junk memos (or junk escrow calls that succeed) until the hourly budget runs out. In `part3-relay.mjs`
a 0.05 HYPE budget ran out after about 170 memos of 8 KB. Then the relay answers 429 until the hour resets, and users
must send their own calls, which links their wallet. Gas on Elysium is cheap (a memo is about 0.0003 HYPE), so the
budget can be generous, but this is a cost Cloak carries with no income on the other side. Options:

- an interface fee taken inside the escrows;
- a small fee note per relayed call;
- relaying only for unlocked accounts with a proof of funds.

### 3.11 Things that worked as promised

- Final ceremony keys on chain 99801: the key gate passes and dev-key proofs are refused on chain.
- Kinetiq's test USDC works in the vault (no transfer fee, plain `transferFrom`).
- The guard owns the vault, its verifiers can't be swapped, and setup is closed.
- Exactly 0.5% is kept per cash out, and anyone can push owed fees to the fixed recipient.
- Deposit limits are enforced.
- With a relayer submitting, no user address appears next to a private send, sweep, cash out, memo, swap or bid. The
  memo board does not record who posted.
- Gloam's escrow guarantees hold in every run:
  - a copied call that changes anything gets a different escrow, and the proof fails;
  - a spend sent on its own waits at its escrow, and anyone can then finish it as a refund;
  - the exit key signs for one address only;
  - a replay is refused;
  - an expired swap leaves its note unspent.

## 4. Feature table

"Works the same" means the same behaviour and privacy. "Works with changes" means it works, with the difference given.

| Feature | Verdict | Reason |
|---|---|---|
| Unlock from one signature | works the same | Gloam keys are derived from Cloak's own signature |
| Restore on another device | works with changes | a self-memo per note (3.3) |
| Shield HYPE, USDC | works the same | HYPE must be listed in the shared vault (Gloam's Elysium plan says USDC only so far) |
| Shield CLOAK, launch tokens | works with changes | 3-day listing (3.5) |
| Private send, amount and token hidden | works with changes | bearer window and sweep (3.1); pieces (3.2) |
| Send to a `.ely` name | works with changes | a name resolves to a 0x address; a private send needs the recipient's `gloamr1.` tag, for example in the name's `text(label, "gloam")` record (not built) |
| Withdraw to a `.ely` name | works the same | resolve, then withdraw |
| Withdraw, withdraw max, split cash-outs | works with changes | a partial withdraw needs a split first; max is one cash out per note; 0.5% fee |
| Fast first sync | works the same on a small chain | tree and memo scan in 13 ms locally; testnet history not measured yet |
| Balance over many small notes | works with changes | k pieces (3.2) |
| Instant private swap, v4 pools | works with changes | Gloam's router as is; 0.5% fee, leftover to the router's treasury, 3-day pool queue (3.4, 3.5) |
| Instant private swap, v2 pools | works with changes | new venue on Gloam's base; same fee and leftover; no queue |
| Batch rounds | works with changes | a claim per order after settlement (3.8); 0.5% fee on entry |
| Sealed bids from a private balance | works with changes | one-time bid account; tokens and refund come back with a second call; 0.5% fee on the deposit |
| Pool seeding, creator fees, locked LP, v4 hook, anti-snipe | works the same | untouched (they don't use the private layer) |
| New launch tokens trading privately at settlement | works with changes | only for launches of 3 days or more (3.5) |
| NFT drops: sealed-auction bids from a private balance | works with changes | public bids only; the NFT goes to a wallet the owner key picks (Gloam's vault holds no NFTs); the refund comes back as a note |
| Drops: WL boost, GTD, WL spot sales | breaks for private balances | a WL or GTD bid must come from the listed wallet, which a private balance's one-time account can't be (the same is true in Cloak today) |
| Claim links | works with changes | Gloam's own `gloam1.` note package; the claimer sweeps; the maker can take an open link back from any device |
| Request links | works with changes | a tag plus an amount, paid with `send`; Gloam's request-link builder doesn't know 99801 |
| Receive addresses that auto-shield | works with changes (not built) | a deposit proof binds the exact amount and needs the owner's secret, so either the owner's device proves when it comes online or a keeper proves and the owner sweeps (a trust window like 3.1) |
| Proof of funds, usable on chain | works with changes | 4 notes, nullifiers public as today; we deploy the verifier (3.7) |
| SDK functions | works with changes | features call `PrivateCore`; escrow helpers in `core/` |
| MCP server and its limits | not built yet | needs the MCP tools moved onto `PrivateCore` (estimate in section 8) |
| Keeper and relayer | works with changes | `services/keeper/gloam.mjs` (POST /gloam/relay) relays vault transfers and cash outs, memos and escrow calls, and refuses unknown targets, other vault functions, spent notes and calls that would revert (simulated first, no gas lost). With no relayer fee in the proof, its gas is a cost Cloak carries under an hourly budget: memo spam can use the budget up, and then users must send their own calls, which links their wallet (3.10). Listing queues at launch creation and settling batch rounds are not wired into the keeper loop yet |
| Volume page and revenue | works with changes | 0.5% to Gloam on every exit; Cloak's own relayer-fee income is gone (proofs carry no relayer fee) |

## 5. Measurements

Machine: 4 vCPU Intel Xeon at 2.3 GHz, Node 22. "One core" is the same run pinned to a single core with `taskset -c
0`, a rough stand-in for a phone. Proving here is snarkjs in Node; the browser is usually slower, so a real phone in a
browser still needs measuring.

### Proof time (median, ms)

| Proof | Cloak today (`transaction2x2`) | Gloam shield | Gloam send | Gloam cash out | Gloam funds |
|---|---|---|---|---|---|
| 4 cores | 1,090 | 119 | 489 | 448 | 1,807 |
| 1 core | 3,680 | 280 | 1,534 | 1,392 | not measured |

### Gas (anvil and Elysium fork; the Orbit chain's L1 data cost is not included)

| Action | Cloak today | Gloam |
|---|---|---|
| Shield | 939,551 | 1,141,759 (HYPE), 1,139,220 (USDC), plus a memo through the relayer (about 92k) |
| Private send | 1,695,346 | 1,787,636 plus memo |
| Receive (secure the payment) | 0 | 1,782,446 (sweep) plus memo |
| Withdraw a whole note | 1,785,841 | 313,599 |
| Withdraw part of a note | 1,785,841 | 1,787,636 (split) + 340,520 (cash out) + memo |
| Private buy or sell, instant | 2,745,400 / 2,659,913 | 1,654,052 (v4) / 1,655,749 (v2) escrow call, plus 1.79M for a split when no note matches the input |
| Forced refund / exit | n/a | 1,180,311 / 99,963 |
| Sealed bid from a private balance | not measured | 2,192,582 (spend, account, commit), plus the finish call |
| Batch order | 2,106,728 | forge only, not measured on chain yet |

At Elysium testnet's 0.1 gwei, a private send is about 0.00018 HYPE of gas, so gas doesn't decide anything here.

### Time per user action with GloamCore (4 cores, prove plus every transaction)

| Action | ms |
|---|---|
| Unlock | 36 |
| Shield | 722 |
| Restore on a new device (small chain) | 13 |
| Private send | 779 |
| Receive and sweep | 731 |
| Send from five small notes (4 pieces) | 2,980 |
| Withdraw part of a note | 1,401 |
| Withdraw max over 4 notes | 2,191 |
| Swap HYPE to FRTN (split, 4 proofs, swap, memo) | 4,871 |
| Swap FRTN to HYPE | 2,626 |
| Create / claim a link | in `measurements/part1-links-anvil.json` |

**Bundle size** (esbuild, minified, browser, snarkjs and Node built-ins left out):

| Bundle | Minified | Gzipped |
|---|---|---|
| Cloak today, `private/client.js` | 491 KB | 163 KB |
| `core/gloam.js` (GloamCore with `@gloamtrade/sdk`) | 3,530 KB | 1,685 KB |
| `core/index.js` (GloamCore, swaps, bids, Cloak adapter) | 3,726 KB | 1,753 KB |

circomlibjs is 2.5 MB of that. Correction to an earlier draft: the SDK loads it lazily (a dynamic `import()` on first
use), and my measurement inlined it because it was a single bundle with no code splitting. GloamCore computes
commitments on every sync, though, so any user with a private balance downloads it in practice. This one is ours to
fix: GloamCore can use poseidon-lite (the same constants, as Cloak already does) for its own hashing, so circomlibjs
only loads if another SDK function needs it.

The circuit files are separate downloads: 13 to 18 MB per zkey.

## 6. Privacy per action, side by side

| Action | Cloak today, on chain | Gloam (GloamCore), on chain |
|---|---|---|
| Shield | depositor, amount, token | the same |
| Private send | nothing about amount or token, a relayer as sender | the same, plus a memo next to the payment commitment. The payer can see when the payee spends it, and spend it until it is swept (3.1). Several pieces for a fragmented balance (3.2) |
| Withdraw | amount, token, recipient | the same, plus a split transfer before a partial withdraw (not linkable to it on chain) |
| Instant swap | amounts, pair, relayer | the same: amounts, pair, relayer, and a one-time escrow |
| Sealed bid | deposit, a one-time bid wallet | the same: deposit, a one-time bid account |
| Batch round | standard sizes and the net | the same, plus one claim per order |
| Proof of funds | nullifiers of 3 notes, the root | nullifiers of 4 notes, the root |
| Crowd | Cloak's own vaults | Gloam's shared vault (every Gloam partner on Elysium), a bigger anonymity set once the shared vault exists |

## 7. What Cloak gains and loses

**Gains:**

- the 13-party ceremony's final keys. Cloak's keys today come from a single-party development setup, with a public
  ceremony still planned, so this saves running a ceremony and closes a trust gap;
- a vault audited by Kann, with no Critical, High or Medium findings (the routers, circuits, SDK and relay were not in
  that audit's scope);
- a shared crowd once Gloam's Elysium vault is up;
- Gloam's v4 router as is;
- x402, MCP spending limits and payroll proofs, if wanted later;
- co-marketing and "powered by Gloam";
- cheaper whole-note cash outs (0.31M gas against 1.79M).

**Losses:**

- the bearer window and a sweep on every received payment (3.1);
- no 2-in sends, so fragmentation (3.2);
- the 3-day listing for launch tokens (3.5);
- 0.5% on every swap, bid and order instead of Cloak's 0.25% on cash outs and swaps, plus the swap leftover (3.4);
- relayer-fee income (Gloam's proofs carry no relayer fee, so a relayer pays gas from somewhere else);
- dependence on Gloam's timelock, listing reviews and SDK releases;
- a second step to claim batch and bid payouts;
- the size of the rewrite (section 8);
- about 1.6 MB gzipped more in the browser until GloamCore hashes with poseidon-lite (ours to fix, 5).

## 8. Effect on the mainnet date, and the real switch

What is left after this test (my estimate, in focused sessions like this one):

1. **Live testnet run** of Parts 0 to 2, once a key is funded: 1 session.
2. **Site pages on the seam:** Portfolio, Send, Withdraw, Links, Trade, Launch bid, Drops bid. About 3 to 4 sessions.
   Most of the UI stays; the private calls move to `PrivateCore` and the escrow helpers.
3. **Keeper:**
   - relay escrow calls and memos (not vault proofs);
   - queue listings at launch creation;
   - settle Gloam batch rounds;
   - push timeout exits.

   About 2 sessions.
4. **MCP tools on the seam, with their limits:** 1 to 2 sessions.
5. **Receive addresses, on one of the two designs in the feature table:** 1 session.
6. **An audit of `CloakGloamBids`, `CloakGloamBatcher` and the `CloakV2PairSwap` venue** (Gloam offered to coordinate
   it), plus their review of Cloak's escrows.

Effect on the date: if Elysium mainnet is 9 November and Cloak's mainnet had to ship on Cloak's own vaults first, this
work can't be on the critical path for that date. A switch to Gloam fits as a v2 after mainnet. Realistically that is
about 2 to 3 weeks of build, plus the escrow audit, plus Gloam's Elysium vault going live and listing HYPE and USDC.
Launch tokens can stay in Cloak's own vaults during the switch (3.5, option 3), so nothing has to move at once.

## 9. Verdict (provisional): go with changes

**Go**, because:

- Gloam's vault, keys and router work on Elysium with Cloak's markets as they are;
- every Cloak action fits the escrow shape with real exits;
- the gains in audited code and in the shared crowd are real.

**With these changes, before committing:**

1. **Keep launch tokens in Cloak's own vaults** until they are listed in Gloam. Queue the listing at launch creation,
   and move the token at listing (3.5).
2. **Sweep every received payment in the client** and show "securing" until it is swept. Say plainly in the UI that a
   payment is final only once it is secured (3.1).
3. **Agree the fee:** 0.5% on every escrow action plus Cloak's interface fee is too high for trading. Ask for a lower
   rate or a share of it for Cloak's volume, or route trading through the batcher, where one order pays the fee on its
   entry only (question 5).
4. **Ship the SDK fixes, or get a Gloam release** that knows 99801 and uses the final keys (3.6).
5. **Get Gloam's review of the escrows, then an audit.**

**No go would be right if:**

- Cloak must keep owner-keyed notes (no bearer window);
- or a launch token must trade privately in the first minute after a launch shorter than 3 days, and Gloam can't
  offer an admission path.

The human decides.

## 10. Decisions taken on my own (the safer option, per the brief)

- **No Claude attribution in git.** At your request, commits are authored as NECOKIZZ with no co-author line. This
  replaces the commit rule in section 9 of the brief.
- **Workflows removed in cloak-v2:** the npm publish jobs (SDK and MCP) and the live keeper ping.
- **The fee recipient** on Cloak's test instance is a test address of ours, not Gloam's treasury, so fee collection
  can be checked. The rate is the same 0.5%.
- **HYPE is listed** in Cloak's instance. Their Elysium testnet script lists USDC only.
- **Fork funding:** on a local fork only, test USDC was borrowed from Cloak's USDC vault by impersonation. Nothing was
  sent on the real chain.
- **Gloam's Elysium testnet vault** isn't deployed yet (no code at `0x39E2...0194` on 99801 on Nov 8), so every run
  uses Cloak's own instance.
- **Swap price buffers** were chosen loosely in the fork runs to make sure they fill. Production needs tight quotes
  (3.4).
- **New network hosts.** The cloud environment got the two Elysium testnet RPC hosts and `api.drand.sh`. Node's fetch
  needs `NODE_USE_ENV_PROXY=1` here to reach drand.

## 11. The founder's answers (Nov 8), checked against Gloam's repo at `16dac34` (unchanged on Nov 8, npm still 0.6.0)

| Topic | Founder's answer | What the repo shows | Settled? |
|---|---|---|---|
| Vault | use Gloam's shared Elysium vault, guarded, multisig, verifiers can't be swapped | matches (`_deployMainnetGuarded`). The controller can lower deposit limits to 0 at once (closing deposits, never withdrawals); raising a limit or the fee (cap 1%) takes 3 days | yes |
| Assets | HYPE, USDC and approved tokens in the main vault | Elysium mainnet launches **USDC only, 500 per deposit, 25,000 in total**. HYPE is not listed at launch, so it needs a timelocked listing (3 days or more after review). Their testnet script lists no native coin at all | partly: timing and caps open |
| Launch tokens | can have their own instance | an instance is the same `ShieldPoolPayments`, so a new token still waits 3 days (3.5) | no |
| Interface fee | partners can charge one, sent privately | `app/src/lib/partners.ts`: partner fees are recorded, **not collected on any network**; collecting one "needs a fee output inside the circuits and the vault contract". A swap carries no partner fee | no: their own code says it isn't possible yet |
| Relayer | supports Elysium from day one, no relayer fee | `lib/relay/server.ts` sends only the vault's transfer and unshield, memo posts and Gloam's own swap routers ("a request never names a target"), and memos only for commitments already in the vault. Elysium's budget is a starting guess of 1 HYPE an hour. Calls to partner escrows are not served | partly: partner escrows open |
| Escrows | the pattern is general, they will review Cloak's | matches (`GloamVaultSwap2`) | yes |
| Private swaps on Elysium | their router does it | `elysium.ts` and `DEPLOY-ELYSIUM.md` say no router on Elysium yet, and the SDK refuses swaps there | partly |
| 2-in sends | not in the short term | matches | yes: a sacrifice |
| Audits | vault by Kann; routers, relay and circuits being booked; partner escrows as a separate scope | matches. No grant, so the partner-escrow audit is Cloak's cost | yes |
| Blacklists | a reverting cash out leaves the note unspent; tokens listed after review | matches (`unshield` reverts whole) | yes |
| SDK | pinned versions, 2 weeks' notice | npm 0.6.0 and the repo's 0.6.0 differ, and npm 0.6.0 knows no Elysium | partly |
| Ceremony keys | work on any chain | confirmed on 99801 (Part 0) | yes |
| Elysium testnet vault | "start the testnet build whenever you're ready" | `ELYSIUM_TESTNET.pool` is null; no code at the expected address | no: when and where |
| Bearer notes | not addressed | no plan for owner-keyed notes in the repo or docs | no |
| Proof of funds verifier | not addressed | none deployed by Gloam; Cloak can deploy its own from their final key (done, 3.7) | not needed: settled on our side |
| Bundle size | not asked | lazy-loaded; ours to fix | settled on our side |

## 12. What Cloak gives up, in full

On Gloam's shared vault, as it is today:

1. **Payments become bearer notes until the recipient comes online.** The payer can take a payment back, or see
   when it is spent, until the recipient's app sweeps it. Every received payment costs a sweep (about 1.8M gas, about
   0.7 s), paid by whoever relays. Claim links, receive addresses and x402 have the same window. Cloak today has none
   of this.
2. **No merging.** A balance in k notes pays out in up to k pieces, and the recipient sees how many. Proof of funds
   covers at most 4 notes.
3. **Launch tokens wait at least 3 days**, plus Gloam's review, before they can be private in Gloam's vault, and the
   same holds in a Cloak-owned instance. A launch shorter than that can't trade privately at settlement there.
4. **HYPE isn't in the Elysium vault at launch.** Elysium launches USDC only, capped at 25,000 USDC in total for the
   whole vault (500 per deposit). Cloak's balances are mostly HYPE. Until the limits rise, Cloak's users share a
   25,000 USDC cap with everyone else.
5. **The fee rises from 0.25% to 0.5% on every exit**, and every swap, bid and batch order is an exit. Gloam can raise
   it to 1% with 3 days' notice. On top of that, the price buffer of an exact-output swap goes to the router's
   treasury.
6. **No interface fee yet.** Gloam's own code says a private interface fee needs circuit and vault changes. Today
   Cloak could only take a fee in the clear inside its own escrows (swaps, bids, batch orders). There would be no fee
   at all on sends and payments, and no relayer fee either.
7. **Cloak runs and pays for a relayer.** Gloam's relay won't send calls to partner escrows, so every Cloak swap
   (outside Gloam's own router), bid and batch order needs Cloak's relay, which pays gas with no fee coming in, under
   a budget that spam can use up (3.10).
8. **Gloam's controller decides some things.** It can close deposits at once, lists assets, and changes limits and
   fees on a 3-day notice. Cloak's users depend on that.
9. **Payouts need a second step.** Batch-round and bid payouts come back with a second relayed call (3.8), not
   automatically.
10. **The rewrite and the audit are Cloak's cost:** about 2 to 3 weeks, plus an audit of Cloak's escrows (no grant).
11. **Proof times get faster** (2 to 2.5 times), but some actions need two proofs (a split, a sweep).

## 13. A hybrid that keeps what matters

Keep Cloak's own vaults for what Gloam can't do yet, and use Gloam for what it does well:

- **Gloam's shared vault holds USDC, and HYPE once listed:** balances, private payments, claim and request links,
  cash outs, proof of funds. This brings the shared crowd, the ceremony keys, the audited vault and "powered by
  Gloam".
- **Cloak's own vaults hold launch tokens and trading:** sealed bids, settlement trading in the first minutes, batch
  rounds, the 0.25% fee and relayer fees, owner-keyed notes and 2-in sends.
- **A bridge escrow joins the two.**
  - Gloam to Cloak: unshield to a one-time escrow, then `depositTo` a one-time key in Cloak's vault, which takes any
    amount for a key.
  - Cloak to Gloam: withdraw an exact amount from Cloak's vault to an escrow, which then makes a bound deposit
    into Gloam.
  - The amounts crossing are public, as they are at any shield or cash out, and each crossing pays the exit fee of
    the side it leaves.
- **Launch tokens move into Gloam once listed** (requested at launch creation), if they still have volume.

What the hybrid keeps:

- private launches and trading exactly as today;
- Gloam's crowd and keys for payments and USDC;
- a gradual path: more moves to Gloam as they add owner-keyed notes, 2-in sends, collectable partner fees and faster
  listing.

What it costs:

- two private layers to maintain;
- the bridge escrow (to build and audit);
- users see two balances unless the app merges them;
- the crowd is split for launch tokens, which have none on Gloam today anyway.

## 14. Questions for the Gloam founder

Each of these is still open after the answers above and a check of Gloam's repo.

1. **Your Elysium testnet vault.** When do you deploy it, and at which addresses (vault, memo board, guard)? Until
   then we test on our own instance of your deploy script, which lists HYPE too.
2. **HYPE and the caps.** Elysium mainnet goes live with USDC only, at 500 per deposit and 25,000 in total. When do
   you plan to list native HYPE, and at what caps? What schedule do you have for raising the USDC caps? Cloak's
   balances are mostly HYPE, and 25,000 in total for the whole vault would fill quickly.
3. **The interface fee.** Your `partners.ts` says partner fees can't be collected yet because they need a fee output
   in the circuits and the vault. How exactly would a Cloak fee be "sent privately" on a send and on a cash out, and
   when? Are you fine with Cloak taking its fee in the clear inside its own escrows (swaps, bids, batch orders) in the
   meantime?
4. **Your relay and our escrows.** Your relay sends only the vault, the memo board and your own routers, and memos
   only for commitments already in the vault. Will it relay calls to partner escrows (Cloak's swap venue, bids, batch
   orders) once you've reviewed them? If not, we run our own relay for those. And is the 1 HYPE an hour on Elysium a
   budget for everyone together, with a share per partner?
5. **Private swaps on Elysium.** Your repo says there's no router on Elysium yet. Will you deploy `GloamVaultSwapV4c`
   there with Cloak's v4 launch pools allowlisted, or should Cloak deploy its own instance (its treasury, its pools)?
   A new pool waits 3 days on your router.
6. **Launch tokens.** A token in any `ShieldPoolPayments` vault waits 3 days, even in its own instance. Would you
   review and stand behind a variant that admits only tokens made by Cloak's factory, at once? Or is the answer that
   launch tokens stay in Cloak's vaults until they're listed? Either is workable; we need to know which.
7. **Bearer notes.** A payer can spend a payment back until the payee sweeps it. Is a note bound to the recipient's
   key on your roadmap, separately from 2-in sends? That decides whether Cloak moves private sends to Gloam now or
   keeps them in its own vault for now.
8. **The fee split.** On 0.5% of every exit, including every swap, bid and batch order Cloak brings, what share
   would you offer? Is a lower rate possible for exits into partner escrows, which go straight back into the vault?
9. **The SDK.** npm 0.6.0 differs from your repo's 0.6.0, and neither knows Elysium testnet's pool yet. When will a
   release know 99801 and 99901 with the final keys? Could `buildTransferWitness` take the change note's secret, so
   partners can make recoverable notes without copying the circuit input?

## 15. One circuit, graduation, and features built on Gloam's own work (Nov 8)

### 15.1 One circuit: yes

The 3-day wait is in the vault contract (`ShieldPoolCore`, through `ChangeTimelock`), not in the circuits. Gloam's circuits know nothing about which tokens are listed. `_setDepositLimit` is internal, so a Cloak launch vault can be Gloam's `ShieldPoolCore` and Gloam's final verifiers (the 13-party keys), plus one function: Cloak's factory sets a deposit limit for a token it has just deployed. That is roughly 30 lines of contract, with no circuit change and no new ceremony. Gloam's own vault and its 3-day rule stay untouched.

It is safe to admit factory tokens at once because every one is the same `CloakToken` contract: fixed supply, no owner, no mint, no tax, no blacklist (`contracts/src/CloakToken.sol`). The 3-day review exists for unknown token code, and here there is none to review. The rule must take only tokens the factory itself deployed, never any token that asks.

What it gives:
- one note format, one prover, one set of ceremony keys and one SDK path (GloamCore on either vault, by address);
- Cloak owns the instance, so Cloak sets its fee (it could stay 0.25%, capped at 1% by the contract) and is the fee recipient, which can also pay for Cloak's relayer;
- graduation becomes a short escrow, below.

What it costs:
- Cloak's own circuits go for launch tokens too, so owner-keyed notes and 2-in sends are lost there as well (bearer window, pieces);
- the variant needs an audit, a small one (one function, no circuit work);
- launch tokens hide in a smaller crowd than Gloam's vault, as they do today.

Not possible without Gloam changing its vault: spending a note of one vault inside the other. Each vault has its own tree, so moving between them is always cash out from one and deposit into the other.

### 15.2 Graduation

When Gloam lists a token (its 3 days and review, which Cloak can queue at launch creation as in Part 2c), a graduation escrow moves holders over:
1. the holder's note in Cloak's launch vault is cashed out to the escrow (the proof names it);
2. the escrow deposits into Gloam's vault with a note the holder made in advance from the same seed, so restore works the same way.

Public at graduation: the token and the amount, out of one vault and into the other. Not public: who. To blur amounts, graduation runs in rounds (many holders, one window) or in standard sizes. Gloam's per-deposit cap for the token applies. Cloak's cash-out fee would apply too, unless the variant exempts its own graduation escrow (one more line).

### 15.3 Features built on Gloam's own work

Gloam ships final ceremony keys for `receipt`, `funds` (solvency) and `payroll_total` as well as shield, transfer and unshield (`app/public/circuits/final`). Each one gives Cloak a feature Cloak doesn't have today:
- Private receipts (`receipt`): prove a payment, a bid deposit or a purchase happened, with the amount shown or hidden, and without revealing when the note is later spent.
- Private creator payouts and airdrops with a proven total (`payroll_total`): a creator pays holders, team or winners privately, then proves the exact total and count.
- Allocation gates by proof of funds (`funds`, verifier built in Part 3a): "holds at least X USDC" earns a launch allocation or a drop spot without revealing the wallet. The public nullifiers let the gate count each note once. This partly replaces WL spots for private balances.
- Cross-app payments: Cloak and Gloam users share one vault, one tag format and one memo board, so a Cloak user can pay any Gloam user and the reverse, and claim links open in either app.
- Gift and airdrop links for launches (`gloam1.` note packages), with take-back from any device (built in Part 1b).
- A "Graduated to Gloam" badge on tokens that reach Gloam's vault, which markets both.
- Later: Gloam's `sealedSwap` circuit (v0, not deployed) would hide swap sizes.

## 16. Plan if the founder hasn't answered (no circuit or vault changes asked of Gloam)

Facts checked on Nov 8:
- Gloam's swaps are cash outs into a swap escrow, so they pay the vault's cash-out fee and nothing else. Gloam's routers charge no fee of their own. The fee is 0.5% on Elysium (testnet and mainnet env files) and 0.25% on Base and Ethereum.
- Cloak already handles the 3-day delay this way. `CloakVaults` gives a factory launch token its vault as soon as its launch settles, with no wait. Any other token (WHYPE, USDC) needs `CloakConfig` approval, behind the 3-day timelock once setup ends.
- Sweeps and payout claims need the owner's secret, so only the user's app can do them, never the keeper. The keeper can queue listings, settle rounds and push timeout exits.

Steps, each tested on anvil and pushed:
1. A Cloak launch vault built from Gloam's `ShieldPoolCore` and final verifiers. It admits factory tokens at once, the same rule as `CloakVaults`, while every other token goes through the 3-day timelock. Cloak sets the fee and receives it. Tests: factory tokens are admitted, other tokens refused, caps hold, and the fee is collected.
2. A graduation escrow from that vault into Gloam's vault, run in rounds, with a test.
3. Cloak's own swap router on the launch vault, returning the price buffer to the user as a note.
4. The relayer paid from the launch vault's fee, plus spam limits (per-client rate limits, memos only for notes in the vault).
5. App-side automation: sweeps, bid finishes and batch claims run on every open. The keeper loop queues listings, settles rounds and pushes timeout exits.
6. Allocation gates by proof of funds, and private receipts, using Gloam's final keys.
7. The live Elysium testnet run, once `GLOAM_TESTNET_PK` is set.

### 16.1 Step 1 done: CloakLaunchVault (Nov 8)

`contracts-gloam/src/CloakLaunchVault.sol` is Gloam's `ShieldPoolCore` with Gloam's ShieldPoolPayments rules copied over (deposits take `shieldBound` only, setup can't end without both verifiers and deposit limits, no sealed swap), plus one addition, `admitLaunch(launchIndex)`.
- Anyone may call it for a settled launch from the one factory named at deploy. It gives the token fixed caps (set at deploy) at once, with no 3-day wait. This is how Cloak's own `CloakVaults.createPool` already admits launch tokens.
- It runs once per token. A second call does nothing, so a limit the owner lowered in an incident can't be raised back. A token the owner already gave limits keeps them.
- Every other asset, the verifiers and the fee still go through setup, then the 3-day timelock. The owner can still lower limits and the fee at once, and still has no function that moves user funds.
- The cash-out fee goes to Cloak. Gloam's `_withdrawFee` isn't virtual, so the vault can't exempt the graduation escrow without changing Gloam's code. Safer choice taken: no exemption, graduating pays the launch vault fee once.
- Tests in `contracts-gloam/test/CloakLaunchVault.t.sol` (14, all pass): admission, unsettled and unknown launches refused, per-deposit and total caps, re-admit after a lowered limit, other tokens need the timelock, deposit then send then cash out with Cloak's fee collected, fee cap, setup checks. The verifiers there are stand-ins. The proof checks are Gloam's unchanged code, so Gloam's final keys work as in Gloam's vault (to be shown in the live run, step 7).

### 16.2 Step 2 done: CloakGraduation (Nov 8)

`contracts-gloam/src/CloakGraduation.sol` moves a launch token from Cloak's launch vault into Gloam's vault in rounds. It reuses the escrow pattern of `CloakGloamBatcher` and Gloam's `SwapEscrow2`.
- In: one note of a standard size (1, 2 or 5 x 10^n) is cashed out of the launch vault to a one-time escrow made from the entry's key. A copier who swaps in their own key or fallback gets another escrow, so the proof fails.
- Out: after the round ends, the owner key signs a deposit of exactly what arrived, and anyone (a relayer) sends it. The signature names the vault: Gloam's, or back into the launch vault if Gloam hasn't listed the token or its cap is full.
- Never stuck: 30 days after the round, anyone can push an unclaimed entry to its fallback address.
- `roundEntries` counts each round's entries, so the app can wait for a crowd before leaving.
- No owner and no fee of its own. Graduating costs the launch vault's fee once. Gloam charges nothing on deposits.
- Limits that stay: the token and the sizes are public. Gloam still has to list the token in its own vault (its 3-day wait). Privacy grows with the number of entries per round.
- Tests in `contracts-gloam/test/CloakGraduation.t.sol` (12, all pass): graduate into Gloam's vault, many entries per round, back into the launch vault, Gloam full then back, the signature binds the vault and the note, copiers refused, a spend sent alone picked up, key checks, timeout exit. Full suite 77 of 77.

### 16.3 Graduation is holder by holder (Nov 8)

You asked whether graduation could move a token's whole vault, every note, to Gloam's vault at once. It can't without a new import function in Gloam's vault. Gloam's vault proves every deposit's amount, nobody (by design) knows which notes are already spent, and an import would let Cloak add balances to Gloam's vault on trust. So graduation is an event per token: Cloak announces it, the launch vault's limit for the token is lowered to zero at once (`lowerDepositLimit`), Gloam lists the token, and each holder's app moves their balance through CloakGraduation the next time it opens. Holders who never return can cash out at any time.

### 16.4 Step 3 done: CloakLaunchSwap (Nov 8)

`contracts-gloam/src/CloakLaunchSwap.sol` gives private swaps between launch vault notes through Uniswap V2 pairs, and gives the price buffer back to the trader.
- Why Gloam's swap base can't: a deposit needs its exact amount up front, and the leftover is known only after the swap runs, so Gloam's base sends it to its treasury (`_trySweep` is private, so it can't be changed by extending the base). Cloak's router is its own contract on the same pattern instead.
- The leftover is owed to the swap's key. The owner's app takes it back as one note of exactly that amount (`claim`, signed, sent by anyone), or in the clear to an address it signs for (`exit`).
- Same protections as Gloam's: a one-time escrow from the swap's key (spend, new note, route, owner key, deadline), so copiers fail. A spend sent alone can be swapped again before the deadline, or rescued after it (the whole input is then owed back the same way).
- No owner, fee or allowlist. A hop may use only the pair the immutable V2 factory reports. HYPE goes through WHYPE.
- Also fixed in this step: CloakLaunchSwap and CloakGraduation now refuse an already-opened escrow before trying CREATE2 again. Without that, a repeat call burned all the gas sent (about 1 billion in a test), as Gloam's own base notes.
- Tests in `contracts-gloam/test/CloakLaunchSwap.t.sol` (14, all pass): buy and sell, leftover owed and claimed as a note, exit in the clear, signature checks, greedy swaps revert with the note untouched, copiers refused, deadline, a spend sent alone then swapped or rescued, route checks, stray HYPE refused. Full suite 91 of 91.

### 16.5 Step 4 done: the relay paid from the launch vault's fee (Nov 8)

`services/keeper/gloam.mjs` now serves Gloam's vault and Cloak's launch vault side by side, with two budgets.
- Fee income. When the relay's wallet is the launch vault's fee recipient, the relay collects the vault's HYPE fees (`collectFees`, anyone may call it, the destination is fixed) once 0.05 HYPE is owed (`GLOAM_RELAY_FEE_COLLECT`). That income, net of the collect's gas, pays for calls about Cloak's contracts: the launch vault, Cloak's escrows, and memos for payments in the launch vault. At most 1 HYPE of it an hour (`GLOAM_RELAY_FEE_SPEND_PER_HOUR`), so a flood can't burn a week's income.
- Base budget. Calls to Gloam's vault and Gloam's routers use only the hourly base budget (`GLOAM_RELAY_HOURLY_SPEND`, default 1 HYPE). Cloak's fee income never pays for Gloam's traffic. Fees in launch tokens stay owed to the recipient.
- Spam limits added: a memo is relayed only for a payment commitment already in a served vault (Gloam's own relay rule), and once per commitment. Memo spam for made-up payments is now refused before sending and costs nothing (before, it ran the hourly budget out after about 170 memos). The per-IP limit (`RELAY_PER_MIN`, 20 a minute) and the earlier rules stay.
- Keeper settings: `GLOAM_LAUNCH_VAULT`, `GLOAM_ESCROWS` (Cloak's escrows), `GLOAM_ROUTERS` (Gloam's routers). `GET /gloam/relay/stats` shows both budgets.

Measured in `e2e-gloam/part4-launch-relay.mjs` on anvil (chain 99801), and the first run of CloakLaunchVault with real proofs:
- CloakLaunchVault wired to the same final-key verifiers Gloam's deploy makes, and driven by GloamCore unchanged: a deposit, a relayed private send, Bob's sweep and a relayed cash out (Bob got 0.995 of 1 HYPE and paid no gas) all pass on final-key proofs. So Gloam's circuits, keys and SDK work on Cloak's vault as they do on Gloam's.
- The relay then collected the 0.005 HYPE fee (0.00495 after gas) and paid a 1.79M-gas private send plus its memo from it, with none of its own budget. The keeper wallet ended up 0.003 HYPE ahead over that send. At anvil's gas price a 1 HYPE cash out's fee paid for about two and a half private sends. The live testnet ratio is still to be measured (step 7).
- Memo refusals (409 for a repeat, 400 for a made-up payment) and 429 for Gloam vault calls once the base budget is spent.
- `part3-relay.mjs` updated to the new memo rule and passing.

### 16.6 Step 5 done: the app's follow-ups and the keeper loop (Nov 8)

App side, `packages/sdk/src/core/launchVault.ts` (exported from `@cloakely/sdk`):
- `launchSwap()` makes a private swap on CloakLaunchSwap. `graduate()` enters a graduation round. Each returns a record the app keeps. A record holds no secrets: the signing key comes back from the account seed and the spent note.
- `finishPending(core, records)` runs on every app open. A swap's leftover comes back as a note (or the whole input, through `rescue`, when a spend landed alone and the deadline passed). A graduation leaves for Gloam's vault once its round ends, and goes back into the launch vault if Gloam's vault refuses it. It waits for at least 3 entries per round for up to a day, so a lone entry is harder to follow (`minRoundEntries`, `crowdWaitSecs`). A failure on one record is reported and the record kept, never thrown.
- Memos now go out after a deposit lands, not before, in the new helpers and in `gloamSwap` and `gloamFinishBid`. Relays (Gloam's and Cloak's) take a memo only for a note already in a vault, so "announce first" would be refused. A memo that fails doesn't undo the deposit: this device already tracks the note, and only other devices would miss it until it is posted again.

Keeper side, `services/keeper/gloamLoop.mjs`, every `GLOAM_LOOP_SECS` (60):
- it admits every settled Cloak launch to the launch vault (`admitLaunch`, so deposits open the moment a launch settles);
- it settles each CloakGloamBatcher round once it ends, or cancels it after its refund time;
- it collects the launch vault's fees for the relay.
- Each call is simulated first, so a round that can't settle yet costs nothing. The keeper still can't do follow-ups that spend or sign for a user (leftovers, payouts, graduation exits, the 30-day graduation timeout), because they need the account's seed or the entry's key. That is why `finishPending` exists.
- Keeper settings: `GLOAM_LAUNCH_VAULT`, `GLOAM_LAUNCH_FACTORY` (optional), `GLOAM_BATCHER`, `GLOAM_BATCHER_BLOCK`, `GLOAM_LOOP_SECS`.

Measured in `e2e-gloam/part5-launch-auto.mjs` on anvil (chain 99801), all on Gloam's final keys and through the relay:
- the keeper loop admitted the settled launch on its own, and did nothing the second time;
- a 2 HYPE private swap for exactly 1000 tokens, then on the next open the 0.977 HYPE buffer came back as a private note (Gloam's base would have sent it to a treasury);
- a graduation waited for its round, then moved 995 tokens into Gloam's vault. Gloam listed the token through its guard's real 3-day timelock, skipped forward on anvil. A GloamCore pointed at Gloam's vault found the note with the same wallet, and it cashed out with a final-key proof;
- a private batch buy order, left alone until its round ended, then settled by the keeper loop.

Also rerun and passing: forge (91), `part2-swap`, `part2-swap-v2`, `part2-bid`, `part3-relay`, `part4-launch-relay`, and the SDK tests (16). The bid run and the SDK's seal tests reach drand, and in this container that needs `NODE_USE_ENV_PROXY=1` for Node's fetch.

### 16.7 Step 6 done: allocation gates and private receipts (Nov 8)

Both run on Gloam's final keys, from balances in either Gloam's vault or Cloak's launch vault.

Allocation gates, `contracts-gloam/src/CloakFundsGate.sol`: "only wallets that privately hold at least X may join this launch".
- Anyone creates a gate (asset, threshold, closing time). A wallet joins with a Gloam funds proof (up to 4 notes). Its context is Gloam's `proofContext` (kind "funds", expiring at the close), computed on chain from the gate, the vault and the wallet. So a proof made for one wallet, gate or vault can't be used for another. The SDK checks that its context matches the contract's before proving.
- The proof's note nullifiers are recorded, so the same notes can't qualify a second wallet. Moving the notes to prove again spends them, and that wallet drops out. After the close the keeper loop confirms every wallet still holding, and a confirmed wallet is then free to spend.
- What it shows: that the wallet holds at least the threshold, not how much. Like every funds proof, it also shows the notes' nullifiers, so a watcher learns when those notes are later spent.
- How a launch uses it: the creator reads the confirmed wallets for the launch's allowlist. Today's CloakAuction takes a Merkle allowlist root, so that is an off-chain step. A later auction could read `isConfirmed` directly.

Private receipts, `contracts-gloam/src/CloakReceiptCheck.sol`, with `GloamReceiptVerifierFinal.sol` exported from Gloam's final `receipt_final.zkey` (its verification key matches Gloam's `final/receipt_vkey.json`):
- A receipt says "this payment note is real, of this asset, worth at least X", or exactly X when the payer shows it, for one reader until a time. The reader checks it with a view call. The note's nullifier is never shown, so the receipt says nothing about when the payment is later spent.
- GloamCore now keeps the payment notes it sends (`sentPayments()`), since the payer chose the payment note's secret and needs it for a receipt. That secret can spend the payment until the payee sweeps it, so the app must store it as carefully as the account.

SDK (`packages/sdk/src/core/gloamProofs.ts`): `joinFundsGate()` and `proveReceipt()`. Keeper loop: `GLOAM_FUNDS_GATE` turns on gate confirmations.

Measured in `e2e-gloam/part6-gates-receipts.mjs` on anvil (chain 99801):
- Alice's wallet joined a 5 HYPE gate on a final-key funds proof from two notes (4 + 2), sent by the relay. The same notes couldn't qualify a second wallet (refused at simulation, so it cost nothing). Carol joined, then spent her note before the close and dropped out. After the close the keeper loop confirmed Alice only, and she could then spend.
- Alice paid Bob 1.5 HYPE and proved it to "Shop #7" with the amount hidden: it passed for at least 1 HYPE and failed for 1.2 HYPE or for another reader. A receipt with the amount shown said exactly 1.5. It still held after Bob swept the payment.
- Proving times on this container: funds 1.4 s, receipt 0.5 s.

Also fixed: the keeper loop read the block number through viem's cache, so a tick could miss new batch orders (it caught them a tick later). It showed up as an intermittent failure in part 5. It now reads the head uncached, and part 5 passed 8 runs out of 8. Forge 105 of 105, SDK tests 16 of 16.

### 16.8 Step 7 done: the live run on Elysium testnet (Nov 8)

`e2e-gloam/live-elysium.mjs` ran everything from steps 1 to 6 live on Elysium testnet (chain 99801), on Gloam's final keys. It used a fresh testnet wallet (`0x130292b4d2A3C2aBc1C5B3747b9f18C06CfBBFE5`, key only in the git-ignored `.env`), funded with 1.3 testnet HYPE. One wallet played deployer, Alice, relay and keeper. Bob was a fresh wallet that never held gas. Addresses are in `deployments/elysium-testnet-gloam.json`, raw numbers in `measurements/live-elysium.json`. The same script with `--anvil` is the local rehearsal.

All 15 checks passed in 310 s:
- Gloam's deploy gate: the deployed verifiers took final-key proofs and refused dev-key ones;
- the keeper loop admitted the settled launch to Cloak's launch vault, with no wait;
- a 0.5 HYPE deposit; a relayed 0.1 HYPE private send, swept by Bob; Bob's relayed cash out paid 0.0995 to a fresh address; the vault held Cloak's 0.0005 fee;
- a private swap of 0.1 HYPE for exactly 50 tokens, and on the next open the 0.033 HYPE buffer came back as a note;
- a graduation: after its 60 s round, 49.75 tokens moved into Gloam's vault, where the same wallet found them, and later cashed them out;
- a private batch buy order, settled by the keeper loop once its round ended;
- a wallet joined a 0.1 HYPE allocation gate on a funds proof, and the keeper loop confirmed it after the close;
- a receipt for Alice's payment to Bob passed on chain, after Bob had swept and cashed it out.

Costs at 0.1 gwei:
- A relayed private send is 1.79M gas, about 0.00018 HYPE. A cash out is about 0.31M to 0.36M gas.
- All relayed calls together cost 0.00134 HYPE. Two 0.5% fee collections (0.00099 HYPE after gas) paid 0.0009 of it, so Cloak's fee income covered two thirds of the run's relaying.
- Deploying Cloak's contracts was 19.7M gas, about 0.002 HYPE, plus Gloam's stack through its own script.
- Of the 0.377 HYPE the wallet spent: 0.2 seeded the test pool, about 0.067 bought the swap's tokens, 0.0995 went to Bob's throwaway address, 0.005 is the batch order's payout (owed in the batcher, its exit after 30 days goes back to the wallet), and about 0.005 was gas. The wallet holds 0.92 HYPE for later runs.

Proving times in this container: shield 0.15 s, transfer 0.55 s, unshield 0.5 s, funds 1.5 s, receipt 0.5 s.

What this run doesn't show:
- Cloak's real launches: the launch, WHYPE and the V2 pool are stand-ins. Cloak's testnet launches trade on Uniswap v4, and this wallet holds none of their tokens.
- Gloam's own Elysium testnet vault: it isn't deployed yet, so "Gloam's vault" here is Cloak's own instance of Gloam's guarded deploy, with the launch token listed at deploy. On Gloam's real vault, listing a token takes Gloam's review and the 3-day wait.
- Only one user per round, so the round privacy numbers are untested.

### 16.9 The site's backend on Gloam, stage 1 (Nov 8)

Same pages and site map. Only the backend changes, chosen by one build setting, `VITE_CORE=gloam` (default `cloak`, today's site).

- `packages/sdk/src/core/gloamPrivate.ts`: `GloamPrivate` has the same methods and return shapes the pages call on `CloakPrivate`. Under it are two GloamCores made from the same one wallet signature, so one private address (`gloamr1.`) receives in both vaults. Balances add up across both.
  - **Deposits** go to the launch vault when it takes the asset (HYPE and launch tokens, so they can trade: a swap spends from the launch vault and nothing moves privately between vaults), else to Gloam's vault (USDC).
  - **Sends and cash outs** draw from Gloam's vault first, then the launch vault.
  - A page's market `pool` id is the asset itself.
  - **Numbers that differ under the same UI:** the relayer fee is 0 (Cloak's relay pays gas), and `afterFee` takes the vault's 0.5%.
- **Works on Gloam:** markets (HYPE plus every admitted launch token with its V2 pool), deposit, balance, max spendable, send, sweep, withdraw, instant buy and sell (CloakLaunchSwap, the price buffer back at once), batch orders (CloakGloamBatcher), and proof of funds. The Funds page's shareable proof is now version 2 (Gloam's funds circuit, final keys, up to 4 notes), and the SDK's `verifyFundsProof`, which the proof page uses, checks it against Gloam's final funds key, built into the SDK.
- **Not on Gloam yet:** bids paid from the private balance, Links (link accounts use Cloak's key format), receive addresses, and spread-out withdrawals. On the Gloam backend they show "This part of Cloak isn't on the new private layer yet. It's coming soon." The panel for moving balances from earlier deployments is hidden there, since those are Cloak's old vaults.
- **Circuits in the browser:** `gloamProvers()` fetches Gloam's wasm and final zkeys (13.5 MB for shield, transfer and unshield) from jsDelivr at Gloam's pinned commit, else from `/circuits/gloam` on the site. Each file is checked against a SHA-256 pinned in the SDK (`GLOAM_CIRCUIT_HASHES`). Not checked from this container: jsDelivr is blocked here, and so is Gloam's GitHub repo, so whether jsDelivr serves it (it must be public) is still to confirm. If not, the site serves its own copy.
- **The SDK's deployment record for chain 99801** now has a `gloam` block with the Nov 8 live-run addresses, marked `standIns: true`.
- **Tests:**
  - `e2e-gloam/part7-adapter.mjs` calls each method the way the pages do, on final keys through the relay. It passes, including the site's proof checker passing a v2 proof and failing it for another reader.
  - `e2e-gloam/stack.mjs` now holds the deploy steps, shared with `live-elysium.mjs`, whose anvil rehearsal passes again after the move.
  - The site type-checks and builds with both settings. SDK tests 16 of 16.

### 16.10 The real site on the Gloam backend, in a browser (Nov 8)

`e2e-gloam/part8-site.mjs` runs the actual site (`apps/web`, `VITE_CORE=gloam`) in Chromium against a local fork of Elysium testnet, where the Nov 8 live-run contracts exist. A local relay sends the private calls (never the live keeper), and an injected test wallet signs with an anvil dev account. It passes:
- the first-visit welcome and the getting-started checklist appear as before;
- "Connect wallet" then "Unlock private account" opens the account with one signature, and the Portfolio page shows a `cloak:` address built from Gloam's receive tag;
- the Shield page deposits 1 HYPE (the browser proves with Gloam's final shield key), and the Assets card shows 1 HYPE private;
- the Withdraw page sends 0.5 HYPE to a fresh address, proved in the browser and relayed, and 0.4975 arrives;
- the Trade page buys the launch token privately through its V2 pool, relayed ("Swapped privately for ~22.5 CLT").

Screenshots are in `measurements/part8-*.png`.

Backend changes this needed, with no layout change:
- **Addresses:** GloamPrivate shows its address as `cloak:` plus Gloam's `gloamr1.` tag, so every page that expects `cloak:` works. Sending takes either form, so a Cloak user can also pay a Gloam user's bare `gloamr1.` address.
- **Trade data:** the Trade page's data layer (`pages/markets.ts`) has a Gloam branch: markets are the launch vault's admitted tokens with their V2 pools, quotes use V2's 0.3% maths on live reserves, the fee is read from the launch vault, and batch mode uses CloakGloamBatcher. On the Gloam backend the page doesn't download Cloak's own circuit.
- **Fee notes:** the Withdraw and Trade notes now state the backend's real terms. On Gloam that is 0.5%, and the relayer pays the gas, with the trade's unused amount coming back.
- **Circuit copies:** `apps/web/public/circuits/gloam/` (the site's self-hosted copy of Gloam's circuits) is git-ignored. The test copies the files there because jsDelivr is blocked in this container.

## 17. Direction after Gloam's code answers (Nov 8)

The answers in `GLOAM_QUESTIONS.md` (Answers read from Gloam's public code) come from an LLM reading Gloam's public repo, not from Gloam's founder. They describe the code, not Gloam's plans. The open items wait for the founder.

**Cloak v2 is Gloam-only.** Once Gloam's side is proven, cloak-v2 drops whatever duplicates Cloak's own private layer. Cloak v1 (NECOKIZZ/Cloak) keeps all of Cloak's own mechanics, so nothing is lost. What would leave cloak-v2 at that point (not removed yet):
- the `cloak` backend in the site (`VITE_CORE` goes, `GloamPrivate` becomes the only private account);
- Cloak's own vaults and circuits: `CloakPrivate`, `SharedVaultClient`, `CloakVaults`, `ShieldedPool`, `PrivateRouter`, the batcher, the migrator, `CloakReceive`, `circuits/`, and the 15 MB of circuit files in `apps/web/public/circuits`;
- the keeper's Cloak relay (`/relay`, `/quote`, the scheduled pieces) and the site code that only serves Cloak's vaults (`scheduled.ts`, the move-from-earlier-deployments panel, the leaves snapshot).

What stays: the launch side (factory, auctions, drops, the launch pairs), the site's pages and the Gloam stack (`contracts-gloam`, `core/` in the SDK, the Gloam relay and loop).

**Decisions this settles:**
- **Launch tokens stay in `CloakLaunchVault`** (Gloam's audited core plus `admitLaunch`). Cloak's own vaults are leaving v2, so there is nowhere else to keep them. Its safety rests on our review until Gloam reviews it or it's audited.
- **Private sends use Gloam's notes,** with the sweep on every app open. That leaves the bearer window (a payer can spend a payment back until the payee's app sweeps it). The pending balance shows it, and receipts can prove a payment was made.
- **The relay follows Gloam's budget rules** (16.11) and **tests use a realistic Gloam vault** (USDC only at their caps, launch tokens through the 3-day wait).
- Later, not yet: escrows posting their note's memo in the same transaction (their memo board allows it).

### 16.11 The relay shares its budget as Gloam's does (Nov 8)

`services/keeper/gloam.mjs`:
- New sends (vault transfers and escrow entries) may use up to 80% of the hour's budget, other calls (memos) up to 92%, and refunds and exits all of it. So the top 8% is always there for getting money out.
- An exit is a vault cash out or an escrow call that takes money out or back. The 12 escrow functions are listed by selector, and each one was checked against the compiled contracts.
- One sender (the caller's IP, passed by the keeper's HTTP layer) gets at most 60%, of the base budget and of the fee income alike.
- The three shares are settable per relay and default to Gloam's.
- `part3-relay.mjs` checks each rule with real sends, and parts 4 to 8 pass on the new relay:
  - past 80% a new send is refused while a cash out still goes through;
  - one sender past 60% is refused while another still gets through.
- One effect to know: since the per-sender cap (60%) is below the new-send line (80%), no single sender can push the relay into its reserve.

### 16.12 Tests on a realistic Gloam vault, and a deadline fix (Nov 8)

`e2e-gloam/stack.mjs` now deploys Cloak's instance of Gloam's vault the way Gloam's Elysium vault will be: USDC only, at 500 per deposit and 25,000 in total. The launch token is listed later through the guard's real 3-day timelock, skipped forward on anvil. `part7-adapter.mjs` and the anvil rehearsal of `live-elysium.mjs` run on it and pass. The live testnet run keeps listing HYPE and the launch token at deploy, because 3 days can't be skipped there.

The clock jump found a bug: `GloamPrivate` set a swap's deadline from the device's clock, but the contract checks block time. A device whose clock runs behind the chain (or a chain ahead of it) would have every swap refused as expired. The deadline now comes from the latest block.

Also settled: Gloam's repo is public, so the site loads Gloam's circuits from jsDelivr at the pinned commit as planned (16.9). The self-hosted copy stays only as a fallback.

### 16.13 Payment links on Gloam (Nov 8)

Payment links now run on the Gloam backend with the same pages and the same link format. Locks, riddles, split shares, covered claim fees and taking a link back all work as before.
- **How:** a link's secret (and passcode, stretched with scrypt as before) opens a small Gloam account, and its receive tag in `cloak:` form is where the sender pays, one payment per share. Whoever opens the link sweeps it, to a wallet (a cash out, relayed, so no gas) or into their own private balance (a private send).
- **Why it fits Gloam:** Gloam's notes are bearer notes, which is what a link needs. The link account spends what it received directly (`spendReceived`), with no sweep into its own note first.
- **SDK:** `core/gloamLinks.ts` (`gloamLinkKeys`, `gloamLinkAddress`, `gloamLinkCheck`, `openGloamLinkKeys`). In `GloamPrivate`: construction from keys, `sweep(..., { one })` for a single share, `history` with spent notes, and `claims()`, which reads where each spent note went from the vault's `Unshielded` and `Transferred` events. In `GloamCore`: `spendReceived` and a record of the session's spent notes.
- **Site:** `links.ts` opens a Gloam link account and makes new link targets for whichever backend is active. The Links and Claim pages are unchanged apart from types.
- **Tests:**
  - `e2e-gloam/part9-links.mjs` covers a locked 2-share link: a wrong passcode refused on the device, the right one in another spelling opens it, one share claimed to a gasless wallet (0.2985 of 0.3), the other into another user's private balance, the claims list showing one wallet and one private, and the sender taking back an unclaimed link.
  - `part8-site.mjs` now also makes a link on the real Links page and claims it in a second browser with no wallet (0.0995 of 0.1 arrived). Screenshots are `part8-6-link-made.png`, `part8-6b-claim-page.png` and `part8-7-link-claimed.png`.
- **Still not on the Gloam backend:** bids from the private balance, receive addresses, and spread-out withdrawals.
