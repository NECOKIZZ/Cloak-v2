# Mainnet readiness (Elysium, chain 99901)

Checked Nov 4 against the live chain through ElysPump's relay (`rpc-live.elysp.com`). Nothing here spent real funds.

## 1. The chain runs what Cloak needs (`e2e/check-mainnet.mjs`)
Read-only eth_calls on mainnet itself, so these are the chain's own precompiles, not a local EVM's:

| Check | Result |
|---|---|
| BN254 add, mul and pairing (0x06, 0x07, 0x08), used by every Groth16 verifier | correct, and a wrong pairing is refused |
| modexp (0x05), sha256 (0x02) | correct |
| PUSH0, TSTORE/TLOAD, MCOPY (our shanghai and cancun builds) | run |
| Block gas limit | 2^50, far above our largest deploy and a proof verification |
| CREATE2 deployer `0x4e59…956c` (the v4 hook is mined through it) | present |
| Multicall3, Permit2 | present |
| Universal Router, V4 Quoter, StateView, PositionManager | all point at the PoolManager `0xe2e1…23f1` |
| PoolManager runtime | byte-identical to the Uniswap build Cloak tests against (apart from its own address) |
| **Real Cloak proofs** (3 from the single-asset vaults, 3 from the shared vault, made in the rehearsal below), replayed on mainnet through our verifiers' exact runtime | all 6 accepted, and each one refused with a single bit changed |

29/29 checks pass (`VERIFY_FILE=deployments/elysium-mainnet.proofs.json node e2e/check-mainnet.mjs`; the proofs come
from `e2e/capture-proofs.mjs`).

## 2. The whole stack, deployed from scratch on Uniswap's mainnet contracts
`e2e/deploy-mainnet.mjs` deploys everything a fresh chain needs in one run: verifier, config with fees and caps, the v4
hook at its flagged address on Uniswap's PoolManager, the v4 launch factory, WHYPE, the vaults, router and batcher, the
shared launch-token vault with its router and batcher, the NFT drop factory and the WL spot book, all registered in the
config. It reads everything back before writing the record.

Rehearsal: the public relay is too slow to serve a forked chain (it timed out mid-run), so `e2e/mirror-mainnet.mjs`
copies the official contracts' exact mainnet bytecode (and first storage slots) onto a local chain at their real
addresses. On that copy:
- `deploy-mainnet.mjs`: every check passes, about 0.044 HYPE of gas at mainnet's 0.1 gwei base fee
- `POOL=v4 DEPLOY_FILE=deployments/elysium-mainnet.fork.json node e2e/shared.mjs` with a local keeper: **23/23**. A
  sealed launch (one wallet bid, one paid from a private balance) settles into a v4 pool on Uniswap's PoolManager at the
  clearing price, with the 10% anti-snipe fee at listing; the token goes into the shared vault; a hidden send names no
  token; a private sell and buy go through the v4 pool; a withdrawal to a fresh wallet; the vault holds exactly its
  notes plus fees; a tampered proof moves nothing; the creator is paid exactly the trading fees.
- `MAINNET_RPC=… forge test --match-contract CloakV4Mainnet` (in `contracts-v4`): **5/5**. Uniswap's own Universal
  Router buys and sells a Cloak pool (Permit2 for the sell) and pays the creator fee, Uniswap's V4 Quoter prices it
  the same as Cloak's market, StateView reads it at the clearing price, Cloak's market still trades it, and Uniswap's
  PositionManager is refused (`OnlyHook`) when it tries to add liquidity. So wallets and aggregators that route
  through Uniswap can trade Cloak launches, and nobody can add liquidity behind the hook's back.

## 3. Findings
- **Mainnet's WHYPE is an upgradeable proxy** (`0xbA87…5E81`, a TransparentUpgradeableProxy, the WETH9 Uniswap's
  PositionManager uses). Its admin can change how it behaves, so Cloak's HYPE vault must not hold it.
  `deploy-mainnet.mjs` deploys Cloak's own fixed WHYPE by default. v4 pools trade native HYPE, so this changes nothing
  for launches.
- **The Universal Router hands v4 swaps to a second contract** (`0xdCD9…4734`, 11.6 KB). Found by tracing a router
  swap; `mirror-mainnet.mjs` copies it too. Nothing for Cloak to change.
- **The PoolManager's owner is an ordinary wallet** (`0x2179…27b6`), not Uniswap governance. It can only turn on
  protocol fees (capped in the contract), never move pool funds. Protocol fees are off today (no fee controller).
- **Deposit caps:** the testnet record described launch-token caps as 1%/10% of supply. The live testnet config uses
  10%/50%; the record and the mainnet script now match the live config.

## 4. Still to do before mainnet
- the public trusted-setup ceremony, then the verifier through the config
- a multisig as owner, then `endSetup()`
- separate treasury, keeper and relayer keys
- deploy with `DEPLOYER_PK=… node e2e/deploy-mainnet.mjs`, verify every contract, publish the addresses, add the
  mainnet record to the SDK
- mainnet USDC's address for a private USDC vault (`USDC=0x…`)
