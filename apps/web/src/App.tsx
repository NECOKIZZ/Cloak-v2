import { Suspense, lazy, useEffect } from "react";
import type { Address } from "viem";
import { Analytics } from "@vercel/analytics/react";
import { AppShell } from "./pages/AppShell";
import { Landing } from "./pages/Landing";
import { navigate, useRoute } from "./router";
import { AppProvider } from "./state";
import { Nav } from "./ui";

// every page but the landing loads on first visit, so the first download is only what that page needs
const Create = lazy(() => import("./pages/Create").then((m) => ({ default: m.Create })));
const Docs = lazy(() => import("./pages/Docs").then((m) => ({ default: m.Docs })));
const Agents = lazy(() => import("./pages/Agents").then((m) => ({ default: m.Agents })));
const Pitch = lazy(() => import("./pages/Pitch").then((m) => ({ default: m.Pitch })));
const Demo = lazy(() => import("./pages/Demo").then((m) => ({ default: m.Demo })));
const Claim = lazy(() => import("./pages/Claim").then((m) => ({ default: m.Claim })));
const Links = lazy(() => import("./pages/Links").then((m) => ({ default: m.Links })));
const Drop = lazy(() => import("./pages/Drop").then((m) => ({ default: m.Drop })));
const Drops = lazy(() => import("./pages/Drops").then((m) => ({ default: m.Drops })));
const DropCreate = lazy(() => import("./pages/DropCreate").then((m) => ({ default: m.DropCreate })));
const Pay = lazy(() => import("./pages/Pay").then((m) => ({ default: m.Pay })));
const Launch = lazy(() => import("./pages/Launch").then((m) => ({ default: m.Launch })));
const Launches = lazy(() => import("./pages/Launches").then((m) => ({ default: m.Launches })));
const Portfolio = lazy(() => import("./pages/Portfolio").then((m) => ({ default: m.Portfolio })));
const PortfolioAction = lazy(() => import("./pages/Portfolio").then((m) => ({ default: m.PortfolioAction })));
const Receive = lazy(() => import("./pages/Receive").then((m) => ({ default: m.Receive })));
const ProveFunds = lazy(() => import("./pages/Funds").then((m) => ({ default: m.ProveFunds })));
const ProofPage = lazy(() => import("./pages/Funds").then((m) => ({ default: m.ProofPage })));
const Sdk = lazy(() => import("./pages/Sdk").then((m) => ({ default: m.Sdk })));
const Trade = lazy(() => import("./pages/Trade").then((m) => ({ default: m.Trade })));
const Volume = lazy(() => import("./pages/Volume").then((m) => ({ default: m.Volume })));

function Routes() {
  const { path, query } = useRoute();
  // old links: /?a=0x… → the launch page
  useEffect(() => {
    const a = query.get("a");
    if (path === "/" && a && /^0x[0-9a-fA-F]{40}$/.test(a)) navigate(`/app/launch/${a}`);
  }, [path]);

  if (path === "/") return <Landing />;
  if (path === "/docs") return <AppShell><Docs /></AppShell>;
  if (path === "/sdk") return <AppShell><Sdk /></AppShell>;
  if (path === "/proof") return <AppShell><ProofPage /></AppShell>;
  if (path === "/agents") return <AppShell><Agents /></AppShell>;
  if (path === "/pitch") return <Pitch />;
  if (path === "/demo") return <Demo />;
  if (path === "/claim") return <AppShell><Claim /></AppShell>;
  if (path === "/pay") return <AppShell><Pay /></AppShell>;
  if (path.startsWith("/app")) {
    const m = path.match(/^\/app\/launch\/(0x[0-9a-fA-F]{40})$/);
    const dm = path.match(/^\/app\/drop\/(0x[0-9a-fA-F]{40})$/);
    const act = path.match(/^\/app\/portfolio\/(shield|send|withdraw)$/);
    const page = m ? <Launch key={m[1]} auction={m[1] as Address} />
      : dm ? <Drop key={dm[1]} drop={dm[1] as Address} />
      : path === "/app/drops" ? <Drops />
      : path === "/app/drops/create" ? <DropCreate />
      : path === "/app/portfolio/receive" ? <Receive />
      : path === "/app/bridge" ? <Receive bridge />
      : path === "/app/portfolio/prove" ? <ProveFunds />
      : act ? <PortfolioAction key={act[1]} kind={act[1] as "shield" | "send" | "withdraw"} />
      : path === "/app/trade" ? <Trade />
      : path === "/app/launches" ? <Launches />
      : path === "/app/create" ? <Create />
      : path === "/app/volume" ? <Volume />
      : path === "/app/links" ? <Links />
      : path === "/app" || path === "/app/portfolio" ? <Portfolio />
      : <div className="nf"><b>404</b><h3>Nothing is hidden here</h3><p className="mute">This page doesn't exist. The link may be old or mistyped.</p><div className="row"><a className="btn btn-ink" href="/app">Go to your portfolio</a></div></div>;
    return <AppShell>{page}</AppShell>;
  }
  return (
    <>
      <Nav />
      <div className="wrap section"><div className="nf"><b>404</b><h3>Nothing is hidden here</h3><p className="mute">This page doesn't exist. The link may be old or mistyped.</p><div className="row"><a className="btn btn-ink" href="/app">Open the app</a><a className="btn btn-ghost" href="/">Back home</a></div></div></div>
    </>
  );
}

export function App() {
  return (
    <AppProvider>
      <Suspense fallback={<div className="wrap section" aria-busy="true" />}>
        <Routes />
      </Suspense>
      <Analytics />
    </AppProvider>
  );
}
