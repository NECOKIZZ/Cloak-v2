# Security

Cloak runs on Elysium **testnet** (chain `99801`). It is beta software. Nothing has been externally audited yet. An external audit and a public trusted-setup ceremony are planned around mainnet (Nov 9), and deposit caps stay on until both are done.

## Reporting a vulnerability

Please report it privately. Don't open a public issue until a fix ships.

- **Where:** DM [@cloakonelysium](https://x.com/cloakonelysium) on X, or open a [private security advisory](https://github.com/NECOKIZZ/cloak/security/advisories/new) on GitHub.
- **What helps:**
  - the affected contract, page or endpoint
  - exact steps or a proof of concept (a forge test or a local anvil run is ideal)
  - the impact you saw
- **In scope:** the contracts in `contracts/`, the circuit in `circuits/`, the SDK, the keeper and relayer, and the site at cloak.boblabs.tech.
- **Please don't:**
  - degrade the service for others
  - touch other people's funds or notes
  - use social engineering
- **What to expect:** we aim to reply within 3 days, keep you updated, and credit you once it's fixed if you'd like that.

## What nobody can do

- **No function in any Cloak contract moves user funds.** Notes leave a vault only with their owner's zero-knowledge proof. Auction money only goes to bidders, the creator and the fee recipient.
- **The relayer can't steal from, alter or redirect a transaction.** The proof binds every field. It can only refuse or delay one.
- **`CloakConfig` holds the rules:** fees (with hard caps of 1% on withdrawals and 3% on launches), deposit caps and the proof verifier.
  - After `endSetup()`, loosening a rule waits a public **3-day** timelock. Tightening one is instant.
  - On testnet, setup is still open and the owner is a single wallet. Before mainnet, ownership moves to a multisig and setup ends.

## Review log

The current testnet deployment is v4: the v2 contracts below (config, auctions, vaults, router, batchers, migrator) carried forward, plus the shared launch-token vault with its router and batcher, Uniswap v4 launches through `CloakV4Hook`, and sealed NFT drops. Every contract is source-verified on the explorer.

**Nov 7, 2026, independent AI-assisted review (Haider Ali, @haiderali_eth).** Nine findings plus three in testnet-only code, all reproduced in Foundry. None let anyone take bidder deposits or private balances. Fixed in the contracts that ship to mainnet, with regression tests named after each finding. Testnet contracts deployed before Nov 7 keep the old behaviour.

| Severity (theirs) | Finding | Outcome |
|---|---|---|
| Medium | CL-01: the NFT drop tie lottery came only from the salts of opened bids, so someone holding several sealed bids could choose which to open and steer the draw | Fixed: the draw also uses the hash of the block after settlement, which nobody knows while bids can still be opened (`CloakDrop`, and the same for `CloakEscrowDrop`'s rotation, A-3) |
| Medium | CL-02: in an undersubscribed launch a dust bid at the minimum price sets the price for everyone | By design (uniform-price rule, documented in RULES.md). Creators set the minimum they accept |
| Medium | CL-03: one well-funded actor can fill a launch's deposit cap | Accepted: needs the full cap (10,000 HYPE) locked per launch, and the caps are temporary until the audit and ceremony |
| Medium-Low | CL-04: a creator can shill their own drop with bids they keep sealed | Mitigated: a sealed bid now loses 25% (was 10%) on drops and escrow drops |
| Low-Medium | CL-05: anyone could open a per-token vault for a Uniswap launch before it was admitted to the shared vault, locking it out for good | Fixed: `CloakVaults.createPool` refuses launches that opened on Uniswap |
| Low-Medium | CL-06: one huge batch order made the whole round refund, less the vault fee | Fixed: each side of a round is capped at 4% of the pool's depth, so the round always settles (both batchers) |
| Low-Medium | CL-07: a WL spot sale's naming deadline could be one second after bidding closed | Fixed: winners always get at least one day |
| Low | CL-08: `PrivateRouter` refused HYPE paid out by a Uniswap v4 market | Fixed: it accepts HYPE during its own swap (only reachable through CL-05, also fixed) |
| Low | CL-09: a note owner could withdraw as a "relayer fee" to themselves and skip the withdrawal fee | Fixed: a relayer's fee pays the same protocol fee (`ShieldedPool`, `SharedVault`) |
| Low (testnet only) | A-1: a large synced WHYPE donation pushes a V2-path launch onto a `CloakPair` | Documented: the market still opens at the clearing price; mainnet launches use the v4 hook |
| Low-Medium (testnet only) | A-2: a collection returning a dirty `ownerOf` word could brick escrow claims | Fixed: the whole word is compared, so the winner is refunded instead |

**Nov 6, 2026, external report (KupiaSec).** Fixed in both batchers, with regression tests in `contracts/test/PrivateBatcher.t.sol` and `contracts/test/SharedVault.t.sol`. The live batchers were replaced the same day (`0x54a5…d43f` and `0x1159…ea14`).

| Severity | Finding | Fix |
|---|---|---|
| High | In a quiet round the average price could cover only a few seconds, so a price held that long could set the crossing price and move value between the two sides of the batch | The crossing price stays within the slippage bound (2%) of the price when the round opened, the net swap fills no worse than that band or the round refunds, and a round settles only once its average covers one full round |

**Oct 25, 2026, internal review (v1 → v2).** Every finding is fixed in v2 and has a regression test in `contracts/test/V2.t.sol`.

| Severity | Finding | Fix in v2 |
|---|---|---|
| Critical (mainnet gate) | Proving keys from a development setup | Open: public multi-party ceremony before mainnet. The new verifier goes in through `CloakConfig`. |
| High | A creator that can't receive HYPE could block settlement and every refund | Pull payments: proceeds and fees are credited, then withdrawn separately |
| High | Batch rounds crossed at a spot price a settler could move inside a 25% band | Rounds cross at the pair's time-weighted price; the band is capped at 2% |
| High | A full Merkle tree would have blocked every withdrawal | A new tree starts when one fills, and old roots stay valid |
| High | The relayer accepted unpaid calls, and an unshield recipient could burn its gas | Fee floor on every relayed call; HYPE is sent with a gas cap and a WHYPE fallback |
| Medium | A nearly balanced batch round couldn't settle | Dust is kept with the crossed side, plus a minimum order size |
| Medium | Sealed bids could be withheld for free, and the timelock round wasn't checked | A 10% minimum penalty, and an on-chain drand round check |
| Medium | Keys derived from a plain signed message | EIP-712 signature bound to the chain and router, plus a check that the wallet signs the same way each time |
| Medium | Creator share had no cap or vesting | At most 20% of the supply, vesting over at least 30 days |
| Medium | No caps or fees | `CloakConfig`: beta caps and fees behind a timelock |
| Medium | Duplicate relays of the same spend | Per-nullifier in-flight lock, and a spent check before simulating |
| Low | Rounding dust left in contracts; transfers to `address(0)`; the relayer didn't check fees | Dust sweep; `CloakToken` refuses transfers to zero; covered by the relayer fixes |

The first deployment stays on-chain so its balances can always leave. The Portfolio page moves them to v2 in one step through `CloakMigrator`.

## Secrets

- Deployer and keeper keys live only in a local, git-ignored `.env` or in the host's secret settings. They are never committed.
- `apps/web/public/circuits/*` holds public proving artifacts, not secrets.
- `deployments/*.json` holds public addresses and transaction links.
