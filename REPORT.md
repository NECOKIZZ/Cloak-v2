# Cloak v2 on Gloam: test report

**Status:** Parts 0 to 2 are built and tested, and Part 3 is partly done. Everything has run on a local chain and on a
local fork of Elysium testnet. **Not done yet:** the live testnet deploy (it needs a funded testnet key), the site
pages, the keeper and the MCP tools on the seam, and receive addresses. Every number here comes from a script in this
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
