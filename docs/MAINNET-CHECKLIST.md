# Mainnet checklist: private mainnet, then public

Nov 10. Everything to do from now until the public launch, in order. **Private mainnet** means it's real and live on Elysium mainnet, but only the team knows the URL and uses it, with small amounts. Public goes live only when every box above "Public launch" is ticked.

Who does it: **Bob**, **Claude**, or **Gloam**. The rehearsal of every deploy step is `e2e-gloam/part22-mainnet-fork.mjs`. It runs on a fork of mainnet against Gloam's real vault and passes.

---

## 1. Before anything is deployed

- [ ] **Bob:** send the reply to Gloam, with the treasury address filled in (from step 2).
- [ ] **Gloam:** their memo board date. If there's none before Monday, Claude deploys their code unchanged (step 4).
- [ ] **Gloam:** HYPE and KNTQ open in their vault on Thursday Nov 12 (HYPE 12 / 600, KNTQ 1,400 / 70,000). **Claude** checks on chain that it happened.
- [ ] **Bob:** a backup RPC endpoint (QuickNode lists Elysium; check it serves mainnet 99901 and `eth_getLogs`).
- [ ] **Bob:** decide whether v2's keeper runs the NFT drops on mainnet (`DROPS`), or leaves them for later.

## 2. Wallets and keys

Four wallets. Each is created fresh, never reused from v1 or testnet, and never pasted in chat or committed.

- [ ] **Owner wallet** (software wallet, its own seed phrase):
  - Write the seed down and keep it offline in two places.
  - Use it only in its own browser profile, never connected to other sites.
  - It controls both vault guards, pauses launches, lists outside tokens, owns the launch rules and the trade-fee settings.
  - **Fund with 0.2 HYPE** for its own calls: accepting ownership, listing tokens, any change.
- [ ] **Treasury wallet** (software wallet, a separate seed phrase, kept the same way):
  - Receives the 1.5% launch fee, the 20% trading share, the 0.25% trade fee and Gloam's monthly share.
  - **Needs no funding.** Note its address for step 1 and the configs.
- [ ] **Deployer key**: a fresh key used only for the deploys, then emptied and retired.
  - **Fund with 0.5 HYPE.** The fork rehearsal used about 0.05 HYPE in all (launch factory 0.015, everything else 0.031, memo board a little), so 0.5 is a 10x margin.
  - It never gets any role: the deploy hands every role to the owner wallet.
- [ ] **Keeper and relay key**: a hot key, held only in Render's dashboard.
  - It sends users' private actions, reveals bids, settles launches and rounds.
  - **Fund with 3 HYPE** to start (each relayed transaction costs about 0.001 HYPE), topped up monthly from the treasury.
  - If it leaks, only that gas money is at risk.

**Total to buy:** about **3.7 HYPE**, about $270 at $73.

## 3. Fill in the mainnet configs

**Claude**, from the example files, with Bob's addresses:
- [ ] `deployments/elysium-mainnet-v2-factory.input.json`:
  - `owner` = the owner wallet;
  - `treasury` = the treasury wallet;
  - `vaultVerifier` = Gloam's verifier `0x2905...FcEf`.
  - Already set: the launch fee 1.5%, the bid caps 100 / 10,000 HYPE, the hook's fees.
- [ ] `deployments/elysium-mainnet-gloam.input.json`:
  - `safe` and `pauser` = the owner wallet;
  - `feeRecipient` and `tradeFee.treasury` = the treasury wallet;
  - `memoBoard` = Gloam's, or ours from step 4.
  - Already set: Gloam's vault, verifiers and Poseidon; the trade fee 0.25%; vault fees 0; USDC and KNTQ in Gloam's vault; the ecosystem rules and floors.
- [ ] **Claude:** rerun part 22 with the final configs on a fork, right before deploying.

## 4. Deploy (private, in this order)

Each step prints what it deployed and reads it back.
- [ ] **Memo board**, only if Gloam's isn't live: Gloam's `GloamPayMemo`, unchanged, from the deployer.
- [ ] **Launch factory and hook:**
  ```bash
  node e2e-gloam/deploy-v2-factory.mjs --config deployments/elysium-mainnet-v2-factory.input.json
  ```
  Run it with the deployer key in the environment. Writes `deployments/elysium-mainnet-v2-factory.json`.
- [ ] **Owner wallet:** accept the launch rules (`acceptOwnership()` on the config; the script prints the call).
- [ ] **Vaults, router and escrows:**
  ```bash
  node e2e-gloam/deploy-partner.mjs --config deployments/elysium-mainnet-gloam.input.json --out deployments/elysium-mainnet-gloam.json
  ```
  It deploys and checks:
  - our vaults against Gloam's real verifiers and Poseidon;
  - USDC's and KNTQ's real pools;
  - Cloak's own WHYPE, the launch vault, the ecosystem vault, the trade-fee settings, the router, batch rounds, bids, receive addresses, the funds gate and the receipt check.
- [ ] **Owner wallet:** accept control of both vault guards (`acceptController()` on each; the script prints both calls).
- [ ] **Deployer:** send what's left to the treasury, then retire the key.
- [ ] **Claude:** check every role on chain:
  - the guards' controller, the config's owner and the trade fee's owner are the owner wallet;
  - the treasury is set everywhere;
  - the deployer holds nothing.
- [ ] **Claude:** verify every contract's source on the explorer, once Kinetiq's verification API is available. Until then, publish the sources and the exact compiler settings.
- [ ] **Claude:** add the mainnet entry to the SDK (`scripts/sdk-entry.mjs` prints it into `packages/sdk/src/deployments.ts`).
- [ ] **Claude:** send Gloam the mainnet addresses (router, batcher, bids), so they can count our flow for the 50/50 share.

## 5. Hosting (private)

- [ ] **Bob:** a new Render service for the mainnet keeper, from `render.yaml` with mainnet values.
  - **Claude** prepares the mainnet block: `FACTORY`, `START_BLOCK`, `GLOAM_VAULT` and its block, `GLOAM_LAUNCH_VAULT`, `GLOAM_ECOSYSTEM_VAULT`, `GLOAM_MEMO`, `GLOAM_ESCROWS`, `GLOAM_BATCHER_V4`, `GLOAM_FUNDS_GATE`, `RPC_URL`.
  - **Bob** sets the secrets in the dashboard only: `KEEPER_PK` and `RPC_BACKUP`.
  - Also `TRUSTED_PROXY_HOPS=1`, `CORS_ORIGINS` (the mainnet site's domain) and `DROPS` (step 1).
- [ ] **Bob:** a Vercel project for the mainnet site:
  - `VITE_CHAIN_ID=99901`;
  - `VITE_RPC_URL=https://rpc.elysium.kinetiq.xyz`;
  - `VITE_RPC_BACKUP`;
  - `VITE_KEEPER_URL` and `VITE_RELAYER_URL` (the mainnet keeper).
- [ ] **Bob:** keep it private. Turn on Vercel's password protection, or use an unlisted domain, until public launch.
- [ ] **Claude:** check the keeper's `/health`: awake, the right factory and vaults, enough gas.
- [ ] **Claude:** check RPC failover on the hosted site and keeper by breaking the main URL once.

## 6. Private mainnet tests (small amounts, real money)

Test with a team wallet and 1 to 5 HYPE. For each step, check the result on chain and in the app.
- [ ] **Shield** HYPE and USDC, including one amount over the cap (it should go in parts).
- [ ] **Private swaps:**
  - HYPE to USDC and back;
  - USDC to KNTQ and back;
  - one swap big enough to split into parts.
- [ ] **A test launch**, small, with a short window. Then:
  - a public bid and a private bid, including one big enough to split into several sealed bids;
  - reveal and settle;
  - check the pool opens at the clearing price.
- [ ] **After the launch:**
  - private buy and sell of the launch token;
  - a batch round;
  - claim the creator's proceeds and trading fees.
- [ ] **Fees land where they should:**
  - the launch fee and 20% of the pool fees in the treasury;
  - 0.25% of a launch-token sale in the treasury, in HYPE;
  - no token fees anywhere.
- [ ] **Receive address:**
  - a plain payment in, collected into the private balance;
  - a Relay bridge in from another chain, small.
- [ ] **Send privately**, a payment link, and a withdrawal, including a withdrawal in pieces over time.
- [ ] **NFT drop**, if `DROPS` is on.
- [ ] **Agents:** one private swap through the MCP server, against mainnet.
- [ ] **Recovery:**
  - open the account on a second device from the same wallet;
  - check balances and pending items come back.
- [ ] **The keeper:**
  - restart it mid-launch, and check reveals and settlement still happen;
  - check gas use against the 3 HYPE.

## 7. UI and UX pass (after hosting, with Bob's new designs)

- [ ] **Bob:** the new look (designs to come). **Claude** applies them.
- [ ] **Claude:** friendly errors everywhere, like v1. No raw error text reaches a user.
- [ ] Every page on a phone and a laptop, light and dark:
  - landing, launches, launch page, create, trade, portfolio, receive, links, drops, docs, roadmap.
- [ ] The words that matter:
  - the 12 HYPE parts lines (few words);
  - whose vaults are whose;
  - fees and caps;
  - "not yet audited, with caps".
- [ ] Remove anything testnet-only from the mainnet site: the faucet, testnet wording, test tokens.
- [ ] The docs page lists every mainnet contract with explorer links.
- [ ] Load time on a slow phone connection. The 12 MB circuit download should say what it's doing.

## 8. Operations, before going public

- [ ] **Watch:**
  - the keeper's gas;
  - Gloam's vault totals (600 HYPE shared);
  - the relay's hourly budget;
  - the keeper's `/health`.
- [ ] **Incident plan** (all owner wallet, all instant):
  - stop new launch admissions (pauser);
  - stop ecosystem listings;
  - lower a vault's caps to 0;
  - lower the trade fee.
  - Withdrawals never close.
- [ ] **Seed phrase check:** both seeds restore their wallets from the written copies.
- [ ] **Monthly routine:**
  - check Gloam's statement against the chain;
  - top up the keeper;
  - run the buyback once $CLOAK trades.

## 9. Public launch

- [ ] Every box above is ticked, and the private tests ran clean for at least a few days.
- [ ] **Bob with Gloam:** the announcement, drafted together and sent to them first.
- [ ] Remove the password from the site, and point the main domain at it.
- [ ] Update the docs, roadmap, pitch and SDK README to "live on mainnet, with caps". Never say "audited" for Cloak's own contracts until the audit is done.
- [ ] Credit the reviewers on X (Haider Ali, Ghost), as promised.
- [ ] Gloam lists Cloak as a live partner on Elysium.

## After public launch

- The audit of Cloak's own contracts (Gloam is asking their reviewer for a quote), then higher bid caps.
- HYPE caps rising with Gloam, with real usage numbers.
- $CLOAK (`docs/CLOAK.md`), then `CloakBuyback`.
- xStocks, Spicenet and GLOAK (the roadmap).
