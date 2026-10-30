# The permanent vault (v4)

> **Draft.** The shared vault (one vault for every token) vs one permanent vault per token is still being decided. Nothing here is built or deployed yet.

How Cloak holds private balances from v4 on, and the rules every later upgrade follows. Modelled on Gloam's mainnet
design: one vault, deployed once, with everything that changes kept outside it.

## In plain words

- **One vault holds everything.** Private HYPE, USDC and every launch token sit in one contract, in one shared list of
  notes. A new launch gets a shelf in that vault. It never gets a vault of its own.
- **The vault is never replaced.** Swaps, sealed batches and moves from old versions are done by separate helper
  contracts (the router, the batcher, the migrator). Better helpers are added next to the old ones. Nobody's money moves.
- **Your private account never changes.** It comes from one fixed message you sign, not from any contract address, so
  your `cloak:` address stays the same for good.
- **Rules change in place, slowly.** Fees, limits, the proof checker and the list of helpers live in `CloakConfig`.
  After setup, anything that loosens a rule waits 3 days in public. Tightening (lower a fee, lower a limit) is instant.
- **One list of addresses, on-chain.** `CloakConfig` lists every factory, vault, router, batcher and migrator with the
  block it started. The site, SDK, keeper and MCP read that list. No contract addresses in Vercel or Render.

## What it hides, and what it doesn't

| | Visible on-chain | Hidden |
|---|---|---|
| Shield (deposit) | asset, amount, depositor | which notes it becomes later |
| Private send | that a send happened | **asset**, amount, sender, receiver |
| Private swap | asset in, asset out, amounts (the AMM trade is public) | who swapped |
| Sealed batch order | asset, standard order size | who ordered |
| Withdraw | asset, amount, recipient | who withdrew |

A send hides **which token** moved. That is new: with one vault per token, a send in the SHADE vault told everyone it
was SHADE.

A swap or withdrawal still shows the asset, because the tokens leave the vault in public. Selling SHADE from the vault
hides you among everyone holding private SHADE notes, the same as before. The crowd for a sell is the number of SHADE
notes, not the whole vault. Growing that crowd is the job of sealed batches and of more people holding launches
privately.

## The circuit

`circuits/src/transaction.circom`, 2 notes in, 2 notes out, Merkle depth 20 with epochs (as today).

```
pubKey     = Poseidon(privKey)
commitment = Poseidon(amount, pubKey, blinding, asset)     // asset = uint160 token address
signature  = Poseidon(privKey, commitment, leafIndex)
nullifier  = Poseidon(commitment, leafIndex, signature)
```

- Every note in one transaction has the same private `asset`.
- Value: `sum(in) + publicAmount == sum(out)`, amounts range-checked to 128 bits, asset to 160 bits.
- Public inputs, in order: `root, publicAmount, extDataHash, publicAsset, inputNullifier[2], outputCommitment[2]`.
- **Asset binding:** `publicAmount * (asset - publicAsset) === 0`. Whenever value enters or leaves (deposit,
  withdrawal, relayer fee), the asset is the public one. A transfer with no value in or out hides it.

The vault requires `publicAsset == 0` when `extAmount == 0 && fee == 0` (a hidden send), and a listed asset otherwise.

## Contracts

| Contract | Replaceable? | Holds funds? | Role |
|---|---|---|---|
| `CloakConfig` | no | no | Rules (verifier, fees, limits, cap exemptions), the approved-asset list, launch factories, the address registry. Setup, then 3-day timelock. |
| `CloakVault` | **no** | **yes** | The one vault: one tree, every asset. `transact`, `depositTo`, `collectFees`. No admin function moves funds. |
| `PrivateRouter` | yes, added alongside | no | Shield HYPE, private swaps through a launch's `CloakPair`, withdraw as native HYPE. |
| `PrivateBatcher` | yes, added alongside | only open orders | Sealed standard-size orders, crossed at mid. |
| `CloakMigrator` | yes | no | Moves balances from v1, v2 and v3 vaults into `CloakVault` in one transaction. |
| `CloakFactory` | yes, added alongside | no (auctions do) | Launches. A new factory is added to the config's factory list. |

### CloakVault

- Assets are **listed**, never delisted (delisting could trap funds):
  - `listLaunch(factory, index)`: anyone, for a launch from a factory registered in `CloakConfig` that settled with a pool.
  - `listAsset(token)`: anyone, for a token the config approved (WHYPE and USDC at deploy; more through the timelock).
- Per asset: `deposited[token]`, `feesOwed[token]`. Invariant: `balanceOf(vault) >= deposited + feesOwed` per token.
- Deposit limits: `config.limitOf(token)`, as today. Cap-exempt callers (router, batcher, migrator) skip them.
- Events: `NewCommitment`, `NewNullifier`, `Deposited(asset, amount)`, `Withdrawn(asset, amount)`, `FeesCollected`.

### Registry in CloakConfig

- `addLaunchFactory(factory)`: launches from it can be listed in the vault. v1, v2 and v3 factories are added at deploy,
  so old launches keep trading.
- `approveAsset(token)`: a non-launch token may be listed.
- `register(kind, addr)` with `kind` in `vault, router, batcher, migrator, factory`: the newest entry of each kind is
  the current one, and every entry keeps its start block for history.
- All three loosen rules, so after setup they go through `queueChange` and wait 3 days. A registered router could
  receive withdrawals that users' clients build for it, which is why registering one is never instant.

## Keys

EIP-712, domain `{ name: "Cloak", version: "4", chainId }` with no `verifyingContract`. The signed purpose names the
site. One signature per wallet per chain, forever. Older keys (v1 plain message, v2 and v3 bound to their routers) are
only derived to move old balances.

Memos carry the asset: the encrypted output holds `(amount, blinding, asset, keyIndex)`, and router-made notes start
`0x03 || amount(16) || asset(20) || encrypted(blinding, keyIndex)`.

## Relayer fees

- Swaps, withdrawals, batch orders and moves pay the relayer in the asset being spent, as today.
- **Private sends are free and sponsored by the relayer.** A fee would be value leaving the transaction, which reveals
  the asset. The keeper rate-limits them per IP and per day. Later: pay the relayer with a private note instead.

## Moving off v1, v2 and v3

One last move. Portfolio finds balances in every older vault (one signature per older version) and moves each into the
vault through `CloakMigrator`, sent by the relayer. Old contracts keep working, so nothing is stranded if someone never
comes back.

## Rules for every later upgrade

1. The vault is never redeployed. A circuit change that changes the public inputs is the only thing that could force it,
   and the circuit is fixed by the trusted-setup ceremony. A new verifier for the same inputs goes in through the
   config timelock.
2. New factories, routers and batchers are added next to the old ones. Old ones keep working.
3. Addresses come from the config registry, never from env vars.
4. Every release is checked as a returning user: saved browser data, an old balance and an old `cloak:` address, on the
   live site.
5. Every release is rehearsed on a fork of the live chain first.
