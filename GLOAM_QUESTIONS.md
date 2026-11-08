# Questions for the Gloam founder

Questions 1 to 9 and the upgrade list were answered by Gloam's founder (Duke) on Nov 8: see "Answers from Gloam's founder" below, which overrides the LLM-read answers further down wherever they differ. Background for each is in REPORT.md.

## What we need, for testnet now and for mainnet (Nov 9)

Checked on Nov 8, night: Gloam's promised testnet vault (`0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194`) has no code on chain 99801 yet.

### Gloam owes us on testnet (promised Nov 8)
1. Their Elysium testnet vault live at `0x39E2…0194`, plus the guard and memo board addresses and the deploy block.
2. Their deployed verifier contracts on testnet (unshield and shield), so our launch vault uses theirs, not copies.
3. Their review of our escrows, then our escrows added to their relay with a per-partner budget (pack: `docs/gloam-pack/ESCROWS.md`).
4. Their one-time review of the factory token, so launch listings in their vault go quickly (pack: `docs/gloam-pack/FACTORY-AND-POOLS.md`).
5. Their review of the launch-vault diff (pack: `docs/gloam-pack/LAUNCH-VAULT-DIFF.md`).
6. The SDK release that knows 99801 and 99901 with the final keys, and the change-note seed in `buildTransferWitness`.

### For mainnet: from Gloam
1. **The mainnet vault on 99901:** its address (the same `0x39E2…0194`?), guard, memo board, deploy block, and the USDC it lists (address and decimals). Their runbook (`DEPLOY-ELYSIUM.md`) deploys USDC only at 500 per deposit and 25,000 in total.
2. **Their verifier contracts on 99901**, so `CloakLaunchVault` is deployed on the same final-key verifiers as theirs.
3. **The fee:** 0.5% on Elysium. Is the split, or a lower rate on exits into reviewed partner escrows, settled before mainnet?
4. **Relay on mainnet:** does theirs relay our escrows from day one, or do we run ours (ours is ready, paid from the launch vault's fee)?
5. **Their router on 99901:** they list "no router on Elysium" for now. Our `CloakLaunchSwapV4` doesn't need it.
6. **Graduation:** when a Cloak token graduates into their mainnet vault, who starts the 3-day listing, and at what caps?
7. **Permission to say it publicly:** may Cloak say "built on Gloam" (or similar) at launch, and is there wording they want or want to avoid? Their runbook says no partnership wording on their side yet.
8. Their own launch-day checks: a small deposit, send and cash out done, relayer funded.

### For mainnet: from Elysium (Kinetiq)
1. **A public RPC for 99901** that serves `eth_getLogs` at our volume (the site, the keeper and the relay all scan logs), and its rate limits. The official one (`rpc-elysium-mainnet.t.conduit.xyz`) answered 403 on Nov 3, and we read mainnet through ElysPump's relay.
2. **The canonical USDC on 99901**, and whether it's the same token Gloam lists.
3. **The block explorer and its verification API** (or Sourcify), to verify every contract.
4. **Confirmation that the Uniswap v4 deployment on 99901 is the one to use:** PoolManager `0xe2e1…23f1`, owner `0x2179…27b6`, an ordinary wallet and not Uniswap governance. Who is that owner, and will it move to governance?
5. **WHYPE on 99901** is an upgradeable proxy (`0xbA87…5E81`). Who is its admin? (Cloak deploys its own fixed WHYPE either way.)
6. **The block time and gas** on mainnet: about 1.1 s per block on Nov 3, against about 0.09 s on testnet. Our batch rounds and timeouts are in seconds, so they hold. Does the sequencer show transactions before a block (Gloam asks the same, for partner links)?
7. Listing in Elysium's ecosystem pages and the explorer's token list, and a contact for incidents.

### For mainnet: from us (Cloak)
1. **No ceremony needed for v2:** it proves on Gloam's final keys. Cloak v1's own ceremony is only for v1's vaults.
2. **A multisig** (Safe) on 99901 for the launch vault's guard controller and the launch pauser, and **separate keeper and relayer keys**.
3. **Cloak's launch factory and v4 hook on 99901:** v2's launch vault admits launches of one factory, fixed at deploy. Does v1's mainnet deploy make that factory, and does v2 point at it?
4. **An outside review** of our escrows and `CloakLaunchVault` (Kann audited only Gloam's vault). Keep deposit caps low until then.
5. Deploy and verify, then hosting: gloak.boblabs.tech and the keeper with the `GLOAM_*` settings.

### New questions for Gloam's founder
1. Is the mainnet vault at the same address as testnet (`0x39E2…0194`), and when exactly does it go up?
2. Can our escrows be on your mainnet relay from day one, or after your review only?
3. Is the fee split settled before mainnet, and does a lower rate on exits into reviewed escrows come at launch or later?
4. May we name Gloam publicly at our launch, and with what wording?
5. When a Cloak launch token graduates to your vault, can its 3-day listing start at its launch, so it is listed by the time trading settles down?
6. Which USDC address does your Elysium mainnet vault list?

## From REPORT §14 (Nov 8)

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

## New from the build

10. **The graduation escrow and the fee.** Cloak's launch vault (`CloakLaunchVault`, REPORT §16.1) is your `ShieldPoolCore` plus instant admission of settled Cloak launches. A token graduating to your vault is cashed out of Cloak's vault into an escrow that deposits it into yours. `_withdrawFee` isn't virtual, so the escrow pays Cloak's fee on the way out. Would you make the fee hook virtual (or add a fee-exempt address) in a later release, so a graduation pays no double fee? Until then it pays once.
11. **Standing behind CloakLaunchVault.** It changes nothing in your vault code and adds one function. Would you review it, and may Cloak say it's built on your vault and keys?

## Answers from Gloam's founder (Nov 8)

What he said, what it confirms or overrides from the code-read answers below, and what we do.

1. **Testnet vault:** goes up "this week" at `0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194`, the same address on every chain. Guard and memo board addresses to follow. *Answers the open item.* We: keep testing on our own instance until it's live, then set `gloam.gloamVault`, `memoBoard` and `block` in `deployments.ts` and redeploy what takes Gloam's vault in its constructor (`CloakGraduation`, `CloakGloamReceive`, `CloakFundsGate`, `CloakReceiptCheck`).
2. **HYPE and caps:** mainnet opens USDC only, at 500 per deposit and 25,000 in total. HYPE comes after launch, and every change takes the 3-day timelock. *Confirms the code read.* Our design already fits: HYPE and launch tokens live in Cloak's launch vault, USDC in Gloam's. `stack.mjs`'s realistic mode stays the default.
3. **Interface fee:** take it in the clear inside our own escrows. *Confirms.* Today Cloak's only fee is the launch vault's 0.5% cash-out fee. A fee on Gloam-vault flows (USDC sends have none) would have to be an escrow fee, and that is Bob's call. No fee is added without his approval.
4. **Relay:** Gloam will review our escrows, then add them to their relay, and can set up a per-partner budget. *Overrides "we run our own relay" as the long-term answer.* We keep running ours until their review is done. Pack for Bob: `docs/gloam-pack/ESCROWS.md`.
5. **Their router on Elysium:** they'll deploy it once our v4 launch pools exist and allowlist the pools we name. New pools still wait 3 days. *Answers the open item.* `CloakLaunchSwapV4` trades instantly without them, so it stays the main path. Pool key list for Bob: `docs/gloam-pack/FACTORY-AND-POOLS.md`.
6. **Launch tokens:** listing in Gloam's main vault stays on the 3-day timelock, even for factory tokens. Launch tokens stay in Cloak's own vault until they list them. *Confirms, and this is exactly our design* (CloakLaunchVault plus graduation). They'll review the factory token contract once, after which listings go quickly. Pack for Bob: `docs/gloam-pack/FACTORY-AND-POOLS.md`.
7. **Bearer notes:** recipient-bound notes are on their roadmap, not this month. *Confirms.* We keep the sweep on every open and the pending balance shown.
8. **Fee split:** a share to be confirmed. He's open to a lower rate on exits into reviewed partner escrows. *Still open, now with a direction.* No code change.
9. **SDK:** a release that knows 99801 and 99901 with the final keys comes around mainnet, npm will match the repo, and a change-note secret input for `buildTransferWitness` is in that release. *Answers the open items.* When it ships: bump `@gloamtrade/sdk`, rerun `part1.mjs` and parts 3 to 14, and use the change seed so change notes are recoverable from the account seed.
10. **Our launch vault:** use their deployed verifiers (any vault can call them). They'll review the diff of our one function (`admitLaunch` plus the pauser). *Answers 11 in part.* It isn't covered by Kann's audit, so it still needs our own outside review before mainnet. Pack for Bob: `docs/gloam-pack/LAUNCH-VAULT-DIFF.md`.
11. **Graduation caps:** when a token graduates, they'll set its caps high enough for a full graduation round. *Answers the open item in 10.* `CloakGraduation` already works this way, and `finishPending` falls back to the launch vault if Gloam's vault refuses.
12. **Upgrade list** (partner fees and a relayer fee in the proof, 2-in sends, recipient-bound notes, one-step partial cash outs): on their roadmap, with an order to come after Elysium is live. The swap buffer going to their treasury is by design (ours returns it through `CloakLaunchSwapBase`, which is fine). They'll look at the memo board accepting posts before a note is in the vault.

Still open after his answers: the fee split (8), the guard and memo board addresses (1), the date of their router (5), and the order of the upgrade list (12).

## Answers read from Gloam's public code (Nov 8)

An LLM read Gloam's public repo (`cryptoduke01/gloam` at `16dac34`) to answer these early. So these answers say what the code does today, not what Gloam promises. Every "still open" item waits for Gloam's founder.

The constraint behind most of them: Gloam's Elysium vault is owned by a `VaultOwnerGuard` that can never swap its proof checkers. Anything that needs a circuit change needs a new vault, a new ceremony and users moving over. Plan as if these won't come soon: 2-in sends, notes bound to the recipient's key, a partner fee output, a relayer fee inside the proof, one-step partial cash outs, and a lower fee on escrow exits.

1. **Testnet vault:** not deployed, and the SDK has no pool for Elysium testnet. We keep testing on our own instance of their deploy script. Still open: the addresses.
2. **HYPE and caps:**
   - The vault supports native HYPE (address 0).
   - Their mainnet launch caps are USDC only: 500 per deposit, 25,000 in total.
   - Listing an asset or raising a cap after launch takes a public 3-day wait.
   - Their testnet script can't list native HYPE without a code change.
   - Still open: when HYPE is listed, and when caps go up.
3. **Interface fee:** it can't be collected privately (sends are 1 note in, 2 out, with no third output). Take Cloak's fee in the clear inside Cloak's own escrows.
4. **Relay:**
   - Theirs sends only to their own vault, memo board and routers, so we run our own relay for escrow actions.
   - The 1 HYPE an hour is one budget for the whole chain. 80% of it can go to new sends, and the top 8% is kept for refunds and exits.
   - One sender (an IP or a partner key) gets at most 60%.
   - Still open: whether they'll relay to our escrows.
5. **Swap router:** none on Elysium. `GloamVaultSwapV4c` makes the pools passed to its constructor live at once, and pools added later wait 3 days. Still open: whether they deploy it, or we run our own instance.
6. **Launch tokens:** every instance lists tokens through the 3-day wait. Instant admission needs a modified vault. Still open: whether Gloam will review ours.
7. **Bearer notes:** confirmed. A note is Poseidon(secret, amount, asset), so whoever holds the secret can spend it until the recipient sweeps it. Binding notes to a key needs a new vault.
8. **Fee on exits:** one fee on every cash out, with no destination exempt, so every swap, bid and batch exit pays it. Still open: a split or rebate.
9. **SDK:**
   - The repo is at 0.6.0, with Elysium mainnet not filled in.
   - The change secret is random, while the payment side already takes a seed (`paySeed`), so a change seed is a small change.
   - Still open: the release date, and whether a change seed goes in.
10. **Graduation and the fee:** see 8. Caps are set per token, so a graduated token can get caps big enough for a whole round, but it still waits 3 days. Still open: the cap sizes.
11. **CloakLaunchVault:**
    - Their verifier contracts hold no state, so we can point at theirs once they're deployed on Elysium.
    - If we deploy copies, their `CheckCeremonyKeys` script proves the copies hold the final keys.
    - Keep the GPL-3.0 headers on the verifier files.
    - Still open: whether they'll review it and stand behind it.

From our upgrade list:
- **Swap buffer back as a change note:** hard by design. The new note's amount is proven before the trade, and the buffer is only known after. With their router, the leftovers go to the router's treasury and can be refunded. Our `CloakLaunchSwap` does it differently: it owes each swap its leftover, and the owner's app takes it back as a note.
- **Memo before insertion:** no change needed. Their memo board takes any commitment, and only their relay checks that the note is in the vault. Our escrows can call `postMemo` directly.
- **Sealed swaps:** blocked on purpose by a known critical bug (ZK-1) and an open solvency issue (H1). Our batch rounds cover hiding trade size.
- **On-chain verifiers for receipt, payroll and funds:** the final keys exist, but no verifiers are deployed. We built the funds and receipt verifiers ourselves.
- **Audit status:** Kann audited only their vault. Their swap routers, escrows, owner guard, relay and circuits have had internal review only. An outside review is "being sourced".
