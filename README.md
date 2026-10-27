<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/web/public/brand/cloak-mark-light.svg">
    <img src="apps/web/public/brand/cloak-mark.svg" alt="Cloak" height="72">
  </picture>
</p>

# Cloak: private launches and private trading for Elysium

**Live: [cloak.boblabs.tech](https://cloak.boblabs.tech)** · [Demo video](https://youtu.be/KNeKiuxBAYA) · [App](https://cloak.boblabs.tech/app) · [Private swap](https://cloak.boblabs.tech/app/trade) · [Docs](https://cloak.boblabs.tech/docs) · [SDK](https://cloak.boblabs.tech/sdk) · [Pitch](https://cloak.boblabs.tech/pitch)

> **Launches nobody can snipe, and trades nobody can trace.** Bids stay sealed until bidding closes, hidden even from the sequencer. Every winner pays **one clearing price**, and liquidity is seeded at that price and locked by the contract. After launch, anyone can hold, send, buy and sell the token **from a private balance**: trades are proven on your device and sent by a relayer, so your wallet never appears on them. **Batch mode** also hides how much you traded, and **private sends** hide the amount completely.

Plain-English walkthrough: [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md).

A **[Bob Labs](https://github.com/NECOKIZZ)** product, live on Kinetiq's **Elysium** testnet (chain `99801`) at [cloak.boblabs.tech](https://cloak.boblabs.tech).

**Try it in about two minutes:** open [the app](https://cloak.boblabs.tech/app), connect a wallet (it adds Elysium testnet for you), get testnet HYPE from the [Elysium faucet](https://elysium.kinetiq.xyz/testnet-faucet), then place a sealed bid, or shield HYPE and make a private swap, send or batch order. Testnet only, play money. Mainnet is planned for **Nov 9**.

---

## Live on Elysium testnet (chain `99801`)

Cloak **v2** (Oct 25): fees, deposit caps, a timelocked rule book and every fix from our internal review.

| Contract | Address |
|---|---|
| **CloakConfig** (fees, caps, verifier; changes behind a 3-day timelock) | [`0x9d30c7b23fa2d5c40779d3db3bb4292e18c94373`](https://elysium.kinetiq.xyz/testnet-explorer/address/0x9d30c7b23fa2d5c40779d3db3bb4292e18c94373) |
| **CloakFactory** | [`0xc1fc14e84cbbd10f75dad9d91bf50f47c48757fc`](https://elysium.kinetiq.xyz/testnet-explorer/address/0xc1fc14e84cbbd10f75dad9d91bf50f47c48757fc) |
| **PrivateRouter** (private swaps and vaults) | [`0xd51e731467c49991496329c2b7979cb1aa220ee2`](https://elysium.kinetiq.xyz/testnet-explorer/address/0xd51e731467c49991496329c2b7979cb1aa220ee2) |
| **PrivateBatcher** (batch auctions) | [`0xa13ffd763a8cccfea1b868c616291723579ddb77`](https://elysium.kinetiq.xyz/testnet-explorer/address/0xa13ffd763a8cccfea1b868c616291723579ddb77) |
| **CloakMigrator** (moves v1 private balances here) | [`0xe54c02fa685f2c95e5ae98e1155547194d04d9ad`](https://elysium.kinetiq.xyz/testnet-explorer/address/0xe54c02fa685f2c95e5ae98e1155547194d04d9ad) |

All addresses, including the vaults, are in [`deployments/elysium-testnet-v2.json`](deployments/elysium-testnet-v2.json). The first deployment (factory `0x1dc1…7e1c`, router `0xfa25…fc41`) stays on-chain: its launches still list on the site, its history still counts on the Volume page, and its private balances move to v2 in one step from the Portfolio page. Its sources are verified on the explorer. Verification of the v2 sources is in progress.

### Fees, caps and governance

| | |
|---|---|
| Deposits and private sends | Free |
| Withdrawals, private swaps, batch orders | **0.25%** of the amount, kept in the vault and collected to the treasury (hard cap 1%) |
| Launch fee | **1.5%** of a successful raise, at settlement. Nothing on a launch that doesn't fill (hard cap 3%) |
| Relayer fee | the relayer's gas plus a margin, paid inside the proof |
| Beta caps | HYPE vault 100 per deposit and 10,000 in total; launch-token vaults 1% of supply per deposit and 10% in total; auctions 100 HYPE per bid and 10,000 in total. Withdrawals are never capped |
| Creator share | at most 20% of the supply, vesting linearly over at least 30 days |

**Nobody can take funds.** No function in any Cloak contract moves user money: notes leave a vault only with their owner's proof, and auction money only goes to bidders, the creator and the fee recipient. `CloakConfig` holds the rules. While in setup, the owner sets them directly. After `endSetup()`, tightening a rule (lower a fee or a cap, close deposits) is instant, and loosening one, or changing the verifier or fee recipient, is queued on-chain and waits a public **3-day** delay. Ownership moves in two steps. A bug in a contract's code still needs a new version: the old one keeps its exits open, and `CloakMigrator` moves balances across privately in one relayed transaction.

**A full real run on testnet** (`pnpm e2e`, 13/13 checks): 5 fresh bidders, sealed bids, keeper auto-reveal from the drand beacon, one clearing price, pool seeded at that price with the LP burned, then the first trade:

| Step | Transaction |
|---|---|
| Create launch | [0xa50c…0c7a](https://elysium.kinetiq.xyz/testnet-explorer/tx/0xa50c90dc8bdc3d16117208db562fdcaf01c14df8b98941bb7bdc48b2d1de0c7a) |
| Sealed bid (one of 5): only a hash + timelock ciphertext | [0xfdb2…82a9](https://elysium.kinetiq.xyz/testnet-explorer/tx/0xfdb235c27e76f17dbe5409d8b8704c3ddf0eafa9f6a844cc8bd2c0374da382a9) |
| Keeper opens all 5 bids (no bidder action) | [0xc218…94b2](https://elysium.kinetiq.xyz/testnet-explorer/tx/0xc2185869b25408a7b80412c0653bbe11916ee6ef99eca3a6cafb401e08a094b2) |
| Settle: clearing price, LP seeded at it, unused tokens burned | [0x3963…2f18](https://elysium.kinetiq.xyz/testnet-explorer/tx/0x39637ad1096b237ec5095722a647d3b3490fdf2500dfaa64f43be169b14f2f18) |
| Claims pushed to every bidder | [0x53f7…2154](https://elysium.kinetiq.xyz/testnet-explorer/tx/0x53f79abf41f3461650833cb8aad386e4476bc4594d5f4e2170fdaf9327e22154) |
| First trade on the pool | [0x11de…a7e2](https://elysium.kinetiq.xyz/testnet-explorer/tx/0x11de2c033b7919752ee0af4ddf51274683a9fb77e80a2bb9a48b77f8f9faa7e2) |

That run's addresses: auction `0xE11293758BF75b84Acd6cae98669642FcFB8760F`, token `0x7e65c418e4E3CDdB1C3C8a9bD2dcE336AC7fd17D`, pool `0xA0642f3c039a7be8360A455b18910c575Cf0bF1E` (all in [`deployments/elysium-testnet.json`](deployments/elysium-testnet.json)).

No keeper is required: once the drand round is out, the launch page shows **Open all sealed bids**, so anyone can reveal from the browser.

## Private trading for launch tokens

Private balances usually stop at stablecoins. Cloak extends them to **trading launchpad tokens**:

```
 your wallet ──shield──▶ private HYPE ──private buy──▶ private $TOKEN ──private sell──▶ private HYPE ──withdraw──▶ any fresh address
   (public, once)          (hidden)      (relayer)        (hidden)        (relayer)        (hidden)       (relayer)
```

- **ShieldedPool**: one per asset (WHYPE plus each launch token). A balance is a set of encrypted notes. Spending one needs a Groth16 proof (2-in/2-out circuit, Poseidon Merkle tree) generated **on your device** in about 3–4 s.
- **PrivateRouter**: a private buy spends a WHYPE note, swaps through the launch's own `CloakPair`, and deposits the tokens as a new note for you. A private sell does the reverse. The swap instructions (pair, output pool, min out, your output note) are inside `ExtData.data`, which **the proof commits to**, so the relayer can submit your trade but cannot change it.
- **One-time keys**: every note that enters a pool publicly (your shield deposit, every swap output) goes to a fresh key derived from your account, so those entries can't be linked to each other or to your main key.
- **Your account** comes from one EIP-712 signature (free, no transaction) bound to Elysium and the router, so a signature any other site asks for can't recreate it. The first unlock signs twice and refuses wallets that sign differently each time. Nothing is stored on a server.
- **Relayer** (`services/keeper`, `POST /relay`): quotes a fee (`GET /quote`), refuses calls that don't pay it or that spend a note already in flight, dry-runs the rest, then submits and pays gas. It is the on-chain sender of every private trade.
- **Only real Cloak launches**: pools can only be created for a settled launch from the Cloak factory, and the router only swaps through that launch's pair.
- **Private sends**: a transfer inside a vault to someone's `cloak:` address. The chain sees that a private transaction happened, but not who sent it, who received it or how much moved.
- **Batch mode (PrivateBatcher), which hides trade size**: your amount is split into **standard sizes** (1, 2 or 5 × 10ⁿ) that everyone uses, and the orders go into a round (30 s on testnet). When the round ends, buys and sells **cross each other at the pool's time-weighted average price over the round** (no pool fee, no price impact), and only the **net** difference trades through the pool, in one swap. Every buyer in the round gets the same price, and so does every seller. Outputs come back as private notes to one-time keys. Observers see "round N: 7 standard-size orders, net +0.4 HYPE hit the pool", not who placed which or how much any one trader moved. A price guard (spot within 2% of that average, and at most 5% price impact on the net swap) stops a settler from sandwiching the batch. If a round can't settle, every order is refunded after a delay.

| Live on Elysium testnet (v2) | |
|---|---|
| **PrivateRouter** | [`0xd51e731467c49991496329c2b7979cb1aa220ee2`](https://elysium.kinetiq.xyz/testnet-explorer/address/0xd51e731467c49991496329c2b7979cb1aa220ee2) |
| Shielded HYPE pool | [`0x4deFEC0814d11c581e5947020ac4ec41e88B55Df`](https://elysium.kinetiq.xyz/testnet-explorer/address/0x4deFEC0814d11c581e5947020ac4ec41e88B55Df) |
| Shielded $CLOAK pool | [`0xDD361593560722c3d965cAA551a6Ed81Cd7dd703`](https://elysium.kinetiq.xyz/testnet-explorer/address/0xDD361593560722c3d965cAA551a6Ed81Cd7dd703) |
| **PrivateBatcher** (30 s rounds) | [`0xa13ffd763a8cccfea1b868c616291723579ddb77`](https://elysium.kinetiq.xyz/testnet-explorer/address/0xa13ffd763a8cccfea1b868c616291723579ddb77) |

**A real private-trading run on testnet against v2** (`e2e/private.mjs`, 19/19 checks, real proofs, fees on):

| Step | Transaction | What the chain sees |
|---|---|---|
| Shield 0.002 HYPE | [0x5e25…2753](https://elysium.kinetiq.xyz/testnet-explorer/tx/0x5e25ac70f319ccb85c9987a049f0c24ed0d7251283a0bd535dfb853946ea2753) | a wallet deposited to a one-time key |
| Private buy | [0xb7b5…a74e](https://elysium.kinetiq.xyz/testnet-explorer/tx/0xb7b5e6e5d653cc45b68a717b5b2955983a7383dd78ceb7acf56d73d34fb3a74e) | **the relayer** bought tokens into the shielded pool |
| Private sell | [0xc8c7…44ec](https://elysium.kinetiq.xyz/testnet-explorer/tx/0xc8c7a7c2f9b70cc236601b680081b77a209c2adf888cf6c982252ca85ea144ec) | **the relayer** sold tokens from the shielded pool |
| Withdraw to a brand-new address | [0xda4e…c963](https://elysium.kinetiq.xyz/testnet-explorer/tx/0xda4e61177a6a792e32bca1de857e9de33af8137b5d1e2b30ee657453ffbec963) | HYPE arrived at an address with no history; 0.25% stayed in the vault as the fee |
| Private send | [0x2553…4396](https://elysium.kinetiq.xyz/testnet-explorer/tx/0x25539f1752de1e51700f7e205f38f3eae1ad092b330b58da6fe716f976224396) | a private transaction happened; no amount, no sender, no recipient |
| Batch order (one of 7) | [0xd689…078c](https://elysium.kinetiq.xyz/testnet-explorer/tx/0xd6893e0d148c666fd082e832986b03b5774c99c0eedefda44902bbb873db078c) | **the relayer** placed a standard-size order |
| Batch settle | [0x0708…5468](https://elysium.kinetiq.xyz/testnet-explorer/tx/0x07086520c06678487d67c7a2a37827de9f9144be9e7f4a47ee137dc2d22c5468) | buys and sells crossed at the round's average price; only the net hit the pool |
| Batch payout | [0xab2c…2aa5](https://elysium.kinetiq.xyz/testnet-explorer/tx/0xab2ca59da864bd7d00ac8046c4d8f60cace058f6a3264c8f943aa5e8fbbb2aa5) | outputs deposited as private notes to one-time keys |

The test checks that the trader's address appears **nowhere** in the trades' calldata or logs, that a second account sees none of the first account's notes, that a private send's amount appears nowhere in its transaction, and that every buy order in a round fills at the same rate.

## Why Elysium needs this

Elysium runs a **single sequencer that orders by priority fee**, with ~300 ms blocks and no public mempool. On a first-come or bonding-curve launch, the first block becomes a gas auction that bots win. The sequencer and the AnyTrust data committee also see every transaction in plain text, so privacy has to come from the app. Timeboost (planned) will make ordering openly purchasable.

Cloak makes a launch **indifferent to who orders it**:

| | How |
|---|---|
| **Sealed bids** | `commit(hash, sealedBid)`: on-chain there is only a keccak hash plus a drand-timelock ciphertext. Price and size are invisible to bots, other bidders and the sequencer. |
| **Bids reveal themselves** | Each bid is encrypted with [tlock](https://github.com/drand/tlock-js) to the drand quicknet round that fires when bidding ends. After that, **anyone** (the keeper, another bidder, the page) can decrypt it and call `reveal`. The contract only checks the hash, so a decryptor can open a bid but never change it. There is no "come back and reveal" step. |
| **Hidden bid size** | Deposits are rounded up to 1/2/5 × 10ⁿ buckets at any price scale. Your real bid can be anything below your deposit, and the excess is refunded, so a deposit only reveals the order of magnitude. |
| **One clearing price** | `settle()` walks up to 256 price ticks from high to low. The first tick where demand covers supply sets the price for **everyone**. Bids at that tick fill pro rata, and lower bids are refunded in full. Gas is O(ticks), not O(bids). |
| **Liquidity at the discovered price** | Part of the raise (`lpBps`), plus matching tokens, seeds a `CloakPair` **at exactly the clearing price**, so there is no first-block arbitrage. LP shares are **burned** or **time-locked** in the auction contract. Unsold tokens are burned. |
| **Fair-launch record** | `FairLaunch` event: clearing price, sold, raised, LP amounts and lock, bidder count. The page renders it as a verified badge, and a launchpad on Elysium (for example Ascend, for its HyperCore graduation criteria) can read it straight from chain. |
| **Censorship-tolerant reveals** | Anyone can reveal anyone's bid, and `revealBatch` skips bad entries. Bids whose ciphertext is garbage can't be withheld strategically: unrevealed deposits lose `noRevealPenaltyBps`, at least 10% (burned, never paid to the creator). The contract also checks that the drand round opens after bidding closes and before reveals end. |
| **Money can't get stuck** | Settlement credits the creator's proceeds and the launch fee instead of sending them, so a recipient that can't take HYPE never blocks settlement or anyone's refund. |

## Layout

```
contracts/         Foundry: CloakConfig (fees, caps, timelock), CloakAuction, CloakFactory, CloakToken (fixed supply,
                   no owner), CloakVesting (creator share), CloakPair (HYPE/token AMM with a time-weighted price)
contracts/src/shielded/  ShieldedPool, PrivateRouter, PrivateBatcher, CloakMigrator, WHYPE, Groth16 verifier,
                   Merkle trees (a new tree starts when one fills, so exits never stop)
circuits/          transaction2x2.circom (2-in/2-out notes); built artifacts in apps/web/public/circuits
packages/sdk/      @cloakely/sdk: launches (createLaunch, bid, revealAll, settle, claimAll) + CloakPrivate
                   (shieldHype, buy, sell, batch, send, unshield, balances, on-device prover, relayer client)
services/keeper/   Auto-reveals after the drand round, settles launches, relays private trades (POST /relay),
                   and settles + pays out private batch rounds.
apps/web/          The site (Vite + React): landing (hover-to-uncloak hero), app (launches, launch page, private swap,
                   portfolio, create, volume), docs, SDK and pitch (/pitch). Wallet modal lists every installed wallet
                   (EIP-6963) plus WalletConnect; src/errors.ts turns every error into a plain sentence. Deployed on Vercel.
e2e/               run.mjs (launch flow), private.mjs (private trading, real proofs), migrate.mjs (v1 → v2 moves
                   through the relayer, real proofs), deploy-v2.mjs (the testnet deployment), seed.mjs
docs/DESIGN.md     Research, design, roadmap
```

## For launchpads: `@cloakely/sdk`

[![npm](https://img.shields.io/npm/v/@cloakely/sdk)](https://www.npmjs.com/package/@cloakely/sdk)

```bash
npm install @cloakely/sdk viem
```

Contract addresses, start blocks, the hosted relayer and the circuit files come built in: `deploymentFor(99801)`.

```ts
import { Cloak, elysiumTestnet } from "@cloakely/sdk";
const cloak = new Cloak(publicClient, walletClient, FACTORY);

// launchpad / project
const { auction } = await cloak.createLaunch({
  name: "Shade", symbol: "SHADE", saleSupply: 1_000_000n * 10n ** 18n,
  minPrice: 10n ** 12n, tickSize: 10n ** 12n, numTicks: 100,
  commitEnd, revealEnd, lpBps: 5000, lpLockUntil: "burn",
});

// bidder: hashes, tlock-encrypts and commits; a bucketed deposit hides the size
await cloak.bid(auction, { maxPrice: parseEther("0.00002"), quantity: parseEther("10000") });

// anyone (keeper)
await cloak.revealAll(auction);   // decrypts with the public drand beacon
await cloak.settle(auction);
await cloak.claimAll(auction);    // tokens and refunds always go to the bidder
```

A launchpad can also call `CloakFactory.createLaunch(name, symbol, creatorAlloc, vestSecs, params, metadataURI)` from its own contracts, with `params.creator` set to the project.

## Run it

Prerequisites: Node ≥ 20, pnpm, Foundry.

```bash
pnpm install && pnpm build
pnpm test                                   # 63 Foundry tests (auction, router, batcher, fees, caps, timelock, migration,
                                            # a regression test for every review finding, solvency fuzzing) + SDK tests

# full flow on a local chain (uses the real drand beacon)
anvil --balance 1000000 &
pnpm e2e                                    # 13 checks: commit → auto-reveal → settle → pro rata → LP at clearing price → trade
node e2e/private.mjs                        # 21 checks with real proofs: fees → shield → buy → sell → withdraw → send → batch round
node e2e/migrate.mjs                        # 11 checks: v1 deployment → balances → relayed, fee-paying moves into v2
```

Local demo with the page:

```bash
anvil --balance 1000000 --block-time 1 &
pnpm seed                                   # prints {factory, auction}; 3-min bidding window, 6 bot bids
KEEPER_PK=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d FACTORY=0x… RPC_URL=http://127.0.0.1:8545 pnpm keeper
cd apps/web && VITE_RPC_URL=http://127.0.0.1:8545 VITE_CHAIN_ID=31337 VITE_FACTORY=0x… VITE_KEEPER_URL=http://127.0.0.1:3001 pnpm dev
```

Use **Dev wallet** (an anvil-funded burner) to bid.

### Elysium testnet

```bash
cp .env.example .env                        # DEPLOYER_PK with testnet HYPE
DEPLOYER_PK=0x… pnpm deploy:factory               # → deployments/elysium-testnet-factory.json
DEPLOYER_PK=0x… FACTORY=0x… RPC_URL=https://testnet-rpc.elysium.kinetiq.xyz pnpm e2e   # real run → explorer links in deployments/elysium-testnet.json
KEEPER_PK=0x… FACTORY=0x… pnpm keeper
cd apps/web && VITE_FACTORY=0x… pnpm build  # static site
```

### Hosting (how the live version runs)

| Part | Where | Notes |
|---|---|---|
| Site | **Vercel**, at [cloak.boblabs.tech](https://cloak.boblabs.tech) | Root directory `apps/web`. `vercel.json` handles the monorepo build, SPA routes, security headers (CSP, frame and referrer policy) and long-lived caching for hashed assets. Env: `VITE_KEEPER_URL`, and optionally `VITE_WC_PROJECT_ID` (a free [Reown](https://cloud.reown.com) project ID) to show WalletConnect in the connect modal. Contract addresses come from `apps/web/.env.production`. |
| Keeper + relayer | **Render** web service, [cloak-keeper.onrender.com](https://cloak-keeper.onrender.com) | `node services/keeper/index.mjs`. Env: `KEEPER_PK`, `FACTORY`, `START_BLOCK`, `ROUTER`, `BATCHER`, `BATCHER_BLOCK`, `MIGRATOR`, `LEGACY_ROUTER` (see `render.yaml`), plus optional `CORS_ORIGINS` (default: the Cloak site and localhost) and `RELAY_PER_MIN` (default 20 relay requests per IP per minute). Requests over 64 KB or malformed are refused before anything is simulated. The relayer wallet pays gas for private transactions and earns it back from the relayer fee in each one (`GET /quote`, 1.25× the gas cost; calls that don't pay it are refused). |

`GET /health` returns the keeper's status. A scheduled GitHub workflow (`.github/workflows/keeper-ping.yml`) pings it every 10 minutes so the host doesn't sleep. Bids can still be opened from the launch page without the keeper, but private trades wait for it.

## Honest limits

**Private trading**
- **Hidden:** who traded, what each account holds, and which trades belong together. Private sends also hide the amount. In batch mode, an individual trader's size is hidden among standard-size orders.
- **Visible:** instant trades show their size and direction on the AMM (the pool is public). A batch round shows its standard-size order counts and the net that hit the pool. Shield deposits and withdrawals show their amounts.
- **Batch anonymity needs company.** If you're the only one in a round, your orders add up to your trade. More users per round means more privacy. Orders placed back-to-back by one client could be linked by timing (spreading orders across a round is a client-side upgrade).
- **Timing can still link you.** Shielding 1 HYPE and immediately buying with exactly 1 HYPE is easy to connect, especially while few people use the pools. Wait, and trade different amounts.
- **Relayer trust:** the relayer can refuse or delay your trade, and it sees your IP. It cannot steal, alter or redirect anything, because the proof binds every field. Anyone can run one.
- **Governance:** on testnet the config owner is a single wallet and setup is still open. Before mainnet it moves to a multisig and setup ends, so every loosening change waits 3 days.
- **Trusted setup:** the Groth16 keys come from a development setup. Production needs a public multi-party ceremony, which is planned alongside mainnet (Nov 9). Caps stay on until it is done.
- **Not hidden from front-running:** trades hit the public AMM with a 1% slippage limit. Sealed batch trading (roadmap) would also hide trades until they clear.

**Launch auction**

- Sealed bids stop **ordering** games, not **many-wallet** games. Uniform pricing removes most of the reason to split bids, though.
- tlock relies on the drand League of Entropy threshold network. A threshold collusion could decrypt early.
- The sequencer can delay transactions. The reveal window, anyone-can-reveal and Elysium's delayed-inbox forced inclusion mitigate this.
- Deposits are visible; buckets only blur them. Unlinkable funding from a shielded balance is on the roadmap.
- Not audited yet. Testnet today. Mainnet is planned for Nov 9, with deposit caps until the audit and the trusted-setup ceremony are done.

## Brand

The hood monogram lives in [`apps/web/public/brand/`](apps/web/public/brand). The whole site is themed from four tokens in [`apps/web/src/brand.css`](apps/web/src/brand.css), tuned to Elysium's palette:

| Token | Light | Dark | Used for |
|---|---|---|---|
| Ink | `#10161A` | `#EEF1F0` | text, logo, primary buttons |
| Paper | `#F8F7F4` | `#0B1013` | page background |
| Signal | `#2D7388` | `#6CB6CB` | private / sealed / live states |
| Seal | `#C9852E` | `#E3A95A` | clearing price, warnings |

## Roadmap

The product roadmap (token pages, SDK on npm, an MCP server for agents, holder proofs) and the revenue model are in [docs/ROADMAP.md](docs/ROADMAP.md). Protocol work is in [docs/DESIGN.md](docs/DESIGN.md#8-beyond-launch-private-trading-on-elysium): private launch bids funded straight from a shielded balance, timelock-sealed batch orders (hide side and size until the round clears), orders spread across the round, claim links, a private perps vault on HyperCore, and kHYPE bids.

## License

[MIT](LICENSE) © 2026 Bob Labs. Third-party code keeps its own license: the generated Groth16 verifier (`contracts/src/shielded/Verifier.sol`, from snarkjs) is GPL-3.0, and the circuits build on circomlib (GPL-3.0).
