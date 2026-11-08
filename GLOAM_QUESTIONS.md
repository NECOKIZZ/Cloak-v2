# Questions for the Gloam founder

Saved for later. Not sent. The founder hasn't seen Cloak's designs yet, so these wait until they have. Background for each is in REPORT.md.

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
