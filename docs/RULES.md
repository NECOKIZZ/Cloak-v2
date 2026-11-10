# Cloak's rules

Every rule Cloak runs on, with its number, where it is enforced, and who can change it. Numbers are the live values on
Elysium testnet (chain `99801`) as of Nov 9, 2026, read from Cloak v2's contracts, its `CloakConfig` and Gloam's vault.

**Where a rule lives matters:**
- **Contract (fixed):** written into the code. Nobody can change it, us included. Only a new contract could, added next
  to the old one.
- **Config:** read from `CloakConfig`. The owner can change it, within hard ceilings set in the code (see governance).
- **Keeper:** how the hosted keeper and relayer behave. Anyone can run their own with other settings.
- **App:** what the site and SDK do by default. Anyone can build a client that does otherwise, but the contracts still
  hold them to the rules above.

---

## Governance: who can change what

| Rule | Value | Where |
|---|---|---|
| Moving user funds | **Impossible.** No function in any Cloak contract moves user money. Notes leave a vault only with their owner's proof; auction money goes only to bidders, the creator and the fee recipient | Contract (fixed) |
| Setup mode | **Still on on testnet.** The owner (one wallet today) sets rules directly and instantly | Config |
| Ending setup | `endSetup()`, one way, can never be turned back on. Planned before mainnet, after ownership moves to a multisig | Config |
| After setup: tightening a rule | Instant (lower a fee, lower a cap, close deposits, remove a launch factory) | Config |
| After setup: loosening a rule | Queued on-chain, waits **3 days** in public, then must be executed within the next **14 days** or it lapses. Covers raising fees or caps, a new verifier, a new fee recipient, a new launch factory, approving an asset, registering a router | Config |
| Fee ceilings | Withdrawal fee at most **1%**, launch fee at most **3%**, whatever the owner sets | Contract (fixed) |
| Ownership | Moves in two steps (transfer, then accept) | Contract (fixed) |
| Vaults | Gloam's vault and `CloakLaunchVault` (Gloam's vault code plus `admitLaunch`). Exits never close, even when paused | Contract (fixed) |
| Upgrades | New escrows are added **next to** the old ones. Old ones keep working, balances never move | Contract (fixed) |

## Launches (sealed-bid auctions)

| Rule | Value | Where |
|---|---|---|
| Price levels | 1 to **256** ticks. Price at tick *t* = `minPrice + t × tickSize` | Contract (fixed) |
| A bid on-chain | A hash plus a drand-timelock ciphertext. The chain can't read price or size until bidding closes | Contract (fixed) |
| Deposit buckets | The app rounds every deposit up to 1, 2 or 5 × 10ⁿ, so it only shows the order of magnitude | App |
| Opening bids | Anyone with the bid's preimage can reveal it, only during the reveal window. A reveal can't change a bid | Contract (fixed) |
| Timelock round | Must open after bidding closes and at least **30 s** before the reveal window ends | Contract (fixed) |
| A valid bid | Its deposit must cover price × quantity at its tick. One that doesn't fails to reveal and counts as unrevealed | Contract (fixed) |
| Unrevealed bids | Lose the creator's penalty, at least **10%** and at most **50%** of the deposit, **burned**. No penalty if the launch fails | Contract (fixed) |
| Clearing price | Walk from the highest tick down until demand covers the sale. Every winner pays that one price; the clearing tick fills pro rata; lower bids get everything back. If demand never covers the sale, everyone fills at the lowest revealed tick, so one bid at the minimum price sets the price for everyone (standard for uniform-price sales). Creators: set a minimum you are happy to sell at | Contract (fixed) |
| A failed launch | Only when no bid was revealed. Every deposit is refunded in full and every token goes back to the creator | Contract (fixed) |
| Launch fee | **1.5%** of a successful raise, fixed when the launch is created. Nothing if it fails | Config (ceiling 3%) |
| Bid caps (beta) | **100 HYPE** per bid, **10,000 HYPE** per launch, fixed when the launch is created | Config |
| Creator share | At most **20%** of the supply, always vesting linearly over at least **30 days** from the end of the reveal window | Contract (fixed) |
| Token | Fixed supply minted once, 18 decimals, no owner, no mint, no tax, no blacklist | Contract (fixed) |
| Unsold tokens | Burned to `0x…dEaD`, with any LP reserve the pool didn't use | Contract (fixed) |
| Getting paid | Pull-based: the creator's proceeds and the fee are withdrawn separately, so a recipient that can't take HYPE can't block anyone. A refund a bidder's address can't take is held for them to withdraw to any address | Contract (fixed) |
| Private bids | Bids paid from a private balance go through `CloakGloamBids`. Winnings come back into the launch vault once the launch is admitted | Contract (fixed) |
| Claims | Bidders claim tokens and refunds, and creators withdraw their raise (`withdrawProceeds`), **whenever they like**. Nothing expires. Anyone can push a claim or the raise to its owner, but the keeper doesn't (`PUSH_CLAIMS=1` turns that back on). The app's bell lists what's waiting | Keeper |
| Presets in the app | Quick (15 min of bidding), Standard (6 hours), Extended (24 hours); every setting can also be set by hand | App |


## The launch's market (Uniswap v4)

| Rule | Value | Where |
|---|---|---|
| Which pool | A Uniswap v4 pool, token / HYPE, on testnet's PoolManager `0x5102…2e68`, with `CloakV4Hook` | Contract (fixed per factory) |
| Liquidity | The creator's share of the net raise (`lpBps`) plus matching tokens, at the clearing price | Contract (fixed) |
| Opening price | **Exactly the clearing price**, so there is no first-block arbitrage | Contract (fixed) |

## Private balances (Gloam's vault and the launch vault)

| Rule | Value | Where |
|---|---|---|
| Proofs | Gloam's circuits and final keys, made on your device. Cloak never changes them | Contract (fixed) |
| Withdrawal fee | **0.5%** on both vaults, kept in the vault and collected to the fee recipient (ceiling **1%**) | Vault owner |
| Gloam's vault (Cloak's testnet instance) | USDC only, **500** per deposit, **25,000** in total | Vault owner |
| Launch vault | HYPE **10** per deposit, **1,000** in total. Each launch token is admitted once its launch settles, with fixed caps | Vault owner |
| Who controls it | Gloam's `VaultOwnerGuard`. The launch pauser can only stop admissions, never touch funds | Contract (fixed) |
| Graduation | `CloakGraduation` moves balances from the launch vault into Gloam's vault in **1-hour** rounds | Contract (fixed) |

## Private swaps and batch rounds

| Rule | Value | Where |
|---|---|---|
| Instant swaps | `CloakLaunchSwapV4` swaps on the launch's v4 pool. The proof binds the pool, the minimum out and your output note | Contract (fixed) |
| Batch rounds | `CloakGloamBatcherV4`: **60 s** rounds, standard sizes (1, 2 or 5 × 10ⁿ), buys and sells crossed at the round's time-weighted price, only the net hits the pool | Contract (fixed) |
| Batch price guard | A round won't settle if the pool is more than **2%** off the round's average price | Contract (fixed) |
| Batch refunds | A round that can't settle is refundable after **10 minutes** | Contract (fixed) |

## The ecosystem vault (outside tokens, KNTQ first)

| Rule | Value | Where |
|---|---|---|
| Who holds what | Gloam's vault: HYPE and USDC. The launch vault: Cloak launch tokens. The ecosystem vault: admitted outside tokens. The router picks the vault from the asset; nobody can point a swap elsewhere | Contract (fixed) |
| Who proposes a token | Only the approver, Cloak's Safe (partner approval) | Contract (fixed) |
| The market | A plain native-HYPE Uniswap v4 pool with no hook, so the router can trade it | Contract (fixed) |
| Liquidity | At least **250 HYPE** in the pool's current range (mainnet config) | Contract (fixed at deploy) |
| Market cap | At least **100,000 HYPE**: the token's supply at the pool's price (mainnet config) | Contract (fixed at deploy) |
| Caps | At most **0.1%** of the supply per deposit and **1%** in total (mainnet config) | Contract (fixed at deploy) |
| Delay | **3 days** from proposal to admission, and every rule is checked again at admission. Anyone may admit once it's ready | Contract (fixed at deploy) |
| Stopping one | The pauser cancels a proposal or pauses admissions; the Safe lowers or zeroes a listed token's caps at once. Withdrawals never close | Contract (fixed) |

## Keeper and relay (hosted, replaceable)

| Rule | Value | Where |
|---|---|---|
| What it does | Reveals bids once the drand round passes, settles launches, admits them to the launch vault, settles batch rounds, collects the launch fee, relays private actions | Keeper |
| What it can't do | Change, steal or redirect anything: every field is bound by the proof. It can delay or refuse, and it sees your IP | Contract (fixed) |
| Relay budget | Follows Gloam's relay rules (per-sender shares, an exit share, a revert cap), paid from the launch vault's fee | Keeper |
| Rate limit | **20** relay requests per IP per minute | Keeper |
| Running your own | `node services/keeper/index.mjs`, every setting in `render.yaml` | Keeper |

## Read them yourself

- Launch fee, bid caps and setup mode: `CloakConfig` at `0xfedf…4f1e` (`launchFeeBps`, `auctionLimit`, `setupMode`).
- Vault fees and caps: `withdrawFeeBps()` and the asset limits on Gloam's vault `0x8D15…cB44` and the launch vault `0x1305…288f`.
- Batch settings: `CloakGloamBatcherV4` at `0xbd4a…28f8` (`roundSecs`, `maxSlippageBps`, `refundAfter`).
