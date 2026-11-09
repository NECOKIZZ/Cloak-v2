<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/web/public/brand/cloak-mark-light.svg">
    <img src="apps/web/public/brand/cloak-mark.svg" alt="Cloak" height="72">
  </picture>
</p>

# Cloak v2: private launches and private trading for Elysium, on Gloam

**Testnet site: gloak.boblabs.tech** (being hosted). Cloak v1 stays at [cloak.boblabs.tech](https://cloak.boblabs.tech) and lives in its own repository.

> **Launches nobody can snipe, and trades nobody can trace.** Bids stay sealed until bidding closes, hidden even from the sequencer. Every winner pays **one clearing price**, and the launch opens a Uniswap v4 pool at that price. After launch, anyone can hold, send, buy and sell the token **from a private balance** kept in [Gloam](https://github.com/cryptoduke01/gloam)'s shielded vault: proofs are made on your device and a relay sends them, so your wallet never appears.

Plain-English walkthrough: [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md). Handover for whoever works on this next: [HANDOVER.md](HANDOVER.md). Things to check after hosting: [CHECK.md](CHECK.md).

---

## What v2 is

Cloak v1 had its own vaults, circuits and verifiers. **v2 keeps none of them.** Private balances live in Gloam's vault (Gloam's circuits, keys and verifiers, never changed by us) and in `CloakLaunchVault`, which is Gloam's vault code plus one function that admits a settled Cloak launch. Around them sit small escrows that turn a Gloam proof into an action:

| Contract | What it does |
|---|---|
| **CloakFactory** + **CloakV4Hook** | Sealed-bid launches. Each settled launch opens a Uniswap v4 pool at its clearing price through the hook |
| **CloakLaunchVault** | Private balances of HYPE and launch tokens (Gloam's vault code, plus `admitLaunch`) |
| **CloakLaunchSwapV4** | Private instant buys and sells on a launch's v4 pool |
| **CloakGloamBatcherV4** | Batch rounds in standard sizes, so a trade's size is hidden too |
| **CloakGloamBids** | Sealed bids paid from a private balance |
| **CloakGloamReceive** | Receive addresses anyone can pay, shielded by the owner's app |
| **CloakGraduation** | Moves balances from the launch vault into Gloam's vault in rounds |
| **CloakFundsGate**, **CloakReceiptCheck** | Allocation gates and receipts, proved with Gloam's own holder circuit |

## Live on Elysium testnet (chain `99801`)

v2 has **its own launch factory** (Nov 9), apart from Cloak v1's. Its rules are copied from v1's: launch fee 1.5%, auctions capped at 100 HYPE per bid and 10,000 HYPE in total. The launch vault and every escrow were redeployed on it, and the first launch, **GLOAK**, is admitted and registered for batch rounds.

| Contract | Address |
|---|---|
| CloakConfig (v2) | `0xfedf1050af9e96dcfef9c098fcbc122d907f4f1e` |
| CloakFactory (v2), from block 26707681 | `0x59d2cd703747a47288518c7380efa95879295784` |
| CloakV4Hook (v2) | `0xC6296320cDFAB6074Fc650f1d788608b16fa2A80` |
| Gloam's vault (Cloak's instance, USDC) | `0x8D15BA46071D5AB2e59d746c22d51C906281cB44` |
| Memo board | `0xf6816854b68CC4B67213289927d8e44050BA62D3` |
| CloakLaunchVault, from block 26707908 | `0x13050b9a0abece56f80d30da107c3f3fad33288f` |
| CloakLaunchSwapV4 | `0xc4b6ce66f12733e6737cda6cc1a882ea05bf99ce` |
| CloakGloamBatcherV4 | `0xbd4a41301b3c0ba2ca07677fd9ba3ba4640d28f8` |
| CloakGloamBids | `0xb3f6f2142439f1b4f088ea24569cc73726dcea32` |
| CloakGloamReceive | `0xa462e810b985029b28b5cee49866760a7f8767bb` |
| CloakGraduation | `0xfd0e96dec9c1edd885e86044790e50e48c1a6268` |
| CloakFundsGate / CloakReceiptCheck | `0x79aafd041a283c334421a17c781b12e353093210` / `0xb0a8fcbd75f4d6d2ce5a0121e8607aa353990304` |
| PoolManager (Uniswap v4 on testnet) | `0x51027076df8416e42ea8438b27a0c433d9662e68` |

The full record: [`deployments/elysium-testnet-gloam.json`](deployments/elysium-testnet-gloam.json) and [`deployments/elysium-testnet-v2-factory.json`](deployments/elysium-testnet-v2-factory.json). The SDK carries the same addresses (`deploymentFor(99801)`). Every rule, with its number: [`docs/RULES.md`](docs/RULES.md). Mainnet plan: [`docs/MAINNET-V2.md`](docs/MAINNET-V2.md).

## Layout

```
contracts/          Foundry: the launch side (CloakConfig, CloakFactory, CloakAuction, CloakToken, CloakVesting, drops)
contracts-gloam/    Cloak's contracts around Gloam's vault: CloakLaunchVault and the escrows
contracts-v4/       The v4 side: CloakV4Hook, CloakLaunchSwapV4, CloakGloamBatcherV4, tested on the real PoolManager
vendor/gloam/       Gloam's repository, pinned. Never edited
packages/sdk/       @cloakely/sdk: launches (Cloak) and private balances (GloamPrivate)
packages/mcp/       @cloakely/mcp: an MCP server so agents can launch, bid and trade privately
services/keeper/    Reveals and settles launches, relays private actions (POST /gloam/relay), runs batch rounds,
                    holds split withdrawals (POST /schedule) and serves the vaults' leaf lists (GET /leaves)
apps/web/           The site (Vite + React), on Vercel
e2e-gloam/          End-to-end runs: anvil, forks of testnet and live
```

## For launchpads: `@cloakely/sdk`

```ts
import { Cloak, GloamPrivate, deploymentFor, gloamProvers, gloamRelaySubmitter } from "@cloakely/sdk";
const d = deploymentFor(99801);
const cloak = new Cloak(publicClient, walletClient, d.factory);

await cloak.createLaunch({ name: "Shade", symbol: "SHADE", /* sale, ticks, windows */ });
await cloak.bid(auction, { maxPrice, quantity }); // a hash and a drand ciphertext on chain, nothing else

const g = d.gloam;
const priv = await GloamPrivate.unlock(walletClient, {
  publicClient, chainId: 99801, payMemo: g.memoBoard, whype: g.whype,
  gloamVault: { pool: g.gloamVault, poolBlock: g.block },
  launchVault: { pool: g.launchVault, poolBlock: g.launchVaultBlock ?? g.block },
  launchSwapV4: g.launchSwapV4, batcherV4: g.batcherV4, receive: g.receive, bids: g.bids,
  provers: gloamProvers(), submit: gloamRelaySubmitter(KEEPER_URL),
});
await priv.shieldHype(walletClient, parseEther("1")); // the one public step
await priv.buy(token, parseEther("0.25"));            // the relay sends it, your wallet never shows
await priv.batch(token, "buy", parseEther("0.37"));   // size hidden too
```

## Run it

Prerequisites: Node 22, pnpm, Foundry. In a container, Node's `fetch` needs `NODE_USE_ENV_PROXY=1`.

```bash
pnpm install && pnpm build
pnpm test                       # forge (contracts, contracts-gloam, contracts-v4) and the SDK tests
node e2e-gloam/part7-adapter.mjs  # the site's backend end to end on anvil, real proofs
```

The full list of end-to-end runs is in [`.github/workflows/ci.yml`](.github/workflows/ci.yml) and [HANDOVER.md](HANDOVER.md).

### Hosting

| Part | Where | Notes |
|---|---|---|
| Site | Vercel, root `apps/web` | Env `VITE_KEEPER_URL` and `VITE_RELAYER_URL` (the keeper's URL). Addresses come from the SDK, never from env |
| Keeper | Render free plan, [`render.yaml`](render.yaml) | `KEEPER_PK` in Render's dashboard. Sleeps when idle and wakes on the site's first request. See [docs/OPTIMIZATION.md](docs/OPTIMIZATION.md) |

## Honest limits

- **Hidden:** who traded, what each account holds, which trades belong together, and in batch mode each trader's size. Private sends hide the amount.
- **Visible:** an instant trade's size and direction on the public pool, a batch round's net, and the amounts of deposits and withdrawals.
- **Batch privacy needs company.** Alone in a round, your orders add up to your trade.
- **Timing can link you.** Shielding 1 HYPE and buying with exactly 1 HYPE right after is easy to connect.
- **The relay** can refuse or delay a call and sees your IP. It can't change anything: the proof binds every field. Anyone can run one.
- **Sealed bids** rely on the drand network. A threshold of its members colluding could open bids early.
- **Not audited yet.** Testnet only, with caps.

## License

[MIT](LICENSE) © 2026 Bob Labs. Gloam's code under `vendor/gloam` and the verifiers exported from Gloam's keys keep their own licenses (GPL-3.0 headers).
