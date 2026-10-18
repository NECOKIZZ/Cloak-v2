import { useEffect, useState } from "react";
import { Link } from "../router";
import { EXPLORER, Footer, GITHUB, Nav } from "../ui";

const ADDR = {
  factory: "0x1dc1ea9837ecbd31ec74f0d558e1db1c303a7e1c",
  router: "0xfa2574cfc3afb8f7d3a0651fa2111ff4e3d2fc41",
  batcher: "0xf6582cc5a84fccf74e571e652fb7b603a2c25812",
  hypePool: "0xCDD04c1c2aEc00728995C151127D619990885715",
};

const NAV: [string, [string, string][]][] = [
  ["Start here", [["overview", "Overview"], ["quickstart", "Quickstart"], ["what-works", "What works today"]]],
  ["Launches", [["sealed-launches", "Sealed launches"], ["clearing-price", "The clearing price"], ["liquidity", "Locked liquidity"]]],
  ["Privacy", [["private-trading", "Private trading"], ["batch-auctions", "Batch auctions"], ["private-send", "Private send"], ["what-stays-private", "What stays private"]]],
  ["Build", [["sdk", "SDK"], ["contracts", "Contracts"], ["keeper", "Keeper & relayer"], ["limits", "Limits & threat model"]]],
];

const A = (a: string) => `${EXPLORER}/address/${a}`;

export function Docs() {
  const [on, setOn] = useState("overview");
  useEffect(() => {
    const ids = NAV.flatMap(([, xs]) => xs.map(([id]) => id));
    const obs = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && setOn(e.target.id)), { rootMargin: "-80px 0px -70% 0px" });
    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (el) obs.observe(el);
    });
    if (location.hash) setTimeout(() => document.getElementById(location.hash.slice(1))?.scrollIntoView(), 50);
    return () => obs.disconnect();
  }, []);
  const go = (id: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
    history.replaceState(null, "", `#${id}`);
  };
  return (
    <>
      <Nav />
      <div className="wrap docs">
        <nav className="docs-nav">
          {NAV.map(([g, xs]) => (
            <div key={g} style={{ display: "contents" }}>
              <div className="eyebrow">{g}</div>
              {xs.map(([id, label]) => <a key={id} href={`#${id}`} className={on === id ? "on" : ""} onClick={go(id)}>{label}</a>)}
            </div>
          ))}
        </nav>
        <article className="doc">
          <div className="crumb">Start here</div>
          <h1 id="overview">Docs</h1>
          <p>Fair launches and private trading on Elysium, explained without the jargon wall.</p>

          <h2>What is Cloak?</h2>
          <p>On Elysium, one sequencer orders transactions by fee, every ~300 ms. A normal token launch becomes a race that bots win in the first block. After that, every buy, sell and balance is public forever and tied to your wallet.</p>
          <p>Cloak fixes both. <b>Launches</b> are sealed-bid auctions: nobody sees a bid until bidding closes, and every winner pays one clearing price. <b>After launch</b>, you can hold, trade and send the token from a private balance. Proofs are made on your device and a relayer submits for you, so your wallet never appears.</p>
          <div className="picture">
            <div><div className="xs mute">Your wallet</div><div className="big">Public</div><div className="exp"><div className="xs mute">Explorer shows</div>1 HYPE</div><p className="xs mute" style={{ marginTop: 10 }}>Anyone can see the balance if they know the address.</p></div>
            <div><div className="xs mute">Cloak vault <span className="signal">● only you</span></div><div className="big">Private</div><div className="exp"><div className="xs mute">Explorer shows</div><span className="dots">●●●●●●</span></div><p className="xs mute" style={{ marginTop: 10 }}>You hold encrypted notes. Trades go through a relayer.</p></div>
            <div><div className="xs mute">After withdraw</div><div className="big">Public again</div><div className="exp"><div className="xs mute">Explorer shows</div>0.4 HYPE</div><p className="xs mute" style={{ marginTop: 10 }}>Leaving the vault is public on purpose. Use a fresh address.</p></div>
          </div>

          <h2 id="quickstart">Quickstart (2 minutes)</h2>
          <ol>
            <li>Open the <Link to="/app">app</Link> and connect a wallet. Cloak adds <b>Elysium testnet</b> (chain 99801) for you.</li>
            <li>Get testnet HYPE from the <a href="https://elysium.kinetiq.xyz/testnet-faucet" target="_blank" rel="noreferrer">Elysium faucet</a>.</li>
            <li><b>Bid</b> in a launch: pick a max price and quantity, then click <i>Seal bid</i>. You can close the tab, because the bid reveals itself.</li>
            <li><b>Trade privately</b>: go to <Link to="/app/portfolio">Portfolio</Link>, unlock your private account (one free signature) and shield some HYPE. Then use <Link to="/app/trade">Trade</Link>.</li>
          </ol>
          <div className="callout">Everything here is <b>testnet</b> with play money, and the ZK keys are development keys. Don't use real funds.</div>

          <h2 id="what-works">What works today</h2>
          <ul>
            <li>Sealed-bid launches with auto-reveal, a uniform clearing price, and liquidity locked at that price.</li>
            <li>Private balances for HYPE and every settled launch token.</li>
            <li>Private instant swaps, private batch swaps (hidden size), private sends, and withdrawals.</li>
            <li>A hosted keeper that reveals bids, settles launches and batch rounds, and relays private transactions.</li>
            <li>The <Link to="/sdk">SDK</Link> for launchpads, with all of the above.</li>
          </ul>

          <div className="crumb" style={{ marginTop: 60 }}>Launches</div>
          <h2 id="sealed-launches">Sealed launches</h2>
          <p>A launch is a silent auction with three phases:</p>
          <table>
            <thead><tr><th>Phase</th><th>What happens</th><th>What the chain sees</th></tr></thead>
            <tbody>
              <tr><td>Sealed bidding</td><td>You choose a max price and quantity. Your deposit is rounded up to a standard bucket (1, 2, 5 × 10ⁿ) so it doesn't reveal your bid.</td><td>A hash and a timelock ciphertext</td></tr>
              <tr><td>Auto-reveal</td><td>When bidding ends, the <a href="https://drand.love" target="_blank" rel="noreferrer">drand</a> beacon releases the key. Any keeper (or you) decrypts and reveals every bid.</td><td>The bids, now readable</td></tr>
              <tr><td>Settle</td><td>One clearing price is computed, and the pool is seeded at that price.</td><td>The demand curve and the clearing price</td></tr>
            </tbody>
          </table>
          <p>The contract only checks that a revealed bid matches its hash. A keeper can open a bid but never change it. Bids that aren't revealed get refunded minus a small burned penalty, so nobody can strategically withhold.</p>

          <h2 id="clearing-price">The clearing price</h2>
          <p>Bids are grouped by price level. Settlement walks from the highest level down until demand covers supply. That level is the <b>clearing price</b>, and every winner pays it, including people who bid higher. Bids at exactly that level share what's left pro rata. Bids below it get their whole deposit back.</p>
          <p>Because the price doesn't depend on order, bidding early, fast or with more gas earns nothing. That's the whole point on a fee-ordered chain.</p>

          <h2 id="liquidity">Locked liquidity</h2>
          <p>A share of the raise (default 50%) plus matching tokens seeds a HYPE/token pool <b>at exactly the clearing price</b>, so trading opens at the fair price with no first-block arbitrage. The LP shares are burned, or time-locked in the auction contract. Unsold tokens are burned.</p>

          <div className="crumb" style={{ marginTop: 60 }}>Privacy</div>
          <h2 id="private-trading">Private trading</h2>
          <p>Cloak runs one <b>shielded vault</b> per asset: WHYPE, plus each launch token. A balance is a set of encrypted notes. To spend one, your browser makes a zero-knowledge proof (Groth16, 2-in/2-out) that says "the owner of some notes here approves this," without saying which notes or whose.</p>
          <ol>
            <li><b>Unlock</b>: you sign one message. Your keys are derived from it on this device.</li>
            <li><b>Shield</b>: you deposit HYPE. It's the only public step, and it lands on a one-time key.</li>
            <li><b>Swap</b>: the router spends a note, swaps through the launch's pool, and deposits the output back as a new note for you. The swap details are locked into the proof, so the relayer can't change them.</li>
          </ol>

          <h2 id="batch-auctions">Batch auctions</h2>
          <p>An instant private trade hides <i>who</i> traded, but its size still shows on the public pool. Batch mode hides the size too:</p>
          <ul>
            <li>Your amount is split into <b>standard sizes</b> (1, 2, 5 × 10ⁿ), the same sizes everyone uses.</li>
            <li>Orders collect into a <b>round</b> (30 s on testnet).</li>
            <li>When it ends, buys and sells <b>cross at the pool's mid-price</b> (no fee, no impact), and only the net trades on the pool.</li>
            <li>Everyone on one side of a round gets the <b>same price</b>, and outputs return as private notes.</li>
          </ul>
          <p>A price guard stops a settler from moving the pool before settling. If a round can't settle, every order is refunded after 10 minutes.</p>

          <h2 id="private-send">Private send</h2>
          <p>Every account has a <code>cloak:</code> address (shown in Portfolio). Sending to it is a transfer inside the vault. The chain sees that a private transaction happened, but not who paid whom or how much.</p>

          <h2 id="what-stays-private">What stays private</h2>
          <table>
            <thead><tr><th></th><th>Hidden</th><th>Visible</th></tr></thead>
            <tbody>
              <tr><td>Launch bid</td><td>Price and size until bidding closes</td><td>Your deposit bucket</td></tr>
              <tr><td>Balance</td><td>How much you hold, and that you hold anything</td><td>Nothing</td></tr>
              <tr><td>Instant trade</td><td>Who traded; links between your trades</td><td>Size and direction on the pool</td></tr>
              <tr><td>Batch trade</td><td>Who traded; your total size</td><td>Each round's order counts and net</td></tr>
              <tr><td>Send</td><td>Sender, recipient, amount</td><td>That a private transaction happened</td></tr>
              <tr><td>Shield / withdraw</td><td>Which notes are involved</td><td>The amount entering or leaving</td></tr>
            </tbody>
          </table>
          <div className="callout"><b>Tip:</b> don't shield 1 HYPE and immediately buy with exactly 1 HYPE. Wait, vary amounts, and use batch mode. Privacy grows with the number of people using the vault.</div>

          <div className="crumb" style={{ marginTop: 60 }}>Build</div>
          <h2 id="sdk">SDK</h2>
          <p>Everything above is one package. See the <Link to="/sdk">SDK page</Link> for the full API.</p>
          <div className="code">
            <div className="code-head"><span>launch + private trading</span><span>TypeScript</span></div>
            <pre>{`import { Cloak, CloakPrivate, createProver, relayerSubmitter } from "@cloak/sdk";

const cloak = new Cloak(publicClient, walletClient, FACTORY);
const { auction } = await cloak.createLaunch({ name, symbol, saleSupply, minPrice, tickSize, commitEnd, revealEnd });
await cloak.bid(auction, { maxPrice, quantity });

const keys = await CloakPrivate.keysFromWallet(walletClient);
const priv = new CloakPrivate(publicClient, ROUTER, keys, loadProver, relayerSubmitter(KEEPER), 0n, BATCHER);
await priv.loadMarkets();
await priv.shieldHype(walletClient, parseEther("1"));
await priv.batch(token, "buy", parseEther("0.37"));`}</pre>
          </div>

          <h2 id="contracts">Contracts (Elysium testnet, chain 99801)</h2>
          <table>
            <tbody>
              <tr><td>CloakFactory</td><td><a href={A(ADDR.factory)} target="_blank" rel="noreferrer"><code>{ADDR.factory}</code></a></td></tr>
              <tr><td>PrivateRouter</td><td><a href={A(ADDR.router)} target="_blank" rel="noreferrer"><code>{ADDR.router}</code></a></td></tr>
              <tr><td>PrivateBatcher</td><td><a href={A(ADDR.batcher)} target="_blank" rel="noreferrer"><code>{ADDR.batcher}</code></a></td></tr>
              <tr><td>Shielded HYPE pool</td><td><a href={A(ADDR.hypePool)} target="_blank" rel="noreferrer"><code>{ADDR.hypePool}</code></a></td></tr>
            </tbody>
          </table>
          <p>None of these contracts has an owner or an admin withdraw. Source, tests and real testnet runs are on <a href={GITHUB} target="_blank" rel="noreferrer">GitHub</a>.</p>

          <h2 id="keeper">Keeper & relayer</h2>
          <p>The keeper is a small Node service. It reveals bids once the drand round passes, settles launches and batch rounds, pays out orders, and relays private transactions (<code>POST /relay</code>). It pays gas, so it's the on-chain sender of every private trade. It can delay or refuse a transaction, but it can't change or steal one, because the proof binds every field. Anyone can run one: <code>node services/keeper/index.mjs</code>.</p>

          <h2 id="limits">Limits & threat model</h2>
          <ul>
            <li>Sealed bids stop <i>ordering</i> games, not many-wallet games. Uniform pricing removes most of the reason to split.</li>
            <li>drand is a threshold network. A threshold collusion could decrypt bids early.</li>
            <li>The relayer sees your IP and can delay you. Anyone can run their own.</li>
            <li>The Groth16 keys come from a development ceremony. Production needs a public one.</li>
            <li>Unaudited testnet software.</li>
          </ul>
        </article>
        <aside className="toc">
          <div className="eyebrow">On this page</div>
          {NAV.flatMap(([, xs]) => xs).map(([id, label]) => <a key={id} href={`#${id}`} onClick={go(id)} style={on === id ? { color: "var(--text)" } : undefined}>{label}</a>)}
        </aside>
      </div>
      <Footer />
    </>
  );
}
