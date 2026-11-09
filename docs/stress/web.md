# Cloak v2 site and launches: stress test (web)

Runs: Nov 8, 23:30 to Nov 9, 00:25 UTC (pages, flows, launch runs), plus a short auction-rules run on Nov 9 (see the end). All on a local anvil fork of Elysium testnet with a local Gloam relay and a local keeper stand-in. Nothing was sent to a live chain. The site ran from `apps/web` with Vite (`VITE_CORE=gloam`) in headless Chromium, with an injected EIP-6963 test wallet backed by anvil dev keys.

Caveats, read these first:
- Three stacks (three anvil forks, three Vites, three Chromiums, in-browser proving) ran at the same time on one container, so some timings are inflated (load average about 5). Times for the same action measured alone are lower (for example "shield 2 HYPE" took 6.8 s alone and 56 to 66 s while two other stacks were proving).
- A fork is cold: the first read of every contract goes to the upstream RPC. First loads of launch pages took 15 s because of that, not because of the site. Warm loads were 0.2 to 0.6 s.
- The coordinator is changing `packages/sdk`, `services/keeper` and `contracts-gloam` in parallel. Results are for the code as it was at the time of each run.
- The links run and the second flows run were cut short (session stop). Where a check has no result it says so.

Scripts: `e2e-gloam/stress/web-harness.mjs` (shared harness: fork, RPC proxy with delay/failure knobs, local relay + `/schedule` + `/unopenable`, Vite, test wallet that can disconnect or reject), `web-pages.mjs`, `web-flows.mjs`, `web-links.mjs`, `web-launch.mjs`, `web-auction-rules.mjs`. Raw results: `docs/stress/raw/*.json` and `*.log`. Screenshots: `docs/stress/shots/`.

## 1. Timings (desktop, click to confirmation)

| Action | Time | Notes |
|---|---|---|
| Landing page, first load | 1.8 s | |
| Any app page, warm (Portfolio, Shield, Send, Withdraw, Links, Docs...) | 0.15 to 0.45 s | |
| Launches list / a launch page, cold fork | 15 s | fork cold cache; 0.3 to 0.6 s warm |
| Connect + unlock (one signature, first sync) | 3 to 9 s alone, 30 to 42 s under load | **slow under load**, see W-17 |
| Shield 2 HYPE | 6.8 s (alone), 56 to 66 s (3 stacks) | |
| Send 0.2 HYPE privately (proof + relay) | 6.7 s | |
| Recipient's open Portfolio shows the send | 10 s | |
| Withdraw 0.3 HYPE (proof + relay, funds landed) | 8.6 s (12 s in run 1) | |
| Withdraw 0.6 HYPE in 3 pieces (3 proofs + hand-off to keeper) | 24.5 s | pieces then paid out by the keeper queue after a 1 h warp |
| Instant private buy / sell | not measured | the flows run stopped before Trade (session stop); part8 covers it |
| Create a launch from the form | 15.6 s | one wallet tx |
| Public sealed bid | under 1 s after click | (tlock seal is local; the shown 0.3 s is unreliable, the success box from the previous bid was still up) |
| Private sealed bid (proof + relay + one-time wallet) | 10.4 s | |
| Keeper revealAll on 4 launches (SDK) | 16.2 s | |
| Settle from the launch page | 4.8 s | |
| Claim from the launch page | under 1 s | measurement unreliable for the same reason as the bid |

Nothing measured was unacceptably slow on its own. The slow parts are first unlock/sync on a busy machine and cold reads.

## 2. Page by page (desktop 1280 and phone 390)

Every page below was loaded wallet-less and again connected and unlocked, on both widths. No page scrolled sideways at 390 px (checked with scrollWidth against clientWidth on every page). Screenshots: `docs/stress/shots/pages-{desktop,mobile}-*.png`, `pages-*-unlocked-*.png`.

| Page | Desktop | Phone | Notes |
|---|---|---|---|
| Landing `/` | works | works | |
| Portfolio `/app` | works | works | balance skeleton while syncing, as designed |
| Launches list | works | works | |
| Launch, commit phase | works | works | name with HTML tags renders as text (no XSS). Default max price prefilled as `0.000000252448979584` (ugly, W-15) |
| Launch, reveal phase | works | works | shows "2 sealed bids couldn't be opened" from `/unopenable` |
| Launch, settle phase | works | works | "Settle it now" button works |
| Launch, trading | works, **ugly** | works | chart line bleeds left of its card into the sidebar (W-14); on Gloam the private card says "Enable private trading" (v1 action) until the keeper admits the token (W-09) |
| Launch, failed (no bids) | works | works | |
| Launch, dust settled | **ugly** | ugly | pool exists but estimate 0 and Buy disabled with no reason (W-16) |
| Launch, unknown address | works | works | "No launch at this address" |
| Create launch | works | works | good inline hints, see section 4 |
| NFT drops, create drop | loads | loads | flows not tested (time) |
| Shield / Send / Withdraw | works | works | error texts in section 3 |
| Withdraw in pieces | works | not tried | |
| Receive | loads | loads | sweep run cut short; part8 covers a sweep |
| Prove funds | loads | loads | proof run cut short |
| Trade | works | works | balance skeleton stays for 15 s after unlock on an empty account (minor) |
| Payment links | works | works | form checks good, two gaps (W-11, W-12) |
| Claim `/claim` (no link) | works | works | throws an uncaught error into the console (W-19) |
| Pay `/pay` (no or bad link) | works | works | "This request doesn't work" (fine), console error as above |
| Proof `/proof` (no link) | works | works | |
| Docs, SDK, Agents | works | works | |
| Unknown routes | works | works | |

## 3. Findings

Severity: High = loses or locks funds or breaks a launch's fairness; Medium = wrong or misleading result a user acts on, or a real flow blocked; Low = message, polish, or edge behaviour.

| ID | Sev | Where | Finding | Repro | Screenshot | Suggested fix |
|---|---|---|---|---|---|---|
| W-01 | High | CloakAuction (testnet config) | **One wallet can fill a launch's whole deposit cap and buy the sale at the minimum price.** The per-auction cap is 10,000 HYPE in 100 HYPE bids. A whale placed 100 min-price bids in 7 s; every later bid reverts "over cap"; the launch settled at the minimum price with the whale as the only buyer. Cost to the whale is only capital locked (refunds come back) plus the clearing price. | `web-launch.mjs` (launch D) | `launch-cap-full-bid.png`, `launch-capfilled-settled-*.png` | Cap per bidder is not enough (sybils). Make the total cap a cap on **revealed demand counted toward clearing**, or drop the per-auction total while bids are sealed, or reserve part of the cap per time slice of the commit window. At least warn creators and lower per-bid caps relative to the sale size. |
| W-02 | Medium | Launch page bid card | When the deposit cap is full, the UI tells the bidder **"Not enough testnet HYPE in your wallet to cover this and the gas"** while the wallet holds 999,000 HYPE. The real reason ("over cap") is lost because gas estimation fails first. | `web-launch.mjs` | `launch-cap-full-bid.png` | Simulate `commit` and map "over cap" (already in `errors.ts`) before the generic insufficient-funds rule; also show "sale cap reached" on the card from `totalDeposits` vs cap. |
| W-03 | Medium | Auction design | **Selective reveal works as feared:** a bid committed with a garbage ciphertext cannot be opened by the keeper; its bidder watched every other reveal and opened it himself at `revealEnd - 1` (accepted). If he had stayed sealed he pays only the 10% penalty. The site does show the sealed-but-unopenable bids (good). | `web-launch.mjs`, `web-auction-rules.mjs` | `launch-reveal-unopenable-*.png` | Known trade-off. Options: verify the ciphertext at commit (needs BLS12-381, EIP-2537), raise the penalty floor for unopenable bids, or let only the keeper's tlock reveal count after a cutoff. |
| W-04 | Medium | Shield page | Shielding over the launch vault's per-deposit cap (10 HYPE) says **"Something went wrong on our side"**. The vault's `OverDepositLimit` error is not decoded. The "max" link also fills 999,999 HYPE, far over the cap. | `web-flows.mjs` | `flows-shield-50.png` | Read `depositLimit(asset)` and `deposited(asset)`; cap "max" and say "Cloak takes up to 10 HYPE per deposit right now". Add the vault ABI's custom errors to the decode. |
| W-05 | Medium | Send page | A Cloak **v1 hex address** (`cloak:0x…`), a garbage `cloak:gloamr1.` string, or a truncated address gives **"Something went wrong on our side"** after loading the prover. | `web-flows.mjs` | `flows-send-edge.png` | Parse the address before proving; for `cloak:0x…` say "This is a Cloak v1 address. Ask for their v2 address (cloak:gloamr1.…)"; otherwise "This cloak: address isn't complete". |
| W-06 | Low | Withdraw page | Withdrawing to the zero address or to the launch vault itself is refused (good) but says "Something went wrong on our side". | `web-flows.mjs` | `flows-withdraw-edge.png` | Check for these before proving and name the reason. |
| W-07 | Low | Withdraw page | Address errors print the sentence twice: "Enter a 0x address or a .ely name. Enter a 0x address or a .ely name. A brand-new address…". | `web-flows.mjs` | `flows-withdraw-edge.png` | In `PortfolioAction`, don't append the hint when `e.message` already is it. |
| W-08 | Low | Create launch form | Reveal window of 99,999,999 minutes (190 years) and 1e29 tokens for sale pass the form checks. A creator can lock every bidder's deposit for as long as they like (bidders can see it, but nobody reads it). | `web-launch.mjs` | `launch-create-form.png` | Cap reveal window (say 7 days) in the form and the factory; cap sale supply to what fits uint128 with the price math. |
| W-09 | Medium | Launch page (Gloam backend) | After settlement the "Trade privately" card shows **"Enable private trading"**, which calls Cloak v1's shared vault / router, not the Gloam launch vault. On v2 the keeper admits the token by itself. | `web-launch.mjs` | `launch-settled-desktop.png` | When `CORE=gloam`, check `launchVault` admission and show "Private trading opens in a minute" or the Trade link; never call v1 contracts. |
| W-10 | Medium (unconfirmed) | Portfolio after reload | Twice, after a reload in the middle of a withdrawal or after a two-tab race, the account would not unlock again within 90 s: the "Connect a wallet" modal stayed up after picking the wallet. Once it worked. Could be the harness, could be a stale lock. Balance stayed correct (nothing sent, nothing lost). | `web-flows.mjs` (refresh mid-withdraw) | `flows-refresh-mid-withdraw.png` | Worth a manual check: reload during "Proving…", then connect again. |
| W-11 | Low | Payment links | "Create link" with more than the private balance (100000 HYPE) showed no message within 90 s (stuck on "Checking your balance…" under load). | `web-links.mjs` | (none, run cut) | Compare against the cached balance first, before any fee lookups. |
| W-12 | Low | Payment links | A dust link (1e-17 HYPE in 3 shares) is accepted; the sender pays three relay sends and three claim fees for nothing. | `web-links.mjs` | | Minimum share size, for example the claim fee. |
| W-13 | Low | Trade page | A negative amount (`-0.01`) parses (viem `parseEther` accepts the sign). Not reached in this run (cut short); by reading `Trade.tsx` the CTA becomes "Swap privately" because only `=== 0n` and `> balance` are checked. | `web-flows.mjs` (trade section) | | `if (amountIn <= 0n)` in the CTA logic. |
| W-14 | Low (ugly) | Launch page chart | The price chart's line runs left past its card into the sidebar on desktop. | `web-launch.mjs` | `launch-settled-desktop.png` | Clip the SVG (`overflow: hidden` on the chart box) or clamp x to the plot. |
| W-15 | Low (ugly) | Launch bid card | Default max price is an 18-digit decimal (`0.000000252448979584`) when the tick size isn't round. | `web-launch.mjs` | `launch-commit-bids-desktop.png` | Format to 3 significant digits. |
| W-16 | Low | Launch page (dust launch) | A launch that sold 1 token settles with a v4 pool that can't quote: estimate 0, Buy disabled, no reason given; market cap "–". | `web-launch.mjs` (launch B) | `launch-dust-settled-desktop.png` | Say "This pool has almost no liquidity". Consider a minimum raise to list (see CL-02 in MAINNET-V2). |
| W-17 | Low | Unlock | First unlock and sync took 30 to 42 s on a loaded machine (3 to 9 s alone). No progress text beyond the skeleton. | all scripts | | Show sync progress ("Reading the vault, block x of y"). |
| W-18 | Low | Shield/Links amount checks | 19 decimal places of HYPE are rounded to 0 then reported as "Enter an amount above zero" (Shield) while Links says "Use at most 18 decimal places". | `web-flows.mjs`, `web-links.mjs` | | Same message everywhere: "at most 18 decimals". |
| W-19 | Low | `/claim`, `/pay` | Opening without a link throws an uncaught error into the console (`This isn't a Cloak claim link`, `Pay to a cloak: address…`). The page itself is fine. | `web-pages.mjs` | | Catch inside the effect. |

Things that held up well:
- Double clicks: one shield, one bid (button disables in time).
- Two tabs withdrawing the same notes at once: one succeeds, the other says "This private balance is already being used in another transaction". Clear.
- Refresh in the middle of a withdrawal: nothing sent and the balance stayed the same (no loss).
- Spread-out withdrawal: 3 pieces of different sizes, all paid by the keeper's queue within the hour (0.597 of 0.6 HYPE, exactly the fees).
- Amount checks on Shield, Send, Withdraw, Links, Create and the bid card: clear messages for empty, 0, negative, letters, `1e3`, `0x10`, `1,5`, too large, unknown `.ely` names.
- HTML and emoji in launch names and link messages are shown as text.
- The launch page shows unopenable sealed bids during the reveal window.

## 4. Auction gaming: what I tried and what happened

Launch A was created from the form (1M tokens, 1e-8 to 1e-6 HYPE over 50 levels, 4 min bidding, 5 min reveal). B, C and D were made with the SDK to close at the same time.

| Try | Result |
|---|---|
| Fill the deposit cap (launch D): 100 bids of 100 HYPE at the minimum price from one wallet | **Worked.** Honest bids revert "over cap" (UI says "not enough HYPE", W-02). D settled at the minimum price, 1M sold, whale the only buyer. W-01. |
| Unopenable sealed bid (garbage ciphertext) + selective reveal at `revealEnd - 1` | Keeper `revealAll` flagged it, the launch page showed "2 sealed bids (0.61 HYPE) couldn't be opened". The bidder's own reveal at the last second was accepted. W-03. |
| Bid sealed to a far-future drand round | Unopenable (drand "too early"), stayed sealed, refunded with the 10% penalty (0.001 of 0.01 HYPE). Correct. |
| Dust bid at the minimum tick in an undersubscribed launch (launch B, 1 token) | Settled (not failed), 1e-8 HYPE raised, a v4 pool was created anyway but cannot quote. W-16. No way to profit found. |
| No bids (launch C) | Failed cleanly, tokens back to the creator, page says it didn't fill. |
| Bid at `commitEnd - 1` | Accepted. |
| Bid at exactly `commitEnd`, claim the same bid twice, claim someone else's bid, `claimPrivate` someone else's bid | First run's checks counted a reverted receipt as success (script bug, fixed). Re-checked in `web-auction-rules.mjs`, results below. |
| Revealing before the drand round | `revealAll` revealed 0 and listed all 9 as not yet openable (as designed). |
| Anti-snipe fee right after listing | Not measured: the public trade card lookup timed out in the script. The creator fees card states "0.3%, and more in the first minutes after listing". Open item. |
| Private bid from the private balance, then claim privately | Bid placed in 10.4 s via relay and a one-time wallet. Claim not measured: the script reloaded the page, which locks the account, so the "Your private bids" card wasn't shown. part13 covers the claim in the SDK. |
| Bidding above the top price | Allowed, clamps to the top tick; the card shows the right "pay at most". |
| A 100 HYPE bid (exactly the per-bid cap) | Accepted. |

### Contract rule re-check (`web-auction-rules.mjs`)

Run at 06:45 UTC on Nov 9 (after the coordinator's parallel fixes had started; the auction contracts are the live testnet bytecode on the fork, so those don't change). An undersubscribed launch: honest bids of 400k and 300k tokens at low ticks, a griefer's 250k at tick 30 with a garbage ciphertext, and a bid sealed to a far drand round. Every call checked by receipt status.

| Check | Result |
|---|---|
| commit at `commitEnd - 1` / at `commitEnd` | accepted / refused. Correct. |
| keeper `revealAll` | opened 2, listed the griefer, the far-round bid and a junk commit as unopenable |
| settle at `revealEnd - 2` | refused ("reveal open") |
| griefer's own reveal at `revealEnd - 1` | accepted (W-03) |
| any reveal at exactly `revealEnd` | refused |
| settle at `revealEnd`, then again | accepted, then refused ("settled") |
| outcome | undersubscribed, cleared at the lowest revealed tick (3e-8). The griefer got all 250k tokens at that low price with no penalty; had the price looked bad he would have stayed sealed and paid 10% (0.00775 HYPE). That is the option W-03 describes. |
| never-revealed bid | 90% refund, 10% penalty. Correct. |
| claim, then claim again | first ok, second refused ("claimed"); `claimBatch` of an already claimed id succeeds as a no-op (fine) |
| a stranger claims someone else's bid | allowed, tokens go to the bidder, the stranger only pays gas. By design. |
| `claimPrivate` of someone else's bid | refused ("bidder"). Correct. |
| `claimPrivate` by the bidder | refused "no vault": the auction's private claim uses Cloak v1's vaults, which have no pool for new v4 tokens. On v2, private claims go through `CloakGloamBids` (`finishPending`), so the v1 "Claim privately" path on the launch page should stay hidden on Gloam (it was, because `usePrivateClaim` returned "no"). |

Note on settle gas: a v4 launch's `settle` (pool seeding) needs well over 600k gas; a keeper or wallet with a low fixed gas limit fails silently. Estimate, don't hardcode.

## 5. Rerun

From `e2e-gloam/` (each script starts and stops its own anvil fork, keeper stand-in and Vite; ports 8650-8670, 5200-5215):

```
export PATH=~/.foundry/bin:$PATH NODE_USE_ENV_PROXY=1 NO_PROXY=127.0.0.1,localhost
node stress/web-pages.mjs          # every page, desktop + 390 px, screenshots (about 5 min)
node stress/web-flows.mjs          # shield/send/withdraw/pieces/two tabs/slow RPC/relay down/trade (about 15 min)
node stress/web-links.mjs          # links, locked, shares, take back, requests, receive, proofs (about 15 min)
node stress/web-launch.mjs         # launches + gaming through the UI, real drand (about 15 min)
node stress/web-auction-rules.mjs  # contract boundaries and claims, SDK only (about 3 min)
```

Run them one at a time for honest timings. Results land in `docs/stress/raw/` and screenshots in `docs/stress/shots/`.

Not covered (time): NFT drops (pages only), the slow-RPC / RPC-down / relay-down / wallet-disconnect sections of `web-flows.mjs` (written, the run was stopped before them), Trade edge inputs, the rest of `web-links.mjs` after the form checks.
