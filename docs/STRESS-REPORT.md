# Cloak v2 stress test: report (Nov 9)

Three testers worked overnight, in parallel:
1. **Contracts:** attacked every Cloak escrow and the launch vault.
2. **Off-chain:** the relay, keeper, SDK and agent tools, under load and with hostile input.
3. **Website:** every page in a browser, desktop and phone, plus full launches and auctions, trying to game them.

Everything ran on local chains and forks of Elysium testnet, never live funds. I then fixed what they found. The details are in `docs/stress/contracts.md`, `offchain.md` and `web.md`. Each finding has a script or test that reproduces it.

## Bottom line

- **Nobody found a way to take money that isn't theirs.** That covers every escrow, the launch vault, receive boxes and bid accounts.
- **Two bugs could lose a user's notes, and both are fixed.** A relayed transaction could land while the app was told it failed, or its memo could be refused afterwards. The new notes were then gone for good.
- **The rest were griefing, sandwiching, money with no exit, budget races and confusing messages.** Almost all are fixed.
- **One High needs a decision from you (W-01):** the deposit cap on launches.
- **The fixed contracts are live on testnet:** the escrows were redeployed. The vaults didn't move, so no balance moved.
- **Tests:**
  - forge: 156 Gloam-side and 91 v4, every stress PoC turned into a regression test;
  - end to end: parts 1, 3b, 5, 7, 9, 10, 11, 14, 15 and 16;
  - the real site in a browser on a fork of the updated testnet (123 s).

## How long things take (4 cores, real proofs, through the relay)

| Action | Typical | Notes |
|---|---|---|
| Shield | 0.4 to 0.7 s (SDK), about 7 s in the browser | one wallet transaction |
| Private send | 1.4 s (SDK), 6.7 s (browser) | plus the payee's sweep, about 1.3 s |
| Withdraw | 1.9 s (SDK), 8.6 s (browser) | |
| Instant private buy | 3.9 s | |
| Batch order (2 orders) / payout | 5.6 s / 0.9 s | payout on the next open |
| Payment link make / claim | about 1.6 s / 1.9 s | |
| Withdraw in 3 pieces | 7.5 s to plan, then the keeper sends them | |
| Prove funds | 3.1 s | |
| Private sealed bid | 2.3 s (SDK), 10.4 s (browser) | |
| Create a launch (site) | 15.6 s | |
| First unlock and sync | 3 to 9 s | was getting slower as the chain grew; fixed (see below) |

Proofs are about half of each action, and the rest is RPC. On Elysium, add about one block per relayed transaction.

## What was fixed

**Funds safety (off-chain)**
- **O-01 and O-02 (High), notes lost when an answer was lost or a memo was refused.** Fix:
  - new notes are registered before anything is sent, and kept on the device as nonces only (useless without the account's signature);
  - a lost answer is checked against the vault;
  - memos are best effort with a retry queue;
  - a shield posts its own memo from the wallet if the relay refuses.

  Now the same device always keeps its notes, and other devices see them once the memo goes out.

**Contracts (redeployed on testnet)**
- **C-01, griefing a batch round.** A push around the first order could void every round. Rounds are now also checked against a time-weighted reference that one transaction can't move.
- **C-02, sandwiching settle.** At settle the pool must be within 0.5% of the round's average (was 2%), which caps the damage at about that.
- **C-03, stuck money.** An order whose spend was sent alone, and no longer fits, becomes refund-only.
- **C-04 and C-05, payouts over the vault's caps.** Payouts can come back as several notes (`claimMany`), or through an owner-signed exit.
- **C-06, no exit from receive boxes.** Receive boxes get an owner-signed sweep, for tokens no vault takes, NFTs, and HYPE over a full cap.
- **C-07, orders paid from outside the vault.** Orders and graduation entries must be real notes, at least 1e12 wei.
- **C-09 to C-13, smaller items:**
  - bids are placed at a fixed amount, so 1 wei can't block them;
  - exit signatures work once;
  - stray HYPE is refused;
  - a zero fallback and a zero refund window are refused.

**Relay and keeper**
- **O-03:** the client IP now comes from the trusted proxy hop. Set `TRUSTED_PROXY_HOPS` (1 behind Render, 0 with nothing in front).
- **O-04:** a spend is locked before any await.
- **O-05:** budgets are held at check time, so calls arriving together can't all pass.
- **O-06:** no relay-chosen nonce, and 503 instead of "malformed request" for our own errors.
- **O-07:** a round is forgotten only once the chain shows it settled or cancelled.
- **O-10 and O-15:** scheduled pieces count against their requester, a 429 means wait, and the queue uses the chain's clock.

**SDK and agent tools**
- **O-08:** a flood of dust payments can't stop an account seeing its balance (failed sweeps don't fail sync, at most 5 per sync).
- **O-13:** the candidate list is capped.
- **O-14 (part):** spent flags are read at once.
- **O-09 to O-12:** spending limits are re-checked inside the queue, reads and dry runs send nothing, and extra decimals and dead-end addresses are refused.

**Website**
- **W-02:** a full sale says so, instead of "not enough HYPE".
- **W-04:** shield and "max" respect what the vault takes in one deposit.
- **W-05:** addresses are checked before proving, with a clear message for v1 addresses.
- **W-06 and W-07:** dead-end withdrawals are refused by name, and the hint isn't repeated.
- **W-09:** the launch page on Gloam shows the launch vault's status, not v1's "Enable private trading".
- **W-13:** negative amounts are refused.

**Found while fixing**
- **Log chunk size.** The site and agent tools read vault logs in 5,000-block chunks. Elysium makes about 860,000 blocks a day, so the first sync was getting slower every day: the browser test had started timing out. They now read 1,000,000 blocks per call, which the public RPC answers in under a second.
- **Batch order sizes.** The SDK now keeps batch orders above the new minimum size.

## Live on Elysium testnet now

The escrows were redeployed with the fixes (`deployments/elysium-testnet-gloam.json`; the old addresses are kept under `previous`):

| Contract | Address |
|---|---|
| CloakGloamBatcherV4 | `0x2681a81fdfbb447a297ac5fd5bba0a2ffc599f54` (5 launches registered) |
| CloakGloamBids | `0xe07d0f72c07f2f18e8d4089a857361b282128c5d` |
| CloakGloamReceive | `0x8ef40f47cf991acd7ee7f4c77c505c909b9367a8` |
| CloakGraduation | `0x8bb5a381f31e2114838cc3dcd876a2ae0775f98d` |

Receive addresses are new with this factory. Nobody used the old ones, since v2 isn't hosted yet.

## Needs your decision

1. **W-01 (High): one wallet can fill a launch's deposit cap** (10,000 HYPE in 100 HYPE bids) and buy the whole sale at the minimum price. It's the same as v1's CL-03, which was accepted because the caps are temporary. Options:
   - count only the cost of revealed bids against the cap;
   - add a per-bidder cap (sybils get around it);
   - lift the caps after the audit, as planned.
2. **W-03: selective reveal of an unopenable sealed bid.** Confirmed in a real run. The launch page now shows these bids. Raising the launch penalty floor (10% today) is your call, and EIP-2537 on Elysium (a question for Kinetiq) would close it.
3. **W-08: no upper limit on the reveal window.** The create form allows 190 years. Cap it in the form, and in the next factory, at for example 7 days.

## Still open (small)

All of these, plus the hosting checks, are in `CHECK.md` as a checklist to run once v2 is hosted.

- **W-10 (unconfirmed):** twice, the account wouldn't unlock again after a reload in the middle of a withdrawal. No funds were affected. Worth a manual check.
- **W-11 and W-12:** link creation over your balance hangs on "Checking your balance". Dust links are accepted.
- **W-14 to W-19:** cosmetic. The chart spills into the sidebar, the default bid price shows 18 digits, a dust pool gives no reason, there's no sync progress text, decimals messages differ, and the claim and pay pages log errors when opened without a link.
- **O-14 (rest):** the vault tree is still re-read on every sync. Fine today, worth caching later.
- **O-16:** `part13-bids.mjs` uses a 40-second reveal window, which the SDK now refuses. It needs updating to 5 minutes, which makes it a real-time run.
- **C-14:** a launch can be admitted to the launch vault before the pauser blocks it. That's by design.
- **v1:** the two patches in `docs/patches/` (minimum reveal window, batcher band) still need applying to Cloak v1.

## Rerun

```
cd contracts-gloam && ~/.foundry/bin/forge test --offline
cd contracts-v4 && ~/.foundry/bin/forge test --offline
cd e2e-gloam && node stress/stress-lostnote.mjs
cd e2e-gloam && node stress/stress-relay.mjs
cd e2e-gloam && node stress/stress-mcp.mjs
cd e2e-gloam && NODE_USE_ENV_PROXY=1 NO_PROXY=127.0.0.1,localhost node part8-site.mjs
```
The full list of commands is in each report under `docs/stress/`.
