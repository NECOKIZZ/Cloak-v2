# What a $1,000 private round trip costs

Nov 10. Worked out from the contracts' own fee rules, not on a fork: start with $1,000 of a Cloak launch token in the launch vault, sell it privately into HYPE (which lands in Gloam's vault), then buy the token straight back with all of that HYPE. HYPE at $73.

## Where each fee is taken

**The sell** (token to HYPE):
1. Our launch vault keeps its withdrawal fee on the tokens spent (0.5% today, 0.25% if we lower it).
2. The launch pool takes 0.3% of the tokens going in: 80% to the token's creator, 20% to Cloak's treasury.
3. The HYPE lands in Gloam's vault. Deposits are free.

**The buy back** (HYPE to token):
1. Gloam's vault keeps 0.5% of the HYPE spent.
2. The launch pool takes 0.3% of the HYPE going in (same 80/20 split).
3. The tokens land in our launch vault. Free.

**Gas:** paid by Cloak's relay. The user pays none.

The pool is a Cloak launch pool: Uniswap v4, full range, so it prices like x × y = k. After the first 5 minutes, so the anti-snipe fee is over (in the first 5 minutes the pool fee starts at 10%).

## Results

**With our vault fee at 0.5% (today):**
- Small pool, 500 HYPE a side (about $73,000 in the pool): the sell gives 13.230 HYPE ($965.77). Buying back gives $984.38 of tokens. **Lost $15.62, 1.56%.**
- Medium pool, 2,500 HYPE a side: the sell gives 13.516 HYPE ($986.65). Buying back gives $984.15. **Lost $15.85, 1.58%.**
- Large pool, 10,000 HYPE a side: the sell gives 13.571 HYPE ($990.67). Buying back gives $984.11. **Lost $15.89, 1.59%.**

**With our vault fee at 0.25%:**
- Small pool: the sell gives 13.262 HYPE ($968.13). Buying back gives $986.85. **Lost $13.15, 1.31%.**
- Medium pool: the sell gives 13.550 HYPE ($989.12). Buying back gives $986.63. **Lost $13.37, 1.34%.**
- Large pool: the sell gives 13.605 HYPE ($993.15). Buying back gives $986.58. **Lost $13.42, 1.34%.**

## Who gets the $15.90 (medium pool, 0.5%)

- Our launch vault fee: $5.00, paid in the token (burned, under the draft plan).
- Gloam's fee: $4.93, in HYPE.
- Pool fees: $5.93. The creator gets $4.74, Cloak's treasury $1.19.
- Price impact: about $0. A round trip undoes its own price move: the sell pushes the price down and the buy back pushes it back up.

## What this tells us

- **One way, pool size matters.** Selling $1,000 into a 500 HYPE pool costs about $25 more than into a 10,000 HYPE pool, because the sale itself moves the price. That's normal for any pool.
- **A round trip costs about 1.6% at 0.5%, or 1.3% at 0.25%.** For comparison, a plain public swap there and back on the same pool costs 0.6% (two 0.3% pool fees). Privacy costs the vault fees: Gloam's 0.5% plus ours.
- **Cloak's real income per $1,000 round trip is about $1.19 in HYPE and tokens** (the 20% pool share), plus our vault fee in the token. If the vault fee is burned, Cloak's cash take is only the $1.19. That's why the launch fee and the 20% pool share matter more than the vault fee.
- **Lowering our vault fee from 0.5% to 0.25% saves the user $2.50 per $1,000 round trip**, which is $2.50 less in tokens for Cloak (burned under the draft plan anyway).
