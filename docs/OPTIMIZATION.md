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

### K2. The keeper's snapshot rebuilds only while someone uses it
- **Before:** `/snapshot` (launches, markets, stats for the site) was rebuilt every 60 seconds, all day, visitors or not, and every rebuild is a batch of multicalls.
- **Now:** if nobody asked for it in 10 minutes (`SNAPSHOT_IDLE_MS`), it isn't rebuilt. A quiet night costs no snapshot reads.
- The first request after a quiet spell gets the last copy, or the site reads the chain if that copy is older than 5 minutes, as it already does. That request also restarts the rebuilds.

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

## What it costs now (estimates, per open tab)

| | Before | Now |
|---|---|---|
| Private balance refresh (every 8 s) | about 28 full rescans of both vaults, growing daily | 2 incremental reads, about 8 calls each, flat |
| First unlock on a known device | full history of both vaults | new blocks only |
| First unlock on a new device | full history of both vaults | one cached `/leaves` download per vault, then new blocks |
| Full app visit with unlock (Vercel, gzipped) | about 2.0 MB | about 1.0 MB |
| Keeper snapshot at night, no visitors | rebuilt every 60 s | not rebuilt |
| Keeper awake | always (with a ping) or asleep with work stuck (without one) | only while there's work |

The RPC reads in the first three rows go to Elysium's public RPC, not our hosts. They still matter: a busy tab could hit its rate limit, and that showed up as slow syncs and timeouts.

## Not done, worth doing later

- **G1, a CDN in front of the keeper** (from v1's plan): Cloudflare's free proxy with a few seconds of cache on `/snapshot` and `/leaves`. Worth it with real traffic.
- **G2, keeper state that survives restarts:** queued withdrawal pieces live in memory. The site re-sends them when its owner opens it, but a piece can wait until then. A free Upstash Redis would close that.
- **The v1 launch loop on v2's keeper:** on testnet, v1's and v2's keepers both reveal and settle the same factory's launches. That works (the second one finds nothing to do) but doubles those reads. If v2 points at its own factory on mainnet, this goes away. Otherwise give one keeper the launches.
- **`isSpent` per note on every sync:** one multicall today. It could skip notes when no vault event touched them.
