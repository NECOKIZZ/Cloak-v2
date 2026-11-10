# Mainnet decisions: Bob and Claude, one question at a time

Nov 10. Each decision is a question. For each one:
- what it means in plain words;
- what it means technically;
- what's set today;
- what Gloam does, where they do something;
- Claude's recommendation.

Answer each one with agree, disagree or copy Gloam.

Two words used throughout:
- **Fixed**: set at deploy, and it can never change.
- **Owner-changeable**: the owner wallet can tighten it at once, or loosen it after a public 3-day wait.

The values live in two config files, which were rehearsed end to end on a fork of Elysium mainnet (part 22):
- `deployments/elysium-mainnet-v2-factory.input.example.json`;
- `deployments/elysium-mainnet-gloam.input.example.json`.

---

## Part A. Launches

### A1. How much does Cloak take from a successful launch?

**Plain words.** When a sale succeeds, Cloak keeps a cut of the HYPE raised. It's our main income today. If the sale fails, nobody pays anything.

**Technical.** `launchFeeBps` in CloakConfig, taken at settlement and sent to `config.feeRecipient()` by `withdrawFee()`, which anyone can call. The hard ceiling in the contract is 3%.

**Now.** 1.5%. Owner-changeable: raising it waits 3 days.

**Gloam.** Has no launches, so nothing to copy.

**Recommendation.** Keep 1.5%. Pump-style launchpads take about 1% plus trading fees; we give a fair, snipe-free price, which is worth a little more.

### A2. Should Cloak earn from trading in launch pools? (decided Nov 10: yes, 20%)

**Plain words.** Every trade in a launch's pool pays 0.3% (more in the first 5 minutes). Cloak now keeps 20% of that, and the creator gets 80%. Cloak earns more as trading grows, not only when new launches happen.

**Technical. Done.**
- `CloakV4Hook.collectFees` sends `PROTOCOL_SHARE_BPS = 2_000` of both the HYPE and token fees to the treasury, and the rest to `feeTo` (the creator, or 0x…dEaD for burned LP).
- The treasury is read live from the factory's CloakConfig (`feeRecipient`), so moving the treasury never needs a new hook. If it can't be read, the creator gets everything, so collecting never gets stuck.
- The 20% is a constant: fixed for the life of the mainnet hook.
- Forge test `test_treasuryTakesTwentyPercentOfTradingFees`, including the anti-snipe fee. The mainnet fork rehearsal passes.
- The create form, the creator fees card and the docs page show the split, read from the hook (earlier testnet hooks show 100% to the creator, which is true for them).

### A3. How big can a bid and a launch be?

**Plain words.** Until the audit, one bid is at most 100 HYPE (about $7,300) and one launch raises at most 10,000 HYPE (about $730,000). If something goes wrong, that limits the damage.

**Technical.** `perBid` and `total` in CloakConfig, with `capsOn`.

**Now.** 100 and 10,000 HYPE, on. Owner-changeable.

**Gloam.** Runs deposit limits on everything (50,000 per deposit and 2,500,000 in total per stablecoin) and calls it "live on mainnet with deposit limits".

**Recommendation.** Keep the caps until the audit, as Gloam does. They can be raised for $CLOAK's own launch (Part E).

### A4. What does sniping cost at listing?

**Plain words.** In the first 5 minutes after a launch's pool opens, the trading fee starts at 10% and falls to 0.3%. Bots that race the listing pay the creator for it.

**Technical.** Hook `startFee` 100,000 pips, `baseFee` 3,000, `decaySecs` 300.

**Now.** As above. **Fixed.**

**Recommendation.** Keep it. It's tested and it suits the brand. If A2 goes ahead, the split applies to this fee too.

### A5. What happens to a bid that's never opened? (decided Nov 10: floor 20%)

**Plain words.** Bids are encrypted and unlock by themselves when bidding closes, and the keeper reveals them, so honest bidders never pay anything. A cheater can instead post a fake encrypted bid that never unlocks and keep the real one to themselves: their deposit makes demand look bigger, and when bidding closes they choose whether to reveal (if the sale looks good) or walk away (if it doesn't). The penalty is what walking away costs: part of the deposit, burned.

**Technical. Done.** `MIN_NO_REVEAL_PENALTY_BPS = 2_000` in CloakAuction (stress item W-03); the creator picks 20% to 50%. The create form, the SDK default and the docs follow. Earlier factories keep their 10% floor. The penalty stays burned.

### A6. Can one wallet fill a whole launch?

**Plain words.** Yes, within the caps. Many wallets can belong to one person, and a sealed sale can't tell them apart.

**Technical.** Stress item W-01. The alternative is counting only revealed bids against the cap, which is a contract change.

**Now.** Allowed within the caps. Fixed per factory.

**Recommendation.** Accept it for the beta. The caps keep it small, and no launchpad can stop it.

### A7. How long can a reveal window be?

**Now.** 5 minutes to 7 days. Done (W-08). Nothing to decide.

---

## Part B. Our vaults

### B1. What does Cloak charge on private trades? (BUILT Nov 10; the rate: see H2)

**Decided.** Our vaults charge nothing. Cloak's fee is taken in HYPE (or USDC) when a token is sold out of our vaults, after the swap, and sent to the treasury. Buys pay no Cloak fee (Gloam's 0.5% applies there). Nothing is burned, and Cloak never holds launch or outside tokens.

**Example (0.5%).** Selling 9,950 CASHCAT: all 9,950 is swapped into 995 HYPE; Cloak takes 4.975 HYPE to the treasury, and 990.03 HYPE lands in Gloam's vault as the seller's note. The seller gets exactly what the old vault fee left them; Cloak just gets HYPE instead of CASHCAT.

**Technical. Done.**
- `CloakTradeFee` holds the rate and the treasury. The owner wallet lowers the rate at once; raising it or moving the treasury is queued and waits 3 days in public; the rate can never pass 1%. Ownership moves in two steps.
- `CloakRouterV4` buys the seller's exact note plus the fee, deposits the note and sends the fee (`tradeFee(assetIn, assetOut, amountOut)` shows it). It applies only to sales from the launch or ecosystem vault into Gloam's vault.
- Batch rounds (`CloakGloamBatcherV4`) take the same rate from the sellers' HYPE when a round settles.
- Both vaults deploy with `withdrawFeeBps: 0`. The SDK, the site and the MCP tools quote net of the fee.
- Tests: 8 for CloakTradeFee, 3 for the router, 1 for batch rounds; end to end, part 20 (KNTQ sold into HYPE: 0.5% to the treasury in HYPE, no KNTQ) and part 22 on the mainnet fork (KNTQ sold into USDC: 0.5% in USDC).

**Status.** Gloam answered (Part H): no lower rate, but a 50/50 share of their 0.5% on our flow. Recommended rate 0.25% (H2). The config holds 0.5% until Bob decides.

### B2. Who pays the relay's gas?

The treasury tops up the relay key in HYPE once a month. Expect a few HYPE a month at beta volume. (Cloak's fee arrives in HYPE, see B1, so the treasury tops it up from that.)

### B3. Launch-token caps in the launch vault

**Plain words.** How much of a launch token can be deposited privately.

**Now.** Effectively unlimited (10^27). Fixed per vault.

**Recommendation.** Keep it. The bid caps already limit a launch's size.

---

## Part C. Outside tokens (the ecosystem vault)

### C1. How do outside tokens get in? (decided Nov 10)

**Decided.** Cloak vets each launchpad's code once, then lists that launchpad's tokens at once, with no wait. The owner wallet chooses which ones by market cap and importance, so a launchpad with 10,000 tokens might give us 20. KNTQ is the one token vetted on its own, because Elysium itself made it an ecosystem token.

**Plain words.** We check a launchpad's token code once. Every token it makes is then the same known code, as with Cloak's own launches. Listing a token is then one call from the owner wallet, live in the next block.

**Technical.**
- `CloakEcosystemVault` no longer has a proposal or a delay. It has `approveLaunchpad(checker, name)`, `removeLaunchpad(checker)` and `list(token, pool, caps, launchpad)`, all instant.
- `launchpad` is the launchpad's checker, or zero for a token vetted on its own (KNTQ).
- A checker answers "did this launchpad's factory make this token?". `CloakLaunchpadCheck` does it for most launchpads by asking the factory's own registry, such as `isToken(token)`. A launchpad without one gets a small adapter.
- The C2 rules are checked at listing.
- The vault records where each token came from (`launchpadOf`), so anyone can check it on chain.
- The pauser (the owner wallet) can pause listings or remove a launchpad. Removing one stops new listings and leaves listed tokens alone.

**What we gave up.** With no wait, a copied owner wallet could list a fake token straight away. Two things limit that: the rules still demand a real pool with 250 HYPE in range, and a bad token can't touch other tokens' funds. The hardware wallet is the protection.

### C2. What must a token pass to be listed?

**Plain words.** A real market and a real size.

**Technical.**
- A plain native-HYPE Uniswap v4 pool, with no hook.
- At least 250 HYPE in range.
- A market cap of at least 50,000 HYPE (about $3.7M).
- Caps of at most 0.1% of supply per deposit and 1% in total.
- 6 to 18 decimals.

**Now.** The pool, caps and decimals rules are fixed per vault. **The 250 HYPE and 50,000 HYPE rules are adjustable** (added Nov 10): the owner wallet changes them any time with one call, `setMarketRules`. Raising has no limit. Lowering stops at floors fixed at deploy, drafted at 100 HYPE in range and a 10,000 HYPE market cap, so even a stolen owner key can't list a token with no real market. A change only affects future listings.

**Decide:** the two floors.

**Recommendation.** Start at 250 and 50,000.
- KNTQ passes: about 15,800 HYPE in range and a market cap of about 70,400 HYPE.
- Lowering the market cap to 25,000 HYPE would let smaller Elysium tokens in. That's your call on taste.

### C3. KNTQ's caps

**Now.**
- 0.05% of the supply per deposit, about 6,500 KNTQ (about $2,600);
- 0.5% in total, about 65,000 KNTQ.

Owner-changeable.

**Recommendation.** Keep these for the beta.

---

## Part D. Revenue: every source, and where it goes

### D1. Every way Cloak earns, today and proposed

1. **Launch fee**, 1.5% of each successful raise. Paid in HYPE to `config.feeRecipient`.
2. **Pool-fee share**, if A2 goes ahead: 20% of every launch pool's trading fee, in HYPE and the token, collected through the hook.
3. **Vault fees**, 0.25% or 0.5% of withdrawals from our two vaults. Paid in launch tokens and KNTQ (see B1).
4. **$CLOAK's own pool.** If $CLOAK launches on Cloak, Cloak is its creator, so its pool's trading fees and the launch's raise come to us.
5. **Bridge fee** (optional). Relay lets an app add its own fee on each bridge. Gloam has the same switch (`BRIDGE_FEE_BPS`), currently off. Recommendation: off at launch, and maybe 0.1% later. It's about an hour of SDK work.
6. **A share of Gloam's 0.5%** on the flow we bring, if Gloam agrees. It's in the Gloam brief.

Not revenue:
- The unrevealed-bid penalty is burned (A5).
- The router, batch rounds, bids and receive addresses take no fee. Keep it that way: every hidden fee is a reason not to trust the escrows.

### D2. Where revenue goes (WAITING on Gloam, with B1)

Copy Gloam's split, automated in a contract:
- `CloakBuyback` is the fee recipient. It has no owner and fixed splits:
  - 50% to the treasury wallet;
  - 50% buys $CLOAK in its pool, and of that, half is burned and half is sent to the treasury.
- Anyone can trigger it, and the keeper does so daily.
- Each buy is small, and it refuses to buy when the pool's price is more than 1% off its 30-minute average, so sandwich bots can't skim it.
- It waits for $CLOAK to exist. Until then the launch fee and the 20% trading share go to the treasury wallet, which is pointed at the contract later (CloakConfig's 3-day change).
- If $CLOAK's pool is somewhere the contract can't trade, it buys through Uniswap's router instead. That's decided once we know where $CLOAK launches.

---

## Part E. $CLOAK

### E1. Where does $CLOAK go? (decided Nov 10)

- **Supply:** 500,000 $CLOAK.
- **Timing:** after the audit.
- **Where it launches:** not promised. It launches wherever demand is best.
- **Where it's listed, in order:**
  1. **Gloam's vault, if Gloam agrees.** We wait their 3-day timelock. Our router already sends it there by itself, since it isn't in our vaults, so nothing to build.
  2. **If Gloam says no:** our ecosystem vault, through the launchpad it launched on (vetted), or on its own like KNTQ.
  3. **If it launches on Cloak:** the launch vault, straight away.
- **Keep in mind:** listing in our vaults is permanent (the router always routes it there), so wait for Gloam's answer before listing it in the ecosystem vault. And its pool must be a plain HYPE Uniswap v4 pool (no hook), or our router can't trade it.

### E2. The 20% to Cloak with vesting (plain words)

This only applies **if $CLOAK launches on Cloak.** When anyone launches a token on Cloak, the creator can keep up to 20% of the supply for themselves. Everything else is sold in the auction or goes into the pool. The creator's 20% isn't handed over at once: it unlocks a little every second, over a period the creator picks (at least 30 days). That stops a creator dumping on buyers on day one.

For $CLOAK on Cloak, Cloak is the creator. So Cloak keeps up to 20% (team and treasury), and it unlocks gradually, say over 18 months. Buyers see on chain that the team can't dump.

If $CLOAK launches elsewhere, that launchpad's rules apply instead.

**Supply.** 500,000 $CLOAK.

### E3. What does $CLOAK do?

**Gloam.** $GLOAM's only stated utility is the buyback: half of fees buy it back.

**Decided.** Buyback and burn from all revenue (D2) is the main utility, and we copy Gloam's honest "facts only" tone. Also:
- a $CLOAK pay-with option in the trade picker (works through the HYPE route once it's tradeable);
- governance later, when the owner wallet moves to a multisig.

**Not doing:** holder fee discounts or launch priority (proving you hold $CLOAK ties your wallet to your private trades), and staking (a securities-shaped promise).

---

## Part F. Wallets and keys (decided Nov 10: software wallets)

No hardware wallet: software wallets, with the seed phrases stored offline. Four keys:

1. **Owner wallet.** Its own seed phrase.
   - It's the guard controller, launch pauser, ecosystem approver (it lists tokens instantly, see C1) and config owner.
   - It holds no money beyond gas.
   - Keep it in a browser profile (or device) used for nothing else, and never connect it to other sites. With instant listing and no multisig, this key is the main protection.
2. **Treasury wallet.** A separate seed phrase, so one leaked seed never exposes both controls and money.
   - It receives the launch fee, the 20% trading share and the ecosystem vault's fees, and later the buyback contract's treasury half.
   - It tops up the relay key.
3. **Deployer key.** A fresh key, used once to deploy, then emptied and retired. It never gets any role.
4. **Keeper and relay key.** A hot key on Render, holding a few HYPE at most. If it leaks, the loss is that gas money: it can't move users' funds or change anything.

**Later.** `CloakBuyback` needs no key. Moving to a multisig is one `transferController` call, when there's a second person.

**Never.** No v1 key reused. No key in the repo, in chat, or in a committed `.env`.

---

## Part G. Waiting on others

- **Gloam.** Answered Nov 10 (Part H). Still to come from them: the memo board on Elysium, our HYPE caps through their timelock (H1), the fee share in writing (H2), the escrow review for their relay, the audit quote, and the change-note seed in their SDK.
- **Kinetiq.** The explorer's contract-verification API.
- **Spicenet.** Answers to the 10 questions.
- **Hosting.** Vercel and Render, by Bob. Also decide whether v2's keeper runs the NFT drops; the `DROPS` switch is ready.
- **The audit**, then lifting the caps, then $CLOAK.

## Part H. Gloam's answers (Nov 10), and what they decide

Gloam read the brief with their team. What they said, what's already done, and the decisions it leaves for Bob.

**Done already (no decision needed):**
- **Their repo moved** to github.com/gloamtrade/gloam. The submodule points there now, still pinned at 16dac34, which Gloam confirmed has the same vault contracts and final keys as their main. The app downloads the circuit files from the new path first, then the old one, then our own copy, each hash-checked.
- **Their Elysium vault** is `0x89d3...2164`, from block 3248495, owned by their guard `0x268D...FAf5`, with verifier `0x2905...FcEf`, shield verifier `0xAEB8...0016` and Poseidon `0x62c4...3457`. All checked on chain, and filled into the mainnet config.
- **KNTQ lives in Gloam's vault** (they list it Thursday, Nov 12, at 1,400 per deposit and 70,000 in total). One home per asset, so it's an asset like USDC in our config, and our ecosystem vault starts empty for the next tokens. The router already sends any token not in our vaults to Gloam's, so no code changed.
- **The rehearsal now runs on Gloam's real vault** (part 22, on a fork of mainnet). Acting as their controller on the fork, we pushed HYPE (12 / 600) and KNTQ (1,400 / 70,000) through their 3-day timelock. Their queue already held exactly those two changes. Then: our deploy against their real verifiers, and private trades with real proofs on real pools (1 HYPE to 69.39 USDC, 100 USDC to 285.9 KNTQ, KNTQ back to USDC, USDC to HYPE). It passes in 74 s.
- **Our escrows work on their vault without sign-off**, since it's permissionless. We run our own relay until they've reviewed them.
- **The site and docs say whose vaults are whose.** Every page names Cloak's launch and ecosystem vaults as Cloak's own, run by Cloak, and Gloam's main vault as Gloam's.

**H1. HYPE caps in Gloam's vault: what do we ask for?**

*Plain words.* From Thursday, Gloam's vault takes at most 12 HYPE per deposit and 600 HYPE in total. Every private HYPE balance on Cloak lives there. So:
- a private sale that brings more than 12 HYPE fails;
- a bid refund over 12 HYPE can't go back in as one deposit;
- all of Cloak, plus every other Gloam user, shares 600 HYPE (about $44,000).

One launch at our beta cap raises up to 10,000 HYPE, so 600 in total wouldn't cover one launch's bidders.

*Technical.* The router deposits each trade's output as one note, so the per-deposit cap bounds the biggest sale, and the bid's refund is a deposit too. Each raise waits Gloam's 3-day timelock, so we should ask once, with room.

*Recommendation.* Ask for **100 HYPE per deposit**, which matches our 100 HYPE bid cap, and **10,000 HYPE in total**, which covers one full beta launch. Raise both together after our audit, when we lift the bid caps.

**H2. The fee share: accept 50/50?**

*Plain words.* Gloam can't give us a lower rate: their vault is already deployed with no upgrade path, and a lower rate would apply to everyone. Instead they'll pay us half of their 0.5% on everything that leaves their vault into our router, batch rounds and bids, counted from the chain's events and paid monthly. That's 0.25% of every private buy, and of every bid.

*What it means for a $1,000 round trip on a launch token:*
- Buy: Gloam takes $5 and pays us back $2.50.
- Sell: our trade fee, B1.
- At a 0.5% trade fee: the user pays $10 in privacy fees on top of the pool fees, and Cloak earns $7.50.
- At a 0.25% trade fee: the user pays $7.50, and Cloak earns $5.

The user's cost doesn't change with the share; it's money Gloam already charges.

*Recommendation.*
- **Accept 50/50**, and ask them to write down which events they count, that it's paid to our treasury wallet, and a monthly statement we can check against the chain.
- **Set our trade fee to 0.25%.** The total privacy cost of a round trip is then 0.75%, the target from B1, and Cloak still earns half of every round trip's privacy fees.
- KNTQ and USDC trades never leave Gloam's vault, so they pay no trade fee. We earn the 0.25% share on them instead.

**H3. The memo board: what do we do until Gloam deploys it?**

*Plain words.* The memo board is how a private payment's recipient finds it. Gloam hasn't deployed theirs on Elysium yet. Our app needs one for payments, links and receive addresses.

*Recommendation.* Ask Gloam when it's coming. If it isn't there before we launch, we deploy Gloam's own memo board code, unchanged, and switch to theirs later. The rehearsal already does exactly this.

**H4. $CLOAK in Gloam's vault.** Gloam will look at listing it after our audit, once it has a market, with starting caps through their 3-day timelock. That matches Part E: a token launched elsewhere goes to their vault with no work from us.

**H5. Announcements.** Any announcement goes to Gloam first, so we put it out together.

**Not needed from their SDK 0.7.0.** It now knows Elysium mainnet, but our SDK has its own Elysium settings. The change-note seed and memo posts before a note lands are on their list. We keep the pin at 16dac34 until there's a reason to move it.

## Done and still open

**Done (Nov 10):** C1 instant listing from vetted launchpads (or a token vetted on its own); A2 the 20% trading share in the hook; A5 the 20% penalty floor; F software wallets; E1 the $CLOAK plan.

**Waiting on Gloam's fee answer:** B1 (our vault fee) and D2 (revenue split and buyback).

**Later:** `CloakBuyback` once $CLOAK trades; a Relay app fee on bridging, if wanted (off for now).
