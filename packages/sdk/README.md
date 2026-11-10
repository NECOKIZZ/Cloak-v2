# @cloakely/sdk

TypeScript SDK for [Cloak](https://cloak.boblabs.tech): fair launches and private trading on Kinetiq's **Elysium**, built on [Gloam](https://github.com/gloamtrade/gloam)'s shielded vault.

**Launches**
- Sealed-bid token launches that bots can't front-run.
- Everyone pays one clearing price.
- Each launch opens a Uniswap v4 pool at that price, with liquidity locked forever.

**Private trading**
- Shielded balances: buy, sell, send and batch-trade without your wallet appearing.
- Zero-knowledge proofs are made on the user's device, on Gloam's final ceremony keys.
- A relayer sends the transaction and pays its gas, but it can't change anything.

Live on Elysium testnet (chain `99801`). Mainnet (`99901`) is coming, in stages. Built on [viem](https://viem.sh).

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
const cloak = new Cloak(publicClient, walletClient, d.factory);

// a sealed-bid launch: at settlement it opens a Uniswap v4 pool at the clearing price
const now = Math.floor(Date.now() / 1000);
const { auction } = await cloak.createLaunch({
  name: "Shade", symbol: "SHADE",
  saleSupply: 1_000_000n * 10n ** 18n,
  minPrice: 10n ** 12n, tickSize: 10n ** 12n, numTicks: 100,
  commitEnd: now + 3600, revealEnd: now + 3600 + 600, // a reveal window of 5 minutes to 7 days
  lpBps: 5000, lpLockUntil: "fees",                   // locked forever, the creator earns the trading fees
});

// a bidder: a hash and a drand time-locked ciphertext on chain, nothing else
await cloak.bid(auction, { maxPrice: parseEther("0.00002"), quantity: parseEther("10000") });

// anyone (usually the hosted keeper)
await cloak.revealAll(auction);
await cloak.settle(auction);
await cloak.claimAll(auction);
```

## Private trading

```ts
import { GloamPrivate, deploymentFor, gloamProvers, gloamRelaySubmitter } from "@cloakely/sdk";

const g = deploymentFor(elysiumTestnet.id).gloam!;
const priv = await GloamPrivate.unlock(walletClient, {
  publicClient, chainId: elysiumTestnet.id, payMemo: g.memoBoard, whype: g.whype,
  gloamVault: { pool: g.gloamVault, poolBlock: g.block },
  launchVault: { pool: g.launchVault, poolBlock: g.launchVaultBlock ?? g.block },
  launchSwapV4: g.launchSwapV4, batcherV4: g.batcherV4, receive: g.receive, bids: g.bids,
  provers: gloamProvers(),                 // Gloam's circuits, fetched once and hash-checked
  submit: gloamRelaySubmitter(KEEPER_URL), // the relay sends it, so the wallet never appears
});
await priv.loadMarkets();

await priv.shieldHype(walletClient, parseEther("1"));        // the one public step
await priv.buy(token, parseEther("0.25"));                   // private buy through the launch's pool
await priv.sell(token, parseEther("1000"));
await priv.trade(usdc, token, parseUnits("100", 6));         // any two markets, through HYPE, one swap
await priv.batch(token, "buy", parseEther("0.37"));          // batch round: trade size hidden too
await priv.send(token, "cloak:…", parseEther("100"));        // private transfer: amount hidden
await priv.bidPrivately(auction, { maxPrice, quantity });    // a sealed bid paid from the private balance
await priv.unshieldHype(freshAddress, parseEther("0.5"));    // back to any wallet
console.log(await priv.balance(priv.hypeMarket.pool));       // only this account can see it
```

The private account comes from one EIP-712 signature bound to the chain only, so it and the `cloak:` address never change. The same wallet always restores it, and nothing is stored on a server.

**Receive addresses and bridging.** `receiveAddress(n)` gives a normal address anyone can pay, from a wallet or an exchange, and `collectReceived()` moves what arrived into the private balance. `relayQuote()` bridges from 20 chains into one through Relay, to an Elysium mainnet receive address.

**Vault caps.** The vaults cap each deposit for now (Gloam's mainnet vault starts at 12 HYPE). The SDK splits anything bigger to fit, automatically:
- a deposit goes in as several;
- a trade goes in as several, one after another (`tradePlan()` shows how many first);
- a bid goes in as several sealed bids at the same price (`bidPieces()`).

`depositCaps()` reads the caps live.

## The vaults

- **Gloam's main vault**, run by Gloam, holds HYPE, USDC and the tokens Gloam lists.
- **Cloak's launch vault** holds Cloak launch tokens.
- **Cloak's ecosystem vault** holds other projects' tokens that Cloak lists.

All three run Gloam's vault code and keys. The last two are Cloak's own, and Cloak runs them. A private trade between vaults is one call through Cloak's router. The router picks each token's vault, so a caller can't send a swap anywhere else.

## Fees

| Action | Fee |
|---|---|
| Deposits and private sends | free |
| Withdrawals, private buys, batch orders and bids from Gloam's vault | 0.5%, Gloam's vault fee (Gloam shares part of it with Cloak) |
| Private sales out of Cloak's vaults | 0.25% of what the sale brings, in HYPE or USDC |
| Successful launch | 1.5% of the raise |
| Launch pool trading | 0.3% (10% at listing, falling over 5 minutes): 80% to the creator, 20% to Cloak |
| Relayer | free: Cloak pays the gas |

No function in any Cloak contract can move user funds. A note leaves a vault only with its owner's proof.

## NFT drops and WL spot sales

```ts
import { CloakDrops, CloakSpots } from "@cloakely/sdk";
const dep = deploymentFor(elysiumTestnet.id);
const drops = new CloakDrops(publicClient, walletClient, dep.dropFactory!, dep.dropFactoryBlock);

const { drop } = await drops.create({ name: "Moonfoxes", symbol: "MOON", baseURI: "", supply: 1000, floor: parseEther("0.5"), biddingSecs: 86400 });
await drops.bid(drop, { price: parseEther("0.7"), quantity: 1 }); // sealed to a drand round
await drops.claim(drop, bidId);
```

## Exports

| Export | What it is |
|---|---|
| `Cloak` | Launches: `createLaunch`, `bid`, `revealAll`, `settle`, `claimAll`, `getAuction`, `listLaunches` |
| `GloamPrivate` | Private balances: `unlock`, `shieldHype`, `shieldToken`, `buy`, `sell`, `trade`, `batch`, `send`, `bidPrivately`, `unshieldHype`, `unshieldToken`, `balance`, `depositCaps`, `tradePlan`, `receiveAddress`, `collectReceived` |
| `CloakDrops`, `CloakSpots` | Sealed NFT drops and WL spot sales |
| `gloamProvers`, `gloamRelaySubmitter` | The on-device prover on Gloam's circuits, and the relay |
| `relayQuote`, `relayStatus` | Bridging into Elysium through Relay |
| `deployments`, `deploymentFor` | Addresses and start blocks per chain |
| `elysium`, `elysiumTestnet` | The viem chains |

Docs: [cloak.boblabs.tech/docs](https://cloak.boblabs.tech/docs). Cloak's own contracts aren't audited yet, so the vaults run with deposit caps. MIT licensed.
