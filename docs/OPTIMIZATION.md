# Cloak v2: optimization for free hosting (Vercel + Render)

Nov 9. Builds on Cloak v1's `OPTIMIZATION.md` (Nov 7). The v1 items already in this code are K1 (launch lists re-read only on a count change, a slower loop when idle), R1 (fee collection every two days), ETags with 304s on `/snapshot` and `/leaves`, hidden tabs not polling, and the keeper build filter. This pass adds the items below. Each one has a test.

**Free plan limits, as we understand them:**
- Render: about 100 GB outbound a month, 750 instance hours, and a stop after 15 minutes with no incoming request.
- Vercel Hobby: 100 GB transfer and 1M requests a month.

v1 measured that Render's bandwidth is mostly **the keeper's own RPC reads**, not visitors. Vercel's was mostly **the 1.4 MB hashing library**, downloaded again after every deploy.

## Done in this pass

### S1. Private balances read only new blocks (the biggest one)
- **Before:** every sync called Gloam's `syncTree`, which reads three events over the vault's **whole history** and hashes every leaf again. Elysium makes about 860,000 blocks a day, so this cost grew every day: a month-old vault means about 26 calls per event per vault.
- **Now:** `GloamTree` (`packages/sdk/src/core/gloamTree.ts`) keeps the tree between syncs and reads only new blocks.
  - A batch is accepted only if it brings the tree to the vault's own leaf count (`nextIndex`) at that block. A node answering from behind can't leave a gap: the batch is read again. After three misses in a row, the tree is rebuilt from the start.
  - Paths come from the same Gloam tree code, so proofs are unchanged.
- **Measured (part 17):** a sync with nothing new costs 1 block-number call, 4 log reads and 3 calls. That stays flat as the chain grows.

### S2. One sync per refresh, not one per asset
- **Before:** the site asked for each asset's balance at once (HYPE, every launch token, USDC), and `GloamPrivate.balance()` ran a full sync of both vaults for each one. With 12 launches, that was about **28 full rescans every 8 seconds**, per open tab.
- **Now:** `syncFresh()` shares one running sync, and reuses one that finished in the last 2 seconds. Twelve reads at once cost one sync (part 17).

### S3. Reloads and new devices skip the history
- **Reload:** the sync state (tree, notes, memo position) is saved on the device, sealed with the account's key as before, and restored on unlock. Only new blocks are read.
  - A saved state from another account is refused.
  - A saved note whose amount was changed is dropped, since its commitment no longer matches.
  - A saved tree with a wrong leaf is refused (the vault doesn't know its root) and read from the chain instead.
  - The tree isn't saved above 40,000 leaves (browser storage is about 5 MB).
- **New device:** the keeper's `GET /leaves?pool=` now serves the Gloam vaults' public leaf lists, with an ETag and a bodiless 304 when unchanged. A new device starts from that one download, and uses it only if the vault knows its root, so a forged list is refused.
  - The keeper reads the list only when someone asks, at most every 10 seconds, so it adds no background polling.
- **Saves:** the site saves this state when the balance changes, else at most every 2 minutes. Before, it saved on every 8-second sync.

### K2. No keeper snapshot at all
- **Before:** `/snapshot` (launches, markets, stats for the site) was rebuilt every 60 seconds, all day, visitors or not, and every rebuild is a batch of multicalls.
- **Now:** it's gone, with the rest of v1's keeper code (Nov 9). The site reads launches and markets from the chain from v2's factory block, and keeps its own short local cache. The keeper does only v2's work: launches of v2's own factory, the Gloam relay and loop, split withdrawals and the leaf lists.

### H1. Render's 15-minute sleep: awake only while there is work
- A free Render service stops after 15 minutes with no incoming request, and the keeper's loops stop with it.
- v1 used a GitHub Actions ping every 10 minutes. On a private repo that's about 4,300 runs a month, more than the 2,000 free minutes, and it keeps the keeper awake even with nothing to do.
- **Now:** the keeper requests its own public address (`RENDER_EXTERNAL_URL`, which Render sets) every 10 minutes, **only while it has work that can't wait for a visitor**:
  - a launch or drop it's still handling (reveals, settles, claims);
  - an open batch round;
  - a queued withdrawal piece;
  - a watched receive address;
  - a relay in the last 15 minutes.
- With nothing pending it lets Render stop it. The next site visit wakes it (about a minute). `/health` shows `awake.why`.
- **Tested (part 18):** no pings with nothing pending, and pings with a piece queued.
- **Settings:** `KEEP_AWAKE=0` turns it off. `KEEP_AWAKE_URL` points it at another address.

### V4. The hashing library: 1.4 MB less per unlock
- Our SDK had already moved to `poseidon-lite` (v1's V1). What still pulled in circomlibjs (1,386 KB gzipped) was **Gloam's SDK**, which we never edit.
- The site's build now points Gloam's `import("circomlibjs")` at a stand-in on poseidon-lite (`packages/sdk/src/circomlibjsLite.ts`, an alias in `apps/web/vite.config.ts`). The stand-in chunk is 396 KB gzipped and loads only on unlock.
- **Tested:**
  - identical to circomlibjs on more than 6,000 inputs and the field edges, plus the empty tree's 20 levels (`packages/sdk/test/circomlibjs-lite.test.mjs`, in CI);
  - the real site in a browser (part 8): proofs, a withdrawal, a swap, a batch round, links and receive all pass on it.
- The keeper and the MCP tools (Node) keep the real circomlibjs.

### W1. Site timers
- Everything that polls now pauses in hidden tabs and checks once when the tab comes back. That covers the keeper status, the HYPE price, the drop page, unopenable bids, scheduled pieces and receive collection.
- **Changed intervals:**
  - Unopenable bids: every 60 s instead of 20 s, since the list only changes once, when the drand round passes.
  - Receive page incoming check: every 10 s instead of 4 s.
- Scheduled withdrawal pieces are saved only when something changed (before: every 30 s).

### Hosting files
- `render.yaml` is now the v2 keeper's Blueprint (free plan, testnet addresses, `TRUSTED_PROXY_HOPS=1`, CORS for gloak.boblabs.tech, the build filter). The site goes on Vercel, whose `vercel.json` already skips builds that don't touch the site (v1's V2).

### R1. Reads up to the head on a load-balanced RPC (Nov 10, from Cloak v1's keeper notes)
- **The bug:** Elysium's public RPC is several nodes behind one address, a block or two apart. `eth_getLogs` up to the head one node just reported can land on a node that hasn't reached it and is refused ("invalid block range params", shown by viem as "Missing or invalid parameters").
- **Measured on the testnet RPC, Nov 10, 300 tries each:** logs up to the reported head failed 4 times (1.3%); up to 3 blocks back, 0 times. Reading the vault's state at the head block failed 0 times, and the head never went backwards in this sample (v1 saw it twice in 300).
- **Fixed with a fallback, not a fixed lag** (`packages/sdk/src/head.ts`): read to the head; only if a node refuses the range, read again to 3 blocks back. v1's note proposed always reading to head minus 3. That breaks on chains that make blocks only with transactions: the newest 3 blocks stay hidden until more transactions arrive. It broke parts 16, 18 and 19 on the local fork, where a fresh deposit stayed invisible. Elysium itself makes a block every 0.15 to 0.2 s, each with at least 2 system transactions (checked on testnet and mainnet), so there the fallback costs about half a second, and only when it's needed.
- **Where:** the keeper's batch-round reader (`settleRounds`, whose cursor now moves only past what was read), the leaf tree (keeper `/leaves` and every app's sync), the payment-memo reader (its cursor only moves forward), and the one-shot reads (reveals, claims, the bell, drops, NFTs). Those used to fall into a piece-by-piece walk on any error, about 270 calls for the bell's read from block 0. Now they walk in pieces only when the RPC really caps the range.
- **Tests:** 4 unit tests (`packages/sdk/test/head.test.mjs`), and parts 7, 8, 16, 18 and 19 pass.

### R2. `/leaves` ETag that stays put
- **Before:** the ETag hashed the whole JSON, including `block`, which moves on every refresh. So a browser's `If-None-Match` almost never matched.
- **Now:** it hashes each vault's address, leaf count and last leaf. The list is append-only and checked against the vault's count, so that names the list exactly. Measured locally: the same ETag across refreshes, and a repeat request gets a 304 with no body.
- **Not done: v1's `x-leaves-block` header.** Not needed. A browser holding a 304'd copy has an older `block`, and that is still right: no leaf came after it, and the app reads the chain from there. A header would also need CORS exposure for nothing.

### R3. Awake through time-only deadlines (H1, checked)
- **A launch in bidding counts:** the keeper records it in its pending list before waiting for bidding to close, so `awake.why` shows "launches" through bidding, the drand round, the reveal window and settling. Drops count in their GTD and bidding phases too. A failed launch still ends as `settled`, so it can't hold the keeper awake forever.
- **The claim delay doesn't apply any more:** the keeper no longer pushes claims (`PUSH_CLAIMS` off), so a settled launch is done once the fee is collected.
- **Batch rounds:** count from the first order the loop reads.
- **Fixed:** `/health` showed `awake.why` as of the last self-ping, up to 10 minutes old (empty for the first 10 minutes). It's now computed on every `/health`.
- **Bob to check on Render** (it can't be seen from here): during a launch's bidding, Render's logs should show no `==> Running 'node services/keeper/index.mjs'` restart lines. If they do, Render isn't counting the self-request as incoming traffic, and we fall back to cron-job.org pinging `/health` every 12 minutes, as v1 is doing.

### R4. What v2's keeper sends (measured Nov 10)
- **How:** run locally against testnet with a throwaway key, with `fetch` wrapped to add up request bodies plus about 350 bytes of headers each. It counts outbound only, which is what Render bills per v1's note.
- **Startup:** about 370 KB in the first 30 s (140 requests: every launch, the 16 shared drops, both leaf lists).
- **Then, with nothing pending:** about **1.3 MB an hour**. That's about 0.95 GB a month even if it never slept, against 5 GB. With nothing pending, Render lets it sleep anyway.
- **Not done: raising `IDLE_MS`** (v1's option). At 1.3 MB an hour it isn't needed, and a longer idle wait would delay the first reveal or settle after bidding closes.
- **Render workspace:** the plan already puts v2's keeper on its own Render account (Stage 2), so it doesn't share v1's 5 GB.
- **Open, for Bob:** v2's keeper also runs the NFT drop factories shared with v1. If v1's keeper runs them too, both read and race on the same drops. One of them should own drops.
- **v1's on-demand snapshot advice** (build a public JSON only when asked): v2 has no keeper-built JSON besides `/leaves`, which already works that way (read only when asked, at most every 10 s).

## What it costs now (estimates, per open tab)

| | Before | Now |
|---|---|---|
| Private balance refresh (every 8 s) | about 28 full rescans of both vaults, growing daily | 2 incremental reads, about 8 calls each, flat |
| First unlock on a known device | full history of both vaults | new blocks only |
| First unlock on a new device | full history of both vaults | one cached `/leaves` download per vault, then new blocks |
| Full app visit with unlock (Vercel, gzipped) | about 2.0 MB | about 1.0 MB |
| Keeper snapshot at night, no visitors | rebuilt every 60 s | no snapshot |
| Keeper awake | always (with a ping) or asleep with work stuck (without one) | only while there's work |

The RPC reads in the first three rows go to Elysium's public RPC, not our hosts. They still matter: a busy tab could hit its rate limit, and that showed up as slow syncs and timeouts.

## Not done, worth doing later

- **G1, a CDN in front of the keeper** (from v1's plan): Cloudflare's free proxy with a few seconds of cache on `/leaves`. Worth it with real traffic.
- **G2, keeper state that survives restarts:** queued withdrawal pieces live in memory. The site re-sends them when its owner opens it, but a piece can wait until then. A free Upstash Redis would close that.
- **`isSpent` per note on every sync:** one multicall today. It could skip notes when no vault event touched them.
