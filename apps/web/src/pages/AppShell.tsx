import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useRoute } from "../router";
import { useApp } from "../state";
import { GITHUB, Icon, Logo, MenuButton, Sheet, ThemeSeg, ThemeToggle, WalletButton, useSheet } from "../ui";
import { STEPS, guideShown, hideGuide, markDone, useGuide, type Step } from "../guide";
import { navigate } from "../router";
import { KEEPER_URL, chain } from "../config";

function Welcome({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <Logo size={34} />
        <div className="eyebrow" style={{ marginTop: 18 }}>Cloak testnet</div>
        <h2>Welcome to Cloak</h2>
        <p className="mute small">Fair launches and private trading on Elysium testnet. This is test software with play money, so don't use real funds.</p>
        <div className="qs">
          <div><span className="n">1</span><span>Connect a wallet. Cloak adds the <b>Elysium testnet</b> network for you.</span></div>
          <div><span className="n">2</span><span>Get testnet HYPE from the <a className="link" href="https://elysium.kinetiq.xyz/testnet-faucet" target="_blank" rel="noreferrer">Elysium faucet</a>.</span></div>
          <div><span className="n">3</span><span><b>Shield</b> HYPE, USDC or CLOAK and trade privately, or <b>bid</b> in a sealed launch.</span></div>
        </div>
        <div className="summary" style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
          <Icon.lock size={16} /><span className="xs mute">Your private account comes from one wallet signature. Nothing is stored on a server, and the same wallet always restores it.</span>
        </div>
        <div className="row-flex" style={{ marginTop: 6 }}>
          <button className="btn btn-ink" style={{ flex: 1 }} onClick={onClose}>Enter the app</button>
          <Link to="/docs" className="btn btn-ghost" style={{ flex: 1 }}>Read the docs</Link>
        </div>
      </div>
    </div>
  );
}

type Item = { to: string; label: string; I: (p: { size?: number }) => JSX.Element; on: (p: string) => boolean };
const GROUPS: [string, Item[]][] = [
  ["Private", [
    { to: "/app", label: "Portfolio", I: Icon.wallet, on: (p) => p === "/app" || p.startsWith("/app/portfolio") },
    { to: "/app/trade", label: "Trade", I: Icon.swap, on: (p) => p.startsWith("/app/trade") },
  ]],
  ["Launch", [
    { to: "/app/launches", label: "Launches", I: Icon.launch, on: (p) => p.startsWith("/app/launch") },
    { to: "/app/create", label: "Create a launch", I: Icon.plus, on: (p) => p === "/app/create" },
    { to: "/app/volume", label: "Volume", I: Icon.layers, on: (p) => p.startsWith("/app/volume") },
  ]],
];
const LEARN: Item[] = [
  { to: "/docs", label: "Docs", I: Icon.book, on: () => false },
  { to: "/sdk", label: "SDK", I: Icon.code, on: () => false },
];

const GUIDE: Record<Step, { title: string; text: string; go: string }> = {
  unlock: { title: "Unlock your private account", text: "One free signature makes your private account on this device. No transaction.", go: "/app" },
  shield: { title: "Add money privately", text: "Shield HYPE, USDC or CLOAK. It moves into your private balance and stops showing in your wallet.", go: "/app/portfolio/shield" },
  swap: { title: "Swap privately", text: "Trade launch tokens from your private balance. Your wallet never appears on the trade.", go: "/app/trade" },
  bid: { title: "Bid in a sealed launch", text: "Nobody can see your price or size until bidding closes.", go: "/app/launches" },
};

/** The "Getting started" checklist: four first steps, ticked off as they happen, with a Go button for the next one. */
function GettingStarted({ onClose }: { onClose: () => void }) {
  const { done } = useGuide();
  const { priv, unlock } = useApp();
  const next = STEPS.find((x) => !done.includes(x));
  const go = (x: Step) => {
    onClose();
    if (x === "unlock" && !priv) unlock();
    navigate(GUIDE[x].go);
  };
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal guide" onClick={(e) => e.stopPropagation()}>
        <div className="row-flex" style={{ justifyContent: "space-between" }}>
          <span className="xs mute">{done.length} of {STEPS.length} done</span>
          <button className="btn btn-text xs" aria-label="Close" onClick={onClose}>✕</button>
        </div>
        <h2>Getting started</h2>
        <p className="mute small">A few steps to get going. Each one takes a minute.</p>
        <div className="guide-steps">
          {STEPS.map((x, i) => {
            const isDone = done.includes(x);
            const isNext = x === next;
            return (
              <div key={x} className={`guide-step ${isNext ? "next" : ""} ${isDone ? "done" : ""}`}>
                <span className="n">{isDone ? <Icon.check size={14} /> : i + 1}</span>
                <div>
                  <div className="t">{GUIDE[x].title}</div>
                  {isNext && <div className="xs mute">{GUIDE[x].text}</div>}
                </div>
                {isDone ? <span className="xs signal">Done</span> : isNext ? <button className="btn btn-ink btn-sm" onClick={() => go(x)}>Go</button> : <button className="btn btn-text xs" onClick={() => markDone(x)}>Mark done</button>}
              </div>
            );
          })}
        </div>
        <div className="row-flex" style={{ justifyContent: "space-between" }}>
          <button className="btn btn-text xs" onClick={() => { hideGuide(); onClose(); }}>Don't show again</button>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

function GuideLink({ onOpen }: { onOpen: () => void }) {
  const { done, hidden } = useGuide();
  if (hidden || done.length >= STEPS.length) return null;
  return <button className="side-link" onClick={onOpen}><Icon.check />Getting started<span className="spacer" /><span className="xs mute">{done.length}/{STEPS.length}</span></button>;
}

function NavItems({ path }: { path: string }) {
  return (
    <>
      {GROUPS.map(([g, xs]) => (
        <div key={g} className="side-group">
          <div className="eyebrow">{g}</div>
          {xs.map((x) => <Link key={x.to} to={x.to} className={`side-link ${x.on(path) ? "on" : ""}`}><x.I />{x.label}</Link>)}
        </div>
      ))}
    </>
  );
}

function Network() {
  const { wrongChain, switchNetwork } = useApp();
  if (wrongChain) return <button className="side-net bad" onClick={switchNetwork}><span className="dot" />Switch to Elysium</button>;
  return <div className="side-net"><span className="dot live" />{chain.name}</div>;
}

function Status({ keeper }: { keeper: "up" | "down" | "?" }) {
  const { priv } = useApp();
  return (
    <div className="side-status">
      <span><span className="dot" style={{ background: keeper === "down" ? "var(--danger)" : undefined }} />Keeper {keeper === "up" ? "online" : keeper === "down" ? "offline" : "…"}</span>
      <span><Icon.lock size={11} />{priv ? "Unlocked" : "Locked"}</span>
    </div>
  );
}

/**
 * The app frame: a floating sidebar on desktop with no top bar, and on phones a
 * slim bar with the wallet and a full-screen menu.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { path } = useRoute();
  const { error, setError, priv } = useApp();
  const guide = useGuide();
  const [guideOpen, setGuideOpen] = useState(false);
  const [open, setOpen] = useSheet();
  const bar = useRef<HTMLElement>(null);
  const [keeper, setKeeper] = useState<"up" | "down" | "?">("?");
  const [welcome, setWelcome] = useState(() => {
    try {
      return localStorage.getItem("cloak.welcomed") !== "1";
    } catch {
      return false;
    }
  });
  // the checklist opens by itself once, after the welcome; later from the sidebar
  useEffect(() => {
    if (!welcome && !guide.shown && !guide.hidden) {
      setGuideOpen(true);
      guideShown();
    }
  }, [welcome]);
  useEffect(() => {
    if (priv) markDone("unlock");
  }, [priv]);
  useEffect(() => {
    if (!KEEPER_URL) return;
    fetch(KEEPER_URL).then((r) => setKeeper(r.ok ? "up" : "down")).catch(() => setKeeper("down"));
  }, []);
  return (
    <div className="app">
      <aside className="side" aria-label="App">
        <div className="side-top">
          <Link to="/" className="brand"><Logo size={24} />Cloak</Link>
          <ThemeToggle />
        </div>
        <Network />
        <nav className="side-nav" aria-label="Product"><NavItems path={path} /></nav>
        <div className="side-foot">
          <GuideLink onOpen={() => setGuideOpen(true)} />
          {LEARN.map((x) => <Link key={x.to} to={x.to} className="side-link"><x.I />{x.label}</Link>)}
          <Status keeper={keeper} />
          <div className="side-wallet"><WalletButton up /></div>
        </div>
      </aside>

      <header ref={bar} className="mbar">
        <Link to="/" className="brand"><Logo size={22} /><span>Cloak</span></Link>
        <div className="row-flex" style={{ gap: 6 }}>
          <WalletButton />
          <MenuButton open={open} onClick={() => setOpen(!open)} />
        </div>
        {open && (
          <Sheet anchor={bar} className="app-sheet">
            <Network />
            <nav className="side-nav" aria-label="Product mobile"><NavItems path={path} /></nav>
            <div className="side-group">
              <div className="eyebrow">Learn</div>
              <GuideLink onOpen={() => { setOpen(false); setGuideOpen(true); }} />
              {LEARN.map((x) => <Link key={x.to} to={x.to} className="side-link"><x.I />{x.label}</Link>)}
            </div>
            <div className="sheet-row"><span className="small mute">Appearance</span><ThemeSeg /></div>
            <Status keeper={keeper} />
            <Link to="/" className="small mute" style={{ display: "block", marginTop: 18 }}>Back to cloak.boblabs.tech</Link>
          </Sheet>
        )}
      </header>

      <main className="main">
        {error && (
          <div className="summary" style={{ background: "var(--danger-soft)", marginBottom: 16, display: "flex", justifyContent: "space-between", gap: 12 }}>
            <span className="err" style={{ margin: 0 }}>{error}</span>
            <button className="btn btn-text xs" onClick={() => setError("")}>Dismiss</button>
          </div>
        )}
        {children}
        <footer className="app-foot">
          <span>Cloak on Elysium testnet. Play money only. Not investment advice.</span>
          <span className="row-flex" style={{ gap: 16 }}>
            <Link to="/docs">Docs</Link>
            <a href={GITHUB} target="_blank" rel="noreferrer">GitHub</a>
            <a href="https://x.com/cloakonelysium" target="_blank" rel="noreferrer">X</a>
          </span>
        </footer>
      </main>
      {guideOpen && !welcome && <GettingStarted onClose={() => setGuideOpen(false)} />}
      {welcome && <Welcome onClose={() => { setWelcome(false); try { localStorage.setItem("cloak.welcomed", "1"); } catch {} }} />}
    </div>
  );
}
