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

### B1. What do our vaults charge on the way out? (WAITING on Gloam's fee answer)

**Plain words.** Selling a launch token or KNTQ privately takes it out of our vault, and the vault keeps a cut. Buying isn't charged by us (the HYPE comes from Gloam's vault, which charges its own 0.5%). Each vault has one rate for every token in it, and the two vaults can have different rates. The cut is paid in the token being sold, not HYPE.

**Options.**
- 0.5% (today's code default), the same on launch tokens and outside tokens.
- 0.25% (v1's rate), so a buy and a sell cost about 0.75% plus pool fees.
- Either way: burn launch-token fees (never sell into our creators' pools), and send outside-token fees (KNTQ) to the treasury.

**Status.** Waiting to hear Gloam's fee terms. The mainnet config currently holds 0.25% with launch-token fees burned as a draft. After deploy the owner can lower the rate at once; raising it waits 3 days.

### B2. Who pays the relay's gas?

The treasury tops up the relay key in HYPE once a month. Expect a few HYPE a month at beta volume. (The vault fee no longer pays it, see B1.)

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

- **Gloam.** Their mainnet vault addresses, the HYPE and USDC listing with caps, the fee answer, the relay, an audit slot and the SDK release (all in the Gloam brief).
- **Kinetiq.** The explorer's contract-verification API.
- **Spicenet.** Answers to the 10 questions.
- **Hosting.** Vercel and Render, by Bob. Also decide whether v2's keeper runs the NFT drops; the `DROPS` switch is ready.
- **The audit**, then lifting the caps, then $CLOAK.

## Done and still open

**Done (Nov 10):** C1 instant listing from vetted launchpads (or a token vetted on its own); A2 the 20% trading share in the hook; A5 the 20% penalty floor; F software wallets; E1 the $CLOAK plan.

**Waiting on Gloam's fee answer:** B1 (our vault fee) and D2 (revenue split and buyback).

**Later:** `CloakBuyback` once $CLOAK trades; a Relay app fee on bridging, if wanted (off for now).
