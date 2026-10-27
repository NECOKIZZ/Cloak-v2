import { useEffect, useRef, useState } from "react";
import { Link } from "../router";
import { Announce, EXPLORER, Footer, GITHUB, Icon, Logo, Nav, Section } from "../ui";

// each public card has a sealed twin; it turns into it as it crosses the Cloak line
const PAIRS = [
  { pub: { k: "Launch buy", who: "Bot 0x7a3…", amt: "40,000", u: "SHADE" }, seal: { k: "Sealed bid", who: "Bidder" } },
  { pub: { k: "Wallet balance", who: "0x19c…e4", amt: "12.4", u: "HYPE" }, seal: { k: "Private balance", who: "Owner" } },
  { pub: { k: "Swap", who: "From 0xbe1…", amt: "2,250", u: "CLOAK" }, seal: { k: "Private trade", who: "Trader" } },
  { pub: { k: "Payment", who: "To 0x44f…", amt: "380", u: "HYPE" }, seal: { k: "Private send", who: "To" } },
  { pub: { k: "Market sell", who: "From 0x5d2…", amt: "18,500", u: "SHADE" }, seal: { k: "Batch order", who: "Order" } },
];

function Ticket({ k, who, amt, u, sealed }: { k: string; who: string; amt?: string; u?: string; sealed?: boolean }) {
  return (
    <div className={`ticket ${sealed ? "is-sealed" : ""}`}>
      <div className="t-top">
        <span>{k}</span>
        <span>{sealed ? <><span className="dot" style={{ marginRight: 6 }} />Sealed</> : "Public chain"}</span>
      </div>
      <div className="t-to">{sealed ? <>{who} <span className="dots">●●●●●</span></> : who}</div>
      <div className="t-amt">{sealed ? <span className="dots" style={{ fontSize: 20 }}>●●●●●●●</span> : <>{amt}<small>{u}</small></>}</div>
    </div>
  );
}

function Strip() {
  // the same row is drawn twice in lockstep: public cards left of the line, their sealed twins right of it
  const row = (sealed: boolean) => {
    const cards = PAIRS.map((p, i) => <Ticket key={i} {...(sealed ? p.seal : p.pub)} sealed={sealed} />);
    return <div className="strip-track">{cards}{cards.map((c, i) => <div key={`d${i}`} style={{ display: "contents" }}>{c}</div>)}</div>;
  };
  return (
    <>
      <div className="seal-strip">
        <div className="seal-layer is-public">{row(false)}</div>
        <div className="seal-layer is-sealed" aria-hidden="true">{row(true)}</div>
        <div className="seal-line"><span><Logo size={15} />Cloak</span></div>
      </div>
      <div className="strip-legend"><span>What a launch or trade normally reveals</span><span>What Cloak lets the world see</span></div>
    </>
  );
}

function Demos() {
  const [view, setView] = useState<"you" | "chain">("you");
  const [price, setPrice] = useState("0.005");
  const [buy, setBuy] = useState("0.5");
  const [batch, setBatch] = useState("0.37");
  const chain = view === "chain";
  const split: Record<string, string> = { "0.37": "0.2 + 0.1 + 0.05 + 0.02", "1.5": "1 + 0.5", "8": "5 + 2 + 1" };
  return (
    <div className="live-panel">
      <div className="center statement">
        <h2 className="display-2">Private by default, live on testnet</h2>
        <p className="lede">Seal a bid, trade from a private balance, hide your size in a batch. These are real contracts on Elysium, and proofs are made in your browser.</p>
        <div style={{ marginTop: 28 }}>
          <div className="seg">
            <button className={!chain ? "on" : ""} onClick={() => setView("you")}>What you see</button>
            <button className={chain ? "on" : ""} onClick={() => setView("chain")}>What the chain sees</button>
          </div>
        </div>
        <p className="xs mute" style={{ marginTop: 12 }}>Try the controls. The buttons open the real app on testnet.</p>
      </div>
      <div className="demo-grid">
        <div>
          <div className="demo">
            <div className="demo-box">
              <div className="k"><span>Max price per token</span><span>HYPE</span></div>
              <div className="v">{chain ? <span className="sealed" style={{ width: 110, height: 24 }} /> : price}</div>
              <div className="chips">{["0.002", "0.005", "0.01"].map((p) => <button key={p} className={`chip ${price === p ? "on" : ""}`} onClick={() => setPrice(p)}>{p}</button>)}</div>
            </div>
            <div className="demo-box">
              <div className="k"><span>{chain ? "On-chain" : "You pay"}</span>{!chain && <span className="signal">uniform price</span>}</div>
              <div className="v" style={{ fontSize: chain ? 15 : 28 }}>{chain ? <span className="mono">hash 0x9f3c…a1 + timelock ciphertext</span> : "the clearing price"}</div>
            </div>
            <Link to="/app" className="btn btn-ink btn-block">Seal a bid</Link>
          </div>
          <div className="demo-cap"><div className="eyebrow">Sealed launch →</div><p>Nobody sees your bid until bidding closes. Everyone who wins pays the same price.</p></div>
        </div>
        <div>
          <div className="demo">
            <div className="demo-box">
              <div className="k"><span>Spend private HYPE</span><span className="signal">● only you</span></div>
              <div className="v">{buy}</div>
              <div className="chips">{["0.1", "0.5", "1"].map((p) => <button key={p} className={`chip ${buy === p ? "on" : ""}`} onClick={() => setBuy(p)}>{p}</button>)}</div>
            </div>
            <div className="demo-box">
              <div className="k"><span>{chain ? "Sender on the explorer" : "You receive"}</span></div>
              <div className="v">{chain ? <span style={{ fontSize: 18 }}>Relayer <span className="dots">●●●●</span></span> : `~${Math.round(Number(buy) * 476)} SHADE`}</div>
            </div>
            <Link to="/app/trade" className="btn btn-ink btn-block">Trade privately</Link>
          </div>
          <div className="demo-cap"><div className="eyebrow">Private trade →</div><p>Proven on your device, sent by a relayer. Your wallet never appears on the trade.</p></div>
        </div>
        <div>
          <div className="demo">
            <div className="demo-box">
              <div className="k"><span>Batch buy</span><span>HYPE</span></div>
              <div className="v">{chain ? <span className="sealed" style={{ width: 90, height: 24 }} /> : batch}</div>
              <div className="chips">{["0.37", "1.5", "8"].map((p) => <button key={p} className={`chip ${batch === p ? "on" : ""}`} onClick={() => setBatch(p)}>{p}</button>)}</div>
            </div>
            <div className="demo-box">
              <div className="k"><span>{chain ? "Round 812 shows" : "Split into standard orders"}</span></div>
              <div className="v" style={{ fontSize: 17 }}>{chain ? "11 orders · net +0.4 HYPE" : split[batch]}</div>
            </div>
            <Link to="/app/trade" className="btn btn-ink btn-block">Try batch mode</Link>
          </div>
          <div className="demo-cap"><div className="eyebrow">Batch auction →</div><p>Your size hides among everyone's. Buys and sells cross at the fair price, and only the net touches the pool.</p></div>
        </div>
      </div>
    </div>
  );
}

/** Two aligned portraits; the uncloaked one shows through a soft circle that follows the pointer. */
function Uncloak() {
  const stage = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const cur = { x: 0.5, y: 0.36, r: 0 };
    const tgt = { x: 0.5, y: 0.36, r: 0 };
    let inside = false, peekUntil = 0, speed = 0, raf = 0, last = { x: 0, y: 0 };
    const fit = () => el.style.setProperty("--head", `${Math.max(0, el.getBoundingClientRect().top + scrollY)}px`);
    fit();
    addEventListener("resize", fit);
    const base = () => Math.max(80, Math.min(180, el.clientWidth * 0.12));
    const move = (e: PointerEvent) => {
      const b = el.getBoundingClientRect();
      const x = (e.clientX - b.left) / b.width, y = (e.clientY - b.top) / b.height;
      speed = Math.min(1, speed + Math.hypot(x - last.x, y - last.y) * 6);
      last = { x, y };
      Object.assign(tgt, { x, y });
      inside = true;
      peekUntil = 0;
    };
    const leave = () => (inside = false);
    const up = (e: PointerEvent) => e.pointerType !== "mouse" && leave();
    const frame = () => {
      speed *= 0.92;
      const peeking = !inside && performance.now() < peekUntil;
      if (peeking) Object.assign(tgt, { x: 0.5, y: 0.36 });
      tgt.r = inside || peeking ? base() * (1 + speed * 0.35) : 0;
      const k = still ? 1 : 0.14;
      cur.x += (tgt.x - cur.x) * k;
      cur.y += (tgt.y - cur.y) * k;
      cur.r += (tgt.r - cur.r) * (still ? 1 : 0.1);
      el.style.setProperty("--x", `${(cur.x * 100).toFixed(2)}%`);
      el.style.setProperty("--y", `${(cur.y * 100).toFixed(2)}%`);
      el.style.setProperty("--r", `${cur.r.toFixed(1)}px`);
      el.style.setProperty("--o", Math.min(1, Math.max(0, (cur.r - 6) / 40)).toFixed(3));
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    // a short peek at the face on load, so people know there's someone under the hood
    const peek = still ? 0 : window.setTimeout(() => {
      if (!inside) peekUntil = performance.now() + 1500;
    }, 900);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerdown", move);
    el.addEventListener("pointerleave", leave);
    el.addEventListener("pointerup", up);
    return () => {
      cancelAnimationFrame(raf);
      removeEventListener("resize", fit);
      clearTimeout(peek);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerdown", move);
      el.removeEventListener("pointerleave", leave);
      el.removeEventListener("pointerup", up);
    };
  }, []);
  return (
    <div className="uncloak" ref={stage}>
        <div className="uncloak-figure">
          <img src="/hero/cloaked.webp" alt="A figure hidden under a black hooded cloak" width={1400} height={933} draggable={false} />
          <img src="/hero/man.webp" alt="" aria-hidden="true" className="uncloak-reveal" width={1400} height={933} draggable={false} />
        </div>
      {/* the title blends with the figure (black on the page, white on the cloak), so it sits directly in the stage */}
      <h1 className="uncloak-title">Launch sealed.<br />Trade unseen.</h1>
      <div className="hero-actions hero-cta">
        <Link to="/app" className="btn btn-ink btn-lg">Open app</Link>
        <Link to="/docs" className="btn btn-ghost btn-lg">Read the docs</Link>
      </div>
    </div>
  );
}

export function Landing() {
  return (
    <>
      <Announce />
      <Nav />
      <main>
        <section className="hero">
          <Uncloak />
        </section>
        <section className="wrap">
          <div className="pillars">
            <div className="pillar">
              <div className="eyebrow">The launch</div>
              <h3>Sealed-bid, one price</h3>
              <p>Bids are hidden, even from Elysium's sequencer. They open themselves when bidding ends, and every winner pays the same clearing price.</p>
              <Link to="/app" className="arrow">See live launches</Link>
            </div>
            <div className="pillar">
              <div className="eyebrow">The vault</div>
              <h3>Private balances and trades</h3>
              <p>Hold, buy, sell and send launch tokens from a private balance. A relayer submits for you, so your wallet never shows up.</p>
              <Link to="/app/trade" className="arrow">Trade privately</Link>
            </div>
            <div className="pillar">
              <div className="eyebrow">The SDK</div>
              <h3>Plug it into any launchpad</h3>
              <p>One package gives an Elysium launchpad sealed launches, locked liquidity and private trading.</p>
              <Link to="/sdk" className="arrow">Explore the SDK</Link>
            </div>
          </div>
        </section>

        <Section>
          <div className="statement">
            <h2 className="display-2">On Elysium, every launch is a race and every trade is a postcard. Cloak seals both.</h2>
            <p className="lede">One sequencer orders transactions by fee every 300 ms, so bots win launches. Then every buy and sell is public forever, tied to your wallet. Cloak keeps settlement on-chain and the details private.</p>
          </div>
          <Strip />
        </Section>

        <Section><Demos /></Section>

        <Section id="how">
          <h2 className="display-2" style={{ maxWidth: 720 }}>A launch where speed buys nothing</h2>
          <p className="lede" style={{ marginTop: 16 }}>Four steps, all on-chain, with no operator in the middle.</p>
          <div className="steps">
            <div className="step"><span className="n">01</span><h3>Seal</h3><p>Your price and size are hashed and timelock-encrypted. The chain only stores the fingerprint.</p></div>
            <div className="step"><span className="n">02</span><h3>Auto-reveal</h3><p>When bidding closes, the drand beacon releases the key. Anyone can open every bid, but nobody can change one.</p></div>
            <div className="step"><span className="n">03</span><h3>One price</h3><p>Demand is walked from the top until supply runs out. That price is what every winner pays.</p></div>
            <div className="step"><span className="n">04</span><h3>Locked liquidity</h3><p>Part of the raise seeds the pool at exactly that price. The LP shares are burned, so there's no rug.</p></div>
          </div>
        </Section>

        <Section>
          <h2 className="display-2">Built for tokens that shouldn't be a public race</h2>
          <p className="lede" style={{ marginTop: 16 }}>Fair launches for projects, and privacy for the people who hold what they launch.</p>
          <div className="uses">
            <div className="use"><Icon.rocket /><h3>Fair launches</h3><p>No snipers, no gas wars, and no overpaying. Everyone gets the same price.</p></div>
            <div className="use"><Icon.lock /><h3>Private holders</h3><p>Hold launch tokens without strangers looking up your balance.</p></div>
            <div className="use"><Icon.swap /><h3>Private trading</h3><p>Buy and sell from your private balance. Your wallet is never on the trade.</p></div>
            <div className="use"><Icon.layers /><h3>Batch auctions</h3><p>Standard-size orders, crossed at the fair price. Nobody can tell how much you moved.</p></div>
            <div className="use"><Icon.send /><h3>Private payments</h3><p>Pay anyone's cloak address. No sender, no recipient and no amount on-chain.</p></div>
            <div className="use"><Icon.users /><h3>Launchpads</h3><p>Add all of it with one SDK call, as a fair-launch mode next to what you already run.</p></div>
          </div>
        </Section>

        <Section>
          <h2 className="display-2" style={{ maxWidth: 760 }}>Sealed bids shouldn't need a committee</h2>
          <p className="lede" style={{ marginTop: 16 }}>Other sealed-bid sales keep bids secret with a committee or a special network that holds the keys. Cloak only needs a public beacon and your own device.</p>
          <div className="compare">
            <div className="cmp">
              <span className="eyebrow">Committee model</span>
              <span className="small mute">FHE and MPC networks · off-chain allocations</span>
              <h3>Someone else holds the key.</h3>
              <p>That means their own network or co-processor, and an operator you have to trust. None of them run on Elysium.</p>
            </div>
            <div className="cmp us">
              <span className="eyebrow">Cloak</span>
              <span className="small mute">drand timelock · proofs on your device</span>
              <h3>A public clock opens the bids. Your device makes the proofs.</h3>
              <p>It runs on a standard EVM chain like Elysium. No operator can read bids early or move your funds.</p>
            </div>
          </div>
        </Section>

        <section className="wrap section">
          <div className="deep dev">
            <div>
              <div className="eyebrow" style={{ color: "var(--deep-soft)" }}>For launchpads and builders</div>
              <h2 className="display-2" style={{ marginTop: 14 }}>Add sealed launches and private trading to anything</h2>
              <p className="lede" style={{ marginTop: 18 }}>The SDK gives any Elysium launchpad sealed-bid launches with locked liquidity, plus private balances, trades, batches and sends for its users.</p>
              <div className="hero-actions">
                <Link to="/sdk" className="btn btn-primary">Explore the SDK</Link>
                <Link to="/docs" className="arrow" style={{ color: "var(--on-deep)" }}>Read the docs</Link>
              </div>
            </div>
            <div>
              <div className="code">
                <div className="code-head"><span>@cloakely/sdk</span><span>TypeScript</span></div>
                <pre>
                  <span className="k">import</span> {"{ Cloak, CloakPrivate }"} <span className="k">from</span> <span className="s">"@cloakely/sdk"</span>;{"\n\n"}
                  <span className="c">// launchpad: a sealed-bid launch with locked LP</span>{"\n"}
                  <span className="k">const</span> {"{ auction }"} = <span className="k">await</span> cloak.createLaunch({"{ name, symbol, saleSupply, … }"});{"\n\n"}
                  <span className="c">// bidder: sealed, auto-revealing</span>{"\n"}
                  <span className="k">await</span> cloak.bid(auction, {"{ maxPrice, quantity }"});{"\n\n"}
                  <span className="c">// holder: private trade, wallet never shows up</span>{"\n"}
                  <span className="k">await</span> priv.buy(token, parseEther(<span className="s">"0.5"</span>));{"\n"}
                  <span className="k">await</span> priv.batch(token, <span className="s">"sell"</span>, amount);
                </pre>
              </div>
              <div className="dev-links"><a href={GITHUB} target="_blank" rel="noreferrer">GitHub ↗</a><Link to="/docs#contracts">Contracts</Link><Link to="/docs#sdk">API</Link></div>
            </div>
          </div>
        </section>

        <Section>
          <div className="split">
            <div>
              <h2 className="display-2">No middlemen</h2>
              <a href={`${EXPLORER}/address/0xc1fc14e84cbbd10f75dad9d91bf50f47c48757fc`} target="_blank" rel="noreferrer" className="arrow" style={{ display: "inline-block", marginTop: 18, fontSize: 14 }}>Verify the contracts</a>
            </div>
            <div className="three">
              <div><h3>Nobody can take funds</h3><p>No function lets anyone, including us, move funds out of an auction or a vault. Rule changes wait a public 3-day delay.</p></div>
              <div><h3>Nothing to trust early</h3><p>Bids open on a public schedule. A relayer can submit your trade but can't change it.</p></div>
              <div><h3>Open source, end to end</h3><p>Contracts, circuits, SDK, keeper and app are public, with tests and real testnet runs.</p></div>
            </div>
          </div>
        </Section>
      </main>
      <Footer />
    </>
  );
}
