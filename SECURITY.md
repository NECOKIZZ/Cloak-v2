# Security

Cloak v2 runs on Elysium **testnet** (chain `99801`) on top of Gloam's shielded vault. It is beta software. Gloam's
vault has its own audit (Kann). **Cloak's own contracts around it are not externally audited yet.** Mainnet opens with
deposit caps that stay on until an external audit of Cloak's contracts is done.

Cloak v1 (its own vaults and circuits) lives in its own repository with its own `SECURITY.md` and review history.

## Reporting a vulnerability

Please report it privately. Don't open a public issue until a fix ships.

- **Where:** DM [@cloakonelysium](https://x.com/cloakonelysium) on X, or a private security advisory on this repository.
- **What helps:** the affected contract, page or endpoint, exact steps or a proof of concept (a forge test or a local
  anvil run is ideal), and the impact you saw.
- **In scope:** `contracts/src` (launches), `contracts-gloam/src` (the launch vault and escrows), `contracts-v4/src`
  (the v4 hook and market), the SDK, the keeper and relay, and the site.
- **Out of scope here:** Gloam's own vault, circuits and keys (`vendor/gloam`). Report those to Gloam.
- **Please don't** degrade the service for others, touch other people's funds or notes, or use social engineering.
- **What to expect:** a reply within 3 days, updates as we fix it, and credit once it ships if you'd like.

## What nobody can do

- **No Cloak function moves user funds.** A note leaves a vault only with its owner's zero-knowledge proof, made with
  Gloam's circuits. Auction money only goes to bidders, the creator and the fee recipient.
- **Nothing expires.** Won tokens, refunds and a creator's raise wait in the auction until their owner takes them.
- **The relay can't steal from, alter or redirect a transaction.** Every field is bound by the proof, and each escrow
  address is made from the whole action. It can only refuse or delay one.
- **The launch vault's owner is Gloam's `VaultOwnerGuard`.** Its launch pauser can only stop new admissions.
- **`CloakConfig` holds the launch rules** (launch fee, bid caps). Loosening one waits a public 3-day timelock once setup
  ends. Tightening one is instant.

## Review log

**Nov 6, 2026, KupiaSec (external report, on v1's batcher).** In a quiet round the average price could cover only a
few seconds, so a price held that long could set the crossing price. v2's batchers (`CloakGloamBatcher`,
`CloakGloamBatcherV4`) were written after the report with the fix built in:

- a round settles only once its average covers **a full round** from its first order (`settleOpens`);
- the average must also sit within the slippage bound of a **time-weighted price from before the round**, so pinning
  the opening spot doesn't help;
- the pool must be within **0.5%** of the average when the net trades, and the net trade within the impact cap, or the
  round is refunded rather than crossed at a band's edge.

Tests in `contracts-gloam/test/CloakGloamBatcher.t.sol`: `test_the_average_always_covers_a_whole_round`,
`test_a_push_in_the_first_orders_block_doesnt_pin_the_price`, `test_a_push_in_the_settling_transaction_doesnt_set_the_price`,
`test_a_big_move_held_through_the_round_is_refunded` and `test_a_small_move_held_through_the_round_sets_the_price`.
v1's batchers got the matching fix in v1's repository.

**Nov 7 and 8, 2026, two outside reviews.** Every finding fixed or decided, finding by finding, in
[`docs/REVIEW-RESPONSES.md`](docs/REVIEW-RESPONSES.md).

**Nov 9, 2026, stress test.** Contract and relay findings and their fixes in [`docs/STRESS-REPORT.md`](docs/STRESS-REPORT.md).

## Audit scope for mainnet

Cloak's code only (Gloam's vault and circuits are audited separately). Counted without comments, tests or interfaces:

| Part | Contracts | Lines |
|---|---|---|
| Launches | CloakConfig, CloakFactory, CloakAuction, CloakToken, CloakVesting | about 950 |
| Uniswap v4 | CloakV4Hook, CloakV4Market | about 420 |
| On Gloam's vault | CloakLaunchVault (our one addition to Gloam's vault code), CloakLaunchSwap base and V4, CloakRouterV4 (buys and sells between the two vaults), CloakGloamBatcher base and V4, CloakGloamBids, CloakGloamReceive, CloakFundsGate, CloakReceiptCheck | about 1,700 |
| Deployment and roles | `deploy-v2-factory.mjs`, `deploy-partner.mjs`, the guard, pauser and Safe handover | included |
| **Total** | | **about 3,070** |

Not shipped to mainnet, so not in scope: the Uniswap V2 path (`CloakPair`, `CloakSeeder`, `CloakV2Market`,
`CloakFeeLocker`, `CloakV2PairSwap`), `CloakGraduation` (launch tokens stay in the launch vault), NFT drops, and
`TestToken`.
