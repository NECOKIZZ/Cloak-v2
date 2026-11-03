import { useEffect, useState } from "react";
import { Link } from "../router";
import { EXPLORER, GITHUB, Icon } from "../ui";
import { DEPLOYMENT, VERSION } from "../config";

// every address from the SDK's deployment record, so this table can't drift from what the app uses
const ADDR = {
  config: DEPLOYMENT?.config ?? "",
  vaults: DEPLOYMENT?.vaults ?? "",
  factory: DEPLOYMENT?.factory ?? "",
  earlierFactory: DEPLOYMENT?.earlierFactories?.[0] ?? "",
  seeder: DEPLOYMENT?.seeder ?? "",
  router: DEPLOYMENT?.router ?? "",
  batcher: DEPLOYMENT?.batcher ?? "",
  migrator: DEPLOYMENT?.migrator ?? "",
  hypePool: DEPLOYMENT?.hypePool ?? "",
  usdcPool: DEPLOYMENT?.assets?.find((a) => a.symbol === "USDC")?.pool ?? "",
};

const NAV: [string, [string, string][]][] = [
  ["Start here", [["overview", "Overview"], ["quickstart", "Quickstart"], ["what-works", "What works today"]]],
  ["Launches", [["sealed-launches", "Sealed launches"], ["clearing-price", "The clearing price"], ["liquidity", "Locked liquidity"], ["uniswap", "Trading on Uniswap"], ["nft-drops", "NFT drops"], ["wl-spots", "WL spot sales"]]],
  ["Privacy", [["private-trading", "Private trading"], ["batch-auctions", "Batch auctions"], ["private-send", "Private send"], ["payment-links", "Payment links"], ["private-usdc", "Private USDC"], ["what-stays-private", "What stays private"]]],
  ["Build", [["sdk", "SDK"], ["agents", "AI agents (MCP)"], ["contracts", "Contracts"], ["fees", "Fees & caps"], ["rules", "All the rules"], ["governance", "Who can change what"], ["keeper", "Keeper & relayer"], ["limits", "Limits & threat model"]]],
];

const A = (a: string) => `${EXPLORER}/address/${a}`;

export function Docs() {
  const [on, setOn] = useState("overview");
  const [jump, setJump] = useState(false);
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
      <div className="wrap docs">
        <nav className="docs-nav">
          {NAV.map(([g, xs]) => (
            <div key={g} style={{ display: "contents" }}>
              <div className="eyebrow">{g}</div>
              {xs.map(([id, label]) => <a key={id} href={`#${id}`} className={on === id ? "on" : ""} onClick={go(id)}>{label}</a>)}
            </div>
          ))}
        </nav>
        <details className="docs-jump" open={jump} onToggle={(e) => setJump((e.target as HTMLDetailsElement).open)}>
          <summary><span><span className="mute">On this page · </span>{NAV.flatMap(([, xs]) => xs).find(([id]) => id === on)?.[1] ?? "Overview"}</span><Icon.chev size={15} /></summary>
          <div className="jump-list">
            {NAV.map(([g, xs]) => (
              <div key={g} style={{ display: "contents" }}>
                <div className="eyebrow">{g}</div>
                {xs.map(([id, label]) => <a key={id} href={`#${id}`} className={on === id ? "on" : ""} onClick={(e) => { setJump(false); go(id)(e); }}>{label}</a>)}
              </div>
            ))}
          </div>
        </details>
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
            <li>Every new launch opens a standard <b>Uniswap V2 pool</b>, so the token trades on Uniswap and anywhere else, while private trades use the same pool.</li>
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
          <p><b>Bid from your private balance.</b> On the bid card, pick "Private balance". Your private HYPE pays a fresh one-time wallet through the relayer, and that wallet places the bid, so nobody can tie the bid to your own wallet. After the launch, one click claims your tokens into your private balance and moves any refund back. The one-time wallets come from your private account, so the same wallet signature finds them again on any device.</p>
          <p>The contract only checks that a revealed bid matches its hash. A keeper can open a bid but never change it. Bids that aren't revealed get refunded minus a small burned penalty, so nobody can strategically withhold.</p>

          <h2 id="clearing-price">The clearing price</h2>
          <p>Bids are grouped by price level. Settlement walks from the highest level down until demand covers supply. That level is the <b>clearing price</b>, and every winner pays it, including people who bid higher. Bids at exactly that level share what's left pro rata. Bids below it get their whole deposit back.</p>
          <p>Because the price doesn't depend on order, bidding early, fast or with more gas earns nothing. That's the whole point on a fee-ordered chain.</p>

          <h2 id="liquidity">Locked liquidity</h2>
          <p>A share of the raise (default 50%) plus matching tokens opens the token's pool <b>at exactly the clearing price</b>, so trading opens at the fair price with no first-block arbitrage. The creator picks what happens to the LP: <b>locked forever with the trading fees going to the creator</b> (the default), burned, or locked until a date. Unsold tokens, and any tokens the pool didn't need, are burned. Whatever HYPE the pool didn't need goes to the creator.</p>
          <p>A pool's address is known before it exists, so someone could try to send it tokens or WHYPE early and make the launch open at a silly price. Settlement handles every case:</p>
          <ul>
            <li>Anything sent to the pool's address before it has reserves is swept to the burn address.</li>
            <li>If someone synced reserves into it, the launch tops up the other side so the pool still opens at the clearing price. Whoever sent them just loses them.</li>
            <li>If someone already put their own liquidity in the pool (which needs launch tokens before settlement), that pool is ignored and the launch opens a Cloak pool instead, so nobody else's position sets the price.</li>
            <li>The Uniswap step always gets a fixed 6,000,000 gas, and settlement refuses to run with less, so nobody can force the fallback by sending too little gas.</li>
          </ul>

          <h3>Creator fees</h3>
          <p>With "locked forever", the pool's LP goes into <code>CloakFeeLocker</code> at settlement and never comes out. Every trade on the pool, public or private, pays Uniswap's 0.3% fee into the pool. The locker remembers what the liquidity was worth when it was locked and lets the creator collect only the growth since, so the creator earns from trading but can never take the liquidity itself. Anyone can trigger a collection; the fees always go to the creator. Fees come from trading only: bidding pays the creator through the raise.</p>

          <h2 id="uniswap">Trading on Uniswap</h2>
          <p><b>Since Nov 3, launches open a Uniswap v4 pool</b> (native HYPE / token) at the clearing price, through Cloak's hook (<code>CloakV4Hook</code>). The hook:</p>
          <ul>
            <li><b>Keeps the liquidity forever.</b> It owns the pool's only position and never removes it, and nobody else can add or remove liquidity, so nobody can pull depth out from under traders.</li>
            <li><b>Pays the trading fees to the creator</b> (0.3% per trade), or to 0x…dEaD for a launch that burns its LP. Anyone can trigger a payout; it always goes to the creator.</li>
            <li><b>Charges an anti-snipe fee.</b> The fee starts at 10% when the pool opens and falls in a straight line to 0.3% over 5 minutes, so racing the listing costs the racer, and what they pay goes to the creator.</li>
            <li><b>Keeps a time-weighted price</b> for batch rounds, updated before every swap.</li>
          </ul>
          <p>The pool lives in Uniswap's own PoolManager, so the token trades on the Universal Router, aggregators and wallets like any v4 token, and private trades use the same pool through <code>CloakV4Market</code>. On testnet Cloak deploys Uniswap's PoolManager itself, built from Uniswap's source byte for byte like the one on Elysium mainnet; on mainnet it uses Uniswap's own. v4 liquidity is a position, not a token, so a v4 launch's LP is either locked forever (fees to the creator) or burned, never locked until a date.</p>
          <p>From Nov 2 to Nov 3, every launch's pool is a standard <b>Uniswap V2 pool</b> (token / WHYPE, 0.3% fee) from Elysium's Uniswap V2 factory. That means the token is a normal token everywhere: anyone can trade it on Uniswap, aggregators can route to it, wallets can price it, and trackers like DexScreener can chart it once they support Elysium. The launch page links to the pool.</p>
          <p>Private trades use <b>the same pool</b>. A small adapter (<code>CloakV2Market</code>) lets Cloak's private router and batch rounds trade it, so liquidity is never split between a "public" and a "private" market. Batch rounds price against the pool's own time-weighted price. Launches from before Nov 2 keep their Cloak pool, which works the same way.</p>

          <h2 id="nft-drops">NFT drops</h2>
          <p>A drop sells an NFT collection the same way a launch sells a token: sealed, with one price for every winner. There is no race, so bots and gas wars gain nothing. <Link to="/app/drops" className="link">See the drops</Link> or <Link to="/app/drops/create" className="link">create one</Link>.</p>
          <ol>
            <li><b>GTD</b> (optional): wallets on the creator's guaranteed list mint their spots at the GTD price during the GTD window. Spots nobody used roll into the auction.</li>
            <li><b>Sealed auction</b>: everyone else bids what they'd pay, at the creator's price or more. Bids are sealed to a drand round, so nobody can read one before bidding closes.</li>
            <li><b>WL bid boost</b>: a WL bid ranks as its price × (1 + boost), and a WL winner pays the clearing price ÷ (1 + boost), never under the creator's price. The boost (0% to 30%) is public on the drop page.</li>
            <li><b>Settle</b>: the highest-ranked bids win until the supply runs out, and every public winner pays the same price, the lowest winning bid. Bids tied at that price share what's left by a lottery whose random start comes from every bid's sealed salt, so nobody knew it in advance.</li>
            <li><b>Open</b>: once the drand round is out, the keeper opens every bid and the drop settles as soon as they're all open, usually within a minute. The reveal window (30 minutes by default) only matters if the keeper is late: anyone can then open the bids or settle from the drop page. A bid still sealed when the window ends loses 10% of its deposit. Every bid must cover at least one NFT at the floor, so spam costs real money.</li>
            <li><b>Claim</b>: the keeper delivers NFTs and refunds an hour after settling, and any bidder can take theirs sooner from the drop page. Winners can take their NFTs to a fresh wallet before then. Anything unsold is the creator's to mint.</li>
          </ol>
          <p>A creator who wants a fixed price sets it as the floor: when demand sits at the floor, everyone pays exactly that. Each drop is one ERC-721 contract with ERC-2981 royalties; with no metadata folder of its own, Cloak serves each token's name and the collection image.</p>

          <h2 id="wl-spots">WL spot sales</h2>
          <p>When a partner collection gives out whitelist spots, they can be sold the same way: a drop whose supply is the number of spots, marked as a spot sale in <b>CloakSpotBook</b>. One book serves every sale. <Link to="/app/drops/create?spots" className="link">Sell WL spots</Link>.</p>
          <ol>
            <li><b>Bid</b>: the sealed auction, floor, WL boost, ties and refunds work exactly as in any drop.</li>
            <li><b>Name wallets</b>: once the bids open and settle, each winning bid names the Elysium wallet to whitelist, one per spot it won. It can be a different wallet from the one that bid, and it can be changed until the deadline the seller set (1 to 90 days after the bids open).</li>
            <li><b>Hand over the list</b>: the sale page shows the whitelist as it fills, with a CSV download, and anyone can read it from the book on chain. Winners also get a receipt NFT.</li>
          </ol>
          <p>The book only takes wallets from the wallet that placed a winning bid, one wallet per spot, and a wallet can hold only one spot per sale, so the list can't be padded or faked. Only drops made by Cloak's drop factory can be sales. Naming a wallet is a public transaction from the bidding wallet, so the link between the two is visible on chain to anyone who looks; the partner's list itself shows only the whitelisted wallets.</p>

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
            <li>When it ends, buys and sells <b>cross at the pool's average price over the round</b> (no pool fee, no impact), and only the net trades on the pool.</li>
            <li>Everyone on one side of a round gets the <b>same price</b>, and outputs return as private notes.</li>
          </ul>
          <p>The rules: orders are standard sizes of at least 0.000001 HYPE. A round won't settle if the pool's price is more than <b>2%</b> away from the round's average (so a settler can't move the pool first), or if its net trade would lose more than <b>5%</b> to price impact (on a very thin pool, a big round simply can't settle). If a round can't settle, every order is refundable as a private note <b>10 minutes</b> after the round ends.</p>

          <h2 id="private-send">Private send</h2>
          <p>Every account has a <code>cloak:</code> address (shown in Portfolio). Sending to it is a transfer inside the vault. The chain sees that a private transaction happened, but not who paid whom or how much.</p>

          <h2 id="payment-links">Payment links</h2>
          <p>Money and requests that travel as a link, for HYPE and USDC. Make them on <Link to="/app/links" className="link">Payment links</Link>.</p>
          <ul>
            <li><b>Send money as a link.</b> The link holds its own private account, funded by a private send from yours. Whoever opens it claims the money into their private balance, or straight to any wallet. The relayer submits the claim and takes its fee from the link, so the person claiming needs no gas and no Cloak account. You can cover that fee so they get the full amount. Until someone claims it, you can take it back.</li>
            <li><b>Lock it with a passcode.</b> The link alone then opens nothing. Send the code another way, or show a riddle on the claim page whose answer is the code: post it in public and the first person to solve it wins. A guessable answer can be guessed by anyone with the link, so use a phrase for real money.</li>
            <li><b>Split it into shares.</b> A red envelope: one link, several equal shares, and each person who opens it claims one, first come first served. Drop it in a group chat.</li>
            <li><b>Request a payment.</b> A link that asks to be paid, with an amount (or none, for a tip jar), a note and your name. It pays your cloak: address privately, or a 0x wallet from the payer's private balance. Show it as a QR code for in-person payments.</li>
          </ul>
          <p>Everything sits after the # in the link, which browsers never send to a server, so the details stay between the people who share it. A claim link is like cash: anyone who has it can claim it. The links you make are kept encrypted in your browser, under Your links.</p>
          <h2 id="private-usdc">Private USDC</h2>
          <p>USDC has its own vault. On Portfolio, pick USDC on the Shield tab and deposit from your wallet (the first time asks for an approval, then the deposit). After that you can send it privately to any <code>cloak:</code> address or withdraw it to a fresh address, like HYPE. The relayer's fee is paid in USDC. During the beta a deposit can be at most 1,000 USDC and the vault holds at most 50,000. Swapping USDC privately for HYPE or launch tokens comes later.</p>
          <p>Elysium's USDC is bridged from Circle's USDC on HyperEVM. Circle can freeze the USDC held by the bridge, and the bridge operator can upgrade the Elysium USDC contract. That applies to everyone holding USDC on Elysium, inside Cloak or not.</p>

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
              <tr><td>Trading on Uniswap from your wallet</td><td>Nothing</td><td>Everything, like any public trade. Trade from your private balance to stay hidden</td></tr>
            </tbody>
          </table>
          <div className="callout"><b>Tip:</b> don't shield 1 HYPE and immediately buy with exactly 1 HYPE. Wait, vary amounts, and use batch mode. Privacy grows with the number of people using the vault.</div>

          <div className="crumb" style={{ marginTop: 60 }}>Build</div>
          <h2 id="sdk">SDK</h2>
          <p>Everything above is one package. See the <Link to="/sdk">SDK page</Link> for the full API.</p>
          <div className="code">
            <div className="code-head"><span>launch + private trading</span><span>TypeScript</span></div>
            <pre>{`import { Cloak, CloakPrivate, createProver, relayerSubmitter } from "@cloakely/sdk";

const cloak = new Cloak(publicClient, walletClient, FACTORY);
const { auction } = await cloak.createLaunch({ name, symbol, saleSupply, minPrice, tickSize, commitEnd, revealEnd });
await cloak.bid(auction, { maxPrice, quantity });

const keys = await CloakPrivate.keysFromWallet(walletClient, { chainId: 99801 });
const priv = new CloakPrivate(publicClient, ROUTER, keys, loadProver, relayerSubmitter(KEEPER), 0n, BATCHER);
await priv.loadMarkets();
await priv.shieldHype(walletClient, parseEther("1"));
await priv.batch(token, "buy", parseEther("0.37"));`}</pre>
          </div>

          <h2 id="agents">AI agents (MCP)</h2>
          <p>Cloak has an MCP server, so Claude, ChatGPT, Cursor and other AI apps can work with it directly. It comes in two parts, so an agent's keys never leave the machine it runs on.</p>
          <p><b>The easy way.</b> Tell your agent: <code>Read https://cloak.boblabs.tech/agent.md and set me up to trade privately.</code> The page is written for the agent. It works out what it can do in your app, sets up its own wallet and the connection, and only asks you for what it can't do itself, like getting free testnet HYPE from the faucet. It never needs your own wallet's key.</p>
          <p><b>Connect by link (read and plan).</b> Paste <code>https://cloak.boblabs.tech/mcp</code> into your AI app. Nothing to install and no key. The agent can list launches, read a launch (bids stay hidden until bidding closes), price a sealed bid or a private swap, see vault totals and plan a launch. It never signs, and it refuses any message that looks like it carries a private key.</p>
          <ul>
            <li><b>Claude</b> (claude.ai or Desktop): Settings, Connectors, Add custom connector, then paste the link.</li>
            <li><b>ChatGPT</b>: turn on developer mode under Apps and connectors, then add a connector with the link and no authentication.</li>
            <li><b>Claude Code</b>: <code>claude mcp add --transport http cloak https://cloak.boblabs.tech/mcp</code></li>
            <li><b>Cursor, VS Code and others</b>: add a remote server with <code>{`{ "mcpServers": { "cloak": { "url": "https://cloak.boblabs.tech/mcp" } } }`}</code></li>
          </ul>
          <p><b>The full agent (launch, bid, trade privately).</b> This part runs on your own machine with a wallet made just for the agent, signs there, and makes its proofs there, under spending limits per transaction and per day (1 and 10 HYPE by default) with a dry run on every action. By hand: <code>npx -y @cloakely/mcp setup</code> makes the agent's wallet and prints its address to fund from the faucet, then <code>claude mcp add cloak -- npx -y @cloakely/mcp</code> (or the same <code>npx -y @cloakely/mcp</code> command in any other app's MCP settings). Full setup is in the <a href="https://www.npmjs.com/package/@cloakely/mcp" target="_blank" rel="noreferrer">package README</a>.</p>

          <h2 id="contracts">Contracts (Cloak v{VERSION}, Elysium testnet, chain 99801)</h2>
          <table>
            <tbody>
              <tr><td>CloakConfig (rules and the list of every Cloak contract)</td><td><a href={A(ADDR.config)} target="_blank" rel="noreferrer"><code>{ADDR.config}</code></a></td></tr>
              <tr><td>CloakVaults (the permanent vaults)</td><td><a href={A(ADDR.vaults)} target="_blank" rel="noreferrer"><code>{ADDR.vaults}</code></a></td></tr>
              {DEPLOYMENT?.dropFactory && <tr><td>CloakDropFactory (sealed NFT drops)</td><td><a href={A(DEPLOYMENT.dropFactory)} target="_blank" rel="noreferrer"><code>{DEPLOYMENT.dropFactory}</code></a></td></tr>}
              {DEPLOYMENT?.spotBook && <tr><td>CloakSpotBook (WL spot sales)</td><td><a href={A(DEPLOYMENT.spotBook)} target="_blank" rel="noreferrer"><code>{DEPLOYMENT.spotBook}</code></a></td></tr>}
              {DEPLOYMENT?.v4Hook && <tr><td>CloakV4Hook (Uniswap v4 launches: seeds the pool, keeps the liquidity, creator fees, anti-snipe fee)</td><td><a href={A(DEPLOYMENT.v4Hook)} target="_blank" rel="noreferrer"><code>{DEPLOYMENT.v4Hook}</code></a></td></tr>}
              {DEPLOYMENT?.poolManager && <tr><td>Uniswap v4 PoolManager</td><td><a href={A(DEPLOYMENT.poolManager)} target="_blank" rel="noreferrer"><code>{DEPLOYMENT.poolManager}</code></a></td></tr>}
              {DEPLOYMENT?.feeLocker && <tr><td>CloakFeeLocker (LP locked forever, trading fees to creators)</td><td><a href={A(DEPLOYMENT.feeLocker)} target="_blank" rel="noreferrer"><code>{DEPLOYMENT.feeLocker}</code></a></td></tr>}
              <tr><td>CloakFactory (launches open a Uniswap V2 pool)</td><td><a href={A(ADDR.factory)} target="_blank" rel="noreferrer"><code>{ADDR.factory}</code></a></td></tr>
              {ADDR.seeder && <tr><td>CloakSeeder (opens each pool at the clearing price)</td><td><a href={A(ADDR.seeder)} target="_blank" rel="noreferrer"><code>{ADDR.seeder}</code></a></td></tr>}
              {(DEPLOYMENT?.earlierFactories ?? []).map((f, i, all) => <tr key={f}><td>CloakFactory, earlier ({i === all.length - 1 ? "v4's first, Cloak pools" : "Uniswap pools, no creator fees"}; still lists)</td><td><a href={A(f)} target="_blank" rel="noreferrer"><code>{f}</code></a></td></tr>)}
              <tr><td>PrivateRouter</td><td><a href={A(ADDR.router)} target="_blank" rel="noreferrer"><code>{ADDR.router}</code></a></td></tr>
              <tr><td>PrivateBatcher</td><td><a href={A(ADDR.batcher)} target="_blank" rel="noreferrer"><code>{ADDR.batcher}</code></a></td></tr>
              <tr><td>HYPE vault</td><td><a href={A(ADDR.hypePool)} target="_blank" rel="noreferrer"><code>{ADDR.hypePool}</code></a></td></tr>
              <tr><td>USDC vault</td><td><a href={A(ADDR.usdcPool)} target="_blank" rel="noreferrer"><code>{ADDR.usdcPool}</code></a></td></tr>
              <tr><td>CloakMigrator (from v1, v2 and v3)</td><td><a href={A(ADDR.migrator)} target="_blank" rel="noreferrer"><code>{ADDR.migrator}</code></a></td></tr>
            </tbody>
          </table>
          <p>No function in any of these contracts lets anyone, including us, move funds out of an auction or a vault. Money leaves a vault only with its owner's proof. <code>CloakConfig</code> holds the rules every contract reads: the fees, the deposit caps and the proof verifier, within hard ceilings in the code. Who can change them, and how fast, is under <a href="#governance" onClick={go("governance")}>Who can change what</a>. Source, tests and real testnet runs are on <a href={GITHUB} target="_blank" rel="noreferrer">GitHub</a>.</p>
          <p><b>The vaults are permanent.</b> Every asset has one vault, made once by <code>CloakVaults</code> and never replaced. Routers, batchers and factories are helpers around the vaults: a better one is added next to the old one and nobody's balance moves. Your private account is signed for this chain only, never for a contract, so it and your <code>cloak:</code> address stay the same from now on. <code>CloakConfig</code> keeps the list of every Cloak contract with the block it started. The rules for later upgrades are in <a href={`${GITHUB}/blob/main/docs/VAULT.md`} target="_blank" rel="noreferrer">docs/VAULT.md</a>.</p>
          <p>Cloak's earlier contracts (v1, v2 and v3) are still on-chain. Their launches still show here, their tokens have permanent vaults, and a private balance held in them moves across once from the Portfolio page through <code>CloakMigrator</code>. It stays private, and the relayer can't redirect it.</p>

          <h2 id="fees">Fees & caps</h2>
          <table>
            <tbody>
              <tr><td>Deposits and private sends</td><td>Free</td></tr>
              <tr><td>Withdrawals, private swaps and batch orders</td><td>0.25% of the amount, kept in the vault and collected to the treasury (hard cap 1%)</td></tr>
              <tr><td>Launch fee</td><td>1.5% of a successful raise, taken at settlement. Nothing if the launch doesn't fill (hard cap 3%)</td></tr>
              <tr><td>Relayer fee</td><td>The gas the relayer pays, plus a small margin, taken inside your proof from the same balance</td></tr>
            </tbody>
          </table>
          <p>While Cloak is in beta, deposits are capped: 100 HYPE per deposit and 10,000 HYPE in the HYPE vault, 1,000 USDC per deposit and 50,000 USDC in the USDC vault, 10% of a token's supply per deposit and 50% in total for launch-token vaults, and 100 HYPE per bid and 10,000 HYPE in total for each new launch. Withdrawals are never capped. Caps lift after the audit and the public trusted-setup ceremony.</p>
          <p>A creator's own share is capped at 20% of the supply and vests over at least 30 days from the end of the auction.</p>

          <h2 id="rules">All the rules</h2>
          <p>Every rule with its number, where it's enforced and who can change it is in <a href={`${GITHUB}/blob/main/docs/RULES.md`} target="_blank" rel="noreferrer">docs/RULES.md</a>. The ones people ask about most:</p>
          <table>
            <thead><tr><th>Rule</th><th>Value</th><th>Set by</th></tr></thead>
            <tbody>
              <tr><td>Price levels per launch</td><td>Up to 256</td><td>Contract</td></tr>
              <tr><td>Penalty for a bid that's never revealed</td><td>10% to 50% of the deposit (the creator picks), burned</td><td>Contract</td></tr>
              <tr><td>When a launch fails</td><td>Only if no bid was revealed: full refunds, tokens back to the creator</td><td>Contract</td></tr>
              <tr><td>Creator's own share</td><td>At most 20% of supply, vesting over at least 30 days</td><td>Contract</td></tr>
              <tr><td>Launch token</td><td>Fixed supply, no owner, no mint, no tax, no blacklist</td><td>Contract</td></tr>
              <tr><td>Pool opening price</td><td>Exactly the clearing price, Uniswap V2, 0.3% fee</td><td>Contract</td></tr>
              <tr><td>LP</td><td>Locked forever with trading fees to the creator, burned, or locked until a date</td><td>Contract</td></tr>
              <tr><td>Creator fees</td><td>Uniswap's 0.3% on every trade; the locked liquidity can never be taken</td><td>Contract</td></tr>
              <tr><td>Winners' window to claim privately</td><td>1 hour after reveals end, then the keeper pushes public claims</td><td>Keeper</td></tr>
              <tr><td>Private swap slippage and deadline</td><td>1% and 10 minutes by default</td><td>App</td></tr>
              <tr><td>Batch round</td><td>30 s, 2% price guard, 5% impact guard, refunds after 10 min</td><td>Contract</td></tr>
              <tr><td>Fees</td><td>0.25% on withdrawals, swaps and batch orders (cap 1%), 1.5% of a successful raise (cap 3%), deposits and sends free</td><td>Config</td></tr>
              <tr><td>Beta caps</td><td>See Fees & caps. Withdrawals never capped</td><td>Config</td></tr>
              <tr><td>Relay fee</td><td>Its gas × 1.25, at least 0.1 gwei gas price</td><td>Keeper</td></tr>
            </tbody>
          </table>

          <h2 id="governance">Who can change what</h2>
          <ul>
            <li><b>Nobody can move your money.</b> No function in any Cloak contract does it, for us or anyone else.</li>
            <li><b>Rules in the code</b> (the auction, the pool opening, batch guards, fee ceilings, vaults that are never replaced) can't be changed by anyone. A new version can only be added next to the old one, and the old one keeps working.</li>
            <li><b>Rules in <code>CloakConfig</code></b> (fees under their ceilings, caps, the verifier, which assets and factories are allowed): <b>today, on testnet, Cloak is still in setup</b>, so the owner (one wallet) can change them at once. Before mainnet, ownership moves to a multisig and setup ends for good. From then on, tightening a rule is instant, and loosening one is queued on-chain, waits a public <b>3 days</b>, and lapses if it isn't carried out within 14 days after that. Anyone who disagrees has 3 days to leave.</li>
            <li><b>Keeper and app settings</b> (the claim window, relay fee, default slippage) are how our hosted services behave. Anyone can run their own.</li>
          </ul>

          <h2 id="keeper">Keeper & relayer</h2>
          <p>The keeper is a small Node service. It reveals bids once the drand round passes, settles launches and batch rounds, pays out orders, and relays private transactions (<code>POST /relay</code>). It pays gas, so it's the on-chain sender of every private trade, and takes a fee for that inside the proof (<code>GET /quote</code>): the gas it pays × 1.25, at a gas price of at least 0.1 gwei. A call that doesn't pay it is refused before it costs anything, and each IP can send 20 relay requests a minute. It pushes public claims 1 hour after a launch's reveals end, so winners can claim privately first, and it opens each launch's private vault at settlement. It can delay or refuse a transaction, but it can't change or steal one, because the proof binds every field. Anyone can run one: <code>node services/keeper/index.mjs</code>.</p>

          <h2 id="limits">Limits & threat model</h2>
          <ul>
            <li>Sealed bids stop <i>ordering</i> games, not many-wallet games. Uniform pricing removes most of the reason to split.</li>
            <li>drand is a threshold network. A threshold collusion could decrypt bids early.</li>
            <li>The relayer sees your IP and can delay you. Anyone can run their own.</li>
            <li>The Groth16 keys come from a development ceremony. Production needs a public one.</li>
            <li>Unaudited testnet software. Mainnet is planned for Nov 9, with deposit caps until the audit and trusted-setup ceremony are done.</li>
          </ul>
        </article>
        <aside className="toc">
          <div className="eyebrow">On this page</div>
          {NAV.flatMap(([, xs]) => xs).map(([id, label]) => <a key={id} href={`#${id}`} onClick={go(id)} style={on === id ? { color: "var(--text)" } : undefined}>{label}</a>)}
        </aside>
      </div>
    </>
  );
}
