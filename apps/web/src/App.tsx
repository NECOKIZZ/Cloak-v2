import { useEffect } from "react";
import type { Address } from "viem";
import { AppShell } from "./pages/AppShell";
import { Create } from "./pages/Create";
import { Docs } from "./pages/Docs";
import { Agents } from "./pages/Agents";
import { Landing } from "./pages/Landing";
import { Pitch } from "./pages/Pitch";
import { Demo } from "./pages/Demo";
import { Claim } from "./pages/Claim";
import { Links } from "./pages/Links";
import { Drop } from "./pages/Drop";
import { Drops } from "./pages/Drops";
import { DropCreate } from "./pages/DropCreate";
import { Pay } from "./pages/Pay";
import { Launch } from "./pages/Launch";
import { Launches } from "./pages/Launches";
import { Portfolio, PortfolioAction } from "./pages/Portfolio";
import { Sdk } from "./pages/Sdk";
import { Trade } from "./pages/Trade";
import { Volume } from "./pages/Volume";
import { navigate, useRoute } from "./router";
import { AppProvider } from "./state";
import { Nav } from "./ui";

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
      : act ? <PortfolioAction key={act[1]} kind={act[1] as "shield" | "send" | "withdraw"} />
      : path === "/app/trade" ? <Trade />
      : path === "/app/launches" ? <Launches />
      : path === "/app/create" ? <Create />
      : path === "/app/volume" ? <Volume />
      : path === "/app/links" ? <Links />
      : <Portfolio />;
    return <AppShell>{page}</AppShell>;
  }
  return (
    <>
      <Nav />
      <div className="wrap section"><div className="empty"><h3>Page not found</h3><a className="link" href="/">Back home</a></div></div>
    </>
  );
}

export function App() {
  return (
    <AppProvider>
      <Routes />
    </AppProvider>
  );
}
