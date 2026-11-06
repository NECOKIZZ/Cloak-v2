# Cloak's rules

Every rule Cloak runs on, with its number, where it is enforced, and who can change it. Numbers are the live values on
Elysium testnet (chain `99801`) as of Nov 2, 2026, read from the contracts and from `CloakConfig`.

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
| Vaults | One per asset, made once by `CloakVaults` and **never replaced or removed**, so nothing can be trapped | Contract (fixed) |
| Upgrades | New factories, routers and batchers are added **next to** the old ones. Old ones keep working, balances never move | Contract (fixed) |

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
| Private claim | Only the bidder, straight into the token's vault as a note for a one-time key. Needs the vault (the keeper opens it at settlement) and fits under the vault's deposit caps | Contract (fixed) |
| Public claims | The keeper pushes tokens and refunds to every unclaimed bidder **1 hour** after the reveal window, so winners can claim privately first. Anyone can push claims at any time | Keeper |
| Presets in the app | Quick (15 min of bidding), Standard (6 hours), Extended (24 hours); every setting can also be set by hand | App |

## The launch's market (from Nov 2: a Uniswap V2 pool)

| Rule | Value | Where |
|---|---|---|
| Which pool | A standard **Uniswap V2** pool, token / WHYPE (on testnet the WHYPE most pools use, `0xcd57…f234`), from Elysium's Uniswap V2 factory `0xb2f8…5dd0`. Pool fee **0.3%** | Contract (fixed per factory) |
| Liquidity | The creator's share of the net raise (`lpBps`, the app and SDK default to **50%**) plus matching tokens from the LP reserve, at the clearing price. Skipped if either side would be dust (≤ 10⁶ wei) | Contract (fixed) |
| Opening price | **Exactly the clearing price**, so there is no first-block arbitrage | Contract (fixed) |
| Sent to the pool early | The pool's address is known in advance. Tokens or WHYPE sent there before it has reserves are swept to `0x…dEaD`. Reserves someone synced in are topped up so the pool still opens at the clearing price; whoever sent them loses them | Contract (fixed) |
| Someone else's LP already in the pool | That pool is left alone and the launch opens a Cloak pool (`CloakPair`) instead, so nobody else's position can set the price | Contract (fixed) |
| Forcing that fallback | Impossible by starving gas: the Uniswap attempt always gets **6,000,000** gas, and settlement refuses to run with too little for it | Contract (fixed) |
| LP | The creator picks one: **locked forever with the trading fees to the creator** (the app's default), **burned** to `0x…dEaD` (Uniswap keeps its own 1,000 at address 0), or **locked** in the auction until a date, then released to the creator | Contract (fixed) |
| What the pool didn't use | HYPE goes to the creator's proceeds, tokens are burned | Contract (fixed) |
| Who can trade it | Anyone, on Uniswap, through aggregators or from any wallet. Private trades go through the same pool | — |
| Launches before Nov 2 | Their market is a `CloakPair` (same constant-product maths, 0.3%, LP burned or locked). It stays as it is | Contract (fixed) |

## Creator fees (LP locked forever)

| Rule | Value | Where |
|---|---|---|
| Where the LP goes | `CloakFeeLocker`, at settlement, for good. It has no owner, no unlock and no setting | Contract (fixed) |
| What the creator earns | The growth of the pool's √(reserve × reserve) per LP token since the lock: the pool's **0.3%** fee on every trade, public or private (plus anything someone donates to the pool) | Contract (fixed) |
| What the creator can never take | The liquidity locked at settlement. The locker stores its value and always keeps enough LP to cover it, rounded in the pool's favour | Contract (fixed) |
| Collecting | Anyone can trigger a claim; the fees always go to the beneficiary, as WHYPE and tokens | Contract (fixed) |
| Beneficiary | The creator; only the current beneficiary can hand it to another address | Contract (fixed) |
| If the launch falls back to a Cloak pool | Its LP stays in the auction forever and earns no fees for anyone | Contract (fixed) |
| Tested | Fee maths, repeated claims, flash price moves, donations, outside LPs and 256 fuzzed trade-and-claim sequences against the real testnet Uniswap: the locked value never fell | — |

## Bidding from a private balance

| Rule | Value | Where |
|---|---|---|
| How | A relayed private withdrawal funds a fresh one-time wallet with the deposit, the vault fee and a little gas (about 6M gas worth), and that wallet seals the bid | App + SDK |
| Linkability | The bid comes from an address nobody can tie to your wallet. The withdrawal shows its amount, like any withdrawal | — |
| Recovery | One-time wallets derive from your private account's seed, so the same wallet signature finds them again on any device | SDK |
| After the launch | One action claims won tokens straight into the private balance (or to the one-time wallet, then in, if a cap blocks it), collects the refund and moves the HYPE back in | App + SDK |
| A bid that didn't go through | Its funding can be moved back in at any time, before or after settlement | App + SDK |

## Private vaults

| Rule | Value | Where |
|---|---|---|
| Vaults | One per asset. A launch token's vault opens (anyone can open it) once its launch settled with a pool. Any other token (WHYPE, USDC) needs `approveAsset` first | Contract + Config |
| Notes | A vault holds up to about 1 million notes (a depth-20 tree). A note can hold up to 2¹²⁸ units | Contract (fixed) |
| Spending | Only with a zero-knowledge proof made on the owner's device (Groth16, 2 notes in, 2 out) | Contract (fixed) |
| Deposits and private sends | **Free** | Config |
| Withdrawals, private swaps, batch orders | **0.25%** of the amount, kept in the vault and collected to the treasury | Config (ceiling 1%) |
| A relayer's fee | Pays the same **0.25%**: it's value leaving the vault too (vaults deployed from Nov 7) | Contract |
| HYPE vault caps (beta) | **100 HYPE** per deposit, **10,000 HYPE** in total | Config |
| USDC vault caps (beta) | **1,000 USDC** per deposit, **50,000 USDC** in total | Config |
| Launch-token vault caps (beta) | **10%** of the token's supply per deposit, **50%** in total | Config |
| Withdrawals | **Never capped** | Contract (fixed) |
| Cap exemptions | Cloak's own router, batcher and migrator (they only move money already inside Cloak). Public HYPE shielded through the router is capped there | Config |
| Caps lift | After the external audit and the public trusted-setup ceremony | Plan |

## The shared launch-token vault (testnet experiment, from Nov 2)

Every Uniswap launch created after Nov 2 keeps its private balances in one shared vault instead of a vault of its own.
HYPE, USDC and every earlier launch keep their own vaults.

| Rule | Value | Where |
|---|---|---|
| Who gets in | A settled Uniswap launch from a registered factory, with no vault of its own. The keeper lets new launches in at settlement; anyone can | Contract (fixed) |
| Notes | Each note holds one token, and every proof spends and creates notes of one token only. A different circuit from the single-token vaults (`transactionMA2x2`) | Contract + circuit (fixed) |
| Per-token balances | The vault also tracks each token's total, so a withdrawal of a token can never take more than was put in as that token | Contract (fixed) |
| Hidden sends | A private send that pays no fee in the vault names no token. Its relayer is paid from the sender's private HYPE in the same transaction | Contract (fixed) |
| Deposits, withdrawals, swaps | Name their token, as they must (the vault has to know what to pay out) | Contract (fixed) |
| Fees and caps | The same as a launch-token vault: free deposits and sends, 0.25% on withdrawals and sells, 10% of supply per deposit and 50% in total during the beta | Config |
| Trading | Instant private buys and sells through the launch's Uniswap pool (`SharedRouter`), and batch rounds (`SharedBatcher`) with the same rules as every other token: 30 s rounds, standard sizes, one price per round, 2% price tolerance, 5% impact guard, refund after 10 minutes | Contract + Config |
| Trusted setup | A development setup, like the other circuit. The public ceremony covers both | Plan |

## Private swaps

| Rule | Value | Where |
|---|---|---|
| What the proof fixes | The market, the output vault, the minimum out, the output note and a deadline. The relayer can submit the swap but can't change it | Contract (fixed) |
| Markets | Only a launch's own registered market, and only between Cloak vaults | Contract (fixed) |
| Minimum out | The swap reverts below it and the note stays unspent. The app and SDK default to **1%** slippage | Contract + App |
| Deadline | The app and SDK give a swap **10 minutes** | App |
| The router | Holds nothing between swaps. A newer router can be added next to it without moving any balance | Contract (fixed) |

## Batch rounds (hidden size)

| Rule | Value | Where |
|---|---|---|
| Round length | **30 seconds** | Contract (fixed per batcher) |
| Order sizes | Only standard sizes, 1, 2 or 5 × 10ⁿ wei, at least **0.000001 HYPE** (10¹² wei) | Contract (fixed) |
| Crossing price | The pool's **time-weighted average price** over the round, which one transaction can't move. Buys and sells cross there with no pool fee; only the net trades on the pool | Contract (fixed) |
| Price guard | A round won't settle if the pool's price is more than **2%** away from the round's average, so a settler can't move the pool first | Contract (fixed per batcher) |
| Impact guard | The net leg may not lose more than **5%** to price impact. On a very thin pool a large round can't settle | Contract (fixed) |
| Round capacity | Each side of a round (all buys, all sells) is capped at **4%** of the pool's depth when an order lands. An order that doesn't fit goes in a later round, so one huge order can't make a round refund for everyone (batchers deployed from Nov 7) | Contract (fixed) |
| A round that can't settle | Every order is refundable as a private note **10 minutes** after the round ends | Contract (fixed per batcher) |
| Settling and paying out | Anyone can. The keeper does both | Keeper |

## Keeper and relayer (hosted, replaceable)

| Rule | Value | Where |
|---|---|---|
| What it does | Reveals bids once the drand round passes, settles launches, opens each launch's vault, pushes public claims after 1 hour, settles and pays out batch rounds, relays private transactions | Keeper |
| What it can't do | Change, steal or redirect anything: every field is bound by the proof. It can delay or refuse, and it sees your IP | Contract (fixed) |
| Relay fee | The gas it pays × **1.25**, at a gas price of at least **0.1 gwei**, taken inside the proof from the same balance. A transaction that doesn't pay it is refused before it costs anything | Keeper |
| Rate limit | **20** relay requests per IP per minute | Keeper |
| Running your own | `node services/keeper/index.mjs` with `CONFIG` set: every address comes from the registry | Keeper |

## Read them yourself

- Fees, caps and setup mode: `CloakConfig` at `0x9fdf…167f` (`withdrawFeeBps`, `launchFeeBps`, `limitOf(token)`,
  `defaultLimitBps`, `auctionLimit`, `setupMode`).
- Every contract and its start block: `readRegistry(publicClient, config)` in `@cloakely/sdk`.
- Batch settings: `PrivateBatcher` at `0x54a5…d43f` (`roundSecs`, `maxSlippageBps`, `refundAfter`, `minOrder`).
- The Uniswap settings: `CloakSeeder` at `0x633a…a88d` (`uniFactory`, `weth`, `feeNum`).
- Creator fees: `CloakFeeLocker` at `0x3b74…01d8` (`positions(id)`, `claimable(id)`, `claimableAmounts(id)`); a launch's
  `feePosition()` is its id there.
