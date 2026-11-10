# Mainnet decisions (Bob)

Nov 10. Each row is a value or a call only Bob makes. The current value is what the mainnet configs hold today, and the recommendation is Claude's. **Fixed** means it's set at deploy and can never change. Everything else the owner wallet can tighten at once, or loosen after a public 3-day wait.

The configs these go into:
- `deployments/elysium-mainnet-v2-factory.input.example.json` (the launch factory);
- `deployments/elysium-mainnet-gloam.input.example.json` (the vaults and escrows).

Both were rehearsed end to end on a fork of Elysium mainnet (part 22).

## 1. Launch economics (the factory and hook)

| Decision | Now | Recommendation | Changeable? |
|---|---|---|---|
| Launch fee (of a successful raise, to the treasury) | 1.5% | Keep 1.5%. It's Cloak's main revenue. The ceiling is 3% | Yes (raising it waits 3 days) |
| Bid caps (beta) | 100 HYPE per bid, 10,000 HYPE per launch | Keep until the audit, then raise | Yes |
| Pool fee | 0.3% | Keep | **Fixed** (in the hook) |
| Anti-snipe fee at listing | 10%, falling to 0.3% over 5 minutes | Keep. It's been tested, and it pays the creator | **Fixed** |
| Who earns the pool fee | 100% the creator | **Decide.** Cloak earns nothing from trading today. A share (say 20% of the pool fee to the treasury) needs a small hook change, which is easy now and impossible after deploy | **Fixed** |
| Reveal window | 5 minutes to 7 days | Done (W-08): the 7-day maximum is in the contract and the form | Fixed |
| Unrevealed-bid penalty floor (W-03) | 10% (creator picks 10% to 50%) | Raise the floor to 20%. A bidder holding a bid only they can open then pays more for not revealing it. A one-line contract change before the mainnet factory | Fixed per factory |
| One wallet filling a launch (W-01) | Possible within the caps | Accept for the beta (the caps are small); lift the caps after the audit. Or count only revealed bids against the cap (a contract change) | Fixed per factory |

## 2. Vault fees

| Decision | Now | Recommendation |
|---|---|---|
| Our launch and ecosystem vaults' withdrawal fee (`withdrawFeeBps`) | 0.5% | **0.25%.** A buy pays Gloam's 0.5% on the HYPE side, so a buy and a sell already cost about 0.75% plus pool fees at 0.25% (1% at 0.5%). v1 charged 0.25%. The fee also pays the relay's gas, and Elysium's gas is cheap (the whole mainnet partner deploy, about 25 contracts, cost about 0.03 HYPE on the fork) |
| Gloam's fee on HYPE and USDC | 0.5% (theirs) | Negotiate (it's in the Gloam brief): a partner rate on exits into our escrows, or a share |

## 3. Caps and rules

| Decision | Now | Recommendation | Changeable? |
|---|---|---|---|
| Launch-token caps in the launch vault | Effectively none (10^27 per deposit) | Keep. The bid caps already bound a launch's size | Yes |
| Ecosystem rules: liquidity | At least 250 HYPE in range | Keep. KNTQ shows about 15,800 HYPE in range by the vault's own measure (the Nov 10 scan said 30,200, from a different reading of the pool) | **Fixed** |
| Ecosystem rules: market cap | At least 50,000 HYPE | Keep. KNTQ is about 70,400 HYPE | **Fixed** |
| Ecosystem rules: caps, delay | 0.1% of supply per deposit, 1% in total, 3-day delay | Keep | **Fixed** |
| KNTQ caps | 0.05% of supply per deposit (about 6,500 KNTQ), 0.5% in total | Keep for the beta | Yes |

## 4. Keys (decided Nov 10)

One owner wallet, a hardware wallet with its seed phrase stored in two places. It's the guard controller, launch pauser, ecosystem approver, config owner and treasury, as Gloam runs theirs, with a multisig later. A fresh deployer key used once, and a separate keeper/relay key holding only gas.

## 5. $CLOAK (not designed yet)

There is no $CLOAK in this repo. Questions to answer first:
- **Supply and split:** team, treasury, community, liquidity.
- **How it launches.** The strongest story is Cloak's own sealed-bid launch on mainnet: the first launch on the platform, with a uniform price and no snipers. It's subject to the same caps as everyone else, so it fits after the audit and cap raise.
- **What it does:**
  - a share of the launch fee and the pool-fee share (above);
  - fee discounts for holders;
  - governance of the owner wallet's powers later;
  - or nothing beyond being the platform's token.
- **Vesting** for the team's share. The factory already vests a creator's share linearly over at least 30 days, but a team usually wants longer.

Once these are settled, Claude can write the design and any contract it needs. The pool-fee share in section 1 is the one decision that has to come before the mainnet factory, whatever $CLOAK becomes.
