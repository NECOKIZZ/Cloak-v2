# Cloak audit scope

This document is the scope for an external security audit of Cloak. It is written for auditors preparing a quote and
then doing the review. Everything listed here is source-verified on the Elysium testnet explorer and has a Foundry
test suite in the repository.

- **Repository:** https://github.com/NECOKIZZ/Cloak
- **Commit to audit:** `255dc4c5319e5cd12f05caf4433906eb795449fa` (Nov 6, 2026). This is the last commit that changed
  `contracts/`, `contracts-v4/` or `circuits/`. Later commits only touch the app, docs and tooling. If we change any
  in-scope file before the audit starts, we will send a new commit hash and a diff.
- **Chain:** Elysium (Hyperliquid's EVM L2 by Kinetiq). Testnet chain id `99801`, mainnet chain id `99901`.
  About 300 ms blocks, Shanghai/Cancun EVM, native gas token HYPE.
- **Contact:** DM [@cloakonelysium](https://x.com/cloakonelysium) on X, or a private advisory on GitHub.

## 1. What Cloak is

Cloak is a privacy layer and a fair-launch platform for Elysium.

1. **Sealed-bid token launches.** Bidders commit a hash plus a drand-timelocked copy of their bid, with an
   over-collateralised HYPE deposit. After bidding closes the bids are opened, a single uniform clearing price is
   found, a market is opened at exactly that price, and the LP is locked forever (or burned). Every winner pays one
   price and the rest is refunded.
2. **Private balances.** Shielded pools in the style of Tornado Nova: notes are Poseidon commitments in a Merkle tree,
   spent with Groth16 proofs (2 inputs, 2 outputs). There is one permanent pool per asset (HYPE as WHYPE, USDC, older
   launch tokens) and one shared multi-asset vault for every newer launch token.
3. **Private trading.** A relayer submits proofs, so the trader's wallet never appears. Instant swaps go through a
   router, and batch rounds (standard order sizes, crossed at a time-weighted price, only the net hits the pool) hide
   trade size too.
4. **Sealed NFT drops.** The same sealed-bid auction for new collections, for NFTs that already exist (escrow), and
   for whitelist spots of partner collections.
5. **Uniswap v4 launches.** A Cloak hook opens each launch's v4 pool at the clearing price, owns the only liquidity
   position forever, pays trading fees to the creator, and charges a decaying anti-snipe fee.

More background, written for readers rather than auditors: `docs/HOW-IT-WORKS.md`, `docs/DESIGN.md`, `docs/VAULT.md`,
`docs/PRIVACY-LAYER.md` and `docs/RULES.md`.

## 2. In scope

### 2.1 Smart contracts (about 4,430 nSLOC, excluding the generated verifiers)

nSLOC counts non-blank, non-comment lines. All contracts are in Solidity, with no external libraries apart from the
vendored Uniswap v4 code listed in 3.

**A. Rules, registry and launches**, `contracts/src/` (solc 0.8.24, Shanghai, via-IR, 200 runs)

| File | nSLOC | What it does |
|---|---:|---|
| `CloakConfig.sol` | 310 | The protocol's rules (proof verifier, fees, deposit caps) and the registry of every vault, router, batcher, migrator and factory. Governance is "setup, then timelock" (see 5). |
| `CloakFactory.sol` | 105 | Creates launches: token, auction and vesting. The creator share is capped at 20% and vests over at least 30 days. |
| `CloakAuction.sol` | 430 | Sealed-bid, uniform-price auction: commit, reveal, settle, claim. Pull payments. Checks the drand round on chain. Can bid from a private balance through one-time bid wallets. |
| `CloakToken.sol` | 49 | Fixed-supply ERC-20. No owner, mint, tax or blacklist. |
| `CloakVesting.sol` | 51 | Linear vesting for the creator share, plus its deployer. No owner. |
| `CloakSeeder.sol` | 88 | Opens a settled launch's market at the clearing price: a Uniswap V2 pool behind `CloakV2Market`, or a `CloakPair` as the fallback. Handles donated and pre-synced pools. |
| `CloakPair.sol` | 133 | A minimal constant-product AMM (native HYPE and one ERC-20, 0.3% fee) with a cumulative price. |
| `CloakV2Market.sol` | 128 | Adapter that gives a Uniswap V2 pool the `CloakPair` interface, including a TWAP in Cloak's units. |
| `CloakFeeLocker.sol` | 86 | Holds Uniswap V2 LP forever and pays only the fee growth (√k growth) to the creator. |

**B. Private balances and trading**, `contracts/src/shielded/` (solc 0.8.24)

| File | nSLOC | What it does |
|---|---:|---|
| `MerkleTreeWithHistory.sol` | 84 | Append-only Poseidon trees (depth 20). A new epoch starts when a tree fills, and every root stays valid. |
| `ShieldedPool.sol` | 178 | Private balances for one ERC-20: `transact` (2-in, 2-out), deposit and withdraw, withdrawal fee, deposit caps. |
| `CloakVaults.sol` | 59 | The permanent list of pools, one per asset. Anyone can open a pool for a settled launch or an approved asset. No owner. |
| `SharedVault.sol` | 245 | One tree for many launch tokens (note = Poseidon(amount, pubKey, blinding, asset)). Per-token accounting, plus private sends that hide which token moved. |
| `PrivateRouter.sol` | 134 | Private buys and sells between pools through each launch's market. Instructions are bound into `extDataHash`. |
| `SharedRouter.sol` | 117 | Buy, sell and send for SharedVault tokens. The relayer fee is paid from the HYPE pool in the same transaction. |
| `PrivateBatcher.sol` | 243 | Batch rounds for pool tokens: standard sizes, a TWAP crossing price clamped to the opening price ± slippage, a net swap, refunds. |
| `SharedBatcher.sol` | 268 | The same batch rounds for SharedVault tokens. |
| `CloakMigrator.sol` | 63 | Moves a private balance from an earlier deployment's pools into the current ones in one transaction. |
| `CloakFactoryList.sol` | 38 | Read-only view of earlier factories as one list. |
| `WHYPE.sol` | 50 | Wrapped HYPE (WETH9 behaviour). |
| `interfaces/IHasher.sol`, `interfaces/IVerifier.sol` | 16 | Interfaces. |
| `Verifier.sol`, `VerifierMA.sol` | (generated) | Groth16 verifiers exported by snarkjs. In scope only to confirm they match the circuits and the verifying keys, not for a line-by-line review. |

The Poseidon hashers (2, 3 and 4 inputs) are deployed from circomlibjs `poseidonContract` bytecode. In scope: check
that the deployed bytecode matches circomlibjs and that the parameters match the circuits' Poseidon.

**C. NFT drops**, `contracts/src/` (solc 0.8.24)

| File | nSLOC | What it does |
|---|---:|---|
| `CloakDrop.sol` | 543 | One NFT collection and its sealed sale: a GTD phase (Merkle list), sealed bids, WL boost, a uniform price, a tie lottery seeded by every bid's salt, and an ERC-721. Includes `CloakDropFactory`. |
| `CloakEscrowDrop.sol` | 518 | A sealed auction of NFTs that already exist. The owner's tokens are escrowed at creation, with a fair rotation for assigning items, and unsold items return. Includes `CloakEscrowDropFactory`. |
| `CloakSpotBook.sol` | 86 | Whitelist spot sales on top of drops: winning bidders name the wallets to whitelist until a deadline. |

**D. Uniswap v4 launches**, `contracts-v4/src/` (solc 0.8.26, Cancun, via-IR)

| File | nSLOC | What it does |
|---|---:|---|
| `CloakV4Hook.sol` | 283 | The launch factory's seeder and the pools' hook. It opens a native-HYPE/token pool at the clearing price with one full-range position, refuses any other liquidity, pays fees to the creator, charges an anti-snipe dynamic fee, and keeps a TWAP accumulator. |
| `CloakV4Market.sol` | 134 | Adapter that gives a v4 pool the `CloakPair` interface for the router and batchers. |

### 2.2 Zero-knowledge circuits (about 200 lines of circom 2, circomlib 2.0.5)

| File | What it does |
|---|---|
| `circuits/src/transaction.circom` | `Transaction(levels, nIns, nOuts)`: notes are Poseidon(amount, pubKey, blinding), nullifiers are Poseidon(privKey, commitment, leafIndex), with Merkle membership, 128-bit range checks and value conservation (`sum in + publicAmount = sum out`). |
| `circuits/src/transaction2x2.circom` | Main component (depth 20, 2 inputs, 2 outputs). Public: root, publicAmount, extDataHash, inputNullifier[2], outputCommitment[2]. Used by every `ShieldedPool`. |
| `circuits/src/transactionMA.circom` | The multi-asset variant: an `asset` field in every note, one asset per proof, and `publicAsset` that is either the asset or 0 (a hidden-token send with no value leaving). |
| `circuits/src/transactionMA2x2.circom` | Main component for `SharedVault` (8 public signals). |
| `circuits/src/merkleproof.circom` | Merkle path check, which must match `MerkleTreeWithHistory` and the SDK tree. |

What we want checked: under-constrained signals, value conservation, field overflow and aliasing (amounts, the
`publicAmount` field encoding, a negative `extAmount`), nullifier uniqueness and binding, the `extDataHash` binding,
the cross-asset rule in the MA circuit (including the `publicAsset = 0` case), the dummy-input handling for zero
amounts, and consistency with the Solidity verifiers and contracts.

### 2.3 Deployment, roles and configuration

- The `CloakConfig` lifecycle: what the owner can do during setup, `endSetup()`, the queue, execute and cancel
  timelock (`CHANGE_DELAY` 3 days, `CHANGE_GRACE` 14 days), "tighten at once, loosen through the timelock",
  `transferOwnership` and `acceptOwnership`, and the hard ceilings (`MAX_WITHDRAW_FEE_BPS` 1%,
  `MAX_LAUNCH_FEE_BPS` 3%).
- The deploy script `e2e/deploy-mainnet.mjs` (read-only review): order, wiring, cap exemptions, registry entries and
  parameters (rounds of 30 s, slippage 2%, refund after 600 s, minimum order 1e12 wei).
- **The verifier swap after the ceremony.** `ShieldedPool` reads the verifier from `CloakConfig` (changeable through
  the timelock). `SharedVault` takes its verifier as an immutable at construction, so the MA circuit's final keys must
  exist before the mainnet `SharedVault` is deployed. Please review both paths and tell us if you see a better one.
- The current testnet deployment (addresses in 9) as a reference. It is still in setup, with a single-wallet owner.

### 2.4 Optional, quoted separately

Please price these as a separate line. We may add them.

| Component | Path | Size | Focus |
|---|---|---|---|
| SDK private client | `packages/sdk/src/private/` (`crypto.ts`, `tx.ts`, `tree.ts`, `client.ts`, `shared.ts`, `links.ts`) | ~2,260 lines TS | Key derivation from an EIP-712 wallet signature, one-time keys, memo encryption (x25519), note scanning, input selection, building `extData` and proofs, payment-link keys. |
| Keeper and relayer | `services/keeper/index.mjs` | ~670 lines JS | Bid reveal (drand decryption), settlement, batch settlement, the relayer's fee floor, the nullifier in-flight lock, simulation before sending. The relayer is trusted only for liveness. |
| Trusted setup tooling | `circuits/build/setup.sh` and the ceremony plan | small | Review of the phase 2 ceremony process before we run it publicly. |

## 3. Out of scope

- **Vendored Uniswap code**, copied unchanged and pinned in `contracts-v4/lib/README.md`:
  - v4-core `bea7f6d1`
  - v4-periphery `LiquidityAmounts.sol` `c6e4754d`
  - solmate `Owned.sol`

  On mainnet Cloak uses Uniswap's own PoolManager. The integration (hook permissions, the unlock callback, delta
  settlement, fee handling) is in scope.
- **Uniswap V2 core** on Elysium, used as is.
- **circomlib's templates** (Poseidon, comparators, bitify) and snarkjs itself. Their use is in scope.
- **The drand network and tlock encryption.** The on-chain round check is in scope.
- `forge-std`, test files, mocks, and the scripts in `e2e/` apart from `deploy-mainnet.mjs`.
- The web app (`apps/web`), the MCP server (`packages/mcp`), the public read-only SDK modules, and the hosting
  (Vercel, Render).
- Earlier deployments (v1 to v3). They stay on chain only so balances can leave, through `CloakMigrator`, which is in
  scope.

## 4. Trust model and actors

| Actor | Trusted for | Must not be able to |
|---|---|---|
| User (note owner) | Their own keys | Spend someone else's note, double-spend, take more than their notes hold, or move value across assets |
| Relayer | Liveness only | Steal, change the recipient, amount, swap, minimum out or output note, or replay a proof. It can refuse or delay. |
| Keeper | Liveness only (revealing bids, settling auctions and batch rounds) | Choose a clearing price, skip valid bids to favour someone, or settle a round at a manipulated price |
| `CloakConfig` owner (a multisig on mainnet) | Rules within hard ceilings, behind a 3-day timelock after setup | Move user funds, raise fees above the ceilings, or change a rule without the timelock once setup ends |
| Launch creator | Their launch's parameters | Dump on buyers (vesting), withdraw the locked LP, or block settlement or refunds |
| Drop creator | Their drop's parameters | Take bidders' deposits beyond the clearing price, or keep escrowed NFTs after selling them |
| Anyone | Calling permissionless functions (reveal, settle, claim, open vault, admit, collect fees) | Profit from the order of calls or grief others |

There is no proxy, no upgradeability and no admin withdrawal anywhere. A vault is never removed. Routers, batchers
and migrators can be replaced, and the registry is append-only, with the newest entry winning.

## 5. Key invariants we want broken

**Private balances**

1. `token.balanceOf(pool) >= deposited + feesOwed` for every `ShieldedPool`. For `SharedVault`, per token:
   `balanceOf(X) >= deposited[X] + feesOwed[X]`.
2. A note can be spent once. A nullifier can never be reused, including across tree epochs.
3. No proof can withdraw token X from `SharedVault` beyond what was deposited as X, and value never moves between assets.
4. Every field a relayer submits is bound by the proof (`extDataHash`), including `ExtData.data` that routers,
   batchers and the migrator act on.
5. Withdrawals are never capped or blocked by configuration. Only deposits have caps.
6. A full Merkle tree never blocks a deposit or a withdrawal, and old roots stay valid.

**Trading**

7. A private swap delivers at least `minOut` to a note only the trader controls, or reverts.
8. A batch round's crossing price stays within `maxSlippageBps` (at most 2%) of the price when the round opened. The
   net swap fills no worse than that band, or the round refunds. A round settles only after one full round from its
   first order. Every order is paid exactly once, or refunded exactly once.
9. Routers and batchers hold no funds between calls, apart from open batch orders.

**Launches and drops**

10. Every winner pays the same clearing price. Every bidder gets back everything above what they owe. Withheld bids
    pay the minimum penalty.
11. The market opens at exactly the clearing price, whatever anyone donated to or synced in the pool beforehand.
12. Locked LP never shrinks. `CloakFeeLocker` and `CloakV4Hook` pay only fees, never principal, and nobody else can
    add liquidity to a Cloak v4 pool.
13. A drop never sells more than its supply. The tie lottery and the escrow rotation could not be known or steered
    before the bids opened. An escrowed NFT ends up with exactly one winner, or back with the owner.

**Governance**

14. After `endSetup()`, any loosening change waits at least `CHANGE_DELAY`, expires after `CHANGE_GRACE`, and fees
    never exceed their ceilings.

## 6. Areas of concern (where we would look first)

- **Price manipulation in batch rounds.** TWAP from `CloakPair`, `CloakV2Market` (UQ112x112 converted) and the hook's
  accumulator. Also short and quiet rounds, multi-block manipulation on 300 ms blocks, and the net swap's `minOut`.
  The Nov 6 KupiaSec finding here is fixed (see 7). Please review the fix.
- **Seeding at the clearing price.** Donations, pre-created and synced V2 pools, and the self-call with a fixed gas
  budget and its fallback to `CloakPair`.
- **The v4 hook.** Permission bits from the address, `beforeAddLiquidity` refusing everyone but the hook, the
  dynamic fee override, delta accounting in the unlock callback, native-HYPE settlement, and fee collection.
- **The circuits.** Every constraint, especially the MA circuit's hidden-asset path.
- **Accounting with fees.** Withdrawal fees on swaps and batch orders, dust, rounding, and `MAX_EXT_AMOUNT` /
  `MAX_FEE` bounds.
- **Payment out.** Native HYPE sent with a gas cap and a WHYPE fallback, pull payments in auctions and drops, and
  callbacks into ERC-721 receivers.
- **Reentrancy** across router → pair/market → pool → batcher, and in the hook's callback.
- **drand round checks** and reveal deadlines in auctions and drops.

## 7. Known issues and earlier reviews

- **Development trusted setup (accepted until the ceremony).** The proving keys come from a single-party setup
  (`circuits/build/setup.sh`). A public multi-party ceremony is planned before deposit caps come off. Please don't
  report this as a finding. Do comment on the ceremony plan if you take 2.4.
- **Deposit caps** stay on until the audit and the ceremony are done.
- **The testnet owner is a single wallet, still in setup.** This is intentional on testnet. On mainnet it is a
  multisig followed by `endSetup()`.
- **Privacy limits by design.** Deposits and withdrawals are public. AMM trades show size and direction (the trader
  stays hidden). Batch rounds show counts of standard sizes and the net. Timing analysis is a user concern (see the
  tips in the app).
- **Review history** is in `SECURITY.md`: the Oct 25 internal review (all fixed, regression tests in
  `contracts/test/V2.t.sol`) and the Nov 6 external report (High, batch crossing price, fixed and redeployed, with
  tests in `PrivateBatcher.t.sol` and `SharedVault.t.sol`).

## 8. Building and testing

```bash
git clone https://github.com/NECOKIZZ/Cloak && cd Cloak
git checkout 255dc4c5319e5cd12f05caf4433906eb795449fa

# core, shielded and drops (solc 0.8.24)
cd contracts && forge build && forge test

# Uniswap v4 hook and market (solc 0.8.26)
cd ../contracts-v4 && forge build && forge test
FOUNDRY_PROFILE=uniswap forge build   # the PoolManager, built like Uniswap's

# circuits: compiled artifacts are in apps/web/public/circuits, and the SDK pins their sha256
cd ../circuits && npm i   # circom2 0.2.23, circomlib 2.0.5
```

- About 200 Foundry tests, including fuzz tests and break-it suites (`CloakDropBreak.t.sol`, `V2.t.sol`).
- The Foundry tests use `test/mocks/MockVerifier.sol` for proofs, so the contract logic can be tested in isolation.
  `contracts/test/fixtures` holds the real Poseidon bytecode. Real Groth16 proofs against the real verifiers run in
  the end-to-end suites below.
- `contracts-v4/test/CloakV4Mainnet.t.sol` runs against a fork of Elysium mainnet's Uniswap v4 deployment
  (`MAINNET_RPC=https://rpc-live.elysp.com forge test --match-contract CloakV4Mainnet`).
- End-to-end suites on a local chain: `node e2e/run.mjs` (see `e2e/`).

## 9. Deployed contracts (Elysium testnet, v4)

Every address below is source-verified at https://elysium.kinetiq.xyz/testnet-explorer. The full record is in
`deployments/elysium-testnet-v4.json`.

| Contract | Address |
|---|---|
| CloakConfig | `0x9fdf166f0671166148ea98cdd3ef0118d256167f` |
| Groth16Verifier (pools) | `0xA554AC0150E853DEAC5214cFf9F5001Ad2f441ED` |
| Groth16VerifierMA (shared vault) | `0x41ad3218e820f9ccf64dda0492a700218440381d` |
| Poseidon2 / Poseidon3 / Poseidon4 | `0x80d9d0b2bdd42a77d083235662925f2907392723` / `0xc36ae84e30a13c9463e00f350ee5e507f5f45564` / `0xbe88b7f6fe46d048434bee14bedccc1b118fac77` |
| CloakVaults | `0x24bc1d369aab3a2d741a48f8cac1af5dfd9f3d43` |
| HYPE pool (ShieldedPool, WHYPE) | `0x3ACB22829bb422446caaDd8546e65ab530A53031` |
| USDC pool (ShieldedPool) | `0x3d5cB722490D9908a118f8B3151f83fcE943E4F0` |
| WHYPE | `0xe44b27113D4b947c0B1bDf4a93878D0e115f4bdD` |
| PrivateRouter | `0x343ab9a7aac93cee28321410510ea24417cc6386` |
| PrivateBatcher | `0x54a503b0683af40aa3427b99292018f4d045d43f` |
| SharedVault | `0x0cE2EcB0195E07899377e3D7B01e927aB3f87610` |
| SharedRouter | `0xe2A0769A5aCBD987c1B6725247c56187A112dC7E` |
| SharedBatcher | `0x11598b35fabc90fdd45d8a77ac41e2057c32ea14` |
| CloakMigrator | `0x86c5d8035224493f10938aaa07b179be316dadf4` |
| CloakFactory (v4 launches) | `0x1b0072684e98d9e23018e2d107ed8166ef84c077` |
| CloakV4Hook (also the factory's seeder) | `0xcDC11340C5ce0b3dCbD9A5e8f7838E8A8bBaaA80` |
| PoolManager (testnet copy of v4-core) | `0x51027076df8416e42ea8438b27a0c433d9662e68` |
| CloakFeeLocker | `0x3b74062a72b16f9a221d63515518a635414501d8` |
| CloakDropFactory | `0x2afb7d9a5baa02a2d72a7c761521fc66dce9d783` |
| CloakEscrowDropFactory | `0x5f3efbfd5d15440947abfbfce7f2fcfffff71079` |
| CloakSpotBook | `0x91806d96814cc205d4b642e280023a1c7b361fc8` |

Per-launch contracts (auction, token, vesting, market) and per-drop contracts are created by the factories and are
verified too.

## 10. What we would like back

- **Findings**, each with a severity (Critical, High, Medium, Low, Informational), a description, the impact, a proof
  of concept (a Foundry test is ideal) and a recommended fix.
- **A fix review** of our patches, with the final report naming the commit it covers.
- **A public report** we can link from `SECURITY.md` and the site.
- **With your quote:** methodology, team and days per area (contracts, circuits, optional items), the earliest start
  date, the timeline to a first report, and a fixed price, with the optional items in 2.4 priced separately.
