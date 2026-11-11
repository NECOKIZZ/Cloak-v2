# GLOAK

A token that lives in private vaults. This page explains how it works, for privacy protocols on Elysium that may want to hold and trade it, and for anyone checking its rules. Contract addresses are published at deploy.

## In one paragraph

GLOAK is an ERC-20 meant to be held and traded privately. Moving it into a private vault and trading it through private routers is free. Taking it out to a public address, or moving it between public addresses, burns 10% of what is sent. Its only Uniswap pool accepts swaps from approved private routers alone, so it can't be bought or sold in public. Any privacy protocol on Elysium can hold and trade it once its vault and router are approved.

## The token

| | |
|---|---|
| Standard | ERC-20, 18 decimals |
| Supply at launch | 500,000 GLOAK, minted once, all to the launch auction |
| Team share | None |
| Minting | None after launch (see "Refunds" below for the one exception, which restores burned tokens within the same transaction) |
| Upgrades | None. No proxy |
| Surcharge | 10%, burned. It can be lowered, never raised |
| Admin | Cloak's owner wallet, with limited powers (see "Who controls what") |

## The rule

Every address has a set of roles, empty by default. A transfer is checked in this order:

1. **Into Uniswap's PoolManager:** allowed only from an address with **Feed**. Otherwise it reverts.
2. **To an address with Receive, or to 0x…dEaD:** free.
3. **From an address with Send:** free.
4. **Anything else:** 10% of the amount is burned and the rest arrives.

| Move | Cost |
|---|---|
| Deposit into an approved vault | Free; the vault receives the exact amount |
| Private buy or sell through an approved router | Free |
| Withdraw from a vault to a public address | 10% burned |
| Public address to public address | 10% burned |
| Public address paying into Uniswap (selling, adding liquidity, minting v4 claims) | Refused |
| Swapping in GLOAK's pool without the Swap role | Refused |
| Sending to 0x…dEaD | Free |
| Holding in a public address | Free |

### Roles

| Role | Bit | Meaning |
|---|---|---|
| Receive | 1 | Transfers to this address are free |
| Send | 2 | Transfers from this address are free. Only the launch auction and Cloak's hook have it, from the start; nobody can grant it |
| Feed | 4 | May transfer GLOAK into Uniswap's PoolManager. Contracts only |
| Swap | 8 | May swap in GLOAK's pool (Cloak's hook asks `canSwap`). Contracts only |
| Vault | 16 | A private vault: its withdrawals are charged, with the refund below |
| Payee | 32 | A router that one-time escrows pay; it receives refunds |

### Refunds: why private sells are free

Private routers on Elysium usually spend a note by withdrawing it to a one-time escrow address, which in the same transaction hands everything to the router. GLOAK can't recognise the escrow in advance, so the vault's payment to it is charged 10% like any withdrawal.

The token remembers that amount, keyed by the recipient, in transient storage (EIP-1153) for the rest of the transaction. When that recipient then sends its whole balance to a **Payee**, the token mints the remembered amount to the Payee, and the swap has the full amount. A real withdrawal never reaches a Payee, so its 10% stays burned. After the transaction the memory is gone.

Supply changes only by burns (surcharges) and these same-transaction refunds. The refund only ever restores what that transaction burned.

## The launch

GLOAK launches on Cloak, in a sealed-bid auction: bids are hidden until a reveal window, and every winner pays one clearing price. With prices in HYPE per GLOAK:

- **Clearing price** `p`: the highest price at which revealed demand covers the sale; if demand never covers it, everyone fills at the lowest revealed price.
- **Sold:** the sale supply if covered, otherwise total demand.
- **Raised** = `p × sold`, less a tiny rounding buffer.
- **Launch fee** = 1.5% of raised, to Cloak.
- **Net** = raised − fee.
- **Pool HYPE** = net × the pool share chosen at launch: at least 50%, Cloak's floor for every launch; GLOAK uses 70%.
- **Pool GLOAK** = pool HYPE ÷ `p`. The pool reserve must be at least the sale × the pool share, so the pool always gets its full share.
- The pool opens at exactly `p`, as one full-range position. **It is locked forever**: nobody can add or remove liquidity.
- **Creator proceeds** = net − pool HYPE. The creator is Cloak.
- **Unused GLOAK** is sent to 0x…dEaD: the unsold sale supply plus the unused pool reserve. It stays in the total supply but can never move.
- **No minimum raise.** GLOAK opens its pool whatever it raises.

Worked example: 300,000 for sale, 200,000 for the pool, a 50% pool share, and 3 HYPE of bids at 0.00001 HYPE.
- All 300,000 are sold and 2.9999 HYPE is raised; the fee is 0.045 HYPE.
- The pool opens with 1.4775 HYPE and 147,750 GLOAK; Cloak's proceeds are 1.4775 HYPE.
- 52,250 GLOAK of unused pool reserve goes to 0x…dEaD.

GLOAK's own parameters are 294,000 for sale and 206,000 for the pool, with 70% of the raise into the pool, at 0.0002 to 0.01 HYPE per GLOAK. Sold out at the lowest price, that raises 58.8 HYPE and opens a pool of about 40.5 HYPE.

**Claims.** The auction pays every winner free of the surcharge. A private bidder's winnings go straight into the vault as a note. A public bidder receives GLOAK in their wallet and can deposit it into a vault for free. From then on the rule applies.

**Anti-snipe fee.** The pool's swap fee starts high when it opens and falls to its base rate over the first minutes.

## The pool

- A native HYPE / GLOAK pool on Uniswap v4, behind Cloak's hook. The pool key is: currency0 native HYPE (address 0), currency1 GLOAK, a dynamic fee, tick spacing 60, and Cloak's hook.
- **Private-only.** Before every swap in this pool, the hook asks GLOAK `canSwap(sender)`. Only Swap-role routers pass. Uniswap's Universal Router, aggregators and bots are refused.
- **Public price.** The pool's price and each trade's size are public, as for any Uniswap pool. Who trades, and who holds GLOAK, are not.
- **Fees:** 80% to the creator and 20% to Cloak; both are Cloak here. The HYPE part funds GLOAK buybacks, which are burned at 0x…dEaD. Fees paid in GLOAK pay the 10% on their way out.
- This is the only private pool Cloak's hook will ever have. Every other Cloak launch pool is unaffected.

## The privacy meter

`meter()` returns where GLOAK is right now:
- in approved vaults;
- in Uniswap's PoolManager (the pool);
- in other approved contracts;
- at 0x…dEaD;
- in public addresses (everything else);
- the vaults' share of everything not at 0x…dEaD, in basis points.

## For privacy protocols: holding and trading GLOAK

Your protocol needs two approvals:

**Your vault: Receive, Vault.**
- Deposits arrive in full, so exact-amount checks pass.
- Withdrawals to public addresses pay 10%.

**Your router: Receive, Feed, Swap, Payee.** We approve a router only if:
- **It always delivers swap output into a vault.** Never to a public address, never as Uniswap v4 claims (ERC-6909). Swap opens GLOAK's pool to it, so this keeps the pool private.
- **It never lets a user pay GLOAK into Uniswap outside a swap** (adding liquidity, settling for claims).
- **It supports hooked, dynamic-fee v4 pools.**
- **For free private sells, it withdraws through a one-time escrow that hands its whole balance to the router in the same transaction.** Any other design works, but its sells pay 10%.
- **Leftovers paid out to a public address pay 10%**, like any exit.

**Treat GLOAK as fee-on-transfer outside your vault and router.** A transfer to an address without Receive delivers 90% of the amount.

**The process:**
1. We review your vault and router.
2. Cloak's owner wallet queues the roles on GLOAK. The change is public on-chain for 3 days.
3. It is applied, and we announce it together.

Approval can be removed at once if a contract is found unsafe. Deposits into a vault that lost its approval stop, and its withdrawals and sells then pay 10%. Nobody can move the funds in it.

## Moving GLOAK between vaults

A note can't move between vaults; each vault has its own tree. Moving is a withdrawal from one and a deposit into the other, and the withdrawal is what pays 10%.
- **Through an approved receiving address:** withdrawing to it is free and its deposit is free. What it sends anywhere else still pays 10%. Whoever controls it holds the GLOAK between the two steps.
- **Through a migrator contract** (one transaction, through a one-time escrow, with Receive and Payee): free and trustless. Not built yet.
- **Through one's own wallet:** costs 10%.

Only a note's owner can move it. Neither Cloak nor any vault owner can move anyone's GLOAK.

## Who controls what

**Cloak's owner wallet (GLOAK's admin) can:**
- **Add roles.** Instant until it ends setup, which it does once the pool is open and the pool's batch-round adapter is approved; after that, each addition waits 3 days in public.
- **Remove roles at once.**
- **Lower the surcharge.**
- **Hand the admin to another address**, in two steps.
- **Renounce the admin for good,** which freezes the roles and the surcharge.

**It can't:**
- mint, move, freeze or confiscate anyone's GLOAK;
- raise the surcharge;
- grant Send to anyone;
- grant Feed or Swap to a wallet.

**At launch, GLOAK is born with Cloak's private zone approved:** Cloak's launch vault (Receive, Vault), Cloak's router (Receive, Feed, Swap, Payee), Cloak's batch rounds (Receive, Feed, Payee) and Cloak's private bids (Receive). The auction and the hook have Receive and Send, and the hook also has Feed.

**Cloak's contracts changed only once for GLOAK:**
- **The launch-token deployer has a one-time door.** The owner wallet used it once, to launch GLOAK with this token, and it can never be used again.
- **Cloak's hook records the door's token's pool as its single private pool**, set at that pool's opening and never changeable. For every other pool, the hook behaves exactly as before.

## Known limits

- **A sell's withdrawal sent alone pays 10%.** If someone submits a private sell's withdrawal in its own transaction, away from the router, the refund can't happen. The seller recovers 90% after the swap's deadline.
- **Hookless pools.** Someone could open their own hookless GLOAK pool, sell GLOAK into it privately, and keep the result as v4 claims. That makes a small, isolated market reachable only by custom contracts. Turning claims back into GLOAK costs 10%, and GLOAK's own pool stays closed to it.
- **Public bids are possible.** A public winner gets public GLOAK, free at the claim.
- **A thin pool moves a lot.** The pool's depth is fixed at launch: with about 1.5 HYPE in it, a 0.2 HYPE buy moves the price by roughly a quarter.
- **Exchanges and public DEXs can't really hold it.** Every move to a public address pays 10%.

## Reference

**Reads**
- `rolesOf(address) → uint8`
- `canSwap(address) → bool`
- `surchargeOn(from, to, value) → uint256` (what a transfer would burn, ignoring a same-transaction refund)
- `surchargeBps()`, `MAX_SURCHARGE_BPS` (1,000)
- `surchargeBurned()`
- `meter()`
- `members(i)`, `membersCount()`
- `admin()`, `pendingAdmin()`, `setupMode()`
- `queuedAt(keccak256(abi.encode(account, roles)))`
- `poolManager()`

**Admin calls**
- `setRoles(account, roles)` (in setup, or to remove)
- `queueRoles` / `applyRoles` / `cancelRoles(account, roles)` (3 days)
- `endSetup()`, `lowerSurcharge(bps)`, `offerAdmin(to)` / `acceptAdmin()`, `renounceAdmin()`

**Events**
- `Transfer`, `Approval`
- `Surcharged(from, to, burned)`, `SurchargeRefunded(escrow, payee, amount)`
- `RolesSet`, `RolesQueued`, `RolesCancelled`
- `SetupEnded`, `SurchargeLowered`
- `AdminOffered`, `AdminChanged`

**Errors**
- `NotPrivate` (paying into Uniswap without Feed)
- `RoleNotGrantable` (Send, or Feed/Swap to a wallet)
- `TimelockRequired`, `TooEarly`, `NotQueued`
- `BadSurcharge`, `NotAdmin`

**Source:** `contracts-v4/src/experiment/GloakToken.sol` (`GloakToken`, `GloakMaker`); the hook's private pool is in `contracts-v4/src/CloakV4Hook.sol`.
