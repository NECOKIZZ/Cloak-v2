# @cloakely/sdk

TypeScript SDK for [Cloak](https://cloak.boblabs.tech), fair launches and private trading on Kinetiq's **Elysium**.

**Launches**
- Sealed-bid token launches that bots can't front-run.
- Everyone pays one clearing price.
- The launch's pool is seeded at that price.

**Private trading**
- Shielded balances: buy, sell, send and batch-trade launch tokens without your wallet appearing.
- Zero-knowledge proofs are made on the user's device.
- A relayer submits the transaction, but it can't change it.

Live on Elysium testnet (chain `99801`). Built on [viem](https://viem.sh).

```bash
npm install @cloakely/sdk viem
```

## Launches

```ts
import { createPublicClient, createWalletClient, custom, http, parseEther } from "viem";
import { Cloak, deploymentFor, elysiumTestnet } from "@cloakely/sdk";

const d = deploymentFor(elysiumTestnet.id);
const publicClient = createPublicClient({ chain: elysiumTestnet, transport: http() });
const walletClient = createWalletClient({ chain: elysiumTestnet, transport: custom(window.ethereum) });
const cloak = new Cloak(publicClient, walletClient, d.factory, d.legacy?.factory);

// a project or launchpad: a sealed-bid launch, with liquidity seeded at the clearing price
const now = Math.floor(Date.now() / 1000);
const { auction } = await cloak.createLaunch({
  name: "Shade", symbol: "SHADE",
  saleSupply: 1_000_000n * 10n ** 18n,
  minPrice: 10n ** 12n, tickSize: 10n ** 12n, numTicks: 100,
  commitEnd: now + 3600, revealEnd: now + 3600 + 600,
  lpBps: 5000, lpLockUntil: "burn",
});

// a bidder: hashed, timelock-encrypted to the drand round when bidding ends, deposit rounded up to a bucket
await cloak.bid(auction, { maxPrice: parseEther("0.00002"), quantity: parseEther("10000") });

// anyone (usually the hosted keeper)
await cloak.revealAll(auction);
await cloak.settle(auction);
await cloak.claimAll(auction);
await cloak.payOut(auction); // the creator's proceeds, and the launch fee to the treasury
```

## Private trading

```ts
import { CloakPrivate, deploymentFor, elysiumTestnet, loadProver, relayerSubmitter } from "@cloakely/sdk";

const d = deploymentFor(elysiumTestnet.id);
const keys = await CloakPrivate.keysFromWallet(walletClient, { chainId: d.chainId, router: d.router, verify: true });
const priv = new CloakPrivate(
  publicClient, d.router, keys,
  () => loadProver(d.circuitsUrl),     // 12 MB of circuit files, fetched once and hash-checked
  relayerSubmitter(d.relayerUrl),      // the relayer submits, so the wallet never appears
  d.routerBlock, d.batcher, d.migrator,
);
await priv.loadMarkets();

await priv.shieldHype(walletClient, parseEther("1"));     // the one public step
await priv.buy(token, parseEther("0.25"));                // private buy through the launch's pool
await priv.batch(token, "buy", parseEther("0.37"));       // batch round: trade size hidden too
await priv.send(token, "cloak:…", parseEther("100"));     // private transfer: amount hidden
await priv.unshieldHype(freshAddress, parseEther("0.5")); // back to any wallet
console.log(await priv.balance(priv.hypeMarket.pool));    // only this account can see it
```

Private USDC lives in its own vault. Register it from the deployment, then shield, send and withdraw like any token:

```ts
const usdc = priv.addAsset(d.assets![0]);                                // { symbol: "USDC", decimals: 6, … }
await priv.shieldToken(walletClient, usdc.token, parseUnits("50", 6));   // approve + deposit (public, once)
await priv.send(usdc.token, "cloak:…", parseUnits("20", 6));             // amount hidden
await priv.unshieldToken(usdc.token, freshAddress, parseUnits("10", 6)); // 0.25% fee kept
```

The private account comes from one EIP-712 signature bound to the chain and the router. The same wallet always restores it, and nothing is stored on a server. In Node, read the circuit files yourself and pass them to `createProver(wasm, zkey)`.

## Fees (testnet beta)

| Action | Fee |
|---|---|
| Deposits and private sends | free |
| Withdrawals, private swaps and batch orders | 0.25% |
| Successful launch | 1.5% of the raise |
| Relayer | the relayer's gas plus a margin, paid inside the proof |

Rules live in the on-chain `CloakConfig`. Raising a fee or a cap waits a public 3-day delay, and no function in any Cloak contract can move user funds.

## Exports

| Export | What it is |
|---|---|
| `Cloak` | Launches: `createLaunch`, `bid`, `revealAll`, `settle`, `claimAll`, `payOut`, `getAuction`, `listLaunches` |
| `CloakPrivate` | Private balances: `shieldHype`, `shieldToken`, `buy`, `sell`, `batch`, `send`, `unshieldHype`, `unshieldToken`, `addAsset`, `balance`, `maxSpendable`, `migrateFrom` |
| `relayerSubmitter`, `walletSubmitter` | How private calls are submitted: through a relayer (private), or from a wallet (for tests) |
| `loadProver`, `createProver` | The Groth16 prover, running on the device |
| `deployments`, `deploymentFor` | Addresses, start blocks, relayer and circuit URLs per chain |
| `elysiumTestnet` | The viem chain |
| `*Abi`, `@cloakely/sdk/bytecode` | Contract ABIs and bytecode |

Docs: [cloak.boblabs.tech/docs](https://cloak.boblabs.tech/docs). Source and contracts: [github.com/NECOKIZZ/cloak](https://github.com/NECOKIZZ/cloak). Unaudited testnet software. MIT licensed.
