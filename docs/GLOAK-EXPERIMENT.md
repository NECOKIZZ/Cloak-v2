# GLOAK: the private-only token experiment (build)

Nov 11. For partners, the token's mechanics are in `docs/GLOAK.md`. This page is the build: what GLOAK is, the rules it follows, every change it needs in Cloak's code, how the owner wallet runs it, and what's tested. GLOAK is a one-time experiment: the first and last of its kind on Cloak. It doesn't touch $CLOAK (`docs/CLOAK.md`) or the ecosystem vault.

## In one paragraph

GLOAK is a token meant to live in private vaults. It launches on Cloak like any launch (sealed bids, one price, a v4 pool), but through a one-time door that gives it its own token code. Bringing GLOAK into a vault and trading it privately are free. Taking it out to a public address, or moving it between public addresses, burns 10%. Its pool only serves private routers, so nobody can buy or sell it in public. Other privacy protocols can hold and trade it once the owner wallet approves their vault and router.

## Decided

- **The surcharge:** 10%, all burned. The owner can lower it, never raise it.
- **No team share.** The whole supply is sold in the sealed-bid auction or goes into the pool.
- **Cloak is the creator.** The pool's liquidity is locked forever with its fees to Cloak's treasury. Those fees fund buybacks: the treasury buys GLOAK privately and sends it to 0x…dEaD (sending to 0x…dEaD is free).
- **The bid cap stays** at 10,000 HYPE per launch.
- **New approvals wait 3 days in public** once setup ends. Removing one is instant.
- **What the owner wallet can approve is limited**, during setup too: it can never let an address send GLOAK tax-free, and it can open Uniswap to contracts only, never to a wallet. Everything else it can grant only makes GLOAK arriving free, never leaving.
- **A privacy meter** on the token shows how much GLOAK is in vaults, in the pool and in public.
- **Built for one use.** The door closes after one launch, and only that launch's pool is private.

## How it works, in plain words

The token keeps a short list of approved contracts. Each gets one or more roles:

| Role | What it means | Who gets it |
|---|---|---|
| Receive | Sending GLOAK to it is free | Vaults, routers, batch rounds, the hook |
| Send | It can send GLOAK anywhere for free | The launch's auction (it pays bidders), the hook |
| Feed | It can send GLOAK into Uniswap | The hook, routers, batch rounds |
| Swap | It can swap in GLOAK's pool | Routers; the pool's market adapter if batch rounds are on |
| Vault | A private vault: its withdrawals pay 10% | The launch vault, later other protocols' vaults |
| Payee | A router or batch round that one-time escrows pay | Routers, batch rounds |

What each move costs:

| Move | Cost |
|---|---|
| Shield into a vault | Free, exact amount |
| Buy or sell privately (router, batch round) | Free |
| Withdraw from a vault to a public address | 10% burned |
| Public address to public address | 10% burned |
| A router's leftover taken out in public (exit) | 10% burned |
| A public address paying into Uniswap (selling, adding liquidity, minting claims) | Refused |
| Anyone not approved swapping in GLOAK's pool (Universal Router, aggregators, bots) | Refused |
| Sending to 0x…dEaD | Free |

**Why a private sell isn't charged.** Every private sell passes its tokens through a one-time escrow: an address made for that one swap, which the token can't recognise in advance. So the vault's payment to the escrow is charged 10% like any withdrawal. In the same transaction the escrow hands everything to the router, and the token gives the 10% back to the router. The swap gets the full amount and nothing is burned. A real withdrawal never reaches a router, so its 10% stays burned. The token remembers the refund only for the length of the transaction (transient storage).

**The cloakroom ticket, closed.** Uniswap v4 can leave a buyer's tokens inside Uniswap as claims instead of paying them out, and claims move without the token seeing them. Two rules close that on GLOAK. Only private routers can swap in its pool, and they always pay out into a vault. Only approved contracts can pay GLOAK into Uniswap, so nobody can turn public GLOAK into claims.

## What changes in Cloak's code

Three things. Mainnet isn't deployed yet, so these go into the first deploy and nothing is redeployed.

### 1. The hook: one private pool (`contracts-v4/src/CloakV4Hook.sol`)

This is the change every launch shares. The hook gets one new storage slot, `privatePool`, which is empty unless the door was used. Two places read it.

**When a launch's pool opens** (`seed`, once per launch), the hook asks the factory's token deployer whether this token is the door's token. If it is, it records the pool:

```solidity
_poolOf[token] = id;
_launches[id] = Launch(m, feeTo, uint64(block.timestamp), uint64(block.timestamp), 0);
if (_isDoorToken(token)) privatePool = id;

// Never reverts: a factory or deployer without a door answers no. Only ever records one pool.
function _isDoorToken(address token) internal view returns (bool) {
    if (PoolId.unwrap(privatePool) != bytes32(0)) return false;
    try ICloakFactoryDoor(address(factory)).vestingDeployer() returns (address d) {
        if (d.code.length == 0) return false;
        try ICloakDoor(d).doorToken() returns (address t) {
            return t != address(0) && t == token;
        } catch {}
    } catch {}
    return false;
}
```

**Before every swap** (`beforeSwap`), on that one pool only, the hook asks GLOAK whether the swapper is approved:

```solidity
PoolId id = key.toId();
// the GLOAK experiment's pool only: its token names who may swap (a router that delivers into a vault)
if (PoolId.unwrap(id) == PoolId.unwrap(privatePool) && !IPrivatePoolGate(Currency.unwrap(key.currency1)).canSwap(sender)) {
    revert PrivatePool();
}
```

**How this affects every other launch:**
- **Behaviour: none.** A pool's id is never zero, so for every other pool the check is false and the swap runs exactly as before. The existing tests pass unchanged (219 v4 tests, plus the mainnet fork suite on Uniswap's real Universal Router, Quoter and PositionManager).
- **Gas:** about 6,000 more once, when the pool opens (two read-only calls), and one more storage read on every swap: about 2,100 gas in a real transaction (roughly 1–2% of a swap).
- **Is it one-time?** The check is code in the hook, so it stays there for good: deployed code can't remove itself. What is one-time is what it applies to. `privatePool` can be set once, only for the door's token, and the door works once, so after GLOAK's pool opens the check can never apply to any other pool. For every other token it is permanently inert: one extra storage read per swap.
- **Can it break other launches?** It only reads. Both calls at listing are wrapped so they can't revert. The swap check can only refuse swaps on the door's own pool, and only one pool can ever be recorded, because the door works once. If GLOAK's token misbehaved, only GLOAK's pool would stop.
- **Deploy:** the hook's bytecode changed, so its address is mined again at deploy, which the deploy script already does. The hook stays at 19.6 KB, under the 24 KB limit. Testnet keeps its old hook, so GLOAK on testnet needs a fresh testnet deploy.

### 2. The one-time door (`contracts/src/CloakVesting.sol`)

`CloakVestingDeployer` makes every launch's token for the factory. It gains:
- `doorAdmin`, fixed at deploy: the owner wallet. The deploy script now passes it.
- `useDoor(maker, factory, createLaunchCall)`, owner only and once ever. In one call it arms the door, creates the launch, and checks that this launch took the door's token. If the launch fails, the whole call reverts and the door stays unused. Arming and launching in one call means no other launch can slip in between and take the token.
- `doorUsed` and `doorToken`, readable by anyone. The hook reads `doorToken`.

Every other launch gets a plain `CloakToken` exactly as before, at the cost of one more storage read.

### 3. New contracts (`contracts-v4/src/experiment/GloakToken.sol`)

- `GloakToken`: the token, its rule, the roles, the privacy meter (`meter()`), and the admin's setup-then-3-day-wait controls. The admin can never grant Send (only the auction and the hook have it, from the start), and grants Feed or Swap only to an address with code.
- `GloakMaker`: what the door calls to make GLOAK. Only the door can call it. It fixes GLOAK's private zone at its own deploy, so GLOAK is born with the launch vault, router, batch rounds and private bids approved (under the same limits as the admin: no Send, Feed or Swap only to contracts).

### What doesn't change

The vaults, the router, batch rounds, private bids, the factory, the auction, `CloakConfig`, the trade fee, the keeper, the SDK and the app. GLOAK is admitted to the launch vault and traded by the router like any launch.

Before deploy, regenerate the SDK's ABIs and bytecode (`pnpm abis`), since the deployer and the hook changed.

## Running it (owner wallet)

The scripts are on the `gloak` branch: `e2e-gloam/deploy-gloak.mjs`, `e2e-gloam/gloak-after-settle.mjs` and their library `e2e-gloam/gloak.mjs`. `e2e-gloam/part23-gloak-fork.mjs` rehearses both on a fork of mainnet (it passes in about 35 s).

1. **Deploy mainnet as planned** with this branch's hook and token deployer. The deployer's door belongs to the owner wallet.
2. **Fill in** `deployments/elysium-mainnet-gloak.input.json` from the example: the owner wallet, when bidding closes, and the launch parameters.
3. **Check the plan without sending anything:** `node e2e-gloam/deploy-gloak.mjs --config deployments/elysium-mainnet-gloak.input.json --plan`. It checks the door belongs to the owner wallet and is unused, the hook has no private pool, the factory, hook, config and zone all match, and prints what the sale does at its lowest and highest price.
4. **Deploy the maker:** the same command with `DEPLOYER_PK` and without `--plan`. It deploys `GloakMaker` with GLOAK's private zone (the launch vault, `CloakRouterV4`, `CloakGloamBatcherV4`, `CloakGloamBids`), reads it back, and prints the owner wallet's one transaction: `useDoor(maker, factory, createLaunch(GLOAK))`. The private-bid contract has to be in the zone: a private bidder's winnings pass through it into the vault, and it checks it got the exact amount.
5. **The owner wallet sends that one transaction** before bidding closes. GLOAK is born with its zone approved.
6. **After settlement:** `node e2e-gloam/gloak-after-settle.mjs --record deployments/elysium-mainnet-gloak.json --end-setup`. It checks the pool is the hook's private pool and that the keeper admitted and registered GLOAK, then prints the owner wallet's last two calls: approve the pool's batch-round adapter (Swap), and end setup. From then on a new approval waits 3 days in public.
7. **Another privacy protocol:** once we've vetted their vault and router, queue Receive and Vault for their vault, and Receive, Feed, Swap and Payee for their router. Apply after 3 days.

Bidding uses the normal private-bid flow. Winnings go from the auction into the vault without a surcharge.

**Public bids still work.** Bidders don't need a private balance: the auction pays every winner for free, so a public bidder gets public GLOAK and can shield it for free. The contracts can't require private bids without charging private bidders too, so if only private bids are wanted, the app shouldn't offer public ones. Don't remove the auction's Send role to force it: that charges every claim, private ones included, and Send can never be given back.

**Notes belong to their owners.** Nobody, the owner wallet included, can move someone else's note: the vault has no function for it. So GLOAK can't be moved between vaults in bulk. Each holder moves their own (an approved bridge address they trust, a migrator if one is built, or their own wallet at 10%). Cloak can move only the GLOAK Cloak owns. Pick GLOAK's home vault before launch.

## Moving GLOAK from one vault to another

A note can't move between vaults: each vault has its own tree. Moving is always a withdrawal from one vault and a deposit into the other, and the withdrawal is what pays 10%. Two ways to make it free:

- **An approved address (works now, no new code).** The owner wallet approves an address to receive (Receive, 3 days in public). Withdrawing to it is free, and its deposit into the other vault is free. What it sends anywhere else still pays 10%, so it isn't a way out. The limits: whoever holds that address holds the tokens in between, and the withdrawal and deposit are public and linked by amount and timing. Good for Cloak moving its own GLOAK, not for users.
- **A migrator contract (for users; not built).** Like the router without the swap: in one transaction it spends a note in one vault through a one-time escrow and deposits the same amount as a new note in the other. With Receive and Payee it gets the escrow refund, so the move is free and exact, and nobody holds the tokens in between. It's a small new contract plus app support, and the other vault must list GLOAK.

Our router always trades GLOAK in Cloak's launch vault, because launch tokens are checked first. So GLOAK in another vault is traded by that protocol's own router.

## Known limits

- **A spend sent alone pays 10%.** If someone submits a private sell's withdrawal in its own transaction, without the router, the refund can't happen. The money isn't stuck: after the deadline the router returns the 90% to the owner key. It takes deliberate front-running to cause.
- **Pools with no hook are still reachable through our router.** Someone could open their own GLOAK pool with no hook, sell GLOAK into it privately, and take the result out as Uniswap claims. That gives them a small, isolated claims market that only custom contracts can use. Turning claims back into GLOAK still costs 10%, and GLOAK's own pool stays closed to it. Closing this would need router changes, which the experiment avoids.
- **Public bids work.** The auction pays every winner without a surcharge, so a public bidder ends up with public GLOAK. The app should only offer private bids for GLOAK.
- **Public buys through the market adapter cost 10%** once the adapter is approved for batch rounds. Anyone can call the adapter, and a public buyer receives 90%.
- **The pool's fees paid in GLOAK lose 10%** on their way to the treasury. Fees paid in HYPE are untouched.
- **The admin key** can approve vaults, routers and receiving addresses (3 days after setup), remove approvals at once, lower the surcharge, or renounce for good. It can't move anyone's GLOAK, make an address tax-free on the way out, or open Uniswap to a wallet. Removing a router's approval would stop private trading until it's added back. Approving a contract with Feed or Swap still means trusting that contract, so vet each router first.
- **Exchanges and other DEXs** can't really hold it: every deposit to a public address pays 10%.

## Tests

`contracts-v4/test/GloakExperiment.t.sol`, 26 tests:
- **The door:** makes GLOAK's launch; works once and only for the owner wallet; reverts whole if its launch fails; nobody else can make a GLOAK.
- **Other launches untouched:** a launch after the door gets a plain token and an open pool; a deployer with no door never makes a private pool.
- **The private pool:** an outside contract can't swap it (taking tokens or claims); public addresses can't pay into Uniswap or sell through the adapter.
- **Private trading is free:** an exact buy, an exact sell, the leftover claimed back into the vault, and nothing burned.
- **Leaving costs 10%:** a withdrawal, a router exit, and public-to-public transfers; shielding back in is free. A spend sent alone loses the 10% but is rescued.
- **The adapter:** refused until approved; a public buy then arrives less 10%.
- **The rules:** the 3-day wait after setup, instant removal, the surcharge only falling, the privacy meter; Send can never be granted; Feed and Swap only to contracts.
- **Born with its zone:** the maker's zone is approved from GLOAK's first block, and a zone that would grant Send, or Feed to a wallet, makes the whole door call revert.
- **Between vaults:** an approved address moves GLOAK from one vault to another for free, and still pays 10% sending anywhere else.
- **Fork only:** Uniswap's real Universal Router on mainnet can't buy GLOAK but still buys a plain launch.

Run locally (`forge test --match-contract GloakExperiment` in `contracts-v4`): all 26 pass; the 2 fork-only tests do nothing there. Run on a fork of Elysium mainnet against Uniswap's real PoolManager (`MAINNET_RPC=https://rpc.elysium.kinetiq.xyz forge test --match-contract GloakExperiment`): all 26 pass, the fork-only ones included. The existing suites still pass: 119 in `contracts`, 219 in `contracts-v4`, and the 5-test mainnet fork suite.

**Simulation** (`contracts-v4/test/GloakSimulation.t.sol`, run with `-vv` to read it): 500,000 GLOAK (300,000 for sale, 200,000 reserved for the pool), no team share, 3 HYPE of bids (Ada 1 and Ben 1.5 from private balances, Cy 0.5 in public). It clears at 0.00001 HYPE: all 300,000 sold, a pool of about 1.48 HYPE and 147,750 GLOAK, and 52,250 unused burned at 0xdEaD. Then private claims (free and exact, the private-bid contract born approved), private buys and sells (nothing burned), Uniswap's real Universal Router refused, a withdrawal and a public transfer (10% each), a buyback from the pool's fees burned at 0xdEaD, and a move into a second vault through an approved bridge address (free) or a holder's own wallet (10%). It passes on the mainnet fork and locally. With a pool this thin a 0.2 HYPE buy moves the price about 25%, and two trades' fees buy back under 100 GLOAK; the raise itself (about 1.48 HYPE to the treasury) is the real buyback money.

Not yet run: the end-to-end rehearsal with real zero-knowledge proofs (`e2e-gloam/part22-mainnet-fork.mjs`). The tests above use stand-in proof checks, as the router's own tests do.
