# Cloak v2 on Gloam: mainnet roadmap and to-do list

Status on Nov 8 (night). Tick items as they land. Each says who it waits on: **Bob**, **Gloam**, **Kinetiq** (Elysium), or **Claude** (can be built now).

## Where v2 stands

Built, tested and pushed to `main`. All of it runs on Gloam's vault, circuits and final keys:
- **Launch vault and escrows:** the launch vault, private v4 swaps, v4 batch rounds (time-weighted price, 4% side cap), sealed bids from a private balance, graduation, receive addresses, allocation gates and receipts.
- **Keeper:** our relay (Gloam's rules, paid from the launch vault's fee) and the keeper loop (admit launches, register markets, settle rounds, confirm gates). It also publishes sealed bids that can't be opened.
- **Site:** every page runs on the Gloam backend, including withdrawals in pieces over time, payment links and requests, and the docs page.
- **SDK and agent tools:** the SDK, and the MCP agent tools including payment links.
- **Tests:** 122 forge tests, 65 v4 forge tests, 17 end-to-end runs, and the real site in a browser on a testnet fork. CI runs v2 only.
- **Outside reviews:** two, with every finding fixed or decided (`docs/REVIEW-RESPONSES.md`).
- **Mainnet deploy script ready:** `e2e-gloam/deploy-partner.mjs` deploys next to Gloam's own vault and hands control to a Safe. Rehearsed on a testnet fork (0.022 HYPE). The config template is `deployments/elysium-mainnet-gloam.input.example.json`.

## The vault model (decided Nov 9)

- **Gloam's vault** holds HYPE and USDC (maybe KNTQ later). Cloak doesn't hold the ecosystem's major assets.
- **Cloak's launch vault** (Gloam's audited vault engine and final keys, plus `admitLaunch`, run by our Safe) holds Cloak launch tokens.
- **One home per asset.** No graduation: `CloakGraduation` isn't deployed on mainnet (`deploy-partner.mjs` deploys it only with `"graduation": true`).
- **CloakRouterV4** joins the two, as v1's router did: a buy spends HYPE in Gloam's vault and lands the token in the launch vault, in one relayed call; a sell does the reverse. The router decides each asset's vault (a launch token: the launch vault, anything else: Gloam's), so nobody can point a swap elsewhere. It's CloakLaunchSwapV4 plus one rule (about 40 lines). Tested in forge and with real proofs in `part19-v2-factory.mjs`.
- [x] **Batch rounds and private bids** follow the same rule (Nov 10): `CloakGloamBatcherV4` and `CloakGloamBids` take a HYPE vault at deploy (Gloam's on mainnet, `deploy-partner.mjs`). Buy orders and bids spend HYPE there; HYPE payouts and refunds go back there; tokens use the launch vault. Built with no HYPE vault (address 0), they keep HYPE in the launch vault as on testnet. Tested in forge and with real proofs (`part13-bids.mjs` runs in mainnet's model, `part19-v2-factory.mjs` has a batch round with HYPE in Gloam's vault).
- **Mainnet assumes Gloam's vault lists HYPE at public launch.** The launch vault gets no HYPE caps (no `"hype"` in the deploy config). If Gloam's HYPE listing slips, put `"hype"` caps back in the config, deploy the batcher and bids with address 0 as the HYPE vault, and leave `router` out of the deployment record: everything then runs as on testnet.
- **The ecosystem vault** (`CloakEcosystemVault`, Nov 10) holds outside tokens: KNTQ first, then other launchpads' tokens and stocks. Gloam's vault engine and keys, run by our Safe, with one way in: the Safe proposes a token, and after a 3-day delay anyone admits it if the preset rules still hold (below). The router knows all three vaults (launch tokens, ecosystem tokens, everything else in Gloam's). Tested in forge (16 tests) and with real proofs (`part20-ecosystem.mjs`).
  - **Admission rules, fixed at deploy** (values in the mainnet config, `ecosystem`): only the Safe proposes (partner approval); a plain native-HYPE Uniswap v4 pool with no hook (one the router can trade); at least 250 HYPE in range; a market cap of at least 100,000 HYPE at the pool price; caps of at most 0.1% of supply per deposit and 1% in total; and the delay, after which every rule is checked again, so a pool pushed for a moment doesn't get a token in. The pauser can cancel a proposal or pause admissions; the Safe can lower or zero a listed token's caps at once; withdrawals never close.
  - [ ] **Bob:** confirm KNTQ's address on Elysium (the config has Kinetiq's HyperEVM address, `0x0000…c2d6`, from their docs) and its native-HYPE v4 pool (fee and tick spacing). If KNTQ trades only on another DEX, it can't be admitted until a plain v4 pool exists, or until we add a venue for that DEX.
  - [ ] **Bob:** the rule values (liquidity, market cap, caps). They're fixed once deployed.
  - [ ] **After deploy:** from the Safe, propose KNTQ (the deploy script prints the call); 3 days later anyone calls `admit`. Then set the keeper's `GLOAM_ECOSYSTEM_VAULT` and `GLOAM_ECOSYSTEM_VAULT_BLOCK`, and add `ecosystemVault` / `ecosystemVaultBlock` to the SDK's deployment record.
- **Fees:** a swap pays the withdrawal fee of the vault it spends from. Gloam's is 0.5% on Elysium (it was 0.25% until Nov 3, and their Base, Ethereum and Tempo deploys use 0.25%). With HYPE in Gloam's vault, every launch-token buy pays Gloam's fee, with no room for ours.
- [ ] **Bob with Gloam's founder:** the fee. A lower rate for cash outs into reviewed partner escrows (he's open to it, but their vault has no per-recipient rate, so it needs code before their Elysium vault is deployed), or a share of the 0.5% on the flows Cloak brings.
- [ ] **Bob:** our launch vault's rate (0.5% today, v1 charged 0.25%). Lowering it is instant.

## Stage 1: testnet complete (now)

- [x] **v2's own launch factory** on testnet (Nov 9): CloakConfig `0xfedf…4f1e`, factory `0x59d2…5784`, CloakV4Hook `0xC629…2A80`. The launch vault, batcher v4 (`0xbd4a…28f8`) and every escrow redeployed on it, the first launch GLOAK admitted and registered. `render.yaml` and `deployments.ts` point at them.
- [ ] **Gloam:** their testnet vault at `0x39E2…0194` (no code yet), with the guard, memo board, block and verifiers. Then **Claude** runs `deploy-partner.mjs` against it on testnet (that moves graduation, receive, the gate and the receipt check onto it, and the launch vault onto their verifiers), points `deployments.ts` at it, and reruns `part8-site.mjs` on a fork and the live script.
- [ ] **Gloam:** a Cloak partner account with `relayApproved`, and the reviews (packs in `docs/gloam-pack/`, brief `docs/FOR-GLOAM.md`).
- [ ] **Gloam:** the SDK release that knows 99801 and 99901, plus the change-note seed. Then **Claude** bumps it, uses the seed, and reruns all parts.

## Stage 2: hosting v2 (gloak.boblabs.tech)

- [ ] **Bob:** before the repo goes public:
  - a secret scan of the history;
  - decide whether `GLOAM_QUESTIONS.md`, `docs/FOR-GLOAM.md` and the partnership parts of `REPORT.md` move somewhere private.
- [ ] **Bob:** a Vercel project on the same account, domain gloak.boblabs.tech. The build needs nothing special, since the site defaults to Gloam. Set `VITE_KEEPER_URL` and `VITE_RELAYER_URL` to the v2 keeper.
- [ ] **Bob:** a v2 keeper on a new Render account (free plan, no custom domain yet): New > Blueprint on this repo. `render.yaml` holds the testnet addresses and settings. Set only `KEEPER_PK` in Render's dashboard, never in the repo. The env it sets:
  - `FACTORY` and `START_BLOCK` (v2's own launch factory) and `CORS_ORIGINS` (gloak.boblabs.tech);
  - `GLOAM_VAULT`, `GLOAM_VAULT_BLOCK`, `GLOAM_LAUNCH_VAULT`, `GLOAM_LAUNCH_VAULT_BLOCK`, `GLOAM_MEMO`;
  - `GLOAM_ESCROWS` (launch swap v4, batcher v4, bids, receive, graduation, funds gate);
  - `GLOAM_BATCHER_V4`, `GLOAM_BATCHER_V4_BLOCK`, `GLOAM_FUNDS_GATE`;
  - `TRUSTED_PROXY_HOPS=1`.

  The keeper stays awake on its own only while it has work (`docs/OPTIMIZATION.md` H1), so no outside ping is needed.
- [ ] **Bob:** the hosted checks in `CHECK.md` (hosting, free-plan behaviour, every feature timed, the open stress items).
- [ ] **Claude:** a run of the hosted site against the hosted keeper once both are up (shield, swap, batch, link, receive, withdraw in pieces).
- [ ] **Claude, after v2 is hosted (Bob's order):** the version dropdown on gloak (Testnet v1 goes to cloak, Testnet v2 stays, Private mainnet shows the access-code page with no codes and no backend), then the same on Cloak v1 as a patch for Bob.

## Stage 3: private mainnet (team only)

**From Gloam:**
- [ ] The mainnet vault, guard, memo board, block, verifiers and the USDC it lists. **Claude** fills in the deploy config from these.
- [ ] Answers to the open questions in `docs/FOR-GLOAM.md`: the fee share, the Safe on their guard, the relay from day one, our swap venue on their vault, and bridging.

**From Kinetiq:**
- [ ] A public mainnet RPC that serves `eth_getLogs` at volume, the explorer and its verification API, and USDC's address.
- [ ] Who owns the v4 PoolManager (`0xe2e1…23f1`), and whether it moves to governance.
- [ ] Whether Elysium has EIP-2537 (BLS12-381), for provable sealed bids, and whether Timeboost is on.

**From Bob:**
- [ ] Cloak v2's own launch factory and hook on mainnet: `e2e-gloam/deploy-v2-factory.mjs` (done this way on testnet, Nov 9), then `deploy-partner.mjs` on it.
- [ ] A Safe on Elysium mainnet (the guard controller and launch pauser), separate keeper and relayer keys, and a treasury.
- [ ] Mainnet caps for the launch vault: HYPE per deposit and total, and launch tokens.
- [ ] Whether Cloak takes an interface fee inside its escrows (Gloam's partner fee can't be paid privately yet).

**Claude, once those are in:**
- [ ] `deploy-partner.mjs --config deployments/elysium-mainnet-gloam.input.json`, then:
  - verify every contract on the explorer;
  - add the mainnet block to `deployments.ts`;
  - small live checks (shield, swap, batch, send, withdraw).
- [ ] Send Gloam the mainnet v4 pool list for their router, once the first mainnet launches settle.

## Stage 4: public mainnet

- [ ] **Outside review** of our escrows and `CloakLaunchVault` (Kann's audit covers only Gloam's vault). Gloam offered to add partner escrows as a separate scope. Keep low caps until it's done.
- [ ] **Bob:** the announcement ("Powered by Gloam" is approved). Gloam then lists Cloak as a live partner on Elysium.
- [ ] **Bob:** the reviewers' credit and thank-you on X (Haider Ali, Ghost), as promised.

## Optimization (Nov 9)

- [x] Free-hosting pass (`docs/OPTIMIZATION.md`):
  - private balances read only new blocks, with one sync per refresh;
  - reloads and new devices skip the vault history;
  - no keeper snapshot (removed with v1's keeper code);
  - the keeper sleeps when idle;
  - the hashing download is about 1 MB smaller;
  - hidden tabs don't poll.

  Tests: part 17, part 18, the stand-in Poseidon test, and part 8 in a browser.
- [ ] **Later:** a CDN in front of the keeper (G1), and keeper state that survives restarts (G2).

## Security and review follow-ups

- [x] Overnight stress test (Nov 8 to 9): contracts, off-chain and website. The fixes are live on testnet. Report: `docs/STRESS-REPORT.md`.
- [ ] **Bob:** the three decisions in `docs/STRESS-REPORT.md` (W-01 deposit cap, W-03 penalty floor, W-08 reveal window ceiling).
- [ ] **Keeper hosting:** set `TRUSTED_PROXY_HOPS` (1 behind Render's proxy, 0 with nothing in front).

- [ ] **Bob:** apply `docs/patches/v1-min-reveal-window.patch` to Cloak v1 (it applies cleanly to v1's `main`). It's needed in v1's mainnet contracts too.
- [ ] **Bob:** apply `docs/patches/v1-batcher-band-and-deadline.patch` to Cloak v1 (the fix promised to Ghost: refuse instead of clamp, plus a settling deadline). It applies cleanly to v1's `main`.
- [ ] **Bob:** the launch no-reveal penalty floor (10% today, 25% on drops), and a notional floor per price tick (CL-02) in the next factory.
- [ ] **Claude, next factory:** seed the drop lottery from a drand round after the reveal deadline (removes the sequencer's last influence on CL-01).
- [ ] Haider's feedback files, if he sends them.

## Product work, after the above

- [ ] **Private bridging in** (`docs/ROUTES-AND-BRIDGE.md`): Relay first, then Spicenet (their docs from Bob), then Kinetiq's bridge.
  - Everything delivers to a fresh receive address.
  - Needs a Bridge panel, per-bridge tracking, and the keeper redeeming stuck tickets.
  - Bob: paste or push `PRIVATE-BRIDGE.md`, and fund a v2 key on HyperEVM testnet.
- [ ] **More swap pairs without an aggregator:** `CloakLaunchSwapV4` on Gloam's vault (USDC/HYPE and ecosystem tokens through hookless v4 pools), after Gloam says yes. Then a venue per non-v4 DEX a partner uses. Check mainnet's pools in its first week (KNTQ/HYPE, stock tokens).
- [ ] **Claude:** a smaller bundle (swap heavy Poseidon libraries for `poseidon-lite` where possible).
- [ ] **Claude:** escrows that post their payout's memo in the same transaction (waiting on Gloam's memo board taking posts before the note is in the vault).
- [x] Cloak's own private layer removed from v2 (Nov 9): v1's vaults, circuits, SDK classes, keeper loop and site code. Cloak v1 keeps it in its own repository.
