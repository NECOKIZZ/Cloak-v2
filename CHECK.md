# Checks to run by hand once v2 is hosted

For Bob, on gloak.boblabs.tech with the v2 keeper on Render. Tick each one off. Where something is wrong, note what you saw and when. Details are in `docs/STRESS-REPORT.md`, `docs/stress/web.md` and `docs/OPTIMIZATION.md`.

## 1. Hosting setup

- [ ] Render: the service comes from `render.yaml` (a Blueprint), on the free plan. `KEEPER_PK` is set in the dashboard, not in the repo.
- [ ] Render env: `TRUSTED_PROXY_HOPS=1` and `CORS_ORIGINS` including `https://gloak.boblabs.tech`.
- [ ] Vercel: `VITE_KEEPER_URL` and `VITE_RELAYER_URL` both point at the v2 keeper's address.
- [ ] Open `<keeper>/health`. It shows the keeper's address, `awake.selfUrl: true`, and `awake.why` (empty when nothing is pending).

## 2. Free-plan behaviour (the optimization pass)

- [ ] **The keeper sleeps when idle.** Leave the site closed for 30 minutes with nothing pending. Render's dashboard should show the service spun down.
- [ ] **A visit wakes it.** Open the site. The keeper status may say offline for up to a minute, then online.
- [ ] **It stays awake with work.** Schedule a withdrawal in pieces with the last piece an hour away, then close the site. The keeper should stay up (Render logs show a `/health` request every 10 minutes) and send each piece on time.
- [ ] **Unlock on a new device or browser** is quick: the balance shows after one download from the keeper (`/leaves`), not a long "Syncing".
- [ ] **Reload on the same device** shows the balance at once, then refreshes it.
- [ ] **Bandwidth after one day:**
  - Render's metrics for the keeper: expect well under v1's 70 MB an hour, and near zero overnight.
  - Vercel's usage: the unlock download is about 1 MB now (the 1.4 MB hashing file is gone).

## 3. Every feature once, timed

Time each one on a phone and on a desktop. The overnight test's numbers are in `docs/STRESS-REPORT.md` (shield about 7 s, send about 7 s, withdraw about 9 s, private bid about 10 s).

- [ ] Shield HYPE, then USDC.
- [ ] Private send to a `cloak:` address. The payee sees it after their next sync.
- [ ] Withdraw to a wallet, and withdraw in pieces over time.
- [ ] Instant private buy and sell of a launch token.
- [ ] Batch order. It settles within a few rounds and the payout arrives.
- [ ] Payment link and payment request: make, open, claim (as a guest too).
- [ ] Receive address: pay it from an outside wallet, and it moves into the private balance while the page is open.
- [ ] Prove funds.
- [ ] Create a launch, bid privately from the private balance, watch the reveal and settlement, claim.
- [ ] The MCP agent tools against the hosted keeper (balance, send, a payment link).

## 4. Open items from the stress test

**Needs your decision:**
- [ ] **W-01 (High):** one wallet can fill a launch's whole deposit cap with minimum-price bids. Choose: count only revealed bids, a per-bidder cap, or lift caps after the audit.
- [ ] **W-03:** a sealed bid nobody can open (see the note at the end). Decide whether to raise the 10% no-reveal penalty floor.
- [ ] **W-08:** no upper limit on the reveal window (the form takes 190 years). Suggested cap: 7 days.

**To check by hand:**
- [ ] **W-10 (unconfirmed):** reload the page while a withdrawal says "Proving…", then connect the wallet again. It should unlock. Twice in testing it didn't within 90 s. No funds were affected either time.
- [ ] **W-11:** make a payment link for more than your private balance. It should say so, not hang on "Checking your balance".
- [ ] **W-12:** a dust link (1e-17 HYPE in 3 shares) is accepted. It should be refused below a minimum share.
- [ ] **W-14:** the launch page's price chart line runs into the sidebar on desktop.
- [ ] **W-15:** the bid card's default max price shows 18 digits when the tick size isn't round.
- [ ] **W-16:** a launch that sold almost nothing has a pool that can't quote. Buy is disabled with no reason given.
- [ ] **W-17:** the first unlock shows no sync progress text. Check whether it's still slow after the optimization pass.
- [ ] **W-18:** 19 decimals of HYPE give "Enter an amount above zero" on Shield, but "at most 18 decimal places" on Links. The messages should match.
- [ ] **W-19:** opening `/claim` or `/pay` without a link logs an error in the browser console. The page itself is fine.

**For the code (not a hosted check):**
- [ ] **O-16:** `e2e-gloam/part13-bids.mjs` uses a 40-second reveal window, which the 5-minute minimum now refuses. It needs updating.
- [ ] **O-14 (rest):** spent flags are read for every note on each sync. Cheap today; worth caching later.
- [ ] **Cloak v1:** apply `docs/patches/v1-min-reveal-window.patch` and `docs/patches/v1-batcher-band-and-deadline.patch`.
- [ ] **C-14 (by design):** a launch can be admitted to the launch vault before the pauser blocks it.

## How a bidder can seal a bid nobody can open (W-03)

- **How a sealed bid normally works:**
  - The bidder's app encrypts the bid (price and amount) to a future drand round. drand is a public randomness beacon that publishes a key every few seconds.
  - Nobody can decrypt it before that round.
  - On chain, the bid is stored as a ciphertext plus a commitment (a hash of the bid and a secret).
  - When the round passes, the keeper decrypts every ciphertext with the beacon's key and reveals the bids for the bidders. A reveal is checked against the commitment, so nobody can change a bid.
- **The gap:** the contract can't check, when the bid is placed, that the ciphertext actually decrypts to the committed bid.
  - That check needs BLS12-381 pairing math on chain (precompile EIP-2537), and Elysium hasn't confirmed it has it.
  - So a bidder with their own script, not our app, can post a valid commitment next to garbage ciphertext.
  - When the round passes, the keeper can't open it. Only the bidder, who knows the real bid and secret, can reveal it.
- **Why it matters:** that bidder waits until everyone else's bids are revealed, then decides whether to reveal theirs. If revealing helps them, they reveal before the window closes. If not, they skip it and lose the no-reveal penalty (10% of their deposit at least, up to 50% if the creator set it).
- **What limits it today:**
  - The penalty prices the option.
  - The launch page shows these bids during the reveal window ("N sealed bids can't be opened by the beacon"), from the keeper's `/unopenable`.
  - In an undersubscribed launch, an honest low bid lowers the price for everyone anyway, so withholding gains little there.
- **What would close it:**
  - If Elysium has EIP-2537, a reveal can carry the drand signature and the contract can verify that the ciphertext opens to the commitment. A bid that doesn't open could then never be revealed, so the option disappears. This is a question for Kinetiq.
  - Until then, a higher penalty floor (for example 25%, as drops already use) makes the option more expensive.
