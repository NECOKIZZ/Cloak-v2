# To-do list

What's open, who it's waiting on, and what has to land before mainnet (Nov 9). Tick items off as they ship.

## Waiting on you

- [ ] **Top up the keeper wallet** `0x6616C2566baD950FcDD420159a51fDdfFa220E8e` from the [Elysium faucet](https://elysium.kinetiq.xyz/testnet-faucet), a few times over. It pays gas for every reveal, settlement and relayed private trade, it's down to about 0.0156 HYPE, and the v3 deploy comes out of it too.
- [x] ~~Say go on v3~~: v3 deployed (Oct 30).
- [x] ~~Point the Render keeper and Vercel at v3~~ (Oct 30).
- [ ] **Fix `MIGRATIONS` on Render**: it arrived as only the v2 router, with no `:migrator` and no v1 pair, so moving old balances fails. The full value is in `render.yaml`.
- [x] ~~First npm release of the MCP server~~: `@cloakely/mcp` 0.1.0 is on npm (Oct 30).
- [x] ~~Switch the MCP package to trusted publishing~~: 0.1.2 published by GitHub Actions with no token (Oct 30).
- [ ] **Remove the publish token, now that nothing needs it:**
  1. GitHub, Cloak, Settings, Secrets and variables, Actions: delete `NPM_TOKEN`.
  2. npmjs.com, Access Tokens: delete the `cloak-mcp-first-publish` token.
- [ ] **Send testnet USDC** (5 to 10) and a little HYPE to the test wallet `0xf913812c12e0f21b6500b059488647d63a510A8a`, for the live private USDC test (shield, send, withdraw, max) through the site.
- [ ] **Fund a fresh agent wallet** with testnet HYPE for a live run of the local MCP server (launch, bid, shield, private trade, send, withdraw on the real testnet).
- [ ] **Reply to the bug report on `claim()`** (draft written). Once the reporter says how they'd like to be named, add the credit to the review log in `SECURITY.md`.

## Next up (Claude)

- [x] ~~**Intermittent batch-order gas failure**~~ (Oct 30): with a local account, viem estimated gas twice, the second time capped at the first result. When a batch round turned over in between, the order opened a fresh round (about 60k more gas) and the capped estimate ran out of gas. The SDK now estimates once, from the address, and pads that. The keeper had the same bug.

- [x] ~~**Cloak v3 on testnet**, which is also the mainnet deploy rehearsal~~ (Oct 30, rehearsed on a fork first):
  - deploy config, factory, router, batcher, HYPE and USDC vaults, with v2's fees and caps
  - a migrator so private balances move from v2 to v3 in one step from Portfolio
  - the site and SDK list launches from v1, v2 and v3 (two older deployments instead of one), and the Volume page keeps their history
  - keeper, site, SDK addresses (`@cloakely/sdk` 0.3.0) and the MCP server point at v3
  - every e2e run against live testnet, then README, roadmap and docs updated
- [x] ~~Add the `npx -y @cloakely/mcp` setup to the site's AI agents docs~~ (Oct 30).

## Before mainnet (Nov 9)

- [ ] **Deploy the vaults once and never move funds again.** Today every redeploy opens new vaults and asks users to move their balances, and every deployment's stats have to be stitched together by hand. Mainnet should work like this:
  1. Vaults (the contracts holding funds) are deployed once and kept for good. The only thing that forces new vaults is a circuit change, and the circuit is final after the ceremony.
  2. A new factory (like v3's `claim()` fix) is **added** to the existing router through `CloakConfig`, with the 3-day wait, instead of redeploying the router. v3 only needed a new router because the router's factory list is fixed at deploy.
  3. A new router or batcher **adopts** the existing vaults (checked against the old router's list) instead of creating new ones, so balances stay where they are.
  4. A small on-chain **deployment registry** lists every factory, router and batcher ever used, so the site, SDK and MCP find all of them on their own and stats carry over without `VITE_PREVIOUS` edits.
  These are contract changes, so they go in before the audit.

- [ ] **Outside review of the circuit** (`circuits/`) by someone who knows circom. A soundness bug there could forge proofs, which nothing in the contracts can catch. Top priority.
- [ ] **Public trusted-setup ceremony** with outside contributors and a drand beacon. The new verifier goes in through `CloakConfig`.
- [ ] **External audit** of the contracts. Deposit caps stay on until it and the ceremony are done.
- [ ] **Ownership to a multisig, then `endSetup()`.** After that, every loosening change waits 3 days.
- [ ] **A dedicated treasury wallet**, and **separate keeper and relayer keys**.
- [ ] **Source verification** on the explorer for every contract (v2 is still in progress).
- [x] ~~Rehearse the mainnet deploy~~: v3 was rehearsed on a fork, then deployed (Oct 30).
- [ ] **Mainnet USDC vault**, with the same caps until the audit.

## Decisions to make

- [ ] **Vault model:** one vault per asset (today) or one shared vault for every asset, like Gloam. A shared vault needs a new circuit, so it has to be decided **before the ceremony**.
- [ ] **USDC swap adapter cap exemption:** instant while `CloakConfig` is in setup, 3 days after `endSetup()`. Decide before setup ends.
- [ ] **Keeper creates private vaults automatically** at settlement, optionally only above a liquidity bar.
- [ ] **Redeploy again if the circuit review changes the circuit** (only if it finds something that changes the public inputs).

## Later

- [ ] **Private USDC phase 2:** private swaps between USDC and HYPE or launch tokens through a swap adapter. First, check which Elysium DEX has real USDC/HYPE liquidity. Details in [ROADMAP.md](ROADMAP.md) item 3b.
- [ ] **Living launch pages:** price chart and trade feed, public buy and sell, holder stats, LP badge, share card ([ROADMAP.md](ROADMAP.md) item 1).
- [ ] **A minimum raise** a creator can set, with full refunds if demand falls short.
- [ ] **MCP server extras:** a hardware-wallet signer, and `volume` and `launch_record` tools once the indexer exists.
