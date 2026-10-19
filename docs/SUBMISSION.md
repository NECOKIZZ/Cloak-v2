# Cloak · Ascend Builder Competition submission

## 🔗 1. Project + Links

- **Project:** Cloak, private launches and trades for Elysium
- **Website:** https://cloak.boblabs.tech
- **X:** [@your_handle]
- **GitHub:** https://github.com/NECOKIZZ/Cloak (contracts, circuits, SDK, keeper, app, all open source)
- **Docs:** https://cloak.boblabs.tech/docs · **SDK:** https://cloak.boblabs.tech/sdk · **Pitch:** https://cloak.boblabs.tech/pitch

## 🧭 2. Project Overview

**The problem: on-chain launches are a speed race, and on-chain trading is a public diary.**

- **Bots win launches.** When Base co-founder Jesse Pollak launched his creator coin in Nov 2025, two snipers bought **26% of the supply in the same block** it went live and took about **$1.3M**, paying the sequencer for priority. The price then fell ~36% when they sold. ([Arkham via CoinDesk/DL News](https://www.dlnews.com/articles/defi/how-snipers-scooped-over-1m-from-base-creator-jesse-token))
- **Elysium has the same shape.** It's a single-sequencer chain with ~300 ms blocks that orders by priority fee. Whoever pays the most is first, every time.
- **Launchpads are a lottery that bots farm.** Solana launchpads created **11.6M tokens in 2025 and only ~0.89% graduated** past the bonding curve. ([Solana / launchpad data](https://www.mexc.com/news/993169))
- **Every trade is visible and tradeable against.** Sandwich bots took an estimated **$370M–$500M from Solana users in 16 months**. ([sandwiched.me, Accelerate 2025](https://solanacompass.com/learn/accelerate-25/scale-or-die-at-accelerate-2025-the-state-of-solana-mev))
- **On Hyperliquid itself, transparency gets weaponised.** In March 2025, traders publicly coordinated to hunt a whale's **$400M+ 40x BTC short** because its liquidation price was visible on-chain. 10x Research called it "democratized whale hunting". ([Cointelegraph](https://cointelegraph.com/news/traders-targeting-hyperliquid-whales-significant-positions-trigger-liquidations-10x-research), [Decrypt](https://decrypt.co/310220/crypto-traders-hunting-521-million-bitcoin-whale)) James Wynn's ~$100M of losses played out live, position by position. ([Cointelegraph](https://cointelegraph.com/news/hyperliquid-whale-loss-100-million-bitcoin-dips-below-105))

**What we built:** a privacy layer for launching and trading tokens on Elysium, in three parts.

1. **Sealed-bid launches.** Bids are encrypted to a future [drand](https://drand.love) round, so nobody can read them until bidding closes, not even the sequencer. Then they open themselves. Everyone pays **one clearing price**, and liquidity is seeded at that price and **locked or burned automatically**. Speed and gas buy nothing.
2. **A private vault.** Holders keep launch tokens in a private balance, then **buy, sell and send** with zero-knowledge proofs made in their browser. A relayer submits the trade, so the wallet never appears on-chain.
3. **Batch auctions.** Orders go in standard sizes and settle together each round at one fair price. Nobody can see how much any one trader moved, so there's no size to front-run, copy or hunt.

**Who it's for:**
- **Launchpads (Ascend first):** a fair-launch mode with one SDK call.
- **Projects:** a launch that isn't won by bots, and a price discovered by real demand.
- **Holders and traders:** they can hold and trade without being tracked, copied or hunted.

**Why people would use it:**
- Buyers get the same price as everyone else.
- Projects get a real community instead of snipers who dump.
- Traders get privacy that Elysium doesn't have today.
- Everything runs on plain EVM contracts with no admin keys and no committee holding secrets.

## 🎬 3. Product Demo

[Demo video link, 60–120 s]

Try it live on Elysium testnet: connect a wallet → place a sealed bid → shield HYPE → make a private swap, a batch order and a private send → watch it all in the on-chain record and the Volume tab.

## 🚦 4. Current Status + Launch Plan

**Working today (live on Elysium testnet):**
- **Sealed-bid launches,** start to finish: tlock-sealed bids, automatic reveal through drand, one clearing price, LP seeded and burned or locked, bidders paid out automatically.
- **Private vault:** shield, private buy and sell, private send to a `cloak:` address, and withdraw to a fresh address. Groth16 proofs take about 4 s in the browser.
- **Batch auctions:** standard-size sealed orders with a uniform price per round. Only the net hits the pool.
- **Hosted keeper and relayer:** reveals, settles, pays out and relays private trades.
- **Full web app:**
  - launches, the launch page with its full on-chain record, private swap, portfolio and a Volume dashboard
  - creating a launch with an on-chain token image
  - a wallet modal listing every installed wallet, plus add-network and faucet buttons
- **`@cloak/sdk`** for launchpads, plus docs.
- **Verified:**
  - 27 contract tests
  - 31/31 end-to-end checks on testnet with real proofs
  - a full browser test of every flow
- **Contracts:**
  - CloakFactory [`0x1dc1…7e1c`](https://elysium.kinetiq.xyz/testnet-explorer/address/0x1dc1ea9837ecbd31ec74f0d558e1db1c303a7e1c)
  - PrivateRouter [`0xfa25…fc41`](https://elysium.kinetiq.xyz/testnet-explorer/address/0xfa2574cfc3afb8f7d3a0651fa2111ff4e3d2fc41)
  - PrivateBatcher [`0xf658…5812`](https://elysium.kinetiq.xyz/testnet-explorer/address/0xf6582cc5a84fccf74e571e652fb7b603a2c25812)

**In development:**
- funding bids straight from a private balance, so the deposit can't be linked to the bidder
- timelock-sealed batch orders that hide side and size until the round clears
- the SDK published on npm

**Before mainnet:**
- a security audit
- a public multi-party trusted-setup ceremony for the circuit
- more independent keepers and relayers
- switching on protocol fees

**Timeline:** [edit to your plan]
- **Oct 2026:** testnet live (done)
- **Nov:** private bid funding, sealed batch orders, SDK on npm
- **Dec:** audit and trusted-setup ceremony
- **Elysium mainnet:** launch alongside Ascend

**Token:** [not decided yet / your plan]. If there is one, it launches through Cloak's own sealed-bid auction on Ascend.

**Support we'd like from Ascend:**
- integrating Cloak as Ascend's fair-launch mode
- an intro to the Kinetiq team for Elysium mainnet
- help with audit funding or partners
- testnet HYPE to keep the public relayer running

## 🚀 5. After Launch

- **Mainnet:** fees switched on (launch, batch and relaying), and more launchpads using the SDK.
- **More private order types:** private limit orders, and private positions on HyperCore through Elysium's direct connection.
- **More keepers:** anyone can already run one, so the network gets more resilient as it grows.

## 👥 6. Team

- **Bob Labs** ([@NECOKIZZ](https://github.com/NECOKIZZ)) [+ other members]
- **Experience:** built **Veil**, a sealed-bid launch and private payments project for Monad's Metropolis hackathon. Cloak is Veil rebuilt for Elysium, with a private vault and batch trading on top.
- **Team size:** [N]
- **Contact:** [Discord handle] · [X handle]
