# Private swap routes and private bridging on Gloam (plan, Nov 8)

Held, and not to be built unless the Gloam test is a no-go: batcher fixes B1 and B3, the ecosystem vault and the aggregator route in Cloak's own vaults. On Gloam, ecosystem tokens go in Gloam's shared vault and the batcher is an escrow, so that work would be thrown away.

## 1. Private swaps: which pairs need what

How it works today: a private swap is an escrow on a vault. One note leaves the vault into a one-time escrow, the swap runs, and the output goes back into the same vault as a new note. So **both tokens must be listed in the vault the swap runs on**.

Our venue `CloakLaunchSwapV4` already routes **up to 3 hops through any Uniswap v4 pool with no hook or with Cloak's own hook**, at once, with no allowlist. Gloam's router (`GloamVaultSwapV4c`) does the same through an allowlist with a 3-day wait per pool. Neither needs an aggregator for v4 pools.

| Pair | Route | What it needs |
|---|---|---|
| HYPE / Cloak launch tokens | live, our venue on the launch vault (each launch's own v4 pool) | nothing |
| HYPE / USDC | a hookless v4 HYPE/USDC pool | both assets in one vault. In Gloam's vault (HYPE comes after launch): Gloam's router with the pool allowlisted, or **our venue deployed on Gloam's vault** (the vault is permissionless, no wait). |
| KNTQ / HYPE (instead of KNTQ/USDC) | a hookless v4 KNTQ/HYPE pool | KNTQ listed (Gloam's vault after their review, or the launch vault through our guard's 3-day timelock). Multi-hop KNTQ to HYPE to a launch token works in one swap. |
| USDC / stock tokens | wherever stock tokens trade on Elysium | if it's a hookless v4 pool, the same as HYPE/USDC. If it's another DEX, a small venue for that DEX on the same escrow base. |
| HYPE / partner-approved ecosystem tokens | the partner's pool | v4 with no hook or ours works at once. A pool with the partner's own hook, or on another DEX, needs a venue or that hook reviewed and allowed. |

**Recommendation: no general aggregator.** An aggregator venue sends arbitrary calldata to an outside contract with the user's money in it, which is the hardest kind of escrow to make safe and to get through Gloam's review. Instead:
1. Deploy `CloakLaunchSwapV4` on **Gloam's vault** too (same code, same hook rule), so USDC, HYPE and every listed ecosystem token swap privately at once, through any hookless v4 pool.
2. For each non-v4 DEX a partner uses, add a venue of about 80 lines on `CloakLaunchSwapBase`, as `CloakLaunchSwap` (V2) already is.
3. Revisit an aggregator only if Elysium mainnet's liquidity sits mostly in DEXes we can't cover that way. Check the first week of mainnet: which pools exist on the official PoolManager (`0xe2e1…23f1`) and where KNTQ, stock tokens and partner tokens actually trade.

**To find out (mainnet, read-only):** the hookless v4 pools for HYPE/USDC and KNTQ/HYPE on 99901 and their depth, where stock tokens trade, and which ecosystem partners run v4 pools without hooks.

## 2. Private bridging in (Relay, Spicenet, Kinetiq's bridge)

**The idea:** every bridge delivers to an address on Elysium. Make that address a **Cloak receive address** (`CloakGloamReceive`, live on testnet). A receive address takes HYPE or any token from anyone, before or after it exists on chain, and the owner's app moves it into the private balance through the relay. So the bridge's delivery never touches the user's Elysium wallet, and the only public link is "someone bridged X to an address nobody can tie to an account". A fresh receive address per bridge (`receiveAddress(n)`) keeps bridges unlinkable from each other.

| Route | How | Status |
|---|---|---|
| **Kinetiq's bridge** (HyperEVM to Elysium) | `createRetryableTicket` with the destination and the refund address both set to the receive address | in `PRIVATE-BRIDGE.md` (not in this repo yet). Blocked on HyperEVM testnet HYPE for `0x6616…0E8e` (the v1 keeper wallet), plus ticket tracking and the keeper finishing a stuck ticket. |
| **Relay** (relay.link, day one on Elysium) | Relay's deposit-address or quote flow with `recipient` = the receive address | Gloam's app already uses Relay (`app/src/lib/bridge.ts`) for public bridging. Relay only delivers to mainnets, so it's testable on mainnet (private mainnet) with small amounts. |
| **Spicenet** | the same pattern, once we have their docs | waiting on their docs |

What the app needs, the same for all three:
1. A **Bridge** panel that makes a fresh receive address, gets the route's quote or deposit address with that recipient, and shows Relay's or Spicenet's fee next to it.
2. **Tracking:** each bridge saved on the device with its route's id (Relay request id, retryable ticket id, Spicenet's id). Its state is shown until the money reaches the receive address and is moved in.
3. Moving it in: as for any receive address (on open, and every 20 s while the page is open). The keeper can't do this step, because it needs the owner's secret.
4. Kinetiq's bridge only: if a retryable ticket isn't redeemed automatically, the keeper redeems it (anyone may, and redeeming changes nothing about where the money goes).

**Caveats:**
- Amounts are public on both chains, so a distinctive amount links the two sides. The panel should suggest round amounts.
- A receive address's deposit goes in under the vault's per-deposit cap, so a big bridge becomes several notes.
- USDC goes to Gloam's vault, and HYPE and launch tokens to the launch vault (until Gloam lists HYPE).

## 3. Next, when you say

1. Read Relay's and Spicenet's APIs (Spicenet docs from you). Confirm each takes an arbitrary recipient contract address, and how refunds work.
2. Bring `PRIVATE-BRIDGE.md` into this repo, then build the bridge panel and tracking on receive addresses (Relay first, since it's on Elysium from day one).
3. Deploy `CloakLaunchSwapV4` on Gloam's vault on testnet once their vault is up, and test HYPE/USDC through a hookless pool.
4. Security fixes from your list as they come.
