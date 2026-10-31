import { useState } from "react";
import { Link } from "../router";
import { Footer, GITHUB, Nav } from "../ui";

const EX: Record<string, string> = {
  Launchpad: `import { Cloak, elysiumTestnet } from "@cloakely/sdk";

const cloak = new Cloak(publicClient, walletClient, FACTORY);

// a sealed-bid launch with liquidity locked at the clearing price
const { auction, token } = await cloak.createLaunch({
  name: "Shade", symbol: "SHADE",
  saleSupply: 1_000_000n * 10n ** 18n,
  minPrice: 10n ** 12n, tickSize: 10n ** 12n, numTicks: 100,
  commitEnd, revealEnd,
  lpBps: 5000, lpLockUntil: "burn",
});`,
  Bidder: `// sealed + timelock-encrypted to the drand round after bidding closes.
// The deposit is rounded up to a bucket so it doesn't reveal the bid.
const bid = await cloak.bid(auction, {
  maxPrice: parseEther("0.00002"),
  quantity: parseEther("10000"),
});

// later: anyone can reveal, settle and push claims
await cloak.revealAll(auction);
await cloak.settle(auction);
await cloak.claimAll(auction);`,
  "Private trading": `import { CloakPrivate, loadProver, relayerSubmitter } from "@cloakely/sdk";

const keys = await CloakPrivate.keysFromWallet(walletClient, { chainId: 99801 }); // one signature, the same account forever
const priv = new CloakPrivate(publicClient, ROUTER, keys,
  () => loadProver("/circuits"), relayerSubmitter(KEEPER_URL), VAULTS_BLOCK, BATCHER);
await priv.loadMarkets();

await priv.shieldHype(walletClient, parseEther("1"));      // the one public step
await priv.buy(token, parseEther("0.25"));                 // instant, wallet never shows up
await priv.batch(token, "buy", parseEther("0.37"));        // batch: size hidden too
await priv.send(token, "cloak:…", parseEther("100"));      // private transfer
await priv.unshieldHype(freshAddress, parseEther("0.5"));  // back to a wallet`,
  Contracts: `// From Solidity: launch through the factory, with the project as creator
CloakAuction.Params memory p = CloakAuction.Params({
  creator: project, saleSupply: 1_000_000e18, lpReserve: 1_000_000e18,
  minPrice: 1e12, tickSize: 1e12, numTicks: 100,
  commitEnd: uint64(block.timestamp + 1 days), revealEnd: uint64(block.timestamp + 1 days + 1 hours),
  lpBps: 5000, noRevealPenaltyBps: 1000, lpLockUntil: 0, tlockRound: round
});
// creator share: up to 20% of the supply, vesting over at least 30 days (here: none)
(address auction, address token) = CloakFactory(FACTORY).createLaunch("Shade", "SHADE", 0, 0, p, uri);`,
};

const API: [string, [string, string][]][] = [
  ["Cloak · launches", [
    ["createLaunch(params)", "Deploy a token and its sealed-bid auction. Returns { auction, token }."],
    ["bid(auction, { maxPrice, quantity, deposit? })", "Seal and commit a bid (tlock-encrypted, bucketed deposit). Returns the bid secret."],
    ["revealAll(auction)", "Decrypt every sealed bid whose drand round has passed and reveal them in batches."],
    ["settle(auction) · claimAll(auction)", "Compute the clearing price and seed the pool, then push tokens and refunds to bidders."],
    ["payOut(auction)", "Pull a settled launch's money out: the creator's proceeds, and the launch fee to the treasury."],
    ["getAuction · demandCurve · bidsOf · listLaunches", "Read state: phase, clearing price, the revealed demand per price level, a bidder's bids."],
  ]],
  ["CloakPrivate · private balances", [
    ["keysFromWallet(wallet, { chainId, verify? })", "Derive the private account from one EIP-712 signature bound to this chain only, so it stays the same through every upgrade. The same wallet always restores it; verify signs twice to refuse wallets that sign differently each time."],
    ["claimPrivately(wallet, auction, bidId)", "Claim a won sealed bid straight into the private balance (v4 launches), so later trades can't be linked to the bid."],
    ["migrateFrom(legacy)", "Move every private balance from the first Cloak deployment into this one, privately, one relayed transaction per note pair."],
    ["shieldHype(wallet, amount)", "Public HYPE → a private note on a one-time key."],
    ["buy · sell(token, amount, { slippageBps })", "Instant private swap through the launch's pool, submitted by the relayer."],
    ["batch(token, side, amount)", "Split into standard sizes and place sealed orders in the current round."],
    ["send(token, cloakAddress, amount)", "Private transfer inside the vault. No sender, recipient or amount on-chain."],
    ["unshieldHype · unshieldToken(…, to, amount)", "Withdraw to any address."],
    ["balance(pool) · address() · roundInfo()", "Your private balance, your cloak: address, and the batch round clock."],
  ]],
  ["Helpers", [
    ["createProver(wasm, zkey) · loadProver(url)", "Groth16 prover for the 2-in/2-out circuit, running on the user's device."],
    ["relayerSubmitter(url) · walletSubmitter(…)", "How shielded calls are submitted: via a Cloak relayer (private) or a wallet (for tests)."],
    ["sealBid · unsealBid · drandRoundAt", "drand timelock primitives used by sealed bids."],
    ["splitStandard(amount) · budgetBuckets(cost)", "Standard sizes for batches, and deposit buckets for bids."],
  ]],
];

export function Sdk() {
  const [tab, setTab] = useState("Launchpad");
  const [copied, setCopied] = useState(false);
  return (
    <>
      <Nav />
      <main>
        <section className="wrap" style={{ paddingTop: 12 }}>
          <div className="deep dev" style={{ alignItems: "start" }}>
            <div>
              <div className="eyebrow" style={{ color: "var(--deep-soft)" }}>@cloakely/sdk</div>
              <h1 className="display-2" style={{ marginTop: 14 }}>Sealed launches and private trading, in one package</h1>
              <p className="lede" style={{ marginTop: 18 }}>
                Give any Elysium launchpad fair launches with locked liquidity, and give its users private balances, swaps, batches and sends. It's TypeScript on viem, with proofs made in the browser.
              </p>
              <div className="hero-actions">
                <a href={`${GITHUB}/tree/main/packages/sdk`} target="_blank" rel="noreferrer" className="btn btn-primary">View on GitHub</a>
                <Link to="/docs#sdk" className="arrow" style={{ color: "var(--on-deep)" }}>Read the docs</Link>
              </div>
            </div>
            <div>
              <div className="code">
                <div className="code-head">
                  <span>@cloakely/sdk · packages/sdk · TypeScript</span>
                  <button className="copy" onClick={() => { navigator.clipboard?.writeText(EX[tab]).catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? "Copied" : "Copy"}</button>
                </div>
                <div style={{ display: "flex", gap: 4, padding: "10px 12px 0", flexWrap: "wrap" }}>
                  {Object.keys(EX).map((k) => (
                    <button key={k} className="copy" style={{ padding: "6px 10px", borderRadius: 999, background: tab === k ? "var(--deep-line)" : "transparent", color: tab === k ? "var(--on-deep)" : undefined }} onClick={() => setTab(k)}>{k}</button>
                  ))}
                </div>
                <pre>{EX[tab]}</pre>
              </div>
              <p className="xs" style={{ color: "var(--deep-soft)", marginTop: 12 }}>Install it with <code>npm install @cloakely/sdk viem</code>. It's on <a href="https://www.npmjs.com/package/@cloakely/sdk" target="_blank" rel="noreferrer">npm</a>, published with provenance from this repo. Addresses come built in: <code>deploymentFor(99801)</code>.</p>
            </div>
          </div>
        </section>

        <section className="wrap section-sm">
          <div className="pillars" style={{ paddingTop: 0 }}>
            <div className="pillar"><div className="eyebrow">Launchpads</div><h3>Fair-launch mode in one call</h3><p>Call <code>createLaunch</code> from your backend, or <code>CloakFactory.createLaunch</code> from your contracts with the project as creator.</p></div>
            <div className="pillar"><div className="eyebrow">Wallets & apps</div><h3>Private balances for users</h3><p>Unlock with one signature, then shield, swap, batch, send and withdraw. Proofs stay on the device.</p></div>
            <div className="pillar"><div className="eyebrow">Operators</div><h3>Run a keeper</h3><p>Reveal bids, settle launches and rounds, and relay private transactions. It's permissionless, and several keepers can run at once.</p></div>
          </div>
        </section>

        <section className="wrap section">
          <h2 className="display-2">API</h2>
          <div style={{ display: "grid", gap: 36, marginTop: 30 }}>
            {API.map(([g, rows]) => (
              <div key={g}>
                <div className="eyebrow" style={{ marginBottom: 10 }}>{g}</div>
                <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                  {rows.map(([sig, desc], i) => (
                    <div key={sig} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1.3fr)", gap: 20, padding: "16px 22px", borderTop: i ? "1px solid var(--line)" : undefined }}>
                      <code className="mono small" style={{ wordBreak: "break-word" }}>{sig}</code>
                      <span className="small soft">{desc}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
