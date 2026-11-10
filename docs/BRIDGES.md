# Money in from other chains and exchanges

Everything lands at one of the account's **receive addresses** (CloakGloamReceive) on Elysium, never at the wallet.
The app moves what arrives there into the private balance, as with any payment to a receive address. So one landing
spot serves every way in: an exchange withdrawal, a bridge, or someone paying you.

## Relay (live on Elysium mainnet, built Nov 10)

Relay serves Elysium mainnet (chain 99901) with HYPE and USDC. It doesn't serve the testnet, so on testnet the panel
shows a short "opens on mainnet" card (`VITE_BRIDGE_PREVIEW=1` shows the full panel with live mainnet quotes, sending
nothing).

- **From an exchange or any wallet:** a one-time Relay deposit address on the source chain. The user withdraws there
  from the exchange on that network. No wallet connection needed, and the wallet never appears.
- **From a connected wallet (EVM chains):** the wallet signs Relay's transactions on the source chain (an exact
  approve, then the deposit; or one transaction for the chain's own coin), then switches back to Elysium. This links
  that wallet to the receive address, so the app suggests a new address afterwards.
- **Checked before anything is shown or signed** (`packages/sdk/src/bridge/relay.ts`): source chain, token and amount;
  destination chain and token; that Relay's recipient is exactly the receive address; in wallet mode, that every
  transaction is on the source chain from that wallet, and that an approve is exact and only to the deposit contract.
  Anything else is refused. 9 offline tests (`packages/sdk/test/relay.test.mjs`), and live quotes checked on Nov 10.
- **Sources** (live deposit-address quotes into Elysium HYPE on Nov 10): HyperEVM (HYPE, USDC), Arbitrum, Base,
  Ethereum, BNB Chain, Tron, Optimism, Polygon, Avalanche, Monad, Unichain, Linea, World Chain, Sonic, Mantle,
  Berachain, zkSync Era, Scroll, Ink, and Bitcoin (to recheck with a real refund address). Relay's fee was $0.08 to
  $0.30 on $20 from most chains; Tron about $2.50.
- **Solana** deposit addresses need a Relay API key, which a public site can't hold. Off until we have one and a small
  server route (the keeper could proxy it).
- **Tracking:** the panel follows each transfer through Relay's status API (kept on the device for 3 days) and moves
  the money in as soon as it arrives.
- **No Cloak fee on bridging.** Relay can add an app fee (`appFees`); not set.

## Spicenet (Spice Flow): partnership, waiting on their Elysium release

From their docs (spiceflow-docs.spicenet.io, read Nov 10):

- **What it is:** a React SDK (`@spicenet-io/spiceflow-ui` 4.23.1, core 0.10.0). The app defines destination calls;
  the SDK funds them from the user's assets on any supported chain, through EIP-7702 delegation of the user's own
  wallet, and runs them on the destination chain from that wallet.
- **Elysium:** prepared but not live. Core `0.10.1-elysium.0` (npm tag `release-elysium`) has Elysium mainnet's
  metadata (HYPE, WHYPE `0xbA87…5E81`, USDC `0xb47c…0B65`, their delegate `0x8AA0…299f`, escrow `0x7839…6102`), but
  the stable UI doesn't include it, UI 4.23.2 and core 0.10.1 aren't published, and their service activation on
  Elysium is pending. Testnet 99801 is out of their integration.
- **Exchanges and cards:** their `swapper` deposits land only on Base or Arbitrum, so exchanges into Elysium go
  through Relay's deposit addresses either way.
- **Needs:** Privy (`@privy-io/react-auth`, a Privy app id from privy.io), wagmi and react-query in the site. Our site
  is React 18 as required.
- **The integration once it's live:** `SpiceSupply` with `destinationToken` Elysium USDC (or HYPE) and
  `buildActionCalls` returning one call, a transfer of the amount to the user's receive address. The rest of the flow
  is the same as Relay's. Loaded only on the Receive page, so the Privy and wagmi weight stays out of every other page.
- **Privacy:** like Relay's wallet mode, the call runs from the user's own wallet, so it links that wallet to the
  receive address. The 7702 delegation stays on the wallet until cleared.
