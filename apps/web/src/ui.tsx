import { useState, type ReactNode } from "react";
import { Link, useRoute } from "./router";
import { useApp, type Theme } from "./state";
import { IS_LOCAL, chain } from "./config";
import { short } from "./format";

export function Logo({ size = 28, inverse }: { size?: number; inverse?: boolean }) {
  const bg = inverse ? "var(--on-deep)" : "var(--brand-ink)";
  const fg = inverse ? "var(--deep)" : "var(--brand-paper)";
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden>
      <rect width="32" height="32" rx="9" fill={bg} />
      <path d="M16 6.5c-4.7 0-8 3.8-8 8.6V25l2.7-1.8 2.7 1.8 2.6-1.8 2.6 1.8 2.7-1.8L24 25v-9.9c0-4.8-3.3-8.6-8-8.6z" fill="none" stroke={fg} strokeWidth="1.7" strokeLinejoin="round" />
      <rect x="11.2" y="13.4" width="9.6" height="3.8" rx="1.1" fill="var(--brand-signal)" />
    </svg>
  );
}

const P = (d: string) => (props: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={props.size ?? 18} height={props.size ?? 18} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);
export const Icon = {
  launch: P("M12 3c3 2 5 5.5 5 9.5L15 17H9l-2-4.5C7 8.5 9 5 12 3zM9 17l-1.5 4M15 17l1.5 4M12 10.5h.01"),
  swap: P("M7 7h12l-3-3M17 17H5l3 3"),
  wallet: P("M3 7.5A2.5 2.5 0 0 1 5.5 5h12A1.5 1.5 0 0 1 19 6.5V8M3 7.5v9A2.5 2.5 0 0 0 5.5 19h13a1.5 1.5 0 0 0 1.5-1.5v-8A1.5 1.5 0 0 0 18.5 8H5.5A2.5 2.5 0 0 1 3 7.5zM16 13.5h.01"),
  plus: P("M12 5v14M5 12h14"),
  book: P("M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5v-15zM4 20.5A2.5 2.5 0 0 0 6.5 23"),
  code: P("M8 7l-5 5 5 5M16 7l5 5-5 5"),
  lock: P("M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3"),
  eye: P("M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"),
  send: P("M4 12l16-8-6 16-2.5-6.5L4 12z"),
  layers: P("M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5"),
  users: P("M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 6.5M18.5 20a6.5 6.5 0 0 0-3-5.5"),
  rocket: P("M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2M14 4c3.5 0 6 2.5 6 6l-7.5 7.5-6-6L14 4zM15 9h.01"),
  shield: P("M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z"),
  sun: P("M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"),
  moon: P("M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"),
  menu: P("M4 7h16M4 12h16M4 17h16"),
  github: P("M9 19c-4 1.5-4-2-6-2.5M15 21v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12 12 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21"),
  chev: P("M6 9l6 6 6-6"),
  arrowDown: P("M12 5v14M6 13l6 6 6-6"),
  check: P("M5 12.5l4.5 4.5L19 7"),
  copy: P("M9 9h11v11H9zM5 15H4V4h11v1"),
};

export const GITHUB = "https://github.com/NECOKIZZ/Cloak";
export const EXPLORER = "https://elysium.kinetiq.xyz/testnet-explorer";

export function ThemeToggle() {
  const { theme, setTheme } = useApp();
  const dark = document.documentElement.dataset.theme === "dark";
  return (
    <button className="icon-btn" title="Toggle theme" onClick={() => setTheme(dark ? "light" : "dark")} aria-label="Toggle theme">
      {dark ? <Icon.sun /> : <Icon.moon />}
      <span hidden>{theme}</span>
    </button>
  );
}

export function WalletButton({ compact }: { compact?: boolean }) {
  const { wallet, connect } = useApp();
  if (wallet) return <span className="pill mono">{short(wallet.account.address)}</span>;
  return (
    <>
      {IS_LOCAL && !compact && <button className="btn btn-ghost btn-sm" onClick={() => connect("burner")}>Dev wallet</button>}
      <button className="btn btn-ink btn-sm" onClick={() => connect()}>Connect</button>
    </>
  );
}

export function Announce() {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem("cloak.announce") !== "0";
    } catch {
      return true;
    }
  });
  if (!open) return null;
  return (
    <div className="announce">
      <span className="dot live" style={{ marginRight: 10, verticalAlign: 1 }} />
      <b>Live on Elysium testnet.</b> <span style={{ opacity: 0.75 }}>Sealed launches, private balances and batch trading, all on-chain.</span>
      <Link to="/app" className="arrow">Try it</Link>
      <button className="x" aria-label="Dismiss" onClick={() => { setOpen(false); try { localStorage.setItem("cloak.announce", "0"); } catch {} }}>×</button>
    </div>
  );
}

const LINKS = [
  { to: "/app", label: "Launches", match: (p: string) => p === "/app" || p.startsWith("/app/launch") || p === "/app/create" },
  { to: "/app/trade", label: "Trade", match: (p: string) => p.startsWith("/app/trade") },
  { to: "/app/portfolio", label: "Portfolio", match: (p: string) => p.startsWith("/app/portfolio") },
  { to: "/docs", label: "Docs", match: (p: string) => p.startsWith("/docs") },
  { to: "/sdk", label: "SDK", match: (p: string) => p.startsWith("/sdk") },
];

export function Nav({ app }: { app?: boolean }) {
  const { path } = useRoute();
  const [open, setOpen] = useState(false);
  return (
    <header className="nav">
      <div className={`${app ? "" : "wrap"} nav-in`} style={app ? { padding: "0 20px" } : undefined}>
        <Link to="/" className="brand"><Logo />Cloak</Link>
        <nav className={`nav-links ${open ? "open" : ""}`} onClick={() => setOpen(false)}>
          {LINKS.map((l) => (
            <Link key={l.to} to={l.to} className={l.match(path) ? "on" : ""}>{l.label}</Link>
          ))}
        </nav>
        <div className="nav-right">
          <span className="pill hide-m"><span className="dot" />{chain.name}</span>
          <ThemeToggle />
          {app ? (
            <WalletButton />
          ) : (
            <>
              <Link to="/docs" className="btn btn-ink btn-sm hide-m">Read the docs</Link>
              <Link to="/app" className="btn btn-signal btn-sm">Open app ↗</Link>
            </>
          )}
          <button className="icon-btn burger" onClick={() => setOpen(!open)} aria-label="Menu"><Icon.menu /></button>
        </div>
      </div>
    </header>
  );
}

export function Footer() {
  const { theme, setTheme } = useApp();
  const T: Theme[] = ["light", "dark", "auto"];
  return (
    <footer className="footer">
      <div className="footer-card">
      <div className="footer-in">
        <div className="footer-grid">
          <div>
            <div className="brand"><Logo inverse />Cloak</div>
            <p className="tag">Private launches and trades on a public chain.</p>
            <div className="row-flex" style={{ gap: 6 }}>
              <a className="icon-btn" href={GITHUB} target="_blank" rel="noreferrer" aria-label="GitHub"><Icon.github /></a>
              <Link to="/app" className="btn btn-primary btn-sm">Open app</Link>
            </div>
          </div>
          <div>
            <h4>Product</h4>
            <ul>
              <li><Link to="/app">Launches</Link></li>
              <li><Link to="/app/trade">Private trade</Link></li>
              <li><Link to="/app/portfolio">Portfolio</Link></li>
              <li><Link to="/app/create">Create a launch</Link></li>
            </ul>
          </div>
          <div>
            <h4>Developers</h4>
            <ul>
              <li><Link to="/sdk">SDK</Link></li>
              <li><Link to="/docs">Docs</Link></li>
              <li><Link to="/docs#contracts">Contracts</Link></li>
              <li><a href={GITHUB} target="_blank" rel="noreferrer">GitHub</a></li>
            </ul>
          </div>
          <div>
            <h4>Learn</h4>
            <ul>
              <li><Link to="/docs#sealed-launches">Sealed launches</Link></li>
              <li><Link to="/docs#private-trading">Private trading</Link></li>
              <li><Link to="/docs#batch-auctions">Batch auctions</Link></li>
              <li><Link to="/docs#what-stays-private">What stays private</Link></li>
            </ul>
          </div>
        </div>
        <div className="footer-bottom">
          <span>© 2026 Cloak. Testnet software with play money. Not investment advice. Built for Ascend on Elysium.</span>
          <div className="theme-seg">
            {T.map((t) => (
              <button key={t} className={theme === t ? "on" : ""} onClick={() => setTheme(t)}>{t[0].toUpperCase() + t.slice(1)}</button>
            ))}
          </div>
        </div>
      </div>
      <div className="footer-art">
        <img src="/hero/crowd.webp" alt="A piazza at dusk full of identical hooded figures; one of them turns back to look at you" width={2000} height={800} loading="lazy" />
      </div>
      </div>
    </footer>
  );
}

export function Section({ id, children, className = "" }: { id?: string; children: ReactNode; className?: string }) {
  return <section id={id} className={`wrap section ${className}`}>{children}</section>;
}
