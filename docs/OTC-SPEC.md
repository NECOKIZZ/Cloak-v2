# Cloak OTC: spec

Status: draft for the team. Nothing here is built yet. It describes what the **NFT drops** page becomes: one **OTC** page where anyone can sell a block of tokens, NFTs, WL or GTD spots and (later) pre-market allocations in a sealed auction or a private deal, paid from a public wallet or a private balance.

> **Sell the block without moving the chart.** Bids stay sealed until bidding closes, hidden even from the sequencer. Every winner pays one clearing price. Buyers and sellers can both stay private.

---

## 1. Why this is mostly built already

OTC is our existing escrow drop, made general. What we have today:

| What exists | What it already does | What OTC reuses |
|---|---|---|
| `CloakEscrowDrop` + factory | Moves a seller's NFTs into escrow in the creation transaction, runs a sealed auction (drand-timelocked bids, one clearing price, WL boost, fair tie draw), delivers to winners, returns unsold items | The whole auction core: commit, reveal, settle, tie numbering, claim, refunds, non-reveal penalty, fees |
| `CloakDrop` | New collections with GTD and WL phases | Stays as the "new mint" listing type |
| `CloakSpotBook` | Sells a partner's WL/GTD spots through a drop; winners name wallets, the partner reads the list | Stays as the "spots" listing type |
| `CloakGloamBids` | Sealed bids paid from a private balance, through a one-time bid account. Works on **any auction with Cloak's bid shape** (`commit`, `claim`) | Private bidding on every OTC sale for free, as long as OTC keeps that shape |
| Payment links / `CloakGloamReceive` | Links that carry money, one-time addresses | The model for private deal links |
| `.ely` names, keeper, relay, SDK, MCP | Reveals, settles, relays | Unchanged; the keeper learns one more contract |

**The one rule for the contracts:** every OTC sale keeps the `commit(commitment, sealedBid)` / `claim(id)` shape and the view surface `CloakDrop` and `CloakEscrowDrop` share. Then the site, the keeper, `CloakGloamBids` and the MCP read and bid on every sale type with one client.

---

## 2. What can be sold

Two kinds of item, and the difference matters.

**Enforced on chain.** The contract holds the item before bidding opens and hands it over in the same transaction that pays the seller. Nobody has to trust anybody.

**Promised off chain.** The item is a promise someone else keeps (a partner whitelisting a wallet, a project delivering tokens at launch). The contract can only hold the money, so these need extra protection: a partner's sign-off, a waiting period, or seller collateral.

### Phase 1 (launch with these)

| Item | Kind | Notes |
|---|---|---|
| **Token blocks** (ERC-20): Cloak launch tokens, ecosystem tokens, any ERC-20 | Enforced | The headline OTC product. Sold in lots, one clearing price per lot |
| **NFTs you already own** (ERC-721) | Enforced | Today's `CloakEscrowDrop`, unchanged |
| **New collection drops** | Enforced (minted) | Today's `CloakDrop` |
| **WL / GTD spots** | Promised | Today's `CloakSpotBook`, with the partner sign-off in section 6 |

### Phase 2

| Item | Kind | Notes |
|---|---|---|
| **ERC-1155 items**: editions, game items, passes | Enforced | Same as NFTs, with quantities per id |
| **Locked and vesting positions** (`CloakVesting` and others) | Enforced, if the lock lets its beneficiary be changed | A team selling a vesting allocation at a discount. Show the unlock schedule on the listing |
| **LP positions** (Uniswap v3/v4 position NFTs) | Enforced | They're ERC-721s; the listing reads and shows the position's range and value. Cloak launch pools themselves are locked forever and can't be sold |
| **Creator fee rights** (a launch's 80% fee share) | Enforced, if `CloakV4Hook` lets the creator change who receives fees | A creator sells future fee income for cash today. Needs a check of the hook |
| **`.ely` names** | Enforced, if names are NFTs | Premium names by sealed auction |

### Phase 3

| Item | Kind | Notes |
|---|---|---|
| **Pre-market allocations**: tokens or airdrops that don't exist yet | Promised, backed by seller collateral | See section 7. The riskiest type; build last |

### Never allowed

The listing form, the SDK and the keeper refuse these, and the team removes listings that slip through:
- social media, Discord or exchange **accounts and logins** (against those platforms' rules, and impossible to enforce);
- seed phrases, private keys or anything that hands over control of a wallet;
- contract ownership or admin roles of live protocols (it lets a buyer take over other people's money);
- tokenized stocks and other real-world assets outside a proper legal setup (xStocks stays its own product);
- stolen or sanctioned assets, and tokens that copy another project's name or ticker.

**Token rules for ERC-20 blocks:**
- The contract measures what actually arrived and refuses tokens that charge a fee on transfer, change balances on their own (rebasing) or can pause or block transfers.
- Listings show a badge: **Cloak launch**, **Listed by Cloak** (in the ecosystem vault) or **Unverified**. Unverified tokens get a warning with the contract address in full.

---

## 3. Ways to sell

| Format | How it works | Best for |
|---|---|---|
| **Sealed auction** (exists) | Everyone bids sealed, bids open at close, winners pay one clearing price | Blocks with several buyers, NFTs, spots |
| **Deal link** (new) | A fixed price for one buyer: a named wallet or `.ely` name, or whoever holds the link's secret code. The seller's item waits in escrow until the buyer pays, or the link expires | A deal already agreed in DMs. The fastest thing to ship |
| **Request for quote** (Phase 2) | A buyer posts "I want 2M TOKEN", listed market makers answer with sealed quotes, the buyer takes the best | Large buyers, once market makers are on board |

Options on a sealed auction:
- **Hidden reserve.** The seller's minimum price is sealed to the same drand round as the bids, so buyers can't bid exactly at the floor. If no bid reaches it, everything goes back. "Size and price stay sealed."
- **Partial fills.** Token blocks sell in lots (for example 100 lots of 20,000 TOKEN), each bid asks for a number of lots, and the seller sets a minimum number of lots per bid.
- **WL boost**, as today: the seller's community bids with a boost.
- **Allocation gates:** only wallets that prove (privately, with `CloakFundsGate`) that they hold enough of something can bid.

---

## 4. Privacy: what is hidden and what isn't

| | Phase 1 | Phase 2 |
|---|---|---|
| **Who the buyers are** | Hidden when they bid from a private balance (`CloakGloamBids`) | Same |
| **What each buyer bid** | Hidden until close (drand). After close, bids are public, as in drops | Same |
| **Who the seller is** | Visible (their wallet creates the sale) | Hidden: the seller lists from a private balance through a one-time **seller account**, the same pattern as `BidAccount` |
| **What is for sale and how much** | Visible (the escrow holds it in public) | Same: a public escrow shows its contents |
| **The seller's reserve** | Hidden until close, if they choose a hidden reserve | Same |
| **Where the proceeds go** | To the seller's wallet, or into their private balance through `finish` | Same |

Hiding the block size too needs settlement inside the vault (matched proofs, no public escrow). That's a different design and isn't in this spec.

**Honest limits, shown on the page:**
- A sealed auction with two bidders isn't very private: after close, everyone sees both bids. Private bidding hides who placed them, not what they were.
- A WL bid has to come from the listed wallet, so it can't come from a private balance (the same rule as drops today).
- NFTs can't go into a vault. A private buyer receives them in their one-time account and moves them out with `ownerCall` (as with private drop bids).
- Timing can link people: shielding exactly the amount of a bid right before placing it is easy to connect.

---

## 5. Contracts

### 5.1 `CloakOtcSale`: one auction core, several item types

Split `CloakEscrowDrop` into the auction core (commit, reveal, settle, ties, claim, refunds, fees, which stays exactly as tested) and a small **item adapter** that does three things: take the item in, check it's held, and deliver `n` units to a winner.

| Adapter | Take in | Deliver | Units |
|---|---|---|---|
| `ERC721Items` | the listed token ids (today's code) | one token id per slot (today's rotation) | tokens |
| `ERC20Lots` | `lots × lotSize`, measured by balance before and after | `n × lotSize` | lots |
| `ERC1155Items` (Phase 2) | ids and amounts | per slot | items |
| `SpotItems` | nothing (spots are a promise) | records the winner in `CloakSpotBook` | spots |

Either one contract with an adapter chosen at creation, or one contract per item type sharing a base contract. **Recommendation: one contract per type, sharing an abstract `CloakSealedAuction` base.** It keeps each deployed contract small, it's easy to review, and it doesn't put a delegate call in the path of every sale.

Changes to the core for OTC:
- **Payment in USDC as well as HYPE.** Today the escrow takes HYPE (`msg.value`). Add an ERC-20 payment option for USDC. `CloakGloamBids` needs to approve and pay ERC-20 deposits for this.
- **Hidden reserve.** The seller commits `hash(reserve, salt)` at creation plus a drand ciphertext. The keeper opens it with the bids. If the clearing price is below the reserve, the sale fails and everything goes back. If the reserve is never opened, the sale fails too (the seller can't use a hidden reserve to see the bids and then walk away more cheaply than if they'd set a public floor).
- **Bigger supply for tokens.** `MAX_SUPPLY = 500` exists because each NFT moves in its own transfer. A token block moves in one transfer, so `ERC20Lots` can allow far more lots (for example 10,000) without any gas problem.
- **No cancelling once there's a bid.** The seller can cancel and take the item back only before the first bid. Bidders can't be strung along.

### 5.2 `CloakDealLink`: fixed-price private deals

- `create(item, price, paymentAsset, buyer | codeHash, expiry)`: escrows the item. The buyer is a wallet, or anyone who can show the secret behind `codeHash`.
- `take(id, code?)`: pays the price and receives the item in one transaction.
- `cancel(id)`: the seller takes the item back if nobody has taken it; anyone can return it to the seller after `expiry`.
- The secret code can be stolen from a link someone leaked, so the page says to send links privately. A named buyer is safer when you know the wallet.
- Private side: a buyer takes the deal from a private balance through a one-time account (Gloam's escrow pattern, as in `CloakGloamBids`). A seller creates it from a private balance through a seller account (Phase 2).

### 5.3 Fees

Today `launchFeeBps` (1.5%) comes off the seller's proceeds. Proposal, to be decided (section 9):

| Sale | Fee |
|---|---|
| Token blocks, NFTs, ERC-1155 | 1% of proceeds |
| WL / GTD spots, new drops | 1.5%, as today |
| Deal links | 0.5% (they're already agreed; we're the escrow) |
| Private bids | the relay stays free; Gloam's own 0.5% applies when value leaves their vault |

Fees come from `CloakConfig`, as today, so they can change later behind the same 3-day public delay as every other rule.

---

## 6. WL and GTD spots: the partner's sign-off

Today a spot sale's payment goes to the seller when it settles, and buyers trust that the partner collection will whitelist the winners. Two additions, both in `CloakSpotBook`:

1. **The partner confirms the sale.** The partner collection's wallet (named at creation) calls `endorse(drop)` before bidding opens. The listing shows **Confirmed by partner** or **Not confirmed**.
2. **Proceeds wait for the whitelist.** For a confirmed sale, the seller's proceeds unlock when the partner calls `listed(drop)` after taking the list, or 7 days after the wallet deadline, whichever comes first. If the partner flags the sale (`dispute(drop)`) in that window, the proceeds go back to the winners. A partner that never acts can't hold the money forever.

GTD spots work the same way, with a guaranteed price instead of an auction. That's the GTD phase of `CloakDrop`, sold for a partner.

---

## 7. Pre-market allocations (Phase 3)

Selling tokens that don't exist yet (a points programme, an airdrop, a presale allocation) is common, and also where people get scammed most. Only offer it with **seller collateral**:

1. The seller lists "20,000 of PROJECT's token at TGE" and puts up collateral in HYPE or USDC, at least 100% of the expected price.
2. The sale runs as a normal sealed auction. The buyers' payment stays in escrow.
3. Cloak sets the real token address when it launches, behind `CloakConfig`'s public delay, so a seller can't pick a fake token.
4. The seller has until a deadline to deliver the tokens to the contract.
   - **Delivered:** buyers get the tokens; the seller gets the payment and their collateral back.
   - **Not delivered:** buyers get their payment back **plus** the seller's collateral.

This is the most complex type, and the most exposed legally. Build it last and get legal advice first.

---

## 8. The page

`/app/drops` becomes **`/app/otc`**; the old paths redirect so links keep working.

**Browse** (today's Drops page):
- Tabs: **All · Tokens · NFTs · Spots · Deals · Ending soon**. Search, the verified badge and the progress bar stay.
- Each card shows: the item, the amount for sale, the floor (or "Hidden reserve"), the time left, the badge, and for tokens the **pool price** and the floor's discount or premium against it.

**Sell** (today's DropCreate and EscrowCreate, merged):
1. **What are you selling?** Tokens · NFTs I own · WL/GTD spots · A new collection.
2. **How?** Sealed auction · Deal link.
3. **Terms:** amount and lots, floor or hidden reserve, payment in HYPE or USDC, bidding window, WL list and boost, gate.
4. **From where?** Public wallet · Private balance (Phase 2).
5. Review: every fee in plain numbers, and what will be public.

**A sale** (today's Drop page): phase, countdown, bid form (with "Pay privately" on by default when the user has a private balance), after close the clearing price and everyone's allocation, claim.

**Deals:** a "Create deal link" form and a page the link opens, built like the payment-link claim page (and under its stricter security policy, from the roadmap).

**SDK and MCP:** `CloakOtc` in `@cloakely/sdk` (`createSale`, `bid`, `bidPrivate`, `createDeal`, `takeDeal`, `claim`), and matching MCP tools so agents can sell and buy blocks.

---

## 9. Decisions for the team

1. Fees per sale type (section 5.3).
2. USDC payment at launch, or HYPE only first?
3. Which tokens can be listed: anything with a warning, or only Cloak launches and ecosystem-listed tokens at first? (Recommendation: Cloak launches and listed tokens only until the audit.)
4. Bid caps for OTC. Today drops share the launch caps (100 HYPE per bid, 10,000 HYPE total on testnet). Token blocks will want higher caps, which means after the audit.
5. Does `CloakV4Hook` let a creator move their fee rights? Does `CloakVesting` let a beneficiary change? Each decides whether that item can be sold.
6. Whether hidden reserves are on by default.

---

## 10. Order of work

| Step | What ships |
|---|---|
| 1 | Pull the auction core out of `CloakEscrowDrop` into `CloakSealedAuction`, with `CloakEscrowDrop`'s tests passing unchanged on top of it |
| 2 | `ERC20Lots` sale + factory, tests (fee-on-transfer, rebasing and pausable tokens refused, lots, partial fills, refunds), and private bids through `CloakGloamBids` on a fork |
| 3 | `CloakDealLink` (HYPE and USDC), tests |
| 4 | The page: rename, Tokens tab, merged Sell flow, deal pages. Keeper reveals and settles the new sales |
| 5 | SDK `CloakOtc` and MCP tools |
| 6 | Hidden reserve; partner sign-off for spots |
| 7 | External audit of the OTC contracts with the rest of Cloak's own contracts; then higher caps |
| 8 | Phase 2: ERC-1155, vesting, LP and fee rights, private seller accounts, request for quote |
| 9 | Phase 3: pre-market with collateral |

**What stays the same:** `CloakDrop`, `CloakEscrowDrop` and `CloakSpotBook` sales already live keep working where they are; the new page reads them alongside the new sales.
