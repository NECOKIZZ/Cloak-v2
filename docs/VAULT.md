# Permanent vaults (v4)

How Cloak holds private balances from v4 on, and the rules every later upgrade follows.

## In plain words

- **Every asset has one private vault, made once and kept for good.** Private HYPE, USDC and each launch token sit in
  their own vault. The vaults are made by `CloakVaults`, which is never replaced.
- **Helpers come and go, vaults stay.** Swaps, sealed batches and moves from old versions are done by separate helper
  contracts (the router, the batcher, the migrator). A better helper is added next to the old one. Nobody's money moves.
- **Your private account never changes.** It comes from one fixed message you sign, not from any contract address, so
  your `cloak:` address stays the same for good.
- **Winners can claim privately.** A sealed-bid winner can claim tokens straight into the vault, so every launch starts
  with its winners already hidden.
- **Rules change in place, slowly.** Fees, limits, the proof checker and the list of helpers live in `CloakConfig`.
  After setup, anything that loosens a rule waits 3 days in public. Tightening (lower a fee, lower a limit) is instant.
- **One list of addresses, on-chain.** `CloakConfig` lists every factory, vault list, router, batcher and migrator with
  the block it started. The site, SDK, keeper and MCP read that list.

## Why one vault per asset, not one shared vault

We weighed Gloam's design (one vault for every asset) and chose one vault per asset for now:

- **Same privacy for trades.** Buys and sells go through a public market, so the token shows either way. Selling SHADE
  hides you among everyone holding private SHADE, whichever design.
- **A shared vault would hide which token a private send moved.** That is its one privacy gain.
- **But anyone can launch a token.** In a shared vault, a bug that let one asset's notes count as another's would let a
  worthless new token drain HYPE and USDC. With one vault per asset, a token's vault can never touch another's.
- **Gradual upgrades.** A newer vault design can serve new launches while older tokens keep their vaults.
- **No new circuit before mainnet.** The circuit we have still needs its review and ceremony.

A shared vault stays an option for later. It needs a new circuit, so it has to be decided before a ceremony.

## Contracts

| Contract | Replaceable? | Holds funds? | Role |
|---|---|---|---|
| `CloakConfig` | no | no | Rules, launch factories, approved assets, the address registry. Setup, then 3-day timelock. |
| `CloakVaults` | **no** | no | Makes and lists the permanent vaults: `createPool(factory, index)`, `createAssetPool(token)`. |
| `ShieldedPool` (one per asset) | **no** | **yes** | The vaults. Same contract and circuit as before. No function moves funds without a proof. |
| `PrivateRouter` | yes, added alongside | no | Shield HYPE, private swaps through each launch's `CloakPair`, withdraw as native HYPE. Reads vaults from `CloakVaults`. |
| `PrivateBatcher` | yes, added alongside | only open orders | Sealed standard-size orders, crossed at mid. |
| `CloakMigrator` | yes | no | Moves balances from every earlier deployment (v1, v2 and v3 vaults, v2's USDC vault) into the permanent vaults. |
| `CloakFactory` | yes, added alongside | no (auctions do) | Launches. Its auctions offer `claimPrivate`. |

### CloakVaults

- `createPool(factory, index)`: anyone, for a launch from a factory registered in `CloakConfig` that settled with a pool.
  v1, v2 and v3 factories are registered too, so every older launch gets a permanent vault.
- `createAssetPool(token)`: anyone, for a token `CloakConfig` approved (WHYPE and USDC at deploy).
- `poolOf`, `pairOf`, `isPool`, `tokens`: the list. Vaults are never removed, so nothing can be trapped.

### Registry in CloakConfig

- `addLaunchFactory(factory)`, `approveAsset(token)`, `register(kind, addr)`. Kinds: `vaults`, `router`, `batcher`,
  `migrator`, `factory`. The newest entry of each kind is the current one (`current(kind)`), and every entry keeps its
  start block.
- All three loosen rules, so after setup they go through `queueChange` and wait 3 days. A registered router receives the
  withdrawals users' apps build for it, which is why registering one is never instant.
- `removeLaunchFactory` tightens (no new listings), so it is instant.

### Private claims

`CloakAuction.claimPrivate(id, pubKey, blinding, memo)`: only the bidder. The tokens go into the token's vault as a note
for a one-time key; the HYPE refund (if any) still goes to the bidder. The vault must exist, so the keeper creates it at
settlement. Deposit limits apply as for any deposit.

## Keys

EIP-712, domain `{ name: "Cloak", version: "4", chainId }` with no `verifyingContract`. One signature per wallet per
chain, forever. Older keys (v1 plain message, v2 and v3 bound to their routers) are only derived to move old balances.

## Moving off v1, v2 and v3

One last move. Portfolio finds balances in every older vault (one signature per older version) and moves each into its
permanent vault through `CloakMigrator`, sent by the relayer. Old contracts keep working, so nothing is stranded if
someone never comes back.

## Rules for every later upgrade

1. Vaults are never redeployed. A new verifier for the same circuit goes in through the config timelock.
2. New factories, routers and batchers are added next to the old ones. Old ones keep working.
3. Addresses come from the config registry, never from env vars.
4. Every release is checked as a returning user: saved browser data, an old balance and an old `cloak:` address, on the
   live site.
5. Every release is rehearsed on a fork of the live chain first.
