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
import { Cloak, deploymentFor, elysiumTestnet, legacyFactories } from "@cloakely/sdk";

const d = deploymentFor(elysiumTestnet.id);
const publicClient = createPublicClient({ chain: elysiumTestnet, transport: http() });
const walletClient = createWalletClient({ chain: elysiumTestnet, transport: custom(window.ethereum) });
// earlier factories too, so every launch lists, settles and pays out
const cloak = new Cloak(publicClient, walletClient, d.factory, legacyFactories(d));

// a project or launchpad: a sealed-bid launch. At settlement it opens a Uniswap V2 pool (token / WHYPE) at the
// clearing price, with the LP burned ("burn") or locked until a date
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

const s = await cloak.getAuction(auction);
s.uniPair; // the Uniswap V2 pool, tradable and trackable anywhere (zero for launches before Nov 2, which use a CloakPair)
s.pair;    // the market Cloak's private router and batcher trade: a CloakV2Market in front of that pool
```

## Private trading

```ts
import { CloakPrivate, deploymentFor, elysiumTestnet, loadProver, relayerSubmitter } from "@cloakely/sdk";

const d = deploymentFor(elysiumTestnet.id);
const keys = await CloakPrivate.keysFromWallet(walletClient, { chainId: d.chainId, verify: true });
const priv = new CloakPrivate(
  publicClient, d.router, keys,
  () => loadProver(d.circuitsUrl),     // 12 MB of circuit files, fetched once and hash-checked
  relayerSubmitter(d.relayerUrl),      // the relayer submits, so the wallet never appears
  d.vaultsBlock!, d.batcher, d.migrator, // notes are scanned from the permanent vaults' first block
);
await priv.loadMarkets();

await priv.shieldHype(walletClient, parseEther("1"));     // the one public step
await priv.buy(token, parseEther("0.25"));                // private buy through the launch's Uniswap pool
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

Launches from Nov 2 on keep their private balances in one shared launch-token vault (a testnet experiment). There a
private send doesn't even show which token moved: its relayer is paid from your private HYPE in the same transaction.

```ts
const shared = new SharedVaultClient(
  priv, d.shared!, d.sharedRouter!,
  () => loadSharedProver(d.circuitsUrl),  // its own circuit (the token is inside each note), hash-checked
  sharedRelayerSubmitter(d.relayerUrl), d.sharedBlock,
);
await shared.buy(token, parseEther("0.25"));          // private HYPE → private token, through the Uniswap pool
await shared.send(token, parseEther("100"), "cloak:…"); // amount, parties and the token itself hidden
await shared.sell(token, parseEther("50"));           // back to private HYPE
await shared.unshield(token, parseEther("10"), freshAddress);
console.log(await shared.balances());                 // every token this account holds there
```

The private account comes from one EIP-712 signature bound to the chain only (never to a contract), so it and the `cloak:` address never change. The same wallet always restores it, and nothing is stored on a server. In Node, read the circuit files yourself and pass them to `createProver(wasm, zkey)`.

## NFT drops and WL spot sales

```ts
import { CloakDrops, CloakSpots, deploymentFor, elysiumTestnet, parseEther } from "@cloakely/sdk";
const dep = deploymentFor(elysiumTestnet.id);
const drops = new CloakDrops(publicClient, walletClient, dep.dropFactory!, dep.dropFactoryBlock);

const { drop } = await drops.create({ name: "Moonfoxes", symbol: "MOON", baseURI: "", supply: 1000, floor: parseEther("0.5"),
  gtd: { list: [{ wallet: "0x…", spots: 2 }], price: parseEther("0.4"), durationSecs: 86400 },
  wl: { list: ["0x…"], boostBps: 2000 }, biddingSecs: 86400 });
await drops.bid(drop, { price: parseEther("0.7"), quantity: 1 });   // sealed to a drand round; WL wallets pass wl: true
await drops.claim(drop, bidId);                                      // or claimTo(drop, bidId, freshWallet)

// sell a partner collection's WL spots: winners name the wallet to whitelist
const spots = new CloakSpots(drops, dep.spotBook!);
const sale = await spots.create({ name: "Moonfoxes WL spots", symbol: "MOONWL", supply: 5, floor: parseEther("0.5"), biddingSecs: 86400, partner: "Moonfoxes" });
await spots.setWallets(sale.drop, bidId, ["0x…"]);                   // one per spot won, until the deadline
const csv = CloakSpots.csv(await spots.winners(sale.drop));          // the list for the partner
```

The creator's price is the floor. Bids rank by price (WL bids by price × (1 + boost)), every winner pays one clearing
price (WL winners pay it ÷ (1 + boost), never under the floor), ties are drawn from every bid's sealed salt, and a drop
settles as soon as every bid is open. Every bid must cover one NFT at the floor; a bid still sealed at the end of the
reveal window loses 10%.

## Fees (testnet beta)

| Action | Fee |
|---|---|
| Deposits and private sends | free |
| Withdrawals, private swaps and batch orders | 0.25% |
| Successful launch | 1.5% of the raise |
| Relayer | the relayer's gas plus a margin, paid inside the proof |

Rules live in the on-chain `CloakConfig`, and no function in any Cloak contract can move user funds. Testnet is still in setup, so the owner can change fees and caps at once (within hard ceilings of 1% and 3%); once setup ends, before mainnet, raising a fee or a cap waits a public 3-day delay. Every rule with its number: [docs/RULES.md](https://github.com/NECOKIZZ/Cloak/blob/main/docs/RULES.md).

## Exports

| Export | What it is |
|---|---|
| `Cloak` | Launches: `createLaunch`, `bid`, `revealAll`, `settle`, `claimAll`, `payOut`, `getAuction`, `listLaunches` |
| `CloakPrivate` | Private balances: `shieldHype`, `shieldToken`, `buy`, `sell`, `batch`, `send`, `unshieldHype`, `unshieldToken`, `addAsset`, `balance`, `maxSpendable`, `migrateFrom` |
| `CloakDrops` | Sealed NFT drops: `create`, `get`, `details`, `listed`, `gtdMint`, `bid`, `bids`, `revealAll`, `settle`, `claim`, `claimTo`, `claimAll`, `withdrawRefund`, `payOut`, `mintUnsold` |
| `CloakSpots` | WL spot sales: `create`, `open`, `sale`, `sales`, `winners`, `setWallets`, `CloakSpots.csv` |
| `relayerSubmitter`, `walletSubmitter` | How private calls are submitted: through a relayer (private), or from a wallet (for tests) |
| `loadProver`, `createProver` | The Groth16 prover, running on the device |
| `deployments`, `deploymentFor` | Addresses, start blocks, relayer and circuit URLs per chain |
| `elysiumTestnet` | The viem chain |
| `*Abi`, `@cloakely/sdk/bytecode` | Contract ABIs and bytecode |

Docs: [cloak.boblabs.tech/docs](https://cloak.boblabs.tech/docs). Source and contracts: [github.com/NECOKIZZ/cloak](https://github.com/NECOKIZZ/cloak). Unaudited testnet software. MIT licensed.
