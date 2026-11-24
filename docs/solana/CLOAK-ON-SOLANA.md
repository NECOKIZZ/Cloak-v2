# Cloak on Solana: spec

Status: on hold (Nov 24). Not the hackathon entry; kept as the plan if Cloak moves to Solana. Nothing is built yet.
Sources: Helius's open-source Rings code (`helius-labs/zolana`, read on Nov 23, 2026), the
`@heliuslabs/spr` 0.9.0-alpha SDK, and Gloam's Solana integration (`gloamtrade/gloam`, PRs #376,
#379 and #428).

---

## 1. In plain words

**What Rings really is.** Under the hood, Helius Privacy Rings is the same kind of thing as the
Gloam vault Cloak uses on Elysium: one big shared pot of encrypted notes, a zero-knowledge proof
for every spend, and a record of spent notes so nothing is spent twice. The difference is how
much each mode shows:

| | Amount | Token | Who paid | Who got paid |
|---|---|---|---|---|
| Default Ring (live today, anyone can use it) | hidden | hidden | **shown** | **shown** |
| Policy ring (a custom ring program; needs Helius to switch it on) | hidden | hidden | hidden | hidden |
| Cloak / Gloam on Elysium today | hidden | hidden | hidden | hidden |

**Can Rings hide swaps? Yes, but not through Jupiter.** Rings lets any Solana program own
private notes and move them under its own rules (Helius calls these "ZK programs"). Helius ships
three example swap programs in its code:

1. **Maker/taker swap.** Two people agree a price privately. One locks their side, the other takes
   it. Amounts and price stay private. Anyone can see that a swap happened.
2. **Dynamic swap.** A market maker keeps a pool of liquidity and publishes a price. Users swap
   against it with private amounts and a private minimum price. If the maker doesn't fill in time,
   the user gets a refund without needing the maker.
3. **RFQ.** The user asks for a quote, and a maker fills it in one transaction.

These are test examples, not live products. A normal Jupiter swap needs public tokens, so swapping
"through Jupiter" means taking money out of the private pot (public), swapping, and putting it
back. That shows the amounts. Truly private swaps need a market maker trading inside the pot,
like the dynamic swap.

**Our combo, in one line:** let Rings do the encryption, the audited core and the token support,
and have Cloak add three things:

- **the "Cloak Pot"**, which breaks the who-paid-whom link on the Default Ring that is live today;
- **private swaps** against a market maker;
- **the easy front door**: receive addresses, top-ups from any chain or a card, names, a privacy
  coach and receipts.

---

## 2. How Rings works (what we build on)

From `docs/spec.md` in `helius-labs/zolana`:

- **Notes (UTXOs).**
  - A private balance is a set of encrypted notes. Spending a note publishes a "nullifier", which
    stops it being spent twice and doesn't show which note was spent (spec §Privacy:
    "unlinkability of UTXOs").
  - Up to 49 notes can be spent in one transfer. A merge service can combine small notes without
    the owner signing each merge.
- **SPP (Solana Privacy Program).** Checks a Groth16 proof (about 93k compute units), updates
  the trees, and holds the real tokens in a vault for each mint. It works for SOL, SPL and
  Token-2022 tokens, with no permission needed from the token's creator.
- **Registry.** Maps a normal Solana address to its private address, so "pay this Solana address
  privately" works. The recipient must register once.
- **Default Ring.** Each output is tagged with its owner's public key so wallets can find their
  notes quickly. That tag is why sender and recipient are visible.
- **Policy rings.**
  - A ring program wraps SPP with rules: allowlists and blocklists, auditor keys, freeze, a
    co-signer, and anonymity with a relayer.
  - Creating a ring is open to anyone. **Activating** it needs Helius governance
    (`set_ring_activation`) unless the protocol flag `ring_activation_is_permissionless` is on.
  - The custom-rings SDK (`@heliuslabs/zolana-custom-rings`) is not published on npm yet.
- **ZK programs.**
  - Any program can run its own small proof over notes and then call SPP to settle (spec
    §ZK Program Interface).
  - No activation is needed. The swap and timelock-escrow examples work this way.
  - **This is the door we use without asking Helius.**
- **Prover.**
  - Helius's prover runs inside an AWS Nitro enclave, and the SDK checks the enclave before
    sending anything. The enclave still sees the private inputs.
  - The spec also allows proving on the user's device; the SDK has a `ProofAuthority` interface
    for this.
- **Relayer.** Any fee payer can submit transactions for the user, so a private account never
  needs SOL. The `ConfidentialEddsa` circuit lets the owner sign inside the proof rather than on
  the transaction.
- **SDK.**
  - `@heliuslabs/spr` provides deposit, register, transfer, multi-transfer (up to 15 recipients),
    withdraw, split, merge, sync, and encrypted wallet snapshots.
  - It uses Solana version 1 transactions (up to 4,096 bytes). A Helius API key is required.
- **Audits.** Certora, OtterSec and zkSecurity (PDFs in `audits/`). Formal verification is due by
  the end of 2026. The SDK is alpha.

---

## 3. What we build

### 3.1 Cloak Pot: unlinkable payments on the Default Ring

**Idea.**
- On the Default Ring everyone sees "A paid B". Put a shared pot in the middle: A pays the pot,
  and later the pot pays B.
- Everyone sees "A paid the pot" and "the pot paid B", but with many people using the pot,
  nobody can tell which deposit became which payout.
- Amounts and tokens stay hidden the whole time, because they're Rings notes.

**How, in Rings terms.**
- `cloak_pot` is a ZK program. Its notes are owned by one program address
  (`ProgramOwner.find(["pot"], CLOAK_POT_ID)`).
- **Deposit.** The user's private account spends a note into a pot-owned note whose `utxo_data`
  holds `H(secret)`. The note is encrypted to the depositor only, so nobody else, Cloak included,
  knows its contents.
- **Claim.**
  - Whoever knows `secret` proves (in the pot's circuit) that they know it for one of the pot's
    notes, and SPP pays the value to any private address.
  - SPP's nullifiers don't show which pot note was spent.
  - Our relayer sends the transaction, so the new owner never signs or pays.
- **Claim links.** The secret can travel as a link ("here's $20, open to claim"). That's the same
  pattern as Cloak's claim links on Elysium.

**Must verify in the prototype (open questions):**
1. Program-owned notes use a fixed, public nullifier key (`ProgramOwner.nullifierKey()`). Confirm
   that hiding the note's contents from everyone except the depositor is enough to stop outsiders
   linking claims to deposits.
2. The pot's circuit must take the note's contents as private inputs, and SPP's proof must not
   leak which pot note is spent.
3. Timing and amount patterns. The amount is hidden, but "deposit at 12:00, claim at 12:01" still
   hints at a link. The privacy coach (3.4) and a minimum wait help.
4. Whether ZK programs CPI into SPP without any allowlist on mainnet. The examples say yes;
   confirm against the deployed `shielded-pool-v1.0.0`.

**Upgrade path.** If Helius activates anonymous policy rings (theirs or a "Cloak Ring" we write),
the pot becomes a nice-to-have rather than essential. The pot also works across rings.

### 3.2 Cloak Swap: private swaps

The three stages are cumulative.

1. **Hackathon: maker/taker and RFQ.**
   - Cloak runs a small market-making bot that quotes from Jupiter or Pyth prices and fills
     users' swaps inside the pot.
   - Based on Helius's `zk-program-swap` / `rfq` examples. Amounts and price stay private.
   - Seen publicly: "a swap happened" and the token being sold (`source_asset_id` is public in the
     maker/taker design).
2. **After the hackathon: dynamic swap pool.**
   - Committed liquidity, a public price, a private minimum, and refund on timeout.
   - The bot rebalances on Jupiter in its own name, so its trades don't point to any user.
3. **Fallback for long-tail tokens: withdraw → Jupiter → deposit through the relayer.**
   - The amount is public for that hop.
   - The UI must say so plainly ("this swap is not private").

Needs: our own proving keys (the examples use unsafe test keys), an audit before real money, and
inventory risk for the bot (start with tight caps).

### 3.3 The front door (where Cloak beats everyone)

| Feature | On Solana | Reuses from Cloak v2 |
|---|---|---|
| Private account from your wallet's signature | `LocalKeys.fromDerivationSeed` (same idea as Gloam's HKDF account) | key-derivation pattern |
| Relayer pays all fees | sponsored `feePayer` + `ConfidentialEddsa` | keeper/relayer ops |
| Receive address anyone can pay from any wallet | a plain Solana address per user; a keeper sweeps it into the private balance (`buildDepositTransaction`) | receive addresses + keeper |
| Top up from other chains | Relay into the receive address | Relay deposit addresses (Receive page) |
| Top up with a card | Helius's onramp partners (MoonPay, Paybis, Crossmint) or Spicenet if it supports Solana | card top-up flow |
| Pay by name | SNS `.sol` names → registry lookup | `@name` resolver pattern |
| Claim links | Cloak Pot secrets | claim links |
| Receipts | share one transaction's viewing key (Rings derives a key per transaction) | new |
| Privacy coach | warns before moves that give you away (same amount in/out, too soon, a fresh account funded from your wallet) | new |
| Agents | SDK/MCP like Gloam's, behind spend limits | later |

### 3.4 Privacy coach rules (v1)

1. **Exact echo.** You're withdrawing or sending exactly what you just deposited. Suggest a
   different amount or waiting.
2. **Too soon.** Less than N minutes between a pot deposit and its claim. Suggest waiting, and
   show the current pot traffic.
3. **Direct link.** Adding money straight from your main wallet into your private account shows
   that link on the Default Ring. Suggest going through the pot.
4. **Swap leak.** A Jupiter-fallback swap shows the amount. Say so before confirming.

### 3.5 Safety and compliance (from day one)

- Screen deposits and relayed transactions against the OFAC Solana list (Gloam ships
  `ofacSolana.json`). Add Chainalysis if available.
- Per-deposit and per-day caps on the pot while the crowd is small.
- Receipts and viewing keys so users can prove where their money came from.
- If a policy ring becomes possible, use Helius's curated OFAC blocklist rule (`ring-policy.md`).
- Precedent: Privacy Cash paused deposits on Nov 4, 2026 after hack proceeds went through it.
  Plan for that on day one.

---

## 3.6 Porting Cloak v2 to Solana

### The app and services

We plug into Helius's deployed pot, programs and circuits, the way Cloak v2 plugs into Gloam's
vault on Elysium. We don't deploy our own pool.

| Piece | Elysium today | On Solana |
|---|---|---|
| Privacy engine | Gloam SDK (`@gloamtrade/sdk`) | Helius `@heliuslabs/spr`. Different key types, one-time registration, balances synced from Helius's indexer |
| Wallet connection | EVM wallets | Solana wallets (Phantom, Backpack, Solflare). The wallet plumbing is rewritten |
| Proofs | In the user's browser | Helius's prover (enclave), via a server route that holds the Helius API key |
| Network fees | User pays HYPE | Our relayer pays SOL. Private accounts hold no SOL |
| Receive addresses + keeper | `CloakGloamReceive` boxes + keeper | Plain Solana addresses that the keeper deposits from. Keeper rewritten, probably no program needed |
| Relay top-ups | Works | Relay supports Solana, so mostly config |
| Card top-up | Spicenet | Check whether Spicenet supports Solana; otherwise Helius's onramp partners |
| Gloam names, `cloak:` addresses | Work (P-256 keys) | Don't carry over. Rings supports Ed25519/X25519 only, so we need a new address format |
| Portfolio prices | Elysium markets | Jupiter / Pyth |

### Our contracts

Every Cloak contract is Solidity, so every one that comes to Solana is rewritten in Rust. Most
also need redesigning, not just translating. They fall into three groups.

**1. Not needed on Solana.** Rings and Solana already provide these.

| Contract | Why not needed |
|---|---|
| `CloakLaunchVault`, `CloakEcosystemVault`, `CloakLaunchpadCheck` | Rings takes any SPL token once it's registered, so launch tokens need no vault of their own |
| `CloakWHYPE` | Solana has wrapped SOL built in |
| `CloakToken` | A token is an SPL mint made by the token program, not a contract we write |

**2. Plain public contracts: straight Rust ports, using Solana's own building blocks.**

| Contract | On Solana |
|---|---|
| `CloakAuction`, `CloakDrop`, `CloakEscrowDrop`, `CloakSpotBook` (sealed bids) | Rust programs. drand time-lock sealing is done off-chain, so the same scheme carries over; the keeper still reveals. NFTs use Metaplex rather than our own collection contract |
| `CloakFactory`, `CloakConfig`, `CloakVesting` | Rust programs (or existing ones such as Streamflow for vesting) |
| `CloakPair`, `CloakV2Market`, `CloakSeeder`, `CloakFeeLocker` | Seed launches on Raydium or Meteora pools, whose fee-locking options cover the fee locker. Only write our own pool if we need its exact rules |
| `CloakV4Hook`, `CloakV4Market` | No Uniswap v4 on Solana. Meteora's dynamic pools come closest; otherwise our own pool program |

**3. Contracts that use the privacy vault: rewritten as Rings "ZK programs".** On Elysium these
call Gloam's vault and Gloam's verifiers. On Solana each becomes a program with its own small
circuit that calls Helius's privacy program to move notes, like Helius's swap and escrow
examples. This is the real work, and it needs new circuits and an audit.

| Contract | On Solana |
|---|---|
| `CloakGloamBids` (sealed bids paid from a private balance) | ZK program: lock a note for the bid, refund or settle after the auction |
| `CloakGloamBatcher`, `CloakGloamBatcherV4` (private batch rounds) | ZK program collecting order notes; net trade on Raydium/Meteora |
| `CloakLaunchSwap`, `CloakLaunchSwapV4`, `CloakV2PairSwap` (private swaps) | ZK program based on Helius's dynamic-swap / RFQ examples (§3.2) |
| `CloakTradeFee` | Logic folded into the swap/batch programs |
| `CloakFundsGate`, `GloamFundsCheck` (proof you hold at least X) | New circuit over Rings notes. Rings has no proof-of-funds circuit |
| `CloakReceiptCheck` (private receipts) | New circuit, or Rings' per-transaction viewing keys if a disclosed receipt is enough |
| `CloakGloamReceive` (receive boxes) | Not a ZK program. The keeper deposits from plain addresses (see the services table above) |

Circuits: Helius's examples write them in Rust (arkworks Groth16, via the `spr-program` SDK).
Our Elysium circuits are Gloam's circom circuits. Circom proofs can also be verified on Solana,
but each program must commit to Rings' `private_tx_hash`, so these circuits get rewritten either
way.

---

## 4. Hackathon scope (about 3 weeks)

**Week 1: core on localnet.**
- Localnet stack (`zolana dev start`: validator, Photon indexer, prover).
- Deposit, register, transfer and withdraw with `@heliuslabs/spr`.
- Write a script that dumps what each transaction makes public, to check the privacy table above
  for ourselves.
- Prototype `cloak_pot` from the `timelock-escrow` example (closest shape: a program-owned note
  with a secret condition).

**Week 2: pot and swap.**
- Pot deposit and claim, plus claim links.
- RFQ swap with a simple quoting bot.
- Relayer with screening and caps.
- Deploy to devnet.

**Week 3: front door and demo.**
- Web app: connect wallet → private account → receive address → pay `@name.sol` → claim link →
  private swap → receipt.
- Privacy coach.
- 3-minute demo video.

**Demo story:**
1. Ade pays Bola $20 privately.
2. On the explorer, the Default Ring alone shows "Ade → Bola".
3. Through Cloak, the explorer only shows "Ade → pot" and "pot → someone", with no amounts.
4. Then Ade swaps SOL to USDC privately.
5. Finally, Bola shares a receipt with an accountant.

---

## 5. Test plan

| # | Test | Where | Pass when |
|---|---|---|---|
| T1 | SDK flow: deposit → register → transfer → withdraw | localnet, then devnet | balances match after `syncWallet` |
| T2 | What's public, from raw transaction bytes | localnet | matches the table in §1 for each operation |
| T3 | Pot deposit and claim by a different account via the relayer | localnet | claim succeeds; the claimer never signs or pays |
| T4 | Pot unlinkability | localnet, 20 deposits / 20 claims | an outside observer with full chain data can't match claims to deposits better than chance |
| T5 | Double claim / wrong secret | localnet | rejected by proof or nullifier |
| T6 | Private RFQ swap | localnet | both sides settle atomically; amounts not in transaction bytes |
| T7 | Swap timeout refund | localnet | user is refunded without the maker |
| T8 | Relayer screening and caps | unit | listed addresses refused; caps enforced |
| T9 | Compute and size budget | localnet | each transaction within 1.4M CU and 4,096 bytes |

What we need to run these:
- permission in our build environment to download and run Helius's `zolana` CLI (localnet);
- a Helius API key (free tier) for devnet;
- devnet SOL.

---

## 6. Risks and open questions

1. **Helius dependency.** Their indexer, their prover enclave and API pricing (not published).
   Mitigate by running the open-source Photon and prover ourselves later.
2. **Policy ring activation is Helius's call.** The pot avoids needing it. Ask Helius about a
   "Cloak Ring" during the hackathon; it's also a partnership story.
3. **Competition.**
   - Helius plans anonymous rings in Q4 2026.
   - Gloam is on Solana's Default Ring now.
   - Umbra/Arcium and Privacy Cash already exist.
   - Our edge is the pot working today, private swaps, and the front door.
4. **New code holding money.** Pot and swap programs need an audit before mainnet. Devnet or
   capped amounts until then.
5. **Small crowd at launch.** Weak privacy until the pot has traffic. The coach and minimum waits
   help.
6. **Alpha SDK.** APIs may change (`@experimental` on all program-owner exports).
7. **Regulatory.** Screening, caps, receipts, and say plainly what's visible.

---

## 7. After the hackathon ("the empire")

1. Mainnet Cloak Pot (audited) + front door.
2. Dynamic-swap pool with outside market makers.
3. Cloak Ring (anonymous policy ring with screening rules) once activated.
4. Private payroll (multi-transfer, 15 per transaction) and agents (SDK/MCP).
5. Bridge: Elysium private balance ↔ Solana private balance through Relay, so Cloak is one
   private wallet across both.
