import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useRoute } from "../router";
import { useApp } from "../state";
import { GITHUB, Icon, Logo, MenuButton, Sheet, ThemeSeg, ThemeToggle, WalletButton, useSheet } from "../ui";
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
          <div><span className="n">3</span><span><b>Bid</b> in a sealed launch, or <b>shield</b> HYPE and trade launch tokens privately.</span></div>
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
  ["Launch", [
    { to: "/app", label: "Launches", I: Icon.launch, on: (p) => p === "/app" || p.startsWith("/app/launch") },
    { to: "/app/create", label: "Create a launch", I: Icon.plus, on: (p) => p === "/app/create" },
  ]],
  ["Private", [
    { to: "/app/trade", label: "Trade", I: Icon.swap, on: (p) => p.startsWith("/app/trade") },
    { to: "/app/portfolio", label: "Portfolio", I: Icon.wallet, on: (p) => p.startsWith("/app/portfolio") },
    { to: "/app/volume", label: "Volume", I: Icon.layers, on: (p) => p.startsWith("/app/volume") },
  ]],
];
const LEARN: Item[] = [
  { to: "/docs", label: "Docs", I: Icon.book, on: () => false },
  { to: "/sdk", label: "SDK", I: Icon.code, on: () => false },
];

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
      <span><Icon.lock size={13} />Private account {priv ? "unlocked" : "locked"}</span>
    </div>
  );
}

/**
 * The app frame: a floating sidebar on desktop with no top bar, and on phones a
 * slim bar with the wallet and a full-screen menu.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { path } = useRoute();
  const { error, setError } = useApp();
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
          {LEARN.map((x) => <Link key={x.to} to={x.to} className="side-link"><x.I />{x.label}</Link>)}
          <a href={GITHUB} target="_blank" rel="noreferrer" className="side-link"><Icon.github />Source</a>
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
              {LEARN.map((x) => <Link key={x.to} to={x.to} className="side-link"><x.I />{x.label}</Link>)}
              <a href={GITHUB} target="_blank" rel="noreferrer" className="side-link"><Icon.github />Source</a>
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
      {welcome && <Welcome onClose={() => { setWelcome(false); try { localStorage.setItem("cloak.welcomed", "1"); } catch {} }} />}
    </div>
  );
}
