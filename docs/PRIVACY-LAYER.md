# Cloak as a privacy layer for tokens (design, for review)

Status: **draft for review, nothing built.** Written Nov 1, 2026. Decided: one vault per token (section 0). Open questions for the Elysium team are at the end.

## The vision in one paragraph

Cloak brings privacy to tokens on Elysium. We don't run an exchange, we don't make markets and we don't provide
liquidity. Tokens trade where they already trade (Uniswap pools, launchpad pools, later aggregators and order books).
Cloak adds one thing on top: the person trading, sending or holding stays hidden. Any good token on Elysium should be
holdable, sendable and swappable privately, including stablecoins and, when they arrive, tokenized stocks.

## In plain words

- **Today** a private swap only works through Cloak's own pools, so only Cloak-launched tokens can be swapped
  privately. USDC can be held and sent privately but not swapped.
- **The change:** a new swap router (added next to the current one, nothing replaced, nobody's balance moves) that can
  trade through the Uniswap pools already on Elysium. Your private balance pays, the trade happens in a public pool, the
  result lands back in your private balance. The wallet never appears.
- **Which tokens:** any token that passes a short checklist gets its own private vault, the same way USDC got one. We
  decide what gets in, and every addition is announced 3 days ahead on-chain, like every other rule change.
- **Safety rule:** the router can only ever spend what the user put into that one swap, and the swap fails unless at
  least the promised amount comes back. A bad pool can at worst give a bad price within the user's own slippage limit.
  It can never touch anyone else's money or any vault.

This is the model Gloam uses on Uniswap (Robinhood Chain, Base, Ethereum). Their tokens like Pons launches and CashCat
work exactly this way: a vault for the token, routing through existing Uniswap pools, no liquidity of their own.

## What exists today (v4)

- **Vaults:** one permanent private vault per asset (`CloakVaults`). Launch tokens get theirs at settlement. Other
  tokens get one with `CloakConfig.approveAsset(token)` then `CloakVaults.createAssetPool(token)`. USDC came in this way.
- **Private swap:** `PrivateRouter.privateSwap`. A proof withdraws from the input vault to the router, the router
  trades through the launch's `CloakPair`, and deposits the output into the output vault as a new note. The swap
  instructions (pair, output vault, minimum out, output note, deadline) sit in `ExtData.data`, which the proof commits
  to, so the relayer can only submit the swap exactly as the user built it.
- **The gap:** the router only knows `CloakPair` pools. No USDC swaps, no token ↔ token in one go, no outside tokens.

## What we found on Elysium testnet (read from the chain, Nov 1)

| Venue (code matches) | Pools | Liquidity held | Paired against |
|---|---|---|---|
| Uniswap V4 PoolManager `0x889a96eedb1df35a012d7e48baf7f9c780f1243b` | 51,210 | ~5,157 WHYPE, ~4M tUSDG | WHYPE `0xcd57…f234` |
| Uniswap V3 factory `0x1186defcaf121da6e773425fec0814608798e792` | 1,807 | ~417,000 USDC, 310 WHYPE | USDC `0x7D29…47b2` (our USDC), WHYPE `0x757a…` |
| Uniswap V2 factory `0xb2f8ad730e9d05d333c7861184aad0bff1785dd0` | 1,245 | ~640 WHYPE | WHYPE `0xcd57…f234` |
| V3-style factory `0x520bf060f58cee054f725877279328f5f73a7893` | a few | ~26M USDC | ELYZ, WHYPE, KALOS |
| ~70 smaller V2/V3/V4/Algebra/Solidly deployments | a few each | small | various |

**Tokenized stocks on testnet.** 1,318 "xStock" tokens trade in the Uniswap V3 pools above, paired with USDC
`0x7D29…`. Examples: TSLAx `0xfdb7678853f1211bd55bf0e92f88c6f48bdb6de6`, AAPLx
`0xc7e8fbf4d1d9445d94486375f0ad93ea1596ddbb`, SPYx `0x16a37122344e16047547d98c42bd8fdc1feece28`, MSTRx
`0x991514e46877247f3aa3816b833d1c533627949f`, CRCLx `0x64eda9fe17520bcb6940a1a22b053b93788ce746`. On testnet they are
stand-ins: identical code, 1B supply each, no owner, no pause, and contracts can hold them. Mainnet stock tokens may
add issuer powers (freeze, allowlists), which is question 2 below. StockFlow also runs a mock NVIDIA token (mNVDAx,
`0x8c8fb72e315a4f72393fdfbf54d5d630b79b2927`) on its own Uniswap V3 fork.

- 33,513 of the V4 pools use one hook (`0xda605da70bff4b32a9b379c614a6d9e4a09baaec`), the fingerprint of a launchpad
  that puts every new token straight into a V4 pool.
- There are several "wrapped HYPE" tokens: `0xcd57…` (most pools), `0x757a…` (some V3 pools) and Cloak's own
  `0xe44b…` (our HYPE vault). Routing has to convert between them.
- Announced for mainnet (Nov 9): Uniswap, 0x and KyberSwap (aggregators), Hyperliquid order books about four weeks
  later. Uniswap Labs has not formally announced Elysium; the testnet deployments come from ecosystem teams.

**Where liquidity comes from on Elysium:** mostly from launchpads. A new token's pool is created and funded by its
launch (raised HYPE plus tokens) and locked, with no bonding curve or graduation step. Second, people depositing token
pairs to earn fees (most of the USDC depth). Aggregators hold none, they route. Cloak launches already do the first
thing (seed and lock their own pool). The difference is only that our pool is a custom design nobody else can route to.

## Design

### 0. Decision: one vault per token (Nov 1, decided)

Every token keeps its own vault: HYPE, USDC, every Cloak launch, and each stock or outside token once admitted. We
weighed a shared vault (Gloam's design, one vault for many tokens) and a middle ground (one shared vault for all stock
tokens, or three vaults: majors, Cloak launches, outside tokens), and chose to stay with one vault per token.

**Privacy is the same where it counts.** The token is public whenever it physically moves, in either design:

- *Deposits* show the token going into Cloak.
- *Swaps* leave the vault, trade in a public pool and come back, so the pair and size are public. Who traded is hidden.
- *Withdrawals* show the token leaving. A TSLAx withdrawal can only come from someone who put TSLAx in or bought it
  privately, so the crowd is the people using that token, whichever vault it sits in. AAPLx holders don't hide a TSLAx
  withdrawal.
- *Private sends* are the only difference: a shared vault could hide which token moved. But the relayer is paid in the
  token being sent and that fee is public, so the token shows anyway. Hiding it would need Cloak to pay every send's
  fee, or a proof that pays the fee in HYPE while moving another token (much harder maths).

Crowd size depends on how many people use a token, not on how many tokens share a vault.

**A shared vault adds a new kind of bug.** Notes would have to record their token, and one rule in the circuit
("every note in this proof is the same token, and that token is the public one whenever money enters or leaves")
would be all that stops a worthless token's notes from being passed off as USDC. A per-token ledger doesn't stop it,
because the ledger counts everyone's USDC as available. With one vault per token that mix-up can't happen at all: a
vault only ever holds its own token. Gloam's audit found two critical bugs in exactly this area of its maths (a deposit
whose note could claim more than was paid in, and amounts wrapping the field); both are fixed, and ours avoids both,
but it shows how easy the maths is to get wrong.

**It is what we already run.** One vault per token is the proven model (Tornado, Tornado Nova, Privacy Pools), it is
live and tested end to end, and nothing has to migrate. Gloam's circuits also can't be dropped in: their notes have no
owner keys (our `cloak:` addresses need them) and spend one note per proof (ours spend two).

**Many vaults are fine.** A vault costs gas once, when it's made. Only launches that settle with their pool get one,
and outside tokens only after admission (section 1). An empty vault costs nothing. If junk launches ever become a
problem, a launch can be made to earn its vault (minimum raise or bidders).

**What we take from Gloam: the gatekeeping, which we already have.** A token needs `approveAsset` before it gets a
vault, every token has its own deposit limits, and after setup mode every addition waits 3 days in public.

**Upgrades.** Every vault reads its rules (proof checker, fees, limits, router registry) from `CloakConfig`, so one
change reaches all vaults. The vault code itself has no proxy on purpose: nobody, Cloak included, can swap the code
under people's money. A bug inside the vault code would mean new vaults and a migration.

**If this is ever revisited**, the only time it's cheap is before the public ceremony, since a shared vault needs a new
circuit, and only together with Cloak paying send fees, without which it hides nothing extra.

### 1. Token admission: which tokens get a private vault

No contract change. A token gets a vault with `approveAsset` (CloakConfig, 3-day public delay once setup mode is off)
then `createAssetPool` (anyone). Each token has its own vault, so a bad token can only ever affect its own vault.

**Listing checklist** (published in the docs, applied to every request):

1. **Plain token behaviour:** standard ERC-20, no fee on transfer (the vault already rejects these), no rebasing, no
   balance changes outside transfers.
2. **Known powers written down:** can the issuer mint, pause, freeze, blocklist or upgrade it? Allowed (USDC and stock
   tokens have some of these) but stated on the token's page.
3. **Holdable by a contract:** no allowlist or KYC gate that would stop our vault from holding or receiving it.
4. **Real market:** a pool on an approved venue (section 2) with a minimum depth, so private swaps get sane prices.
5. **Enough private holders likely:** privacy means hiding in a crowd. A niche token with three private holders hides
   little, so the app shows how many deposits a vault has and warns when the crowd is small.
6. **Caps:** the default beta caps apply (now 10% of supply per deposit, 50% in total for launch tokens; explicit limits
   for stablecoins), tightened per token if needed.

Cloak launches pass automatically. A "Request a listing" form collects requests; approvals are announced 3 days ahead.

### 2. The swap router: `CloakSwapRouter`

A new router registered in `CloakConfig` next to `PrivateRouter`. The vaults, keys and balances don't change.

```
private note (vault A) ──proof──▶ CloakSwapRouter ──hop 1──▶ pool ──hop 2──▶ pool ──▶ token B ──depositTo──▶ private note (vault B)
                                   (route, min out, output note and deadline are fixed by the proof)
```

**Swap instructions** (in `ExtData.data`, bound by the proof as today):

```
Route {
  Hop[] hops;          // 1 to 3 hops
  address poolOut;     // vault that receives the output
  uint256 minOut;      // fails below this
  uint256 outPubKey; uint256 outBlinding; bytes outMemo;  // the output note
  uint64 deadline;
}
Hop { uint8 kind; address tokenOut; bytes params; }
// kind: CLOAK_PAIR (today's pools), UNI_V2 (pair), UNI_V3 (pool, fee), UNI_V4 (fee, tickSpacing, hooks)
```

**Approved venues, not approved pools.** Gloam approves individual pools. With tens of thousands of pools on Elysium
we approve **venues** instead, and token admission (section 1) is what gates tokens:

- **Uniswap V2 / V3:** an approved factory. For every hop the router checks the pool is the factory's own pool for that
  pair (`getPair` / `getPool`), so a fake pool can't be slipped in.
- **Uniswap V4:** an approved PoolManager, hookless pools allowed, and pools with hooks only if that hook is on the
  approved hook list. Hooks run custom code on every swap, so each one is reviewed before approval.
- **Cloak pairs:** as today, checked against `CloakVaults`.

The venue list lives in the router: **adding** a venue or hook waits 3 days in public (queued on-chain), **removing**
one is instant. The router can be replaced by a newer one at any time without touching balances.

**Safety rules** (enforced by the contract on every swap):

1. The router holds nothing between swaps. It only ever spends what this swap's proof withdrew.
2. It gives no lasting approvals: each hop approves or transfers exactly what that hop needs, and leftover approvals are
   reset to zero.
3. The output must be at least `minOut` of the output vault's token, or the whole swap reverts and the note stays
   unspent. So a bad price can never be worse than the user's own slippage limit.
4. Only approved venues, only the venue's own pools, only approved V4 hooks.
5. Re-entry is blocked (the existing `lock`).
6. The output vault and input vault must be Cloak vaults (`CloakVaults.isPool`).

**Wrapped HYPE.** Our HYPE vault holds Cloak's WHYPE (`0xe44b…`). When a route needs the market's WHYPE (`0xcd57…` or
`0x757a…`) or native HYPE, the router unwraps and rewraps inside the swap. That costs a little gas, nothing else.

**Fees:** unchanged. The input vault's withdrawal fee (0.25%) and the relayer's fee. Pools charge their own trading fee.

**Price protection:** the app quotes with the venues' own quoters (V2 `getAmountsOut`, V3 `QuoterV2`, V4 `V4Quoter`)
and sets `minOut` from a tight default slippage. The trade happens in a public pool, so like any public trade it can be
sandwiched up to that limit. Batch mode (size hidden, crossed at mid) stays available for Cloak launches and can be
extended to outside tokens later using Uniswap V3's built-in price history.

### 3. Quotes and routes (SDK)

- `CloakPrivate.quoteRoute(tokenIn, tokenOut, amountIn)` checks direct pools, then through WHYPE, then through USDC,
  across approved venues, and returns the best route with its `minOut`.
- `CloakPrivate.swap(tokenIn, tokenOut, amountIn, opts)` builds the proof with that route.
- The keeper's snapshot adds approved tokens and their best pools, so the Trade page loads at once.

### 4. Later: aggregators

When 0x or KyberSwap are live on Elysium, an `AGGREGATOR` hop kind calls an approved aggregator router with the
aggregator's calldata. The same safety rules apply (spend at most what came in, get at least `minOut` back, approved
aggregator contracts only). It reaches every venue including order books, at the cost of depending on the aggregator's
online service.

### 5. Cloak launches into Uniswap pools (decided Nov 2, live on testnet)

**Done:** from Nov 2 every launch opens a standard Uniswap V2 pool at its clearing price (`CloakSeeder`, LP burned or
locked as before), and a `CloakV2Market` lets the private router and batcher trade it, using the pool's own price
accumulator for batch rounds. V3 and V4 pools are on the roadmap. The original reasoning:

Today a Cloak launch seeds a `CloakPair`. If launches seeded a standard Uniswap pool instead, Cloak tokens would be
tradable and visible everywhere (DexScreener, aggregators, any wallet) and liquidity wouldn't be split. This answers
"tokens must be able to leave Cloak and be traceable on other platforms". It changes the launch contracts, and batch
rounds would need a new price reference (Uniswap V3's price history). Not part of the first step.

## What stays private, honestly

- **Hidden:** who traded, who holds what, who paid whom, and (for sends) the amount.
- **Visible:** that a swap happened in a public pool, its size and direction, and every deposit into and withdrawal out
  of a vault. That's true of today's private swaps too.
- **Depends on the crowd:** a deposit followed by a withdrawal of a similar amount can be matched if few people use that
  token's vault. Popular tokens get strong privacy. The app shows the crowd size.

## Order of work

1. **Router with V2 and V3 hops** (plus today's Cloak pairs), venue list with the 3-day queue, WHYPE conversion,
   multi-hop. Foundry tests against a fork of Elysium testnet using the real pools above.
2. **SDK quotes and routes, site Trade page** (any approved token, token ↔ token), MCP `private_swap` takes any token.
3. **Admit first tokens:** USDC swaps, then a short list of popular testnet tokens with real depth.
4. **V4 hops** with approved hooks only.
5. **Aggregator hop** once 0x or KyberSwap are live.
6. **Decide on Cloak launches into Uniswap pools** (section 5).

## Pros and cons of this design

| Choice | For | Against |
|---|---|---|
| Route through existing pools (no own liquidity) | Every token with a market works; we never compete with exchanges for liquidity | Prices depend on others' pools; testnet prices are play money |
| Approve venues, not pools | Scales to tens of thousands of tokens; token admission is the real gate | A venue's code must be trusted, so only standard Uniswap code is approved |
| V4 hooks one by one | Reaches launchpad tokens safely | Each hook needs a review; some launchpad hooks may restrict swaps |
| New router next to the old one | No vault change, no migration, instant rollback (stop using it) | One more contract and registry entry |
| Curated token list with a 3-day delay | Keeps scams and broken tokens out; public notice | Slower than permissionless; we decide |

## Open questions for the Elysium team

Contract deployment on mainnet is open to everyone (confirmed). Three questions remain:

1. The official WHYPE, USDC and Uniswap contracts on mainnet (addresses), so routes use the right pools.
2. Can a smart contract hold the stock tokens (xStocks, EQX), or are they limited to approved (KYC) wallets?
3. Does the launchpad behind most V4 pools (hook `0xda605da70bff4b32a9b379c614a6d9e4a09baaec`) let any contract swap
   through its pools?
