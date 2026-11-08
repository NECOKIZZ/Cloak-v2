# Cloak v2 on Gloam: handover

For whoever (person or LLM) picks this up next. Read this first, then `REPORT.md` (section 16 onwards is the build log, section 17 the direction) and `GLOAM_QUESTIONS.md`. Everything below was true on Nov 8 at commit time.

## 1. Rules (from the owner, Bob / NECOKIZZ). Follow them exactly

- Work only in `NECOKIZZ/Cloak-v2`. Branch `main` (the Nov 8 night session worked on `claude/zen-edison-pikw3r`, which builds on `main` and is merged there when Bob says). **Never push to `NECOKIZZ/cloak` (Cloak v1).** Never touch the live site (Vercel), the live keeper (Render) or npm packages.
- Commit as the owner, with **no Claude or AI attribution** (no Co-Authored-By, no session links): `git -c user.name=NECOKIZZ -c user.email=ohukeofficial@gmail.com commit ...`. Commit and push each working step.
- Testnet only (Elysium testnet, chain 99801), never real funds. Use a fresh testnet key from `.env` (`GLOAM_TESTNET_PK`), never Cloak's deployer or keeper key. `.env` is git-ignored: never commit it or any key. Never paste keys in chat.
- No pull requests unless asked. Budget is $0, so no paid services.
- On-screen copy and posts: no em dashes, no colons, no semicolons.
- Don't publish exploit details anywhere public. Don't message Gloam's people yourself: list questions for Bob.
- Same pages and site map as Cloak v1. Only the backend changes.
- Gloam's circuits, ceremony keys, verifiers and note format are fixed. Never change them. Everything around the vault (escrows, our launch vault on their code and verifiers, routers, relay, SDK, app) is ours to build.
- When a choice is unclear, take the safer option and note it in `REPORT.md`. When something conflicts with what's built, propose it to Bob and change only after he approves.
- End each session with a status: done, measured, next, and new questions for Gloam's founder.

**Team line (agreed):** we adopt Gloam's circuits, keys, verifiers and vault unchanged. Everything Cloak-specific is built around them: escrows, a launch vault on their code and verifiers, our router instance, our relay and our SDK layer. Anything that needs a circuit change waits for Gloam's next vault.

## 2. The testnet wallet

- **Current key (Nov 8, night):** `0x49C71A0c1d6E394392009922658f294dC2a2bEf5`, in this container's git-ignored `.env` (`GLOAM_TESTNET_PK`, mode 600). Not funded yet: Bob funds it with about 0.05 testnet HYPE. If the container is gone, make a new one the same way (`cast wallet new`) and ask Bob again.
- The old address `0x130292b4d2A3C2aBc1C5B3747b9f18C06CfBBFE5` (about 0.92 HYPE) owns the deployed guard, pauser and fee recipient. Its key is gone. The contracts still work, since none of them needs the owner day to day. A full redeploy (`e2e-gloam/deploy-testnet.mjs`, about 0.003 HYPE) moves those roles to the new key, and is due anyway when Gloam's own vault goes live.
- Ownerless additions (like the v4 batcher, `e2e-gloam/deploy-batcher-v4.mjs`) need no redeploy.

## 3. Repo map (what matters)

| Path | What |
|---|---|
| `vendor/gloam` | Gloam's repo, pinned at `16dac34` (public: github.com/cryptoduke01/gloam). Never edit. |
| `contracts-gloam/src` | Our contracts around Gloam's vault (solc 0.8.24, like Gloam's). |
| `contracts-gloam/test` | forge tests (117 passing at last run). |
| `contracts-v4/test/CloakLaunchSwapV4.t.sol`, `CloakGloamBatcherV4.t.sol` | v4 tests on the **real** Uniswap PoolManager and a real Cloak launch (contracts-v4 compiles at 0.8.26 cancun; remappings `gloam/` and `cloak-gloam/` were added to its foundry.toml). |
| `packages/sdk/src/core` | `GloamCore` (a Gloam account), `GloamPrivate` (the site's backend), `launchVault.ts` (swaps, graduation, bids, finishPending), `gloamProofs.ts`, `gloamLinks.ts`, `gloamProvers.ts`, `gloamBids.ts`, `gloamSwap.ts`. |
| `packages/sdk/src/deployments.ts` | Deployment record. Chain 99801 has a `gloam` block, which the site reads. |
| `services/keeper/gloam.mjs` | The Gloam relay (`POST /gloam/relay`). |
| `services/keeper/gloamLoop.mjs` | The keeper loop: admit launches, settle batch rounds, confirm gates, collect fees. |
| `apps/web` | The site. `VITE_CORE=gloam` switches the backend. Gloam-specific glue is in `src/gloam.ts`, `src/links.ts` and `pages/markets.ts`. |
| `e2e-gloam/*.mjs` | End-to-end scripts (anvil, forks, live). `stack.mjs` deploys the full stack, and `lib.mjs` has the helpers. |
| `REPORT.md`, `GLOAM_QUESTIONS.md`, `measurements/` | Findings, the founder questions, and raw numbers and screenshots. |

## 4. What is built (all tested, all on Gloam's final keys)

- **CloakLaunchVault** (`contracts-gloam/src/CloakLaunchVault.sol`): Gloam's `ShieldPoolCore` plus `ShieldPoolPayments`' rules, plus our one function `admitLaunch(i)`. It admits a settled launch of Cloak's factory at once, with fixed caps, once per token.
  - It has a `launchPauser` that can only stop admissions.
  - It is deployed under Gloam's `VaultOwnerGuard`, with 12 read-back checks (`stack.mjs` `checkLaunchVault`).
- **Escrows on the launch vault:**
  - `CloakLaunchSwapBase` with two venues: V2 `CloakLaunchSwap` and v4 `CloakLaunchSwapV4`. The v4 venue takes any pool whose hook is none or `CloakV4Hook`, with no 3-day wait, and the swap's leftover is owed back to the trader.
  - `CloakGraduation`: rounds from the launch vault into Gloam's vault.
  - `CloakGloamBatcherBase`, with the V2 `CloakGloamBatcher` and the new `CloakGloamBatcherV4` (see section 5).
  - `CloakGloamBids`: sealed bids from the private balance.
  - `CloakGloamReceive`: receive addresses. Anyone pays a box, and the owner's app shields the funds via the relay.
- **Proofs:** `CloakFundsGate` (allocation gates) and `CloakReceiptCheck` (receipts), with verifiers we exported from Gloam's final zkeys. Keep their GPL-3.0 headers.
- **Relay:** follows Gloam's rules:
  - targets limited, every call simulated, spent and root checked before the gas estimate;
  - a send record per spend and a lock that stays held on an unknown outcome;
  - cash-out destinations checked;
  - budget shares: 80% new sends, the rest for exits, 60% per sender, a separate exit share, an 8% memo budget, a 10% revert cap;
  - funded by the launch vault's 0.5% fee.
- **SDK / site:** `GloamPrivate` has the same methods as `CloakPrivate`. On the Gloam backend these work: Portfolio, Shield, Send, Withdraw, Trade (v4 instant), Payment links and Claim, Receive, Prove funds (FundsProof v2), and bids from the private balance (`finishPending` on unlock).
  - Addresses are shown as `cloak:gloamr1....`.
  - Deposits go to the launch vault when it takes the asset, else to Gloam's vault. Sends spend from Gloam's vault first.
- **Live on Elysium testnet:** `deployments/elysium-testnet-gloam.json`, from block 26230337:
  - Cloak's instance of Gloam's guarded vault (USDC only, 500 per deposit / 25,000 total);
  - the launch vault on Cloak's real v4 factory `0x1b0072684e98d9e23018e2d107ed8166ef84c077`, with all 12 settled launches admitted;
  - `CloakLaunchSwapV4`, receive, bids, graduation, gate and receipt check.
  - There is no batcher there yet.
- **Real site test** (`part8-site.mjs`, on a fork of that deployment): unlock, shield, withdraw, a buy of FRTN through its real v4 pool, a link claimed by a wallet-less guest, and the Receive page, all passing.

## 5. Done on Nov 8 (night), see REPORT 16.21 to 16.24

- **v4 batch rounds, end to end:** the round test passes (the test had signed with the wrong key's address). The keeper loop registers settled launches and settles both batchers. The SDK picks the v4 batcher per token, records each order and claims payouts in `finishPending` (before this, batch payouts were never claimed by the app). Orders are sized by the notes held (`standardSizesFor`). The site turns batch mode on for registered v4 launches. `part14-batch-v4.mjs` on a fork covers a cancel with refund, a buy round and a sell round on real launches.
- **Founder answers** are in `GLOAM_QUESTIONS.md`. The packs for Bob to send are in `docs/gloam-pack/`.
- **Spread-out withdrawals on Gloam:** proved up front (Gloam keeps every root), queued by the keeper's schedule through the Gloam relay (new dry run), and dropped if cancelled. `part15-split-withdraw.mjs`.
- **MCP on Gloam:** the default where the deployment has `gloam`. `part16-mcp.mjs`. Payment links in the agent tools are still to do.
- **CI** runs v2 only (Gloam stack, v4 contracts, SDK, MCP, site on Gloam, 13 anvil runs). **The site defaults to the Gloam backend** (`VITE_CORE=cloak` for the old one).
- **Network:** this session's cloud environment is "Cloak-v2", which allows the Elysium testnet RPC, drand and soliditylang, and has a setup script that installs Foundry 1.5.1, solc and deps. The script hasn't been proven in a fresh session yet.

## 6. Gloam's founder (Duke) answered our questions. What it means for the build

His answers, and what to do about each:

1. **Gloam's Elysium testnet vault goes up "this week" at `0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194`** (the same address on every chain). Guard and memo board addresses will follow.
   - When it's live, put it in `deployments.ts` `gloam.gloamVault` (and `memoBoard`, `block`).
   - Point our launch vault and receive, graduation, gate and receipt contracts at it. This means redeploying the ones that take Gloam's vault in their constructor: `CloakGraduation`, `CloakGloamReceive`, `CloakFundsGate`, `CloakReceiptCheck`.
   - Our launch vault should then use **Gloam's deployed verifier contracts** (he confirmed any vault can call them). So redeploy `CloakLaunchVault` with their `verifier` and `shieldVerifier` instead of our copies, and run their `CheckCeremonyKeys` script on them if needed.
   - Until then, keep testing on our own instance (what we do now).
2. **HYPE and caps:** mainnet opens USDC only, at 500/25,000. HYPE comes after launch, and every change takes a 3-day timelock.
   - This already matches our design: HYPE and launch tokens live in our launch vault, and USDC in Gloam's.
   - Keep `e2e-gloam/stack.mjs`'s realistic mode (USDC only in Gloam's vault) as the default.
3. **Interface fee:** take it in the clear inside our own escrows.
   - Today our only fee is the launch vault's 0.5% cash-out fee, which goes to Cloak.
   - If Cloak wants a fee on flows in Gloam's main vault (USDC sends have none), it has to be an escrow fee. That's a business decision for Bob. Don't add fees without his approval.
4. **Relay:** Gloam will review our escrows and then add them to their relay, and can set up a per-partner budget.
   - Keep running ours (`services/keeper/gloam.mjs`) until their review is done.
   - Prepare a short list for Bob to send: the escrow addresses and what each one's calls do (launch swap v4, graduation, batcher, bids, receive).
5. **Their router on Elysium:** they'll deploy it once our v4 launch pools exist and allowlist the pools we name. New pools wait 3 days.
   - Our `CloakLaunchSwapV4` already trades instantly without them, so keep it as the main path.
   - Give Bob the list of Cloak's v4 pool keys: the hook's `keyFor(token)` for each admitted launch.
6. **Launch tokens:** listing in Gloam's main vault stays on the 3-day timelock, even for factory tokens. Keep launch tokens in Cloak's own vault until they list them. **This is exactly our design** (CloakLaunchVault plus graduation).
   - They'll review the factory token contract once (`contracts/src/CloakToken.sol`), after which listings go quickly.
   - Prepare that for Bob to send: the token source and the factory address.
7. **Bearer notes:** recipient-bound notes are on their roadmap but not this month. Plan around sweeping, which we already do (auto-sweep on every sync, and the pending balance shown).
8. **Fee split:** a share to be confirmed. He's open to a lower rate on exits into reviewed partner escrows.
   - Note it in `GLOAM_QUESTIONS.md`. No code change now.
9. **SDK:** a release that knows 99801 and 99901 with the final keys comes around mainnet, npm will match the repo, and a change-note secret input for `buildTransferWitness` is in that release.
   - When it ships: bump `@gloamtrade/sdk`, check `GloamCore` still works (`e2e-gloam/part1.mjs` and parts 3 to 13), and use the change seed so change notes become recoverable from the account seed.
10. **Our launch vault:** use their deployed verifiers (see 1). They'll review the diff of our one function (`admitLaunch` plus the pauser).
    - It isn't covered by their audit, so it still needs our own outside review before mainnet.
    - Prepare the diff for Bob: `CloakLaunchVault.sol` against their `ShieldPoolPayments.sol`.
11. **Graduation caps:** when a token graduates, they'll set its caps high enough for a full graduation round.
    - Our `CloakGraduation` already works this way. The token must be listed in Gloam's vault first (3 days), and `finishPending` falls back to the launch vault if Gloam's vault refuses.
12. **Upgrade list** (partner fees and a relayer fee in the proof, 2-in sends, recipient-bound notes, one-step partial cash outs): on their roadmap, with an order to come after Elysium is live.
    - The swap buffer going to their treasury is by design (ours returns it via `CloakLaunchSwapBase`, which is fine).
    - They'll look at the memo board accepting posts before a note is in the vault.

**Update `GLOAM_QUESTIONS.md`** with a section "Answers from Gloam's founder (Nov 8)" covering the above, and mark which earlier LLM-derived answers they confirm or override.

## 7. Next steps

The roadmap and to-do list, by stage and by who it waits on, is **`docs/MAINNET-V2.md`**. The brief for Gloam is `docs/FOR-GLOAM.md`, and the review log is `docs/REVIEW-RESPONSES.md`. The mainnet deploy is `e2e-gloam/deploy-partner.mjs` (rehearse with `--rehearse`).

## 8. How to run things

- **Tools.** Foundry may be missing in a fresh container. Download the release binary into `~/.foundry/bin`: `curl -sSLf https://github.com/foundry-rs/foundry/releases/download/stable/foundry_stable_linux_amd64.tar.gz`, then untar it. The install script piped to bash is blocked. Then run `pnpm install` at the repo root.
- **Contracts:**
  ```
  cd contracts-gloam && ~/.foundry/bin/forge test
  cd contracts-v4 && ~/.foundry/bin/forge test
  ```
- **SDK:**
  ```
  cd packages/sdk && npm run build && NODE_USE_ENV_PROXY=1 npm test
  ```
  Rebuild the SDK after every SDK change: the e2e scripts and the site use `dist`.
- **Site:**
  ```
  cd apps/web && npx tsc --noEmit -p . && VITE_CORE=gloam npx vite build
  ```
- **End-to-end** (from `e2e-gloam/`):
  - `node part7-adapter.mjs` covers the site backend. Then parts 3 to 6 and 9 to 11 (anvil).
  - `part12-v4-fork.mjs` and `part13-bids.mjs` run on a fork of testnet. Part 13 needs `NODE_USE_ENV_PROXY=1` for drand.
  - `NODE_USE_ENV_PROXY=1 NO_PROXY=127.0.0.1,localhost node part8-site.mjs` is the real site in Chromium on a fork.
  - `node live-elysium.mjs --anvil` (rehearsal), `node deploy-testnet.mjs --fork` then live.
- **Container quirks:**
  - Node's `fetch` needs `NODE_USE_ENV_PROXY=1` to reach the internet.
  - jsDelivr and GitHub raw are blocked here (but work in browsers).
  - The environment allows the Elysium RPCs, `api.drand.sh` and GitHub release downloads.
- **Test-writing traps we hit repeatedly:**
  - In forge, a helper that calls the contract inside `vm.expectRevert`'s next call consumes the expectation, so compute signatures and digests first.
  - viem caches `getBlockNumber`, so use `{ cacheTime: 0 }` where freshness matters.
  - Use the chain's clock, not the device's, for deadlines.
