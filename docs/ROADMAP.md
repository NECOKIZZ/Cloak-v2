# Cloak roadmap

## What Cloak can do today

Everything below is live on Elysium testnet (chain `99801`) at [cloak.boblabs.tech](https://cloak.boblabs.tech), with tests and real on-chain runs behind it.

**Launches**
- **Sealed-bid launches.** A bid is only a hash plus a drand-timelock ciphertext until bidding closes. Bots, other bidders and the sequencer can't see price or size.
- **Bids open themselves.** After bidding closes, anyone (the keeper, another bidder, the launch page) can decrypt and reveal every bid. Bidders never have to come back.
- **Hidden bid size.** Deposits round up to 1, 2 or 5 × 10ⁿ, so a deposit only shows the order of magnitude.
- **One clearing price for everyone**, found across up to 256 price ticks. Bids at the clearing tick fill pro rata, and lower bids get a full refund.
- **Liquidity seeded at that price and locked.** The pool starts at exactly the clearing price, the LP is burned or time-locked, and unsold tokens are burned.
- **Creator share** of at most 20% of supply, vesting over at least 30 days.
- **A fair-launch record on chain** that any launchpad can read.
- **Penalties for hiding bids.** A bid that is never revealed loses at least 10% of its deposit, and that money is burned.

**Private balances and trading**
- **Shield HYPE** into a private balance, in one public step to a one-time key.
- **Private buy and sell of any Cloak launch token**, proven on your device and sent by a relayer, so your wallet never appears on the trade.
- **Batch mode** hides trade size: standard-size orders cross each other at the round's average price, and only the net hits the pool.
- **Private sends** to a `cloak:` address, with sender, receiver and amount all hidden.
- **Withdraw** to any address, ideally a fresh one.
- **Private USDC:** shield, send privately and withdraw, with the relayer paid in USDC.
- **Migration:** private balances move from v1 to v2 privately, in one step.
- **Your account comes from one wallet signature.** Nothing is stored on a server.

**Rules and safety**
- **No contract can move user funds.** Notes leave a vault only with their owner's proof.
- **Fees:** 1.5% on a successful launch, 0.25% on withdrawals, private swaps and batch orders, with hard caps in the contract. Deposits and private sends are free.
- **Beta deposit caps** on every vault. Withdrawals are never capped.
- **A public 3-day timelock** on any loosening rule change, once setup ends.

**For builders**
- **`@cloakely/sdk` on npm** (0.2.6), published from GitHub with npm trusted publishing. It covers launches, bids, private balances, swaps, batch orders, sends, USDC, and the on-device prover.
- **A hosted keeper** that reveals bids, settles launches and batch rounds, and relays private transactions for a quoted fee.

**Not yet**
- **No private swaps for USDC yet:** see 3b.
- **A token's private vault isn't created automatically.** Anyone can create it in one click after the launch settles: see 1.
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
This lets an AI agent launch a token and trade it privately from Claude, Cursor or any MCP client.

Why it matters: an agent that trades on-chain leaks its strategy with every transaction, and anyone can copy or front-run it. Cloak hides who traded and how much, which is exactly what an agent needs.

| Group   | Tools |
|---------|-------|
| Launch  | `create_launch`, `get_launch`, `list_launches`, `place_sealed_bid`, `my_bids`, `claim` |
| Private | `unlock` (derives the private keys from one signature), `private_balance`, `shield`, `private_swap`, `batch_order`, `private_send`, `withdraw` |
| Read    | `quote`, `launch_record`, `volume` |

Safety built in from day one:
- **Spending limits** for each session and each day.
- **Testnet by default.** Mainnet is opt-in through a flag.
- **The signer stays local** (a key file or a hardware wallet). Keys are never sent to a server.
- **A dry-run mode** that returns what would happen before anything is signed.

Runs with `npx @cloakely/mcp`.

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

## Mainnet · Nov 9

**Done on testnet (v2, Oct 25):**
- fees, deposit caps and a public 3-day timelock on rule changes (`CloakConfig`)
- every fix from the internal review, each with a regression test
- private balance moves from the first deployment (`CloakMigrator`)

**Still to do before Nov 9:**
- **Public trusted-setup ceremony**, with outside contributors and a drand beacon. The new verifier goes in through the config.
- **Hand ownership to a multisig, then `endSetup()`.** After that, every loosening change waits 3 days.
- **A dedicated treasury wallet**, and **separate keeper and relayer keys**.
- **Source verification** on the explorer for every contract.
- **Rehearse the mainnet deploy** on a fork, then deploy, verify and publish the addresses.
- **Settle the vault model before the ceremony.** Today each asset gets its own vault. A single vault for every asset (the asset goes inside each note, like Gloam) pools everyone's privacy into one crowd, but it needs a new circuit, and a ceremony is run per circuit. So it has to be decided before the ceremony, or not at all until a second one.
- **Private USDC on mainnet:** a vault for mainnet USDC, with the same caps until the audit.

At launch:
- **Deposit caps stay on** until the external audit and the public ceremony are done.
- **Fees are on** from day one (see the revenue model below).

---

## Later · protocol (around and after mainnet)

Already planned:
- **Bid funding from a private balance,** so a deposit can't be linked to the bidder.
- **Timelock-sealed batch orders** that hide side and size until the round clears.
- **A security audit and a public trusted-setup ceremony.** Mainnet caps lift once both are done.
- **A minimum raise for launches.** The creator sets a floor, and if revealed demand doesn't reach it, every bidder gets a full refund. Today a launch settles with any demand above zero.

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
