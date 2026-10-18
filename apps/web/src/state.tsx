import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { CloakPrivate, loadProver, relayerSubmitter, walletSubmitter, type Prover, type Wallet } from "@cloak/sdk";
import { BATCHER, RELAYER_URL, ROUTER, ROUTER_BLOCK } from "./config";
import { connectBurner, connectInjected, publicClient } from "./wallet";

let proverPromise: Promise<Prover> | null = null;
export const getProver = () => (proverPromise ??= loadProver("/circuits"));

export type Theme = "light" | "dark" | "auto";

interface AppState {
  wallet: Wallet | null;
  connect: (kind?: "injected" | "burner") => Promise<Wallet | null>;
  priv: CloakPrivate | null;
  privAddress: string;
  unlock: () => Promise<CloakPrivate | null>;
  unlocking: boolean;
  error: string;
  setError: (e: string) => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
  toast: (m: string) => void;
}

const Ctx = createContext<AppState>(null as never);
export const useApp = () => useContext(Ctx);

function applyTheme(t: Theme) {
  const dark = t === "dark" || (t === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [priv, setPriv] = useState<CloakPrivate | null>(null);
  const [privAddress, setPrivAddress] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [error, setError] = useState("");
  const [toastMsg, setToast] = useState("");
  const [theme, setThemeState] = useState<Theme>(() => {
    try {
      return (localStorage.getItem("cloak.theme") as Theme) || "auto";
    } catch {
      return "auto";
    }
  });

  useEffect(() => {
    applyTheme(theme);
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const l = () => theme === "auto" && applyTheme("auto");
    mq.addEventListener("change", l);
    return () => mq.removeEventListener("change", l);
  }, [theme]);

  const setTheme = (t: Theme) => {
    setThemeState(t);
    try {
      localStorage.setItem("cloak.theme", t);
    } catch {}
  };

  const toast = useCallback((m: string) => {
    setToast(m);
    setTimeout(() => setToast(""), 2600);
  }, []);

  const connect = useCallback(async (kind: "injected" | "burner" = "injected") => {
    try {
      const w = kind === "burner" ? await connectBurner() : await connectInjected();
      setWallet(w);
      setError("");
      return w;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  }, []);

  const unlock = useCallback(async () => {
    if (priv) return priv;
    if (!ROUTER) {
      setError("Private trading isn't configured on this deployment (VITE_ROUTER).");
      return null;
    }
    const w = wallet ?? (await connect());
    if (!w) return null;
    setUnlocking(true);
    try {
      const keys = await CloakPrivate.keysFromWallet(w);
      const submit = RELAYER_URL ? relayerSubmitter(RELAYER_URL) : walletSubmitter(publicClient, w, ROUTER, BATCHER);
      const p = new CloakPrivate(publicClient, ROUTER, keys, getProver, submit, ROUTER_BLOCK, BATCHER);
      await p.loadMarkets();
      setPriv(p);
      setPrivAddress(await p.address());
      getProver(); // warm the 12 MB circuit download
      return p;
    } catch (e) {
      setError((e as { shortMessage?: string }).shortMessage ?? (e as Error).message);
      return null;
    } finally {
      setUnlocking(false);
    }
  }, [priv, wallet, connect]);

  return (
    <Ctx.Provider value={{ wallet, connect, priv, privAddress, unlock, unlocking, error, setError, theme, setTheme, toast }}>
      {children}
      {toastMsg && <div className="toast">{toastMsg}</div>}
    </Ctx.Provider>
  );
}
