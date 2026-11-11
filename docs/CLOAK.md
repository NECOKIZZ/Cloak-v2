# $CLOAK

Nov 10. What's decided, what's open, and how $CLOAK fits into Cloak's vaults. The decisions behind it are in `docs/MAINNET-DECISIONS.md` (Part D and Part E).

## In one paragraph

$CLOAK is Cloak's own token. There are 500,000 of them. It launches after the audit, wherever demand is best (Cloak itself is not promised). Its main job is the buyback: part of what Cloak earns buys $CLOAK in the market, and part of that is burned, so supply shrinks as Cloak is used. It's traded privately like any other token in Cloak, and the goal is to get it into Gloam's main vault as fast as Gloam allows.

## Decided

- **Supply:** 500,000 $CLOAK, fixed. If it launches on Cloak it has no mint, no owner and no tax, like every Cloak launch token. If it launches elsewhere, we pick a launchpad whose tokens are the same.
- **Timing:** after the audit of Cloak's own contracts. The mainnet beta opens without it.
- **Where it launches:** open. It goes wherever it gets the most demand.
- **Utility:** the buyback, copying Gloam's $GLOAM model. Plus a "pay with $CLOAK" option in the trade picker once it trades (it routes through HYPE, so it needs nothing new), and governance later, when the owner wallet becomes a multisig.
- **Tone:** facts only, like Gloam: "half of Cloak's revenue buys back $CLOAK". No promises of price, yield or returns.

## Not doing, and why

- **Holder fee discounts or launch priority.** To get a discount you'd have to prove you hold $CLOAK, which ties your wallet to your private trades. That breaks the point of Cloak. Doing it privately needs a new zero-knowledge circuit, which is a big build for a small perk.
- **Staking for yield.** Paying holders from revenue looks like a security. Burning does the same job (less supply) without the promise.

## Where $CLOAK lives in Cloak

Cloak has three vaults: Gloam's (HYPE, USDC and whatever Gloam lists), our launch vault (Cloak launch tokens) and our ecosystem vault (vetted outside tokens). The router picks the vault from the token, so a token has one home.

The order we'll try:
1. **Gloam's vault, if Gloam agrees.** We wait out their 3-day timelock. The router already sends any token that isn't in our vaults to Gloam's, so nothing needs building.
2. **If Gloam says no:** our ecosystem vault, through the launchpad it launched on (once we vet that launchpad), or listed on its own as KNTQ was. Listing is instant.
3. **If it launches on Cloak:** our launch vault, automatically, the moment the sale settles.

Two rules to remember:
- **Our listings are permanent.** Once $CLOAK is in one of our vaults, the router always routes it there. Moving it to Gloam's later needs a new router version (easy, it holds no money) and holders moving their balance across. So wait for Gloam's answer before listing it in the ecosystem vault.
- **Its pool must be one our router can trade:** a plain HYPE Uniswap v4 pool with no hook, or a Cloak launch pool. A launchpad whose pools use its own hook can't be routed, so $CLOAK must also get a plain pool, or Cloak can't trade it privately.

## If it launches on Cloak

Cloak's own rules apply to us like anyone:
- Cloak, as the creator, can keep **at most 20%** of the supply (up to 100,000 $CLOAK) for the team and treasury. That share unlocks a little every second over a period we pick (at least 30 days; 12 to 24 months is normal for a team), and bidders see it before they bid.
- Everything else is sold in the sealed-bid auction or goes into the pool, all at one clearing price, with no snipers (10% anti-snipe fee in the first 5 minutes).
- The raise is capped by the beta bid caps (10,000 HYPE per launch) until we raise them after the audit. Raising them waits 3 days in public, which doubles as an announcement.
- Cloak is the creator, so the pool's trading fees come to us too: 80% as creator plus the 20% treasury share.

## Gloam and $CLOAK (Gloam, Nov 10)

Gloam's answer on listing $CLOAK in their main vault: **after Cloak's audit, and once $CLOAK has a market, they'll look at listing it, with starting caps through their usual 3-day public timelock.**

What that means for us:
- **The order holds.** We launch after the audit, then ask Gloam. If they list it, $CLOAK lives in Gloam's main vault, where the biggest private crowd is.
- **No code needed for their vault.** Our router sends any token that isn't in Cloak's own vaults to Gloam's, so once they list it, private trading just works.
- **Don't list it in our ecosystem vault while we wait for Gloam's answer.** Our listings are permanent, and once it's in our vault the router always sends it there.
- **Starting caps will be small** (Gloam starts every asset small, like HYPE at 12 per deposit). Cloak's app already splits deposits, trades and bids to fit any cap, so small caps never limit what a holder can do.
- **The pool must be one our router can trade:** a plain HYPE Uniswap v4 pool with no hook, or a Cloak launch pool.
- **Announcements go out together with Gloam** (their ask).

## The buyback (decided Nov 10)

Copying Gloam (their fees go to a treasury wallet; half buy back $GLOAM; half of that is burned and half kept):
- Cloak's revenue goes to a `CloakBuyback` contract with no owner and fixed splits: 50% to the treasury; 50% buys $CLOAK, of which half is burned and half kept by the treasury.
- Anyone can trigger it, and the keeper does daily. Each buy is small and refuses to run when the price is more than 1% off its 30-minute average, so bots can't skim it.
- It's built once we know where $CLOAK trades. Until then revenue sits in the treasury wallet.

Cloak's revenue, which feeds the buyback (decided Nov 10):
- 1.5% of every successful launch raise (in HYPE);
- 20% of every Cloak launch pool's trading fee (in HYPE and the token);
- **half of Gloam's 0.5%** on everything that leaves Gloam's vault into Cloak's router, batch rounds and bids (every private buy and bid), paid by Gloam monthly;
- **0.25%** of every private sale out of Cloak's own vaults, in HYPE or USDC;
- optionally later, a small fee on bridging in through Relay (off for now).

On a $1,000 private round trip on a launch token, that's about $6.20 for Cloak.

## An experiment: GLOAK, the fully private token

Bob's idea (Nov 10). **GLOAK is an experiment, not $CLOAK and not an ecosystem token.** It doesn't touch $CLOAK's plans or the ecosystem vault's rules.

**Updated Nov 11: the build is in `docs/GLOAK-EXPERIMENT.md`.** It replaces the plan below: withdrawals cost 10% (burned) instead of being blocked, it launches on Cloak through a one-time door, and other privacy protocols can hold it once approved.

- **What it is.** A token that can only ever be held privately. Every unit lives in a vault, withdrawals to outside wallets are blocked, so it can only be bought and sold privately through Cloak. Possibly the world's first completely private token.
- **How it could work.** The token's own transfer rule allows only the vault, Cloak's router and its one-time escrows, and its Uniswap pool. A transfer to any other wallet reverts, so a withdrawal fails, and the way out is selling privately for HYPE.
- **What stays public.** The pool, so the price and each trade's size are visible. Who holds it, and how much, isn't.
- **The risks.** Liquidity and availability: no exchange, wallet app or other protocol can hold it. Some people won't like a token they can't withdraw, so the wording must be very clear before anyone buys.
- **Why as an experiment.** It's contained, so if it struggles nothing else is affected, and if it works it's a first worth announcing (with Gloam).
- **When.** After mainnet is live. It needs its own token contract and a review.

## Still open (Bob's questions, moved here from the mainnet decisions file)

None of these block mainnet. Answer whenever you're ready.

1. **Where does $CLOAK launch?** On Cloak (sealed bids, one price, it lives in our launch vault), or on another launchpad (then Gloam's vault if they list it, else our ecosystem vault through that launchpad or vetted on its own). Gloam's vault is the goal either way.
2. **Who gets the first allocation?** A Cloak launch means the sale is the distribution: no separate airdrop pot unless it comes out of the team's share. Another launchpad has its own rules.
3. **If it launches on Cloak: the team's share and its unlock period.** 0% to 20% of the 500,000, unlocking a little every second over a period we pick (at least 30 days; 12 to 24 months is usual for a team).
4. **When to ask Gloam to list it.** Their answer: after our audit and once it has a market. Hold off on our ecosystem vault until they answer, since our listings are permanent.
5. **The `CloakBuyback` contract.** Built once 1 and 4 are settled, since it has to know where $CLOAK trades.
