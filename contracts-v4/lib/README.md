# Vendored Uniswap v4 source

Only what Cloak compiles against, copied unchanged.

| Folder | Upstream | Commit | Licence |
|---|---|---|---|
| `v4-core/src` | https://github.com/Uniswap/v4-core | `bea7f6d1c11cd5dc4f0d5151ffa37a1c239feee6` | BUSL-1.1 for the PoolManager and its internals, MIT for the interfaces, types and math libraries (see `v4-core/licenses`) |
| `v4-periphery/src/libraries/LiquidityAmounts.sol` | https://github.com/Uniswap/v4-periphery | `c6e4754dab11bd38c6f08ac51c3c868569e93d64` | MIT |

| `solmate/src/auth/Owned.sol` | https://github.com/transmissions11/solmate | main | MIT (used by the PoolManager) |

`CloakV4Hook` and `CloakV4Market` only use MIT files. The BUSL PoolManager is deployed by Cloak on testnet only
(non-production use, as the licence allows); on mainnet Cloak uses Uniswap's own PoolManager. Built with
`FOUNDRY_PROFILE=uniswap`, its runtime bytecode is identical to the official PoolManager on Elysium mainnet
(0xe2e105d3f7209a9da11f83ccf3e7398a753823f1) apart from its own address (`e2e/check-v4-bytecode.mjs`).
