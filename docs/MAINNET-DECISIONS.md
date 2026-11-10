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

### A5. What happens to a bid that's never opened?

**Plain words.** Bids are sealed. A bidder who never lets their bid be opened loses part of their deposit. That stops people placing bids to scare others off and then walking away. Today the lost part is burned, so nobody gets it.

**Technical.** `noRevealPenaltyBps`: the creator picks 10% to 50%, with a floor of `MIN_NO_REVEAL_PENALTY_BPS = 1_000`. The penalty goes to 0x…dEaD (`_settleRest`).

**Now.** Floor 10%, burned. **Fixed per factory.**

**Recommendation.**
- Raise the floor to 20% (stress item W-03). This is a one-line change.
- Keep burning it. Sending it to the treasury would make Cloak earn when users make mistakes, which looks bad and isn't worth the money.

### A6. Can one wallet fill a whole launch?

**Plain words.** Yes, within the caps. Many wallets can belong to one person, and a sealed sale can't tell them apart.

**Technical.** Stress item W-01. The alternative is counting only revealed bids against the cap, which is a contract change.

**Now.** Allowed within the caps. Fixed per factory.

**Recommendation.** Accept it for the beta. The caps keep it small, and no launchpad can stop it.

### A7. How long can a reveal window be?

**Now.** 5 minutes to 7 days. Done (W-08). Nothing to decide.

---

## Part B. Our vaults

### B1. What do our vaults charge on the way out? (decided Nov 10: 0.25%)

**Plain words.** Selling a launch token or KNTQ takes it out of our vault, and the vault keeps 0.25%. Buying already costs Gloam's 0.5% on the HYPE side.

**Technical. Done in the mainnet config.**
- `withdrawFeeBps: 25` on both of our vaults.
- The launch vault's fee is paid in launch tokens, so its `feeRecipient` is 0x…dEaD: anyone calling `collectFees(token)` burns it. Cloak never sells into its creators' pools.
- The ecosystem vault's fee (KNTQ and other outside tokens) goes to the treasury (`ecosystemFeeRecipient`). Those are liquid tokens from other projects, so selling them hurts nobody of ours.

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

**Now.** As above. **Fixed per vault.**

**Recommendation.** Keep them.
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

### D2. Where revenue goes (decided Nov 10: approved)

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

### E1. Where does $CLOAK launch? (open: not promised)

**Decided so far.**
- No promise to launch on Cloak. It launches wherever it gets the most demand.
- It launches after the audit.
- The goal is Gloam's main vault, as fast as possible.

**Wherever it launches, it has a place in Cloak:**
- **On Cloak:** the launch vault, automatically.
- **On another launchpad:** that launchpad gets vetted and $CLOAK is listed in the ecosystem vault, or it's listed on its own like KNTQ.

**Getting into Gloam's vault fastest. Two facts matter:**
1. **A token launched elsewhere goes to Gloam's vault with no work from us.** The router sends any token that isn't a Cloak launch token or listed in our ecosystem vault to Gloam's vault. So once Gloam lists $CLOAK, private trading just works, through today's router.
2. **Listing in our vaults is permanent.** A Cloak launch token always routes to the launch vault, and an ecosystem listing is never cleared. If $CLOAK goes into one of our vaults first, moving it to Gloam's later needs a new router version (easy, it holds no funds) and holders moving their balance across (one click in the app).

**So, if Gloam's vault is the goal, the cleanest path is:**
- launch elsewhere (or on Cloak, accepting the router change later);
- do **not** list it in our ecosystem vault if Gloam can list it soon;
- give it a plain HYPE Uniswap v4 pool with no hook. The router can only trade plain pools and Cloak's own hook pools. A launchpad whose pools use its own hook can't be routed.

**Ask Gloam:** whether they'd list $CLOAK at launch, and what they need (their 3-day timelock, and caps).

### E2. The 20% to Cloak with vesting (plain words)

This only applies **if $CLOAK launches on Cloak.** When anyone launches a token on Cloak, the creator can keep up to 20% of the supply for themselves. Everything else is sold in the auction or goes into the pool. The creator's 20% isn't handed over at once: it unlocks a little every second, over a period the creator picks (at least 30 days). That stops a creator dumping on buyers on day one.

For $CLOAK on Cloak, Cloak is the creator. So Cloak keeps up to 20% (team and treasury), and it unlocks gradually, say over 18 months. Buyers see on chain that the team can't dump.

If $CLOAK launches elsewhere, that launchpad's rules apply instead.

**Supply.** You said 500k. Please confirm: 500,000 tokens, or 500,000,000?

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

**Done (Nov 10):** C1 instant listing from vetted launchpads; A2 the 20% trading share in the hook; B1 0.25% with launch-token fees burned; D2 approved; F software wallets. Rehearsed again on the mainnet fork (part 22).

**Still open:**
1. A5: raise the unopened-bid penalty floor from 10% to 20%? One line, before the factory.
2. E2: $CLOAK's supply (500,000 or 500,000,000).
3. E1: where $CLOAK launches, and Gloam's answer on listing it.
4. D2: `CloakBuyback`, built once we know where $CLOAK trades.
5. D1.5: a Relay app fee on bridging, if wanted (off for now).
