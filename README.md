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

**Try it in about two minutes:** open [the app](https://cloak.boblabs.tech/app), connect a wallet (it adds Elysium testnet for you), get testnet HYPE from the [Elysium faucet](https://elysium.kinetiq.xyz/testnet-faucet), then place a sealed bid, or shield HYPE and make a private swap, send or batch order. Testnet only, play money.

---

## Live on Elysium testnet (chain `99801`)

| Contract | Address |
|---|---|
| **CloakFactory** | [`0x1dc1ea9837ecbd31ec74f0d558e1db1c303a7e1c`](https://elysium.kinetiq.xyz/testnet-explorer/address/0x1dc1ea9837ecbd31ec74f0d558e1db1c303a7e1c) |
| **PrivateRouter** (private swaps and vaults) | [`0xfa2574cfc3afb8f7d3a0651fa2111ff4e3d2fc41`](https://elysium.kinetiq.xyz/testnet-explorer/address/0xfa2574cfc3afb8f7d3a0651fa2111ff4e3d2fc41) |
| **PrivateBatcher** (batch auctions) | [`0xf6582cc5a84fccf74e571e652fb7b603a2c25812`](https://elysium.kinetiq.xyz/testnet-explorer/address/0xf6582cc5a84fccf74e571e652fb7b603a2c25812) |

Source is verified on the explorer for the factory, router, batcher, both shielded vaults, the Groth16 verifier, WHYPE and the demo launch's auction, token and pool. None of them has an owner or admin key.

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
- **Your account** comes from one wallet signature (free, no transaction). Nothing is stored on a server.
- **Relayer** (`services/keeper`, `POST /relay`): dry-runs your call, then submits it and pays gas. It is the on-chain sender of every private trade.
- **Only real Cloak launches**: pools can only be created for a settled launch from the Cloak factory, and the router only swaps through that launch's pair.
- **Private sends**: a transfer inside a vault to someone's `cloak:` address. The chain sees that a private transaction happened, but not who sent it, who received it or how much moved.
- **Batch mode (PrivateBatcher), which hides trade size**: your amount is split into **standard sizes** (1, 2 or 5 × 10ⁿ) that everyone uses, and the orders go into a round (30 s on testnet). When the round ends, buys and sells **cross each other at the pool's mid-price** (no fee, no price impact), and only the **net** difference trades through the pool, in one swap. Every buyer in the round gets the same price, and so does every seller. Outputs come back as private notes to one-time keys. Observers see "round N: 7 standard-size orders, net +0.4 HYPE hit the pool", not who placed which or how much any one trader moved. A price guard (settle-time mid within `maxSlippageBps` of the average at order time) stops a settler from sandwiching the batch. If a round can't settle, every order is refunded after a delay.

| Live on Elysium testnet | |
|---|---|
| **PrivateRouter** | [`0xfa2574cfc3afb8f7d3a0651fa2111ff4e3d2fc41`](https://elysium.kinetiq.xyz/testnet-explorer/address/0xfa2574cfc3afb8f7d3a0651fa2111ff4e3d2fc41) |
| Shielded HYPE pool | [`0xCDD04c1c2aEc00728995C151127D619990885715`](https://elysium.kinetiq.xyz/testnet-explorer/address/0xCDD04c1c2aEc00728995C151127D619990885715) |
| Shielded $CLOAK pool | [`0x5AB75B030adD2D9814F48D51585eBb9e42BBC721`](https://elysium.kinetiq.xyz/testnet-explorer/address/0x5AB75B030adD2D9814F48D51585eBb9e42BBC721) |
| **PrivateBatcher** (30 s rounds) | [`0xf6582cc5a84fccf74e571e652fb7b603a2c25812`](https://elysium.kinetiq.xyz/testnet-explorer/address/0xf6582cc5a84fccf74e571e652fb7b603a2c25812) |

**A real private-trading run on testnet** (`e2e/private.mjs`, 18/18 checks, real proofs):

| Step | Transaction | What the chain sees |
|---|---|---|
| Shield 0.002 HYPE | [0x51a6…75e5](https://elysium.kinetiq.xyz/testnet-explorer/tx/0x51a61a2395266b5b0b3ed3d3091a3c43fd6e686cd08572b34b03107ae64775e5) | a wallet deposited to a one-time key |
| Private buy | [0x1d25…ec30](https://elysium.kinetiq.xyz/testnet-explorer/tx/0x1d2506221f6a04f32c401d1a2dc32ed579f207b0a5a2181ed3dee79f1dd3ec30) | **the relayer** bought tokens into the shielded pool |
| Private sell | [0xb0c1…7ff3](https://elysium.kinetiq.xyz/testnet-explorer/tx/0xb0c10c24cb2599f35bba714e669810958eca7b860cdd3f239adc2c4211647ff3) | **the relayer** sold tokens from the shielded pool |
| Withdraw to a brand-new address | [0x2008…04e5](https://elysium.kinetiq.xyz/testnet-explorer/tx/0x2008d9d408582953a3cec2742d06292eb8022368985440fd59bb49e2fed804e5) | HYPE arrived at an address with no history |
| Private send | [0x72a6…b731](https://elysium.kinetiq.xyz/testnet-explorer/tx/0x72a604c3aa9b3ebef3d22d50cf9ee90938b2d70d0eceb0f23477d04706ffb731) | a private transaction happened; no amount, no sender, no recipient |
| Batch order (one of 7) | [0xba2d…30b1](https://elysium.kinetiq.xyz/testnet-explorer/tx/0xba2db51982d8a8ad190d813afd68f821bbd8dd48ee831021d4fb8729c99130b1) | **the relayer** placed a standard-size order |
| Batch settle | [0x74f9…2392](https://elysium.kinetiq.xyz/testnet-explorer/tx/0x74f97a933d703dbfaf5fb56d833596e2c2658447216660028d2a0cd053d22392) | buys and sells crossed; only the net hit the pool |
| Batch payout | [0x6885…7009](https://elysium.kinetiq.xyz/testnet-explorer/tx/0x6885e0e4c1b3dd69b3e99cf80dbc1b7da8fa825dcafcc5895294828374037009) | outputs deposited as private notes to one-time keys |

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
| **Censorship-tolerant reveals** | Anyone can reveal anyone's bid, and `revealBatch` skips bad entries. Bids whose ciphertext is garbage can't be withheld strategically: unrevealed deposits lose `noRevealPenaltyBps` (burned, never paid to the creator). |

## Layout

```
contracts/         Foundry: CloakAuction, CloakFactory, CloakToken (fixed supply, no owner), CloakPair (HYPE/token AMM)
contracts/src/shielded/  ShieldedPool, PrivateRouter, PrivateBatcher, WHYPE, Groth16 verifier, Merkle tree
circuits/          transaction2x2.circom (2-in/2-out notes); built artifacts in apps/web/public/circuits
packages/sdk/      @cloak/sdk: launches (createLaunch, bid, revealAll, settle, claimAll) + CloakPrivate
                   (shieldHype, buy, sell, batch, send, unshield, balances, on-device prover, relayer client)
services/keeper/   Auto-reveals after the drand round, settles launches, relays private trades (POST /relay),
                   and settles + pays out private batch rounds.
apps/web/          The site (Vite + React): landing (hover-to-uncloak hero), app (launches, launch page, private swap,
                   portfolio, create, volume), docs, SDK and pitch (/pitch). Wallet modal lists every installed wallet
                   (EIP-6963) plus WalletConnect; src/errors.ts turns every error into a plain sentence. Deployed on Vercel.
e2e/               run.mjs (launch flow, 13 checks), private.mjs (private trading, 18 checks), seed.mjs, deploy.mjs
docs/DESIGN.md     Research, design, roadmap
```

## For launchpads: `@cloak/sdk`

```ts
import { Cloak, elysiumTestnet } from "@cloak/sdk";
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

A launchpad can also call `CloakFactory.createLaunch(name, symbol, creatorAlloc, params, metadataURI)` from its own contracts, with `params.creator` set to the project.

## Run it

Prerequisites: Node ≥ 20, pnpm, Foundry.

```bash
pnpm install && pnpm build
pnpm test                                   # 27 Foundry tests (auction incl. solvency fuzz, private router, batcher) + SDK tests

# full flow on a local chain (uses the real drand beacon)
anvil --balance 1000000 &
pnpm e2e                                    # 13 checks: commit → auto-reveal → settle → pro rata → LP at clearing price → trade
node e2e/private.mjs                        # 18 checks with real proofs: shield → buy → sell → withdraw → send → batch round
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
| Keeper + relayer | **Render** web service, [cloak-keeper.onrender.com](https://cloak-keeper.onrender.com) | `node services/keeper/index.mjs`. Env: `KEEPER_PK`, `FACTORY`, `START_BLOCK`, `ROUTER`, `BATCHER`, `BATCHER_BLOCK` (see `render.yaml`), plus optional `CORS_ORIGINS` (default: the Cloak site and localhost) and `RELAY_PER_MIN` (default 20 relay requests per IP per minute). Requests over 64 KB or malformed are refused before anything is simulated. The relayer wallet pays gas for private transactions, so keep it topped up with testnet HYPE. |

`GET /health` returns the keeper's status. A scheduled GitHub workflow (`.github/workflows/keeper-ping.yml`) pings it every 10 minutes so the host doesn't sleep. Bids can still be opened from the launch page without the keeper, but private trades wait for it.

## Honest limits

**Private trading**
- **Hidden:** who traded, what each account holds, and which trades belong together. Private sends also hide the amount. In batch mode, an individual trader's size is hidden among standard-size orders.
- **Visible:** instant trades show their size and direction on the AMM (the pool is public). A batch round shows its standard-size order counts and the net that hit the pool. Shield deposits and withdrawals show their amounts.
- **Batch anonymity needs company.** If you're the only one in a round, your orders add up to your trade. More users per round means more privacy. Orders placed back-to-back by one client could be linked by timing (spreading orders across a round is a client-side upgrade).
- **Timing can still link you.** Shielding 1 HYPE and immediately buying with exactly 1 HYPE is easy to connect, especially while few people use the pools. Wait, and trade different amounts.
- **Relayer trust:** the relayer can refuse or delay your trade, and it sees your IP. It cannot steal, alter or redirect anything, because the proof binds every field. Anyone can run one.
- **Trusted setup:** the Groth16 keys come from a development setup. Production needs a public multi-party ceremony.
- **Not hidden from front-running:** trades hit the public AMM with a 1% slippage limit. Sealed batch trading (roadmap) would also hide trades until they clear.

**Launch auction**

- Sealed bids stop **ordering** games, not **many-wallet** games. Uniform pricing removes most of the reason to split bids, though.
- tlock relies on the drand League of Entropy threshold network. A threshold collusion could decrypt early.
- The sequencer can delay transactions. The reveal window, anyone-can-reveal and Elysium's delayed-inbox forced inclusion mitigate this.
- Deposits are visible; buckets only blur them. Unlinkable funding from a shielded balance is on the roadmap.
- Not audited. Testnet only.

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
