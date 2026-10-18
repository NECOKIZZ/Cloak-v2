import { useEffect, useState, type ReactNode } from "react";
import { Link, useRoute } from "../router";
import { useApp } from "../state";
import { Icon, Logo, Nav, GITHUB } from "../ui";
import { KEEPER_URL } from "../config";

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

export function AppShell({ children }: { children: ReactNode }) {
  const { path } = useRoute();
  const { error, setError, priv } = useApp();
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
  const item = (to: string, label: string, I: (p: { size?: number }) => JSX.Element, on: boolean) => (
    <Link to={to} className={on ? "on" : ""}><I />{label}</Link>
  );
  return (
    <>
      <Nav app />
      <div className="app">
        <aside className="side">
          <div className="eyebrow">Launch</div>
          {item("/app", "Launches", Icon.launch, path === "/app" || path.startsWith("/app/launch"))}
          {item("/app/create", "Create a launch", Icon.plus, path === "/app/create")}
          <div className="eyebrow">Private</div>
          {item("/app/trade", "Trade", Icon.swap, path.startsWith("/app/trade"))}
          {item("/app/portfolio", "Portfolio", Icon.wallet, path.startsWith("/app/portfolio"))}
          <div className="eyebrow">Learn</div>
          {item("/docs", "Docs", Icon.book, false)}
          {item("/sdk", "SDK", Icon.code, false)}
          <div className="side-foot">
            <span className="row-flex" style={{ gap: 8 }}><span className="dot" style={{ background: keeper === "down" ? "var(--danger)" : undefined }} />Keeper {keeper === "up" ? "online" : keeper === "down" ? "offline" : "…"}</span>
            <span className="row-flex" style={{ gap: 8 }}><Icon.lock size={14} />Private account {priv ? "unlocked" : "locked"}</span>
            <a href={GITHUB} target="_blank" rel="noreferrer" className="row-flex" style={{ gap: 8 }}><Icon.github size={14} />Source</a>
          </div>
        </aside>
        <main className="main">
          {error && (
            <div className="summary" style={{ background: "var(--danger-soft)", marginBottom: 16, display: "flex", justifyContent: "space-between", gap: 12 }}>
              <span className="err" style={{ margin: 0 }}>{error}</span>
              <button className="btn btn-text xs" onClick={() => setError("")}>Dismiss</button>
            </div>
          )}
          {children}
        </main>
      </div>
      {welcome && <Welcome onClose={() => { setWelcome(false); try { localStorage.setItem("cloak.welcomed", "1"); } catch {} }} />}
    </>
  );
}
