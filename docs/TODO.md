# To-do list

What's open, who it's waiting on, and what has to land before mainnet (Nov 9). Tick items off as they ship.

## Waiting on you

- [ ] **Top up the keeper wallet** `0x6616C2566baD950FcDD420159a51fDdfFa220E8e` from the [Elysium faucet](https://elysium.kinetiq.xyz/testnet-faucet), a few times over. It pays gas for every reveal, settlement, vault opening and relayed private trade, and it's down to about 0.007 HYPE after the v4 deploy.
- [ ] **Point Render at v4** (cloak-keeper, Environment): add `CONFIG` = `0x9fdf166f0671166148ea98cdd3ef0118d256167f` and `CLAIM_DELAY` = `3600`, then delete `FACTORY`, `START_BLOCK`, `ROUTER`, `BATCHER`, `BATCHER_BLOCK`, `MIGRATIONS`, `MIGRATOR`, `LEGACY_ROUTER` and `ASSET_POOLS`. Keep `KEEPER_PK`. With `CONFIG` set the keeper ignores the old ones anyway, so this can't go wrong again.
- [ ] **Vercel**: the site no longer reads any contract address from env vars, so `VITE_FACTORY`, `VITE_ROUTER`, `VITE_ROUTER_BLOCK`, `VITE_BATCHER`, `VITE_PREVIOUS`, `VITE_USDC*` can all be deleted (they're ignored).
- [x] ~~Say go on v3~~: v3 deployed (Oct 30).
- [x] ~~Point the Render keeper and Vercel at v3~~ (Oct 30), ~~fix `MIGRATIONS` on Render~~ (Oct 30).
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

- [x] ~~**Deploy the vaults once and never move funds again**~~ (v4, Oct 31, live on testnet; [VAULT.md](VAULT.md)): permanent vaults in `CloakVaults`, routers and batchers around them, factories added through `CloakConfig`, a registry of every contract, account keys bound to the chain only, private claims, one last move from v1, v2 and v3. Mainnet deploys this same layout once.

- [ ] **Outside review of the circuit** (`circuits/`) by someone who knows circom. A soundness bug there could forge proofs, which nothing in the contracts can catch. Top priority.
- [ ] **Public trusted-setup ceremony** with outside contributors and a drand beacon. The new verifier goes in through `CloakConfig`.
- [ ] **External audit** of the contracts. Deposit caps stay on until it and the ceremony are done.
- [ ] **Ownership to a multisig, then `endSetup()`.** After that, every loosening change waits 3 days.
- [ ] **A dedicated treasury wallet**, and **separate keeper and relayer keys**.
- [ ] **Source verification** on the explorer for every contract (v2 is still in progress).
- [x] ~~Rehearse the mainnet deploy~~: v3 was rehearsed on a fork, then deployed (Oct 30).
- [ ] **Mainnet USDC vault**, with the same caps until the audit.

## Decisions to make

- [ ] **Shared vault later?** We chose one vault per asset (v4). A shared vault would hide which token a private send moved, but needs a new circuit, so it can only come with a ceremony. See [VAULT.md](VAULT.md).
- [ ] **USDC swap adapter cap exemption:** instant while `CloakConfig` is in setup, 3 days after `endSetup()`. Decide before setup ends.
- [ ] **Redeploy again if the circuit review changes the circuit** (only if it finds something that changes the public inputs).

## Later

- [ ] **Private USDC phase 2:** private swaps between USDC and HYPE or launch tokens through a swap adapter. First, check which Elysium DEX has real USDC/HYPE liquidity. Details in [ROADMAP.md](ROADMAP.md) item 3b.
- [ ] **Living launch pages:** price chart and trade feed, public buy and sell, holder stats, LP badge, share card ([ROADMAP.md](ROADMAP.md) item 1).
- [ ] **A minimum raise** a creator can set, with full refunds if demand falls short.
- [ ] **MCP server extras:** a hardware-wallet signer, and `volume` and `launch_record` tools once the indexer exists.
