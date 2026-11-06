# Cloak roadmap

## What Cloak can do today

Everything below is live on Elysium testnet (chain `99801`) at [cloak.boblabs.tech](https://cloak.boblabs.tech), with tests and real on-chain runs behind it.

**Launches**
- **Sealed-bid launches.** A bid is only a hash plus a drand-timelock ciphertext until bidding closes. Bots, other bidders and the sequencer can't see price or size.
- **Bids open themselves.** After bidding closes, anyone (the keeper, another bidder, the launch page) can decrypt and reveal every bid. Bidders never have to come back.
- **Hidden bid size.** Deposits round up to 1, 2 or 5 × 10ⁿ, so a deposit only shows the order of magnitude.
- **One clearing price for everyone**, found across up to 256 price ticks. Bids at the clearing tick fill pro rata, and lower bids get a full refund.
- **Liquidity seeded at that price and locked.** The pool starts at exactly the clearing price, the LP is burned or time-locked, and unsold tokens are burned.
- **Every launch opens a Uniswap v4 pool** (native HYPE / token, from Nov 3) through Cloak's hook: the liquidity stays forever, trading fees go to the creator, an anti-snipe fee (10% falling to 0.3% over 5 minutes) makes racing the listing cost the racer, and a time-weighted price feeds batch rounds. The PoolManager is Uniswap's, built byte for byte like mainnet's. Launches from Nov 2 to Nov 3 opened a standard Uniswap V2 pool (token / WHYPE). The token trades on Uniswap, aggregators and any wallet, and trackers can chart it, while private buys, sells and batch rounds trade the same pool through the vaults. Launches before Nov 2 keep their Cloak pool.
- **Creator share** of at most 20% of supply, vesting over at least 30 days.
- **A fair-launch record on chain** that any launchpad can read.
- **Penalties for hiding bids.** A bid that is never revealed loses at least 10% of its deposit, and that money is burned.

**NFT drops and WL spot sales**
- **Sealed NFT drops** (Nov 3): one ERC-721 contract per drop. GTD wallets mint first, then everyone bids sealed with the creator's price as the floor, and every winner pays one clearing price. WL bids get a public boost (0% to 30%), ties are drawn fairly, and losers are refunded. Factory [`0x2afb…d783`](https://elysium.kinetiq.xyz/testnet-explorer/address/0x2afb7d9a5baa02a2d72a7c761521fc66dce9d783).
- **WL spot sales** (Nov 3): a partner collection's whitelist spots sell as a sealed drop. Each winner names the Elysium wallet to whitelist, and the sale page gives the partner the list as a CSV. One `CloakSpotBook` serves every sale ([`0x9180…1fc8`](https://elysium.kinetiq.xyz/testnet-explorer/address/0x91806d96814cc205d4b642e280023a1c7b361fc8)).

**Private balances and trading**
- **Shield HYPE** into a private balance, in one public step to a one-time key.
- **Private buy and sell of any Cloak launch token**, proven on your device and sent by a relayer, so your wallet never appears on the trade.
- **Batch mode** hides trade size: standard-size orders cross each other at the round's average price, and only the net hits the pool.
- **Private sends** to a `cloak:` address, with sender, receiver and amount all hidden.
- **Withdraw** to any address, ideally a fresh one.
- **Private USDC:** shield, send privately and withdraw, with the relayer paid in USDC.
- **Permanent vaults (v4):** every asset has one vault, made once and never replaced. Upgrades add helpers around the vaults, so balances never have to move again. Balances from v1, v2 and v3 move in once, privately, in one step.
- **Private claims:** a sealed-bid winner can claim tokens straight into the vault, so later trades can't be linked to the bid.
- **Your account comes from one wallet signature**, bound to the chain only, so it and your `cloak:` address never change. Nothing is stored on a server.

**Rules and safety**
- **No contract can move user funds.** Notes leave a vault only with their owner's proof.
- **Fees:** 1.5% on a successful launch, 0.25% on withdrawals, private swaps and batch orders, with hard caps in the contract. Deposits and private sends are free.
- **Beta deposit caps** on every vault. Withdrawals are never capped.
- **A public 3-day timelock** on any loosening rule change, once setup ends.

**For builders**
- **`@cloakely/sdk` on npm** (0.4.0), published from GitHub with npm trusted publishing. It covers launches, bids, private balances, swaps, batch orders, sends, USDC, and the on-device prover.
- **A hosted keeper** that reveals bids, settles launches and batch rounds, opens each launch's vault at settlement, and relays private transactions for a quoted fee.
- **One address for everything:** `CloakConfig` lists every Cloak contract with its start block (`readRegistry` in the SDK).
- **An MCP server for AI agents:** a hosted link (`https://cloak.boblabs.tech/mcp`, read and plan, no install) and a local server (`npx @cloakely/mcp`, on npm) with 29 tools covering launches, bids, private trading, payment links, NFT drops and WL spot sales, under spending limits with dry runs.

**Not yet**
- **No private swaps for USDC yet:** see 3b.
- **No minimum raise:** a launch settles as long as at least one bid was revealed.
- **The trusted setup is single-party for now.** Caps stay on until the public ceremony and an external audit.

---

## What comes next

The work ahead is about two things:

1. **What happens to a token after it launches.** Today the story stops at "Trading", and there's very little to do on a launch page once it settles.
2. **How Cloak reaches people who never open our site:** launchpads, developers and AI agents.

The plan follows one pattern: the core product, then packages that let other people build on it, then trust pages that let anyone check it.

---

## Now · next 2 to 4 weeks

### 1. Launch pages that stay alive after settlement
A settled launch should become the token's home page, not a finished receipt.
- **Price chart and trade feed** built from the pool's `Swap` events. Private trades show up as "private trade" with the amount the chain already shows and no wallet.
- **Public buy and sell** on the pool, next to the private option. Today the UI only offers private trading, so a normal holder has nowhere to just buy.
- **Holder stats** that respect privacy: how many holders are public, and how much of the supply sits in the private vault (the total is public, who owns it isn't).
- **LP status:** a "burned" or "locked until" badge with a countdown, and proof links.
- **Share card:** an OG image for each launch (logo, name, clearing price, "sealed launch") so posts on X look right.
- **Private trading switched on automatically.** Today a token's private vault appears only after someone presses "Enable private trading" on its launch page (`createPool`, open to anyone). The keeper should do this at settlement, optionally only above a liquidity bar so empty launches don't get vaults nobody uses. The launch page should also say plainly whether private trading is on.
- **Clearer launch page:** one obvious next step for each phase (bid, wait for reveal, claim, trade), instead of several cards.

### 2. Creator dashboard (`/app/created`)
Everything a team needs after their launch, in one place.
- Their launches, raise, clearing price, holder count and LP status.
- Edit the description and links. This needs a small metadata registry contract, since `metadataURI` is fixed at creation today.
- **Private airdrops:** paste or upload a CSV of `cloak:` addresses and amounts, and Cloak pays each one from the creator's private balance. Recipients get tokens without the list showing up on a block explorer as a set of wallets to farm.
- **Claim links** for people who don't have a cloak address yet: send a private amount to a link, and the person who opens it claims it.

### 3. `@cloakely/sdk` on npm
**Published** (Oct 27): `npm install @cloakely/sdk viem`, with addresses per chain built in. Next to it:
- **`@cloakely/react`:** hooks (`useLaunch`, `useBid`, `usePrivateBalance`, `usePrivateSwap`) so launchpads don't have to rebuild our state layer.
- **`@cloakely/widget`:** a drop-in `<cloak-launch auction="0x…">` web component (with an iframe fallback). It lets any launchpad or site embed a sealed-bid box in one line.
- Versioned ABIs and deployment addresses per chain, so integrators never copy addresses by hand.

### 3b. Private USDC
**Phase 1, live on testnet (Oct 29):** a USDC vault next to the router ([`0x61de…fa08`](https://elysium.kinetiq.xyz/testnet-explorer/address/0x61de30970e3c53665ce5a89323284e7ab379fa08)). Shield, send privately and withdraw, with the relayer paid in USDC at the live HYPE/USD price. Caps: 1,000 USDC per deposit and 50,000 in the vault. Shielding checks the wallet balance before asking for an approval, so an empty wallet never pays gas.

**Phase 2, private swaps with USDC.** USDC can't be swapped privately yet, for three reasons:
1. **There's no USDC market on Cloak.** Every Cloak pool is a launch token against HYPE. Nothing trades USDC.
2. **The router can't be upgraded**, by design. It only swaps HYPE to and from launch tokens, and only accepts vaults made for launches.
3. **The price needs real liquidity.** A thin USDC/HYPE pool would give bad fills, which is worse than no swap.

The plan:
- **Find the liquidity.** Check which Elysium DEX has real USDC/HYPE depth. If none does, seed a pool ourselves, and be clear that its price is only as good as what we put in.
- **A USDC swap adapter**, a small new contract. It takes a private USDC note out of the USDC vault (proof-checked, so the relayer can't change the trade), swaps on that market, and deposits the HYPE as a private note to a one-time key. The reverse works the same way. Launch tokens go through two hops: USDC to HYPE, then HYPE to the token.
- **No redeploy:** the existing vaults, router and circuit stay as they are.
- **Cap exemption for the adapter**, like the router has. It's instant while `CloakConfig` is in setup but waits the 3-day timelock after `endSetup()`, so it should land before mainnet.
- **Keeper, SDK and site:** quote and relay `usdcSwap`, add USDC to the swap box, and test it end to end with real proofs.
- Later, **batch mode for USDC**, so USDC trades hide their size too.

### 4. Indexer API
The Volume tab and the on-chain record read logs from block 0 in the browser. That's fine on testnet, but it gets slow on mainnet.
- A small indexer, on the keeper or a subgraph, that serves launches, records, volume and charts as JSON.
- The same API backs the SDK, the MCP server and the widget.

### 5. Trust pages
- **`/verify`:** every contract address, its source on the explorer, and plain-language answers to "is there an admin key?" (no), "who can move funds?" and "what can the keeper do?" (nothing the chain doesn't check).
- **`/transparency`:** relayer balance, keeper uptime and fees collected.

---

## Next · the agent and developer layer (1 to 2 months)

### 6. Cloak MCP server (`@cloakely/mcp`)
**Built** (Oct 29), in `packages/mcp`. It lets an AI agent launch a token and trade it privately from Claude, ChatGPT, Cursor or any MCP client, in two parts:
- **A hosted link, `https://cloak.boblabs.tech/mcp`:** paste it into the app, nothing to install. Read and plan only (launches, quotes, vault totals, launch plans). It never signs and refuses calls that look like they carry a key.
- **The local server, `npx @cloakely/mcp`:** launches, bids and private trading, signed on the agent's own machine. Published on npm (Oct 30) with provenance.

Why it matters: an agent that trades on-chain leaks its strategy with every transaction, and anyone can copy or front-run it. Cloak hides who traded and how much, which is exactly what an agent needs.

| Group   | Tools |
|---------|-------|
| Read    | `cloak_info`, `list_launches`, `get_launch`, `quote_bid`, `quote_swap`, `vault_stats` (hosted adds `plan_launch` and `connect_full_agent`) |
| Launch  | `create_launch`, `place_sealed_bid`, `my_bids`, `claim`, `enable_private_trading` |
| Drops   | `list_drops`, `get_drop`, `place_drop_bid`, `my_drop_bids`, `claim_drop`, `set_whitelist_wallets` |
| Private | `unlock` (derives the private keys from one local signature), `private_balance`, `shield`, `private_swap`, `batch_order`, `private_send`, `withdraw` |

Safety built in:
- **Spending limits** per transaction and per UTC day, for HYPE value and for USDC, plus launches per day. The day's totals survive a restart.
- **Testnet by default.** Mainnet needs two explicit flags.
- **The signer stays local** (a key file). Keys are never sent to a server, and proofs are made on the agent's machine.
- **Dry run** on every write tool, or for all of them with `CLOAK_DRY_RUN=1`.
- **Read only** without a key.

Tested end to end on a local chain with real proofs (`e2e/mcp.mjs`, 38 checks, including the hosted link over HTTP): an agent launches a token, bids, gets its tokens, opens private trading, shields HYPE and USDC, trades, places a batch order, pays a second agent privately and withdraws, while the keeper reveals, settles and relays.

Runs with `npx @cloakely/mcp`. Next: a hardware-wallet signer, and `volume` and `launch_record` tools once the indexer (item 4) exists.

### 7. CLI (`npx cloak`)
The same actions as the MCP server, for scripts and power users:
- `cloak launch --name Ember --supply 1m`
- `cloak bid <auction> --max-price … --amount …`
- `cloak swap --private …`

It's mostly a thin wrapper over the SDK, so it's cheap to build once the SDK is published.

### 8. Private holder proofs
Selective disclosure, applied to tokens.
- Prove "I hold at least X $TOKEN" (or "I was in the sealed auction") without revealing the balance or wallet.
- Use cases:
  - token-gated Telegram and Discord groups
  - allowlists for the project's next launch
  - "early supporter" perks
- Proofs name the reader they're for and expire.

### 9. Notifications
- A Telegram bot and web push for:
  - "bidding closes in 10 min"
  - "your bid opened"
  - "launch settled, here's what you got"
  - "your batch order filled"
- The keeper already sees all of these events, so this mostly means forwarding them.

### 10. Run-your-own keeper and relayer
- A Docker image plus a one-click Render or Railway template.
- Relayers set a fee, and the app picks the cheapest live one. That removes our relayer as a single point of failure, and as the only one paying gas.

---

## This week · NFT partnerships

- **Outreach to Elysium NFT collections:** run part or all of a mint as a sealed drop, or auction a batch of their WL spots.
- **Drop pages redesigned (Nov 4):** banner, collection picture, links, category, an items tab that previews the collection's own metadata and traits, a mint schedule and progress bar; a gallery list with a featured drop.
- **Auctions of existing NFTs (Nov 4):** any holder lists tokens from any Elysium collection; they sit in escrow in the auction contract, sell in a sealed auction, and winners get tokens by a draw fixed when the bids open. Unsold tokens go back.
- **Next for drops:** link previews for drop pages, bids from a private balance, and private GTD mints (needs a new circuit).
- **`@cloakely/sdk` and `@cloakely/mcp` 0.8.4** are on npm: everything in 0.8.3 (drops, WL spot sales, drop tools in the MCP, Uniswap v4 launches), plus the fixed batchers, withdrawals to `.ely` names, and proving files from a CDN with the site as a fallback.

---

## Mainnet · Nov 9

**Done on testnet (v2, Oct 25):**
- fees, deposit caps and a public 3-day timelock on rule changes (`CloakConfig`)
- every fix from the internal review, each with a regression test
- private balance moves from the first deployment (`CloakMigrator`)

**Done on testnet (v4, Oct 31):** permanent vaults, the address registry, fixed account keys and private claims: the layout mainnet deploys once.

**Mainnet is chain 99901** (parent chain 999, HyperEVM mainnet), already deployed by Conduit and opening to the public
on Nov 9. Official Uniswap v4 is live there (see [V4-AND-STOCKS.md](V4-AND-STOCKS.md)). Testnet stays on 99801.

**Still to do before Nov 9:**
- **Public trusted-setup ceremony**, with outside contributors and a drand beacon. The new verifier goes in through the config.
- **Hand ownership to a multisig, then `endSetup()`.** After that, every loosening change waits 3 days.
- **A dedicated treasury wallet**, and **separate keeper and relayer keys**.
- **Source verification** on the explorer for every contract.
- **Rehearse the mainnet deploy** (done Nov 4, see [MAINNET.md](MAINNET.md)): `e2e/deploy-mainnet.mjs` deploys the whole stack from scratch against Uniswap's own PoolManager. Next: deploy, verify and publish the addresses.
- **Our own WHYPE on mainnet.** Mainnet's WHYPE (the one Uniswap's PositionManager uses) is an upgradeable proxy, so the HYPE vault uses Cloak's fixed WHYPE instead.
- **Vault model: one vault per asset (v4), plus a testnet experiment (Nov 2).** New Uniswap launches now share one launch-token vault with its own circuit, so a private send hides which token moved. HYPE and USDC are never in it, and the contract keeps a separate total per token. Whether mainnet keeps it is decided after the experiment ([PRIVACY-LAYER.md](PRIVACY-LAYER.md), section 6).
- **Private USDC on mainnet:** a vault for mainnet USDC, with the same caps until the audit.
- **`.ely` names on mainnet:** add the Elysium Name Service's mainnet contract once it's published (`ELY_NAMES` in the SDK), so withdrawals to names and names shown in place of addresses work there too.
- **`.ely` names for agents and links:** agents can already withdraw to a name over the MCP (`withdraw 1 HYPE to bona.ely`). Next, payment links show who sent and who claimed them by name, and the MCP's read tools return names next to addresses.

At launch:
- **Deposit caps stay on** until the external audit and the public ceremony are done.
- **Fees are on** from day one (see the revenue model below).

---

## Partner Launchpad Vault · testnet first, then mainnet

A second private vault for tokens from approved outside launchpads, separate from Cloak's own shared vault. **Ascend is the first partner.** Every partner launchpad shares this one vault, so their users hide in the same crowd.

**How it's built**
- **Same circuit and verifier as the shared vault** (`transactionMA2x2`), so no new circuit and no new ceremony.
- **A small variant of `SharedVault`, called `PartnerVault`.** Deposits, withdrawals, proofs, the tree and the per-token totals stay the same code. Two things change, because today's `admit()` only understands Cloak's own factory and auctions, and it checks Cloak's own list of launch factories:
  - admission goes through approved launchpad adapters instead
  - it adds a cap per launchpad and records which launchpad each token came from
- **Pluggable admission.** Each launchpad gets one small read-only adapter contract, like `CloakFactoryList` was. It answers whether a token came from that launchpad's factory and has graduated, and which pool it trades in. Adding another launchpad later means writing its adapter and approving it, with no redeploy.
- **Admission rule per token:**
  - it came from an approved launchpad's factory
  - it has graduated to a DEX pool
  - its liquidity is locked or burned, so liquidity that can be added and pulled right away doesn't count
- **Approving a launchpad goes through `CloakConfig`:** instant during setup, behind the 3-day timelock after `endSetup()`. Removing one is instant and only stops new admissions. Tokens already admitted stay admitted, so withdrawals can never be blocked.
- **Caps:** the existing per-token caps, plus a total cap per launchpad.
- **Source on chain:** the vault records each token's launchpad, so the site can show an "Ascend" section and labels.
- **Token review before approving any launchpad.** Check its token template for:
  - transfer fees
  - rebasing
  - blacklists
  - pausing
  - upgradeability
  - transfer callbacks

  Any of these can break the vault's accounting or trap that token's withdrawals, so a template with them is refused or needs a specific mitigation.
- **Markets:**
  - Reuse `CloakV2Market` when tokens graduate to Uniswap v2 style pools. Otherwise write a market adapter.
  - Batch rounds only for pools that record a time-weighted price, with the Nov 6 batcher bounds.
- **Audit:** `PartnerVault` and the adapter mechanism join the external audit scope with KupiaSec.

**Testnet**
1. Read Ascend's factory and token template: how it records tokens and graduation, where they trade, and the token review above.
2. Build `PartnerVault`, the adapter interface, the Ascend adapter and, if needed, a market adapter, with tests (including hostile tokens and a removed launchpad whose holders still withdraw).
3. Deploy on testnet, approve Ascend during setup, then run a live end-to-end test: admit, shield, private send, swap, batch, withdraw.
4. Site: an Ascend section and labels, then an SDK and MCP release.

**Mainnet**
- After the testnet run and the audit, on the mainnet config. After `endSetup()`, each new launchpad waits the 3-day timelock, and deposit caps stay on until the audit and the ceremony are done.

## Later · protocol (around and after mainnet)

Already planned:
- ~~Bid funding from a private balance~~: live (Nov 2), through one-time bid wallets.
- **A minimum raise** and a **live price on the demand meter after bidding closes** are next for launches.
- **Timelock-sealed batch orders** that hide side and size until the round clears.
- **A security audit and a public trusted-setup ceremony.** Mainnet caps lift once both are done.
- **A minimum raise for launches.** The creator sets a floor, and if revealed demand doesn't reach it, every bidder gets a full refund. Today a launch settles with any demand above zero.

Launch pools:
- **Uniswap V3 as an option per launch:** a full-range position (a new token's price moves too much for a narrow one), with the creator picking the fee tier. The LP position NFT is locked or burned like today's LP.
- **Creator fees: live (Nov 2)** through `CloakFeeLocker` on V2 pools (the LP locked forever, the 0.3% trading fee to the creator).
- **Uniswap V4 with a Cloak hook:** the hook can carry a separate creator fee, anti-sniping right after settlement, a private opening window and a built-in price feed for batch rounds. The private router learns V4 pools first. Testnet already has 17 v4 PoolManagers from different teams (none confirmed official), so we wait for the official mainnet addresses and only route through approved managers and hooks. Research and plan: [V4-AND-STOCKS.md](V4-AND-STOCKS.md).
- **Choosing per launch:** the factory takes a pool type and settlement opens that pool. V2 stays the default.
- **Private stock trading:** once real tokenized stocks (Synthra sSTOCKs, xStocks) have real liquidity on Elysium, after checking each token for transfer lists, freezes and rebasing. Testnet only has mock and launchpad copies today ([V4-AND-STOCKS.md](V4-AND-STOCKS.md)).
- **Private swaps through outside pools** (USDC, stock tokens, curated outside tokens): a swap router over approved Uniswap V2 and V3 factories, see [PRIVACY-LAYER.md](PRIVACY-LAYER.md).
- **Availability** ([PARTNERS.md](PARTNERS.md)): the Cloak token list (`tokenlist.json`, live) and launch feed (live), explorer source verification, price charts on launch pages from the keeper's record of trades, and asking DexScreener, GeckoTerminal, DefiLlama, 0x and KyberSwap to add Elysium once mainnet is live.

New:
- **Private limit orders:** a resting order that fills inside batch rounds when the price crosses.
- **Launch modes:**
  - **vested claims:** buyers' tokens unlock over time, set by the creator
  - **a creator allocation with a public vesting schedule**
  - **a second-round sale** that reuses the same sealed auction
- **Private positions on HyperCore** through Elysium's link to it, which hides liquidation prices (the "whale hunting" problem).
- **More chains** that share the same contracts. The SDK, MCP server and widget already take a chain id.

---

## Revenue model

**Fees are live on testnet in v2** and switch on at mainnet the same way:

| Stream | Rate | Where it's collected |
|---|---|---|
| **Launch fee** (main revenue) | 1.5% of a successful raise (hard cap 3%) | `CloakAuction` at settlement, then `collectFees()` to the treasury |
| **Withdrawal fee** | 0.25% of every cash out, private swap and batch order (hard cap 1%) | kept in each shielded vault, then `collectFees()` to the treasury |
| **Relayer margin** | gas × 1.25 | paid inside each proof to our relayer, until open relayers compete it down (item 10) |
| **B2B** (later) | revenue share and paid tiers | A share of the launch fee for launchpads that embed the widget, hosted indexer and API tiers, premium launch options |

Deposits and private sends stay free. Rates live in `CloakConfig`: lowering one is instant, and raising one waits a public 3-day delay.

**Rough sizing (illustrative):**
- **Launch fees:** 100 mainnet launches a month at a $50k average raise and a 1.5% fee is about $75k a month.
- **Trading fees:** $2M a month of private volume at 0.15% is about $3k a month.
- So launches are the business, and private trading is what keeps users around.

**Rules we commit to:**
- No fee on a failed launch or a refund.
- Locked liquidity is never touched.
- Fee rates are capped in the contracts (1% on withdrawals, 3% on launches).
- Fee increases are queued on-chain and wait a public 3-day delay.
- No admin can withdraw users' funds.

---

## What we would pick first

If we only do three things next:

1. **Living launch pages with public buy and sell (item 1).** This fixes "after launching, what next?" for every user, every day.
2. **SDK on npm plus the widget (item 3).** This is how launchpads on Elysium actually adopt Cloak.
3. **The MCP server (item 6).** It's the most distinctive story: private launches and trades for AI agents. It also reuses the SDK, so it's mostly packaging.

The indexer (item 4) quietly supports all three, so it should be built alongside them.
