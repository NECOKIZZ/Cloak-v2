# Cloak roadmap

Cloak today covers the moment of launch: a sealed-bid auction, one fair price, locked liquidity, and a private vault to trade from. This roadmap is about the two things that come next:

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

### 2. Creator dashboard (`/app/created`)
Everything a team needs after their launch, in one place.
- Their launches, raise, clearing price, holder count and LP status.
- Edit the description and links. This needs a small metadata registry contract, since `metadataURI` is fixed at creation today.
- **Private airdrops:** paste or upload a CSV of `cloak:` addresses and amounts, and Cloak pays each one from the creator's private balance. Recipients get tokens without the list showing up on a block explorer as a set of wallets to farm.
- **Claim links** for people who don't have a cloak address yet: send a private amount to a link, and the person who opens it claims it.

### 3. `@cloak/sdk` on npm
The SDK already exists in `packages/sdk`. Publish it, along with:
- **`@cloak/react`:** hooks (`useLaunch`, `useBid`, `usePrivateBalance`, `usePrivateSwap`) so launchpads don't have to rebuild our state layer.
- **`@cloak/widget`:** a drop-in `<cloak-launch auction="0x…">` web component (with an iframe fallback). It lets any launchpad or site embed a sealed-bid box in one line.
- Versioned ABIs and deployment addresses per chain, so integrators never copy addresses by hand.

### 4. Indexer API
The Volume tab and the on-chain record read logs from block 0 in the browser. That's fine on testnet, but it gets slow on mainnet.
- A small indexer, on the keeper or a subgraph, that serves launches, records, volume and charts as JSON.
- The same API backs the SDK, the MCP server and the widget.

### 5. Trust pages
- **`/verify`:** every contract address, its source on the explorer, and plain-language answers to "is there an admin key?" (no), "who can move funds?" and "what can the keeper do?" (nothing the chain doesn't check).
- **`/transparency`:** relayer balance, keeper uptime and fees collected.

---

## Next · the agent and developer layer (1 to 2 months)

### 6. Cloak MCP server (`@cloak/mcp`)
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

Runs with `npx @cloak/mcp`.

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

At launch:
- **Deposit caps stay on** until the external audit and the public ceremony are done.
- **Fees are on** from day one (see the revenue model below).

---

## Later · protocol (around and after mainnet)

Already planned:
- **Bid funding from a private balance,** so a deposit can't be linked to the bidder.
- **Timelock-sealed batch orders** that hide side and size until the round clears.
- **A security audit and a public trusted-setup ceremony.** Mainnet caps lift once both are done.

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
