# Uniswap v4 and tokenized stocks on Elysium

Status (Nov 3): **3.2, launches on v4 with a Cloak hook, is live on testnet**, and private trading of v4 launches works through the existing router (3.1 turned out not to need its own contract: `CloakV4Market` gives a v4 pool the interface the router already trades). Testnet addresses: PoolManager `0x51027076df8416e42ea8438b27a0c433d9662e68` (Uniswap's build, byte-identical to mainnet's apart from its own address), CloakV4Hook `0xcdc11340c5ce0b3dcbd9a5e8f7838e8a8bbaaa80`, launch factory `0x1b0072684e98d9e23018e2d107ed8166ef84c077`. Source in `contracts-v4/`. On mainnet the same hook and factory deploy against Uniswap's own PoolManager (`POOL_MANAGER=0xe2e1…23f1 node e2e/deploy-v4pools.mjs`).

## 1. What is on chain today

### Uniswap v4
v4 pools are live on testnet, but not as one official Uniswap deployment. A scan for v4's `Initialize` event over the
last 3M blocks found **17 different PoolManagers** with **1,200 pools** between them, each owned by a different team.

| PoolManager | Pools | Native HYPE held | Notes |
|---|---|---|---|
| `0x0088bea218c283a939c93d7db8353cd87cdcf647` | 330 | ~1,475 | all against native HYPE, one hook |
| `0xffce5ec7281ef884b53aed8f6669040a8679a225` | 110 | ~245 | HYPE and USDC pairs, two hooks |
| `0x0a47f680e4123a9d77946de9efa710d18d7aa782` | 323 | ~10 | HYPE and tUSD pairs |
| `0x889a96eedb1df35a012d7e48baf7f9c780f1243b` | 339 | ~0.1 | mostly WHYPE pairs |
| `0x83e9b995352fef9d32140c8f00c62473f65614a1` | 30 | n/a | the `elyq` stock-named launchpad |

KyberSwap's integration ([kyberswap-dex-lib#1857](https://github.com/KyberNetwork/kyberswap-dex-lib/pull/1857)) treats
Elysium v4 as an ElysPump fork with its own PoolManager and Quoter. Crypto Briefing reports that "no official Uniswap
Labs support has been announced", with v4 "upcoming" for testnet and mainnet on Nov 9. **None of the 17 is confirmed
as the official Uniswap deployment.** Their owners can set protocol fees, and their pools run hooks we haven't read.

### Official Uniswap v4 (verified Nov 3, on chain 99901)
ElysPump's Launchpad v3 publishes the official Uniswap v4 contracts. They are on **chain 99901, Elysium mainnet**,
not on chain 99801 (Elysium's public testnet, where Cloak runs): none of these addresses has code on 99801.

What 99901 is (Nov 3):
- **Elysium mainnet, not yet public.** Kinetiq's intake form gives 99901 as mainnet (LI.FI's integration), and dRPC's
  integration notes Conduit has deployed chain 99901 with **parent chain 999, HyperEVM mainnet** (99801's parent is
  998, HyperEVM testnet). Mainnet opens to the public on **Nov 9**. Its official RPC
  (`rpc-elysium-mainnet.t.conduit.xyz`) still returns 403.
- **On chain:** block 1 on Oct 19, about 296k blocks, ~1.1 s per block so far (99801: block 1 Sep 11, ~22.4M blocks,
  ~0.09 s). We read it through ElysPump's own relay (`rpc-live.elysp.com`, client `elyspump-live/inbox-relay`), which
  gives partners early access before the public RPC opens. Treat that relay as ElysPump's, not Kinetiq's.
- **So Cloak was never on the wrong testnet.** 99801 is the only public Elysium testnet. The official Uniswap v4 is
  simply a mainnet deployment, and the v4 copies on 99801 are other teams' test deployments.

| Contract | Address | Checked on chain |
|---|---|---|
| PoolManager | `0xe2e105d3f7209a9da11f83ccf3e7398a753823f1` | 24,009 B, **byte-identical to Uniswap's Ethereum PoolManager** apart from its own address. Holds ~669 HYPE. |
| Universal Router | `0x1b341fdd55d56f8e08409a2c25ddfad93eb03c1a` | 23,233 B, `poolManager()` = the PoolManager |
| V4 Quoter | `0x379f556c5a748bd7cc9baf0f7a344094ac1814f5` | 6,118 B, `poolManager()` = the PoolManager |
| StateView | `0x27ed73ae0652fdcf71d6793412a7525f32be9dfe` | 3,531 B, `poolManager()` = the PoolManager |
| PositionManager | `0x1d1c51b9d07fd27d36412a2b66cc23d19eb3e518` | 19,965 B, `poolManager()` = the PoolManager |
| ElysPump Launchpad v3 hook + factory | `0xbacf71bf02b8cfe171853c5ec4a060ba2ac1e0cc` | 22,083 B, `poolManager()` = the PoolManager. Hook flags: beforeInitialize, beforeSwap, afterSwap, beforeSwapReturnDelta, afterSwapReturnDelta |

**Owner:** the PoolManager's `owner()` is `0x2179a60856e37dfeaaca0ab043b931fe224b27b6`, an ordinary wallet (32 transactions). On
Ethereum, Base, Arbitrum and Unichain, Uniswap governance owns the PoolManager instead. Uniswap often deploys from its own
wallet and hands ownership to governance later; we couldn't confirm this wallet is Uniswap's. The owner can only turn
on protocol fees (capped in the contract), never move pool funds.

**What it means for us:** the official v4 is a mainnet deployment, so there is no official v4 to test against on
testnet. v4 work gets tested on a local fork of 99901 (reading mainnet state, spending nothing), then ships with
Cloak's mainnet deploy.

### Tokenized stocks
No Synthra sSTOCK token showed up. Synthra only mentions sSTOCKs as a pair asset on its own launchpad, with nothing yet
tying them to Elysium. Every stock-named token in a v4 pool is a test or launchpad token:

| Token | What it is |
|---|---|
| `elyqAAPL`, `elyqNVDA`, `elyqTSLA`, `elyqSPY`, `elyqQQQ`, `elyqGOOGL` | Launchpad tokens with 1T supply, ~99.98% still in the pool. No link to real shares. |
| `wNVDA` (`0x4ea1…5b2d`, "Wrapped NVDAx, testnet mock") | ~1,096 in a v4 pool |
| `mNVDAx` (`0xa7cd…6a51`, "Mock NVIDIA xStock, no value") | ~997 in a v4 pool |
| `AAPLX`, `tSTOCK` | test tokens |

Real stock liquidity can only be judged on mainnet. Re-scan once Synthra's contract addresses are public.

## 2. What v4 changes for Cloak

- **One PoolManager holds every pool**, and a trade settles only the net amount at the end. Multi-hop routes are cheap.
- **Native HYPE.** Pools trade HYPE directly, which fits our HYPE vault with no wrapping.
- **Hooks.** A pool can run its own code before and after every swap and liquidity change.

## 3. Plan

The official v4 addresses are now known (above, chain 99901). Before shipping anything on them, test rigorously: a
fork of 99901 with the real PoolManager, Universal Router and Quoter, then live runs. Then:

### 3.1 Private router through v4 (first)
- A v4 adapter: spend a note, swap through the PoolManager (`unlock` callback), deposit the output as a new note. The
  swap details stay bound by the proof, as on V2.
- **Allowlist only.** The router accepts approved PoolManagers and approved hooks (a hook can block or skim a swap),
  set through `CloakConfig` with the usual timelock. Never an arbitrary pool.
- Native HYPE pairs go straight from the HYPE vault, with no WHYPE step.
- New contract next to the vaults. No vault or circuit change.

### 3.2 Launches on v4 with a Cloak hook (the big one)
Settlement opens a v4 pool whose hook is ours:
- **Creator fee in the hook**, taken per swap, instead of locking LP in `CloakFeeLocker`.
- **Anti-snipe right after listing:** for the first blocks, cap trade size or charge a decaying fee.
- **Private opening:** for a short window, only the batcher can trade, so the first trades are batch-crossed and
  hidden.
- **Price feed for batch rounds** from the hook's own observations.
- The factory takes a pool type (V2 default, V4 with hook). Hook addresses need the right permission bits, so the hook
  is mined to an address with CREATE2.
- Needs its own tests, a fork rehearsal against the real PoolManager, and an audit before the caps lift.

### 3.3 Private stock trading
Once a real stock token has real liquidity:
- **Check the token first:** allowlist or blocklist on transfers (a blocked vault would trap balances), pause or freeze
  powers, rebasing or dividend mechanics, decimals, and how far a normal-size trade moves the price.
- Only plain, freely transferable tokens can go in a vault. The shared vault already takes any token, so this is
  mostly the checks plus a route (3.1).
- Pitch: "buy NVDA on Elysium without anyone seeing your position."

## 4. Open questions
- The official mainnet RPC and explorer, once Kinetiq publishes them (expected at the Nov 9 launch).
- Does Uniswap publish these addresses itself, and when does PoolManager ownership move to governance?
- Synthra's sSTOCK contract addresses, and how they are backed (custody, oracle, synthetic).
- Do any stock tokens restrict who can hold them? If so, they stay out of the vaults.

Sources: [kyberswap-dex-lib#1857](https://github.com/KyberNetwork/kyberswap-dex-lib/pull/1857),
[Crypto Briefing](https://cryptobriefing.com/uniswap-coming-to-elysium-hype-chain/),
[ElysPump swap](https://swap.elysp.com/), [Synthra on X](https://x.com/synthra_finance), and the on-chain scan above.
