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

## Stage 1: testnet complete (now)

- [x] The v4 batcher is live on testnet (`0x77a5…ea1b`, with the opening band), registered for all 5 v4 launches and in `deployments.ts`. The keeper's env (`GLOAM_BATCHER_V4`) is set at hosting.
- [ ] **Gloam:** their testnet vault at `0x39E2…0194` (no code yet), with the guard, memo board, block and verifiers. Then **Claude** runs `deploy-partner.mjs` against it on testnet (that moves graduation, receive, the gate and the receipt check onto it, and the launch vault onto their verifiers), points `deployments.ts` at it, and reruns `part8-site.mjs` on a fork and the live script.
- [ ] **Gloam:** a Cloak partner account with `relayApproved`, and the reviews (packs in `docs/gloam-pack/`, brief `docs/FOR-GLOAM.md`).
- [ ] **Gloam:** the SDK release that knows 99801 and 99901, plus the change-note seed. Then **Claude** bumps it, uses the seed, and reruns all parts.

## Stage 2: hosting v2 (gloak.boblabs.tech)

- [ ] **Bob:** before the repo goes public:
  - a secret scan of the history;
  - decide whether `GLOAM_QUESTIONS.md`, `docs/FOR-GLOAM.md` and the partnership parts of `REPORT.md` move somewhere private.
- [ ] **Bob:** a Vercel project on the same account, domain gloak.boblabs.tech. The build needs nothing special, since the site defaults to Gloam. Set `VITE_KEEPER_URL` and `VITE_RELAYER_URL` to the v2 keeper.
- [ ] **Bob:** a v2 keeper on a new Render account (no custom domain yet), with the key in Render's env, never in the repo. Its env:
  - `KEEPER_PK` and `CONFIG` (for launches);
  - `GLOAM_VAULT`, `GLOAM_LAUNCH_VAULT`, `GLOAM_MEMO`;
  - `GLOAM_ESCROWS` (launch swap v4, batcher v4, bids, receive, graduation, funds gate);
  - `GLOAM_BATCHER_V4`, `GLOAM_BATCHER_V4_BLOCK`, `GLOAM_FUNDS_GATE`.

  CORS must allow gloak.boblabs.tech.
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
- [ ] Cloak's launch factory, hook and fixed WHYPE on mainnet. Decide whether Cloak v1's mainnet deploy makes them and v2 points at them.
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

## Security and review follow-ups

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
- [ ] **Later, once Bob says Gloam's side is proven:** remove Cloak's own private layer from v2 (REPORT section 17). Cloak v1 keeps it.
