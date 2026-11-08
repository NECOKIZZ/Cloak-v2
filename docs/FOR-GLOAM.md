# Cloak v2 on Gloam: status for Gloam (Nov 8)

Cloak v2 runs on Gloam's vault, circuits and final ceremony keys, all unchanged. Cloak's launch features are built around them: sealed-bid launches, launch tokens with their own Uniswap v4 pools, private swaps, batch rounds, bids from a private balance, and receive addresses. Everything below is on Elysium testnet (99801) unless it says mainnet.

**Repo:** github.com/NECOKIZZ/Cloak-v2. Gloam is pinned at `cryptoduke01/gloam@16dac34` as a submodule we never edit. Our contracts are in `contracts-gloam/src` (solc 0.8.24 like yours) and `contracts-v4` (the v4 venues, tested on the real PoolManager). The build log is `REPORT.md`, and review packs are in `docs/gloam-pack/`.

## 1. What we shipped

- **Our launch vault (`CloakLaunchVault`):** your `ShieldPoolCore` plus your `ShieldPoolPayments` rules, and one addition. `admitLaunch` gives a settled launch of Cloak's factory fixed caps at once, once per token, and a pauser can stop new admissions only. It's deployed the way your guarded deploy works: under a `VaultOwnerGuard`, with your final-key verifiers. HYPE and launch tokens live here, and USDC lives in your vault.
- **Escrows on your pattern** (one-time CREATE2 escrow bound by the unshield proof, a timeout exit on each, no owner, no admin, no fee of their own):
  - private swaps through Cloak launches' own v4 pools, with the price buffer owed back to the trader;
  - batch rounds (V2 and v4 venues);
  - sealed bids from a private balance;
  - graduation into your vault in rounds;
  - receive addresses (a public address anyone pays, shielded by the owner's app).
- **Proofs:** an allocation gate on your funds circuit and a receipt check on your receipt circuit, with verifiers exported from your final zkeys (GPL-3.0 headers kept).
- **Relay:** ours, built on your relay's rules (send records, locks held when the outcome is unknown, the 80/60/8 budget shares, cash-out destination checks). It is paid from the launch vault's 0.5% fee.
- **Site, SDK and agent tools:** every page of Cloak's site runs on your vault: portfolio, send, withdraw (also in pieces over time), trade (instant or batched), payment links, receive and prove funds. Proofs are made in the browser on your files from jsDelivr at the pinned commit, hash-checked. The MCP agent tools run on it too.
- **Tests:** 117 forge tests (ours), 65 more on the real v4 PoolManager, 16 end-to-end runs (anvil and forks of testnet, all on final keys), and the real site in a browser on a fork.

**Token policy:** we vet every token ourselves before asking you to list it in your vault for graduation. Launch tokens are Cloak's factory token (fixed supply, no owner, no mint, no tax, no blacklist), and anything else gets the same check first.

## 2. Our contracts on Elysium testnet (for vetting)

From `deployments/elysium-testnet-gloam.json`, deploy block 26230337. Today the deploy wallet stands in for our multisig (guard controller, pauser, fee recipient).

| Contract | Address |
|---|---|
| Cloak's instance of your guarded vault (USDC only, 500 / 25,000) | `0x8D15BA46071D5AB2e59d746c22d51C906281cB44` |
| Its guard / memo board | `0xD9f827BF69b769e0bF39c9Bc96101DcdEA098171` / `0xf6816854b68CC4B67213289927d8e44050BA62D3` |
| Final-key verifiers (unshield / shield), our copies | `0xe65Ad45F408b74Dc2eEb6562C54721fE60DCA7F2` / `0xFacd1e048F7B6D1CdD9A7Bcca93b806Ed0C6F67d` |
| **CloakLaunchVault** (HYPE 10 per deposit, 12 launches admitted) | `0x8e38155ae9e753874415482e1ab1c169bbc7d1a2` |
| Its VaultOwnerGuard | `0x8362860ea98c1b95dda1d28077909779b457dcc2` |
| CloakLaunchSwapV4 (private swaps) | `0xd540527d3eef9b4de63f741159036d5e35204541` |
| CloakGloamBids (sealed bids) | `0x0c3f42b10569a4550fe75785f86b2b019905f31b` |
| CloakGraduation (into the Gloam vault, 1-hour rounds) | `0x51756969b91f8b6a8c941250691b974c769c97fa` |
| CloakGloamReceive (receive addresses) | `0x4a11f7948513fe7517ef7c6efee88c5681bb06c4` |
| CloakFundsGate / CloakReceiptCheck | `0x1642422970782e5d1b0a94a64ee022e2c3b4a25c` / `0x2236b68e231cebd7dd04e23fe756efdae726e325` |
| CloakGloamBatcherV4 (batch rounds) | built and tested, deploys next |
| Cloak's v4 launch factory / CloakV4Hook / PoolManager | `0x1b0072684e98d9e23018e2d107ed8166ef84c077` / `0xcdc11340c5ce0b3dcbd9a5e8f7838e8a8bbaaa80` / `0x51027076df8416e42ea8438b27a0c433d9662e68` |

What each escrow call does and where money can go: `docs/gloam-pack/ESCROWS.md`. The launch-vault diff against `ShieldPoolPayments`: `LAUNCH-VAULT-DIFF.md`. The factory token and v4 pool keys: `FACTORY-AND-POOLS.md`.

## 3. What we need from Gloam on testnet

1. **Your Elysium testnet vault** (`ELYSIUM_TESTNET.pool` is still empty in your SDK, and `0x39E2…0194` has no code on 99801 yet), with the guard, memo board and deploy block. We then redeploy against it the contracts that take your vault: graduation, receive, the gate and the receipt check.
2. **Your verifier addresses on 99801**, so our launch vault uses yours, not our copies.
3. **Reviews:** our escrows, the launch-vault diff and the factory token (the packs above).
4. **A Cloak partner account with `relayApproved`**, so Cloak's payment messages share your paid memo budget, and our escrows on your relay once reviewed.
5. **The SDK release** with 99801 and 99901 and the change-note seed. We bump to it and rerun everything.

## 4. What we need for mainnet (99901)

**From Gloam:**
1. The mainnet vault's address, deploy block, memo board and guard, and the verifier addresses, on launch day.
2. Our escrows on your mainnet relay, or confirmation that we keep running ours until your review is done (ours is ready).
3. The fee: the split, and whether a lower rate on exits into reviewed partner escrows comes at launch or later.
4. Graduation listings: a launch token that passes our vetting goes to you for listing, through your guard's 3-day timelock, at caps big enough for a full round.

**From Elysium (Kinetiq):** a public RPC that answers `eth_getLogs` at volume, the explorer and its verification API, and confirmation of the official Uniswap v4 PoolManager (`0xe2e1…23f1`) and who owns it.

**From us:** Cloak's launch factory and hook on 99901, a Safe for the guard controller and pauser, separate keeper and relayer keys, an outside review of our escrows and launch vault (your Kann audit covers only your vault), and low caps until that review is done. No ceremony is needed, because we prove on your final keys.

## 5. Your answers, as we read them

These are checked against your repo at `083c544`. What we're doing with each:
- **Shared vault:** USDC goes in your vault now. HYPE and approved ecosystem tokens move there as you list them, and our app already deposits into your vault whenever it takes the asset. Launch tokens stay in `CloakLaunchVault`, the separate instance you suggested for experimental tokens, until they pass our vetting and your review and listing. Swaps spend from the launch vault, so HYPE for trading stays there until a swap path from your vault exists.
- **Fee:** 0.5% on cash outs. Cloak's fee is taken in the clear inside our escrows, since `partners.ts` only tracks a would-be partner fee and doesn't pay one yet.
- **Relay:** we run ours until your review of our escrows is done, then move to yours with a per-partner budget.
- **Audits:** Kann covered your vault only. Our escrows and launch vault join as a separate scope when you book the router review.
- **Branding:** "Powered by Gloam" on Cloak, and you list Cloak as a live partner once we're on mainnet.
- **Router on Elysium:** our v4 pool list is in `FACTORY-AND-POOLS.md` (testnet). We'll send the mainnet list as soon as the first mainnet launches settle.

## 6. Open questions

Not repeated here, because your answers or your repo settle them: the vault address, testnet RPC, explorer and USDC, ceremony keys on Elysium, the relay fee, the 3-day listings, graduation caps, SDK pinning and notice, branding, grants.

1. **The fee share:** your note came through with "[fee share]" as a placeholder. What's the number, from when, and does it include a lower rate on exits into reviewed partner escrows?
2. **Interface fee:** your first note says partner fees can be paid privately, and the second says not until a fee output is in the circuits. We read the second as current. Is that right?
3. **Guard controller on Elysium:** a Safe from day one, or the owner wallet first (your runbook's `GUARD_CONTROLLER_EOA=1` fallback) and a Safe later?
4. **Testnet vault day:** which day this week? Then we redeploy graduation, receive, the gate and the receipt check against it, and point our launch vault at your verifiers.
5. **Partner budget on your relay:** can it be set up for Cloak on testnet now (an account with `relayApproved`), ahead of the escrow review?
6. **HYPE in your vault:** the HYPE caps and timing when you have them. That's when Cloak moves HYPE deposits that aren't for trading into your vault.
7. **The escrow review scope:** what you need from us to book it (commit, contract list, our own internal review notes).
