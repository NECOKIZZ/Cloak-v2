import { useEffect, useRef, useState, type ReactNode } from "react";
import { addrLink, BATCHER, FACTORY, ROUTER } from "../config";
import { Link } from "../router";
import { GITHUB, Icon, Logo, Nav } from "../ui";

const SLIDES = ["Cloak", "Problem", "Insight", "Product", "Launch", "Different", "Live", "Distribution", "Model", "Roadmap", "Team", "Close"];

function Slide({ i, dark, children, className = "" }: { i: number; dark?: boolean; children: ReactNode; className?: string }) {
  return (
    <section className={`slide ${dark ? "slide-dark" : ""} ${className}`} id={`s${i + 1}`} data-slide={i}>
      <div className="slide-in">
        <div className="slide-n">{String(i + 1).padStart(2, "0")} / {SLIDES.length} · {SLIDES[i]}</div>
        {children}
      </div>
    </section>
  );
}

function Contract({ name, addr }: { name: string; addr?: string }) {
  if (!addr) return null;
  return (
    <a className="p-contract" href={addrLink(addr)} target="_blank" rel="noreferrer">
      <span>{name}</span>
      <span className="mono">{addr.slice(0, 8)}…{addr.slice(-6)} ↗</span>
    </a>
  );
}

export function Pitch() {
  const [cur, setCur] = useState(0);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.title = "Cloak · Pitch";
    document.documentElement.classList.add("snap");
    const els = [...(root.current?.querySelectorAll<HTMLElement>("[data-slide]") ?? [])];
    const io = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && setCur(Number((e.target as HTMLElement).dataset.slide))), { threshold: 0.55 });
    els.forEach((el) => io.observe(el));
    const go = (d: number) => {
      const now = els.findIndex((el) => Math.abs(el.getBoundingClientRect().top - 68) < innerHeight / 2);
      els[Math.max(0, Math.min(els.length - 1, (now < 0 ? 0 : now) + d))]?.scrollIntoView({ behavior: "smooth" });
    };
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.("input, textarea")) return;
      if (["ArrowDown", "PageDown", " "].includes(e.key)) { e.preventDefault(); go(1); }
      if (["ArrowUp", "PageUp"].includes(e.key)) { e.preventDefault(); go(-1); }
    };
    addEventListener("keydown", key);
    return () => {
      io.disconnect();
      removeEventListener("keydown", key);
      document.documentElement.classList.remove("snap");
      document.title = "Cloak · Fair launches and private trading on Elysium";
    };
  }, []);

  return (
    <>
      <Nav />
      <div className="pitch" ref={root}>
        <nav className="pitch-rail" aria-label="Slides">
          {SLIDES.map((s, i) => <a key={s} href={`#s${i + 1}`} className={i === cur ? "on" : ""} aria-label={s} title={s} onClick={(e) => { e.preventDefault(); document.getElementById(`s${i + 1}`)?.scrollIntoView({ behavior: "smooth" }); }} />)}
        </nav>

        <Slide i={0} dark className="slide-cover">
          <img className="cover-art" src="/hero/crowd.webp" alt="" />
          <div className="cover-copy">
            <div className="brand" style={{ fontSize: 22 }}><Logo inverse size={34} />Cloak</div>
            <h1 className="p-title">Private launches and trades for Elysium.</h1>
            <p className="p-lede">Sealed-bid launches nobody can snipe, and private trading nobody can trace. Built by Bob Labs.</p>
            <div className="hero-actions"><Link to="/app" className="btn btn-primary btn-lg">Try it on testnet</Link><span className="xs" style={{ color: "var(--deep-soft)" }}>Press ↓ or scroll</span></div>
          </div>
        </Slide>

        <Slide i={1}>
          <h2 className="p-h">On Elysium, speed wins and everything shows.</h2>
          <div className="p-two">
            <div className="p-card">
              <div className="p-big">~300 ms</div>
              <h3>Launches are a race</h3>
              <p>One sequencer orders transactions by fee every ~300 ms. The fastest bot buys the first block of every launch, and real buyers pay the markup.</p>
            </div>
            <div className="p-card">
              <div className="p-big">100%</div>
              <h3>Every trade is a postcard</h3>
              <p>Every buy, sell and balance is public forever and tied to a wallet. Holders get tracked, sizes get copied, and big positions become targets.</p>
            </div>
          </div>
        </Slide>

        <Slide i={2}>
          <h2 className="p-h" style={{ maxWidth: 900 }}>Privacy has to start at the launch, not after it.</h2>
          <p className="p-lede" style={{ maxWidth: 720 }}>By the time a token trades, the snipe has already happened and every buyer's wallet is already linked to it. A mixer added later can't undo either. Cloak seals the bid, then keeps the holder private from the first trade on.</p>
        </Slide>

        <Slide i={3}>
          <h2 className="p-h">One layer, three parts</h2>
          <div className="p-three">
            <div className="p-card"><Icon.rocket /><h3>Sealed-bid launch</h3><p>Bids are sealed until bidding ends, then open themselves. Everyone pays one clearing price, and liquidity is locked at that price.</p></div>
            <div className="p-card"><Icon.lock /><h3>Private vault</h3><p>Hold, swap and send launch tokens from a private balance. A relayer submits for you, so your wallet never appears.</p></div>
            <div className="p-card"><Icon.layers /><h3>Batch auctions</h3><p>Orders in standard sizes, crossed at the fair price every round. Nobody can tell how much you traded.</p></div>
          </div>
        </Slide>

        <Slide i={4}>
          <h2 className="p-h">A launch where speed buys nothing</h2>
          <div className="steps" style={{ marginTop: 34 }}>
            <div className="step"><span className="n">01</span><h3>Seal</h3><p>Price and size are hashed and timelock-encrypted to a future drand round. The chain only stores the fingerprint.</p></div>
            <div className="step"><span className="n">02</span><h3>Auto-reveal</h3><p>When bidding closes, the public drand beacon releases the key. Anyone can open every bid, nobody can change one.</p></div>
            <div className="step"><span className="n">03</span><h3>One price</h3><p>Demand is walked from the top until supply runs out. That's the price every winner pays.</p></div>
            <div className="step"><span className="n">04</span><h3>Locked LP</h3><p>Part of the raise seeds the pool at that price. LP shares are burned or locked, then private trading opens.</p></div>
          </div>
        </Slide>

        <Slide i={5}>
          <h2 className="p-h" style={{ maxWidth: 860 }}>No committee, no operator, no new chain</h2>
          <div className="compare" style={{ marginTop: 34 }}>
            <div className="cmp">
              <span className="eyebrow">Other sealed or private designs</span>
              <h3>Someone else holds the key.</h3>
              <p>FHE or MPC networks, trusted hardware, or an off-chain operator who sees bids first. None of them run on Elysium today.</p>
            </div>
            <div className="cmp us">
              <span className="eyebrow">Cloak</span>
              <h3>A public clock opens the bids. Your device makes the proofs.</h3>
              <p>drand timelock for bids, zero-knowledge proofs made in the browser for the vault. Plain EVM contracts that nobody can withdraw from, with rule changes behind a public 3-day delay.</p>
            </div>
          </div>
        </Slide>

        <Slide i={6}>
          <h2 className="p-h">It's live on Elysium testnet</h2>
          <div className="p-stats">
            <div><b>27</b><span>contract tests passing</span></div>
            <div><b>31/31</b><span>end-to-end checks on testnet, with real proofs</span></div>
            <div><b>~4 s</b><span>to prove a private trade in the browser</span></div>
            <div><b>3 s</b><span>drand rounds open sealed bids on time</span></div>
          </div>
          <div className="p-contracts">
            <Contract name="Launch factory" addr={FACTORY} />
            <Contract name="Private router" addr={ROUTER} />
            <Contract name="Batch auction" addr={BATCHER} />
          </div>
        </Slide>

        <Slide i={7}>
          <h2 className="p-h" style={{ maxWidth: 860 }}>Distribution: plug into launchpads, don't compete with them</h2>
          <div className="p-three">
            <div className="p-card"><Icon.code /><h3>One SDK</h3><p><code>createLaunch()</code> gives any Elysium launchpad a sealed, fair-launch mode. <code>CloakPrivate</code> gives its users private balances.</p></div>
            <div className="p-card"><Icon.users /><h3>Launchpads first</h3><p>A fair-launch mode any Elysium launchpad can add: projects keep their launchpad, buyers get one price and no snipers.</p></div>
            <div className="p-card"><Icon.shield /><h3>Permissionless keepers</h3><p>Anyone can run a keeper to reveal, settle and relay. Several can run at once, so there's no single point of failure.</p></div>
          </div>
        </Slide>

        <Slide i={8}>
          <h2 className="p-h">Business model</h2>
          <p className="p-tag">Proposed · not in the testnet contracts yet</p>
          <div className="p-three">
            <div className="p-card"><div className="p-big">Launch fee</div><p>A small share of each raise at settlement, paid by the project, only when the launch succeeds.</p></div>
            <div className="p-card"><div className="p-big">Batch fee</div><p>A few basis points on the net that each batch round sends through the pool.</p></div>
            <div className="p-card"><div className="p-big">Relaying</div><p>Relayers recover gas plus a small tip from inside the private transaction, so users never need public gas.</p></div>
          </div>
        </Slide>

        <Slide i={9}>
          <h2 className="p-h">Roadmap</h2>
          <div className="p-road">
            <div className="on"><span className="eyebrow">Now · testnet</span><h3>Sealed launches, private vault</h3><p>Sealed bids, one price, locked LP. Private balances, swaps, sends and batch auctions. Hosted keeper and relayer.</p></div>
            <div><span className="eyebrow">Next</span><h3>Harden and package</h3><p>Bid from a private balance, a security audit, the SDK on npm, and more keepers.</p></div>
            <div><span className="eyebrow">Nov 9 · mainnet</span><h3>Mainnet on Elysium</h3><p>Launch with deposit caps and fees switched on. Caps lift after the audit and trusted-setup ceremony, then launchpad integrations and new private order types.</p></div>
          </div>
        </Slide>

        <Slide i={10}>
          <h2 className="p-h">Team</h2>
          <div className="p-team">
            <div className="p-card">
              <div className="brand" style={{ fontSize: 22 }}>Bob Labs</div>
              <p style={{ marginTop: 14 }}>We build privacy tools for public chains. Cloak is our launch and trading product on Elysium: sealed-bid auctions, a private vault and batch trading, all open source.</p>
              <div className="row-flex" style={{ gap: 14, marginTop: 18, flexWrap: "wrap" }}>
                <a className="arrow" href="https://cloak.boblabs.tech" target="_blank" rel="noreferrer">cloak.boblabs.tech</a>
                <a className="arrow" href={GITHUB} target="_blank" rel="noreferrer">GitHub</a>
              </div>
            </div>
          </div>
        </Slide>

        <Slide i={11} dark className="slide-close">
          <img className="close-art" src="/hero/cloaked.webp" alt="" />
          <div className="close-copy">
            <h2 className="p-title">Launch sealed.<br />Trade unseen.</h2>
            <p className="p-lede">Try a sealed bid, a private swap and a batch order on Elysium testnet. It takes about two minutes.</p>
            <div className="hero-actions" style={{ justifyContent: "center" }}>
              <Link to="/app" className="btn btn-primary btn-lg">Open the app</Link>
              <Link to="/docs" className="btn btn-ghost btn-lg">Read the docs</Link>
            </div>
          </div>
        </Slide>
      </div>
    </>
  );
}
