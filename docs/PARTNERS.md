# Getting Cloak launches onto every platform

Goal: a token that finishes a Cloak sealed-bid launch shows up on trackers, aggregators and wallets **by itself**, with
no work per token.

## How it works

Trackers and aggregators don't list tokens one by one. They add a **chain**, then a **DEX** on that chain, and from
then on every pool that DEX's factory creates appears automatically, with its price, chart, volume and holders.

Since Nov 2, every Cloak launch opens a **standard Uniswap V2 pool** at its clearing price. So the partnership we need
is not per token. It is one listing per platform for **Elysium plus the Uniswap V2 deployment our launches use**. After
that, every future Cloak launch appears on its own the moment it settles.

**The one dependency:** on mainnet our seeder must point at the Uniswap V2 factory the platforms index. That is the
"official mainnet Uniswap addresses" question for the Elysium founders. On testnet it is
`0xb2f8ad730e9d05d333c7861184aad0bff1785dd0` with WHYPE `0xcd57…f234`. Most trackers don't index testnets, so this
mostly pays off from mainnet (Nov 9).

## What we already provide

| What | Where | Who uses it |
|---|---|---|
| Standard Uniswap V2 pools, opened at the clearing price, LP burned or locked | every launch from Nov 2 | trackers, aggregators, Uniswap's own app |
| A standard token list that updates itself as launches settle | `https://cloak.boblabs.tech/tokenlist.json` | wallets and DEX front ends that import token lists (Uniswap app, many wallets) |
| A launch feed with pool, launch page, clearing price, description and logo | `https://cloak.boblabs.tech/api/tokenlist?feed=1` | partners that want to list new tokens automatically, Elysium's ecosystem pages, bots |
| Token logos as normal image links | `https://cloak.boblabs.tech/api/preview?a=<auction>&img=1` | token lists, explorers |
| Plain tokens: fixed supply, 18 decimals, no owner, no mint, no tax, no blacklist | `CloakToken` | every platform's safety checks (they flag taxes and owner powers) |

Still to do on our side: verify `CloakToken` (and every Cloak contract) on the explorer, so "contract verified" shows
on every token, and pass the explorer our token list for logos.

## The platforms

| Platform | What it gives a launch | How a chain or DEX gets added | Status |
|---|---|---|---|
| **DexScreener** | Chart, price, volume, trending, the place traders look first | Chain listing request in their Discord. Their criteria are an active DEX, real liquidity and volume, audited code and bridge, an active community. Once a chain is in, DEXes on it are tracked automatically | Ask at mainnet, together with the Elysium team |
| **GeckoTerminal** (CoinGecko) | Chart, price, pools, feeds CoinGecko | Request a new network and DEX through GeckoTerminal or CoinGecko support | Ask at mainnet |
| **DefiLlama** | Cloak's TVL and volume, credibility with investors | Pull request to `DefiLlama-Adapters`: add Elysium to `chains.json` and token mappings, plus a Cloak adapter (TVL = the vaults plus launch LP). A new chain is only accepted with a protocol on it, so our PR can bring Elysium in | We write the PR at mainnet (testnets aren't listed) |
| **0x** and **KyberSwap** (aggregators, announced for Elysium) | Cloak tokens buyable from any wallet or app that routes through them | They route every pool of the DEXes they integrate. We ask them to include the Uniswap V2 factory our launches use | Ask once they're live on Elysium |
| **Uniswap app** | Trading on app.uniswap.org | Needs Elysium in Uniswap's app. Anyone can still import our token list | Depends on Uniswap Labs |
| **Wallets** (Rabby, MetaMask and others) | Balances shown with name and logo | Token detection from token lists and the explorer | Share the token list |
| **Elysium explorer and ecosystem page** | Logos and names on the explorer, Cloak on the ecosystem page | Ask the Elysium team | Ask now |
| **CoinGecko and CoinMarketCap** (per token) | Mainstream price pages | One application per token once it has real volume | The creator's job; we link the form from the launch page |
| **DexScreener token profile** (per token, paid) | Logo, banner and socials on the token's DexScreener page | The creator orders it on DexScreener | Optional, the creator's choice |

## Order

1. **Now:** ask the Elysium team which Uniswap V2 factory and WHYPE are official on mainnet (founder question 1), and
   to list Cloak on the ecosystem page and pass our token list to the explorer.
2. **Mainnet day:** point the mainnet seeder at that factory, then send the requests below to DexScreener and
   GeckoTerminal, ideally with the Elysium team backing the chain request (it's their chain listing as much as ours).
3. **First mainnet week:** open the DefiLlama PR (Elysium plus Cloak), verify every contract on the explorer.
4. **When 0x or KyberSwap go live on Elysium:** ask them to route the Uniswap V2 pools.

## Message drafts

Written to send as they are. Fill in the mainnet details where marked.

**DexScreener (Discord, chain listing request)**

> Hi team. We would like to request listing for Elysium, the EVM chain by Kinetiq that settles to Hyperliquid. Mainnet is live since Nov 9 and Uniswap V2 is deployed at [factory address]. We are Cloak, a sealed bid launchpad on Elysium. Every token that launches with us opens a standard Uniswap V2 pool at its auction clearing price with the liquidity burned or locked, so every new pool on that factory is a real launch with real liquidity. Happy to share volume numbers, contracts and anything else you need. Thanks

**GeckoTerminal (network and DEX request)**

> Hello. We are requesting support for Elysium mainnet (chain id [id]) and its Uniswap V2 deployment at [factory address] with WHYPE at [WHYPE address]. Cloak is a sealed bid launchpad on Elysium and every Cloak launch opens a Uniswap V2 pool on that factory at a fair clearing price with the LP burned or locked. We keep a live token list at cloak.boblabs.tech/tokenlist.json if it helps with names and logos. Thank you

**0x and KyberSwap (once live on Elysium)**

> Hi. Cloak is a sealed bid launchpad on Elysium and every token we launch trades in a standard Uniswap V2 pool on [factory address]. Could you include that factory in your Elysium routing so our tokens are buyable through you from day one. Our token list is at cloak.boblabs.tech/tokenlist.json and a live feed of new launches is at cloak.boblabs.tech/api/tokenlist?feed=1. Happy to help test

**Elysium team**

> Hey team. Two quick asks for Cloak. First, which Uniswap V2 factory and WHYPE will be the official ones on mainnet, so every Cloak launch opens its pool where DexScreener and the aggregators will look. Second, could you add Cloak to the ecosystem page and pass our token list cloak.boblabs.tech/tokenlist.json to the explorer team so our tokens show names and logos. If you are already talking to DexScreener or GeckoTerminal about the chain listing we would love to be part of that request

## Sources

- [DexScreener chain listing](https://docs.dexscreener.com/chain-listing) and [DEX listing](https://docs.dexscreener.com/dex-listing)
- [DexScreener help: getting a chain listed](https://help.dexscreener.com/en/articles/1147393)
- [DefiLlama: list a project](https://docs.llama.fi/list-your-project/submit-a-project) and [add a new blockchain](https://docs.llama.fi/list-your-project/how-to-add-a-new-blockchain)
- [Token list standard](https://tokenlists.org)
