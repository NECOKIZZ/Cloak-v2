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

### A2. Should Cloak earn from trading in launch pools?

**Plain words.** Every trade in a launch's pool pays 0.3%. Today all of it goes to the token's creator, so Cloak earns nothing from trading, however busy a token gets. This is the one choice that can't be fixed later.

**Technical.** `CloakV4Hook.collectFees` pays the whole LP fee to `feeTo` (the creator, or 0x…dEaD for burned LP). A split, for example 20% to the treasury, is a change of about 15 lines in the hook. The hook is immutable, and the mainnet factory is tied to it.

**Now.** 100% to the creator. **Fixed.**

**Gloam.** Gloam takes 0.5% on every private swap, so they do earn from trading.

**Recommendation.** Take 20% of the pool fee to the treasury. The creator keeps 80%, still the best deal of any launchpad, and Cloak gets income that grows with volume rather than only with new launches. **This has to be decided before the mainnet factory.**

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

### B1. What do our vaults charge on the way out?

**Plain words.** Selling a launch token or KNTQ takes it out of our vault, and the vault keeps a small cut. Buying already costs Gloam's 0.5% on the HYPE side, so a round trip costs both fees plus pool fees.

**Technical.** `withdrawFeeBps` on CloakLaunchVault and CloakEcosystemVault, at most 1%. The fee collects in the vault and `collectFees(asset)` sends it to `feeRecipient`.

**The catch.** The fee is paid in the token being withdrawn, not in HYPE. The launch vault's fees pile up as dozens of small launch tokens. Turning them into HYPE means selling into our own creators' pools, which looks bad at any size.

**Now.** 0.5%. Owner-changeable: lowering it is instant, raising it waits 3 days.

**Gloam.** 0.5% on every cash out and swap, paid in the asset, which for them is a stablecoin, so it's clean money.

**Recommendation.**
- 0.25%, which is what v1 charged. A buy and a sell then cost about 0.75% plus pool fees.
- Collect the tokens into the treasury and **burn them** (send them to 0x…dEaD) instead of selling. It's honest marketing ("Cloak's fee burns your token's supply"), it never dumps on creators, and the real income comes from A1, A2 and C1 in HYPE.
- The alternative is to sell them slowly through the buyback contract (D2). It earns more and looks worse.

### B2. Who pays the relay's gas?

**Plain words.** Private actions are sent by Cloak's relay, which pays the network fee. Elysium's gas is very cheap: the whole 25-contract deploy cost about 0.03 HYPE.

**Technical.** Today the plan says "the vault fee pays relay gas", but B1 shows that fee arrives in tokens. So the relay key should be topped up in HYPE from the treasury.

**Recommendation.** The treasury tops up the relay key once a month. Expect a few HYPE a month at beta volume.

### B3. Launch-token caps in the launch vault

**Plain words.** How much of a launch token can be deposited privately.

**Now.** Effectively unlimited (10^27). Fixed per vault.

**Recommendation.** Keep it. The bid caps already limit a launch's size.

---

## Part C. Outside tokens (the ecosystem vault)

### C1. Should outside tokens wait 3 days before they're listed?

**Plain words.** Today the owner wallet proposes a token such as KNTQ, and anyone can add it 3 days later if the rules still hold. You asked for "vet and add" like Cloak's own tokens.

**Technical.** `admitDelay` is set in the vault's constructor and must be above zero. Setting `admitDelaySecs` to 1 in the mainnet config means "propose, then admit in the next block", with no contract change. The rules (C2) are still checked both times.

**Why Cloak's own tokens skip it.** The vault knows our factory's code, so every Cloak token is a known contract. An outside token is anyone's code.

**What the wait buys.**
- If the owner wallet were ever copied, a fake token can't be listed before we notice and cancel it. A fake "KNTQ" shown as vetted in our app is the real risk here. A bad token can't touch other tokens' funds.
- A public notice ahead of each listing.

**What it costs.**
- KNTQ arrives 3 days after mainnet opens.
- Each new listing is slower.

**Now.** 3 days. **Fixed per vault.**

**Gloam.** Gloam waits a public 3-day timelock for **every** new asset, and for every limit raise.

**Recommendation.** I'd push back once. Gloam does exactly this, and with a single owner wallet it's our only safety net. A middle ground is **24 hours**: it keeps the cancel window, and the public notice works as a marketing beat ("KNTQ lists on Cloak tomorrow"). If you still want instant, it's one config value, `admitDelaySecs: 1`. I'll switch it the moment you say so.

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

### D2. Where revenue goes: copy Gloam's split?

**Gloam.** All fees go to a dedicated treasury wallet. Half of them buy back $GLOAM; half of what's bought is burned and half is kept.

**Recommendation.** Copy it, with one change: **automate it in a contract** so nobody has to remember, and anyone can check it on chain.
- A `CloakBuyback` contract is the fee recipient. It has no owner and fixed splits:
  - 50% to the treasury wallet;
  - 50% buys $CLOAK in its pool, and of that, half is burned and half is sent to the treasury.
- Anyone can trigger it, and the keeper does so daily.
- Each buy is small, and it refuses to buy when the pool's price is more than 1% off its 30-minute average. That stops sandwich bots from skimming it.
- It's about 120 lines, and it waits for $CLOAK to exist. Until then the fee recipient is the treasury wallet, which can be pointed at the contract later (Gloam's 3-day change).

---

## Part E. $CLOAK

### E1. Where does $CLOAK live?

**Your plan.** Launched on Cloak, it sits in Cloak's launch vault. Launched elsewhere, it goes in the ecosystem vault. It might graduate to Gloam's vault later.

**Recommendation.** Launch it on Cloak. It's the strongest story: the first launch on the platform, with a sealed-bid uniform price and no snipers. Cloak is then its creator, so its pool fees come to us (D1.4).

**Moving it to Gloam's vault later works, with one condition.** The router decides each token's vault itself, and a Cloak launch token always routes to the launch vault (`vaultFor` checks `isLaunchToken`, which is never cleared). Graduating needs:
1. Gloam to list $CLOAK, which is their call and their 3-day timelock;
2. a new router version, which holds no funds and so is easy to replace;
3. holders to move their balance across (cash out of one, shield into the other), which the app can do in one click.

So it's doable later, and nothing has to be built for it now.

### E2. What a Cloak launch forces on $CLOAK's supply

The factory's rules apply to us too:
- the creator's share (team plus treasury) is **at most 20%** of the supply, and it vests linearly from the sale's end (at least 30 days, and we can pick 12 to 24 months);
- the other **80% or more** is sold in the auction or goes into the pool.

So:
- there's no separate airdrop or community pot unless it comes out of the 20%;
- the sale is the distribution, which is a clean story.

**Sale size.** With the bid caps on, the raise is at most 10,000 HYPE. Raising the caps for this one launch waits 3 days in public, which works as an announcement.

**Proposal for you to react to:**
- 1,000,000,000 supply;
- 20% to Cloak as the creator, vesting over 18 months;
- the rest split between the sale and the pool by the launch form's usual LP share;
- LP locked forever, with the fees to Cloak.

### E3. What does $CLOAK do?

**Gloam.** $GLOAM's only stated utility is the buyback: half of fees buy it back. Their own rules say "facts only" when talking about it.

**Recommendation.** Copy that and keep it honest:
- **Buyback and burn from all revenue** (D2). This is the main utility.
- **A $CLOAK pay-with option** in the trade picker. It already works through the HYPE route, so it costs nothing.
- **Governance later**, when the owner wallet moves to a multisig.

I'd push back on the usual extras:
- **Holder fee discounts and launch priority.** Proving you hold $CLOAK ties your wallet to your private trades, which breaks the product's whole point. Doing it privately (proving a balance in zero knowledge) means a new circuit, which is a big lift for little gain.
- **Staking.** Staking yield from the buyback is a securities-shaped promise. Burning does the same job without it.

### E4. When?

After the audit and the cap raise, so $CLOAK isn't capped at 10,000 HYPE and doesn't launch on unaudited contracts. The mainnet beta can open without it.

---

## Part F. Wallets and keys

Gloam runs one owner wallet, a separate treasury wallet and its own relay. Copy that, with four keys in total:

1. **Owner wallet.** A hardware wallet, account 1. The seed phrase is written down and kept in two places.
   - It's the guard controller, launch pauser, ecosystem approver and config owner.
   - It holds no money.
   - It's used maybe once a week.
2. **Treasury wallet.** The same hardware wallet, account 2. It's a different address from the same seed, so there's nothing extra to back up.
   - It receives the launch fee and the vault fees, and later the buyback contract's treasury half.
   - It tops up the relay key.
   - Keeping it apart from the owner wallet means the money and the controls never share an address.
3. **Deployer key.** A fresh hot key, used once to deploy the contracts, then emptied and retired.
   - It never gets any role: every role goes to the owner wallet in the deploy.
4. **Keeper and relay key.** A hot key on Render.
   - It sends users' private actions and pays their gas.
   - It holds a few HYPE at most, topped up monthly from the treasury.
   - If it leaks, the loss is that gas money: it can't move users' funds or change anything.

**Later.** `CloakBuyback` needs no key. Moving to a multisig is one `transferController` call, when there's a second person.

**Never.**
- No v1 key is reused.
- No key in the repo, in chat or in an `.env` that's committed.

---

## Part G. Waiting on others

- **Gloam.** Their mainnet vault addresses, the HYPE and USDC listing with caps, the fee answer, the relay, an audit slot and the SDK release (all in the Gloam brief).
- **Kinetiq.** The explorer's contract-verification API.
- **Spicenet.** Answers to the 10 questions.
- **Hosting.** Vercel and Render, by Bob. Also decide whether v2's keeper runs the NFT drops; the `DROPS` switch is ready.
- **The audit**, then lifting the caps, then $CLOAK.

## What Claude builds once you answer

1. A2: the pool-fee split in CloakV4Hook, with tests. Before the factory.
2. A5: the 20% penalty floor. One line.
3. B1 and C1: config values.
4. D2: `CloakBuyback`, with tests, once $CLOAK's supply is set.
5. D1.5: the Relay app fee switch, if wanted.
6. Re-run the mainnet fork rehearsal (part 22) with the final values.
