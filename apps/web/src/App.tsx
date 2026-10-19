import { useEffect } from "react";
import type { Address } from "viem";
import { AppShell } from "./pages/AppShell";
import { Create } from "./pages/Create";
import { Docs } from "./pages/Docs";
import { Landing } from "./pages/Landing";
import { Pitch } from "./pages/Pitch";
import { Launch } from "./pages/Launch";
import { Launches } from "./pages/Launches";
import { Portfolio } from "./pages/Portfolio";
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
  if (path === "/docs") return <Docs />;
  if (path === "/sdk") return <Sdk />;
  if (path === "/pitch") return <Pitch />;
  if (path.startsWith("/app")) {
    const m = path.match(/^\/app\/launch\/(0x[0-9a-fA-F]{40})$/);
    const page = m ? <Launch key={m[1]} auction={m[1] as Address} />
      : path === "/app/trade" ? <Trade />
      : path === "/app/portfolio" ? <Portfolio />
      : path === "/app/create" ? <Create />
      : path === "/app/volume" ? <Volume />
      : <Launches />;
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
