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
