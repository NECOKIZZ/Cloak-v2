import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { CloakPrivate, SharedVaultClient, loadProver, loadSharedProver, relayerSubmitter, sharedRelayerSubmitter, sharedWalletSubmitter, walletSubmitter, type Prover, type Wallet } from "@cloakely/sdk";
import { BATCHER, MIGRATOR, RELAYER_URL, ROUTER, VAULTS_BLOCK, ASSETS, SHARED, SHARED_BATCHER, SHARED_BLOCK, SHARED_ROUTER } from "./config";
import { chain, IS_LOCAL } from "./config";
import { friendly, Hint } from "./errors";
import { WalletModal } from "./walletModal";
import { connectBurner, connectProvider, ensureElysium, installedWallets, publicClient, silentReconnect, walletConnectProvider, walletFor, type Eip1193, type WalletOption } from "./wallet";

let proverPromise: Promise<Prover> | null = null;
export const getProver = () => (proverPromise ??= loadProver("/circuits"));
// the shared vault's circuit (15 MB, checked against the SDK's hashes), fetched the first time a shared-vault token moves
let sharedProverPromise: Promise<Prover> | null = null;
export const getSharedProver = () => (sharedProverPromise ??= loadSharedProver("/circuits").catch((e) => ((sharedProverPromise = null), Promise.reject(e))));

/** The shared launch-token vault client for a private account (null when the deployment has none). */
export function sharedFor(p: CloakPrivate, w?: Wallet | null): SharedVaultClient | null {
  if (!SHARED || !SHARED_ROUTER) return null;
  const ss = RELAYER_URL ? sharedRelayerSubmitter(RELAYER_URL) : w ? sharedWalletSubmitter(p, w, SHARED, SHARED_ROUTER, SHARED_BATCHER) : null;
  return ss ? new SharedVaultClient(p, SHARED, SHARED_ROUTER, getSharedProver, ss, SHARED_BLOCK, SHARED_BATCHER) : null;
}

export type Theme = "light" | "dark" | "auto";

interface AppState {
  wallet: Wallet | null;
  connect: (kind?: "injected" | "burner") => Promise<Wallet | null>;
  disconnect: () => void;
  walletInfo: { name: string; icon?: string } | null;
  provider: Eip1193 | null;
  wrongChain: boolean;
  switchNetwork: () => Promise<void>;
  priv: CloakPrivate | null;
  /** The shared launch-token vault for this private account (null when the deployment has none). */
  shared: SharedVaultClient | null;
  privAddress: string;
  /** `given`: a wallet that was just connected, before React state has caught up with it. */
  unlock: (given?: Wallet) => Promise<CloakPrivate | null>;
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
  const [shared, setShared] = useState<SharedVaultClient | null>(null);
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

  // ── wallet: a modal lists every installed wallet (EIP-6963) plus WalletConnect ──
  const [walletInfo, setWalletInfo] = useState<{ name: string; icon?: string } | null>(null);
  const [provider, setProvider] = useState<Eip1193 | null>(null);
  const [wrongChain, setWrongChain] = useState(false);
  const [modal, setModal] = useState(false);
  const pending = useRef<((w: Wallet | null) => void) | null>(null);

  const attach = useCallback((eth: Eip1193, w: Wallet, info: { name: string; icon?: string }, id: string) => {
    setProvider(eth);
    setWallet(w);
    setWalletInfo(info);
    setWrongChain(false);
    setError("");
    try {
      localStorage.setItem("cloak.wallet", id);
    } catch {}
  }, []);

  const disconnect = useCallback(() => {
    provider?.disconnect?.().catch(() => {});
    setProvider(null);
    setWallet(null);
    setWalletInfo(null);
    setPriv(null);
    setShared(null);
    setPrivAddress("");
    setWrongChain(false);
    try {
      localStorage.removeItem("cloak.wallet");
    } catch {}
  }, [provider]);

  // follow the wallet when the user switches account or network in it
  useEffect(() => {
    if (!provider?.on) return;
    const onAccounts = (accs: string[]) => {
      if (!accs?.length) return disconnect();
      setWallet(walletFor(provider, accs[0] as `0x${string}`));
      setPriv(null); // private keys come from the wallet, so a new account means a new private account
      setShared(null);
      setPrivAddress("");
    };
    const onChain = (id: string) => setWrongChain(Number(id) !== chain.id);
    provider.on("accountsChanged", onAccounts as never);
    provider.on("chainChanged", onChain as never);
    return () => {
      provider.removeListener?.("accountsChanged", onAccounts as never);
      provider.removeListener?.("chainChanged", onChain as never);
    };
  }, [provider, disconnect]);

  // reconnect without a popup to the wallet used last time
  useEffect(() => {
    let id: string | null = null;
    try {
      id = localStorage.getItem("cloak.wallet");
    } catch {}
    if (!id || id === "walletconnect") return;
    if (id === "dev") {
      if (IS_LOCAL) connectBurner().then((w) => (setWallet(w), setWalletInfo({ name: "Dev wallet" }))).catch(() => {});
      return;
    }
    const t = setTimeout(async () => {
      const opt = installedWallets().find((o) => o.id === id);
      if (!opt) return;
      const w = await silentReconnect(opt.provider).catch(() => null);
      if (w) attach(opt.provider, w, { name: opt.name, icon: opt.icon }, opt.id);
    }, 350);
    return () => clearTimeout(t);
  }, [attach]);

  const connect = useCallback(async (kind: "injected" | "burner" = "injected") => {
    if (kind === "burner") {
      try {
        const w = await connectBurner();
        setWallet(w);
        setWalletInfo({ name: "Dev wallet" });
        return w;
      } catch (e) {
        setError(friendly(e));
        return null;
      }
    }
    return new Promise<Wallet | null>((res) => {
      pending.current = res;
      setModal(true);
    });
  }, []);

  const pick = useCallback(async (opt: WalletOption | "walletconnect") => {
    const eth = opt === "walletconnect" ? await walletConnectProvider() : opt.provider;
    const w = await connectProvider(eth);
    const info = opt === "walletconnect" ? { name: "WalletConnect" } : { name: opt.name, icon: opt.icon };
    attach(eth, w, info, opt === "walletconnect" ? "walletconnect" : opt.id);
    setModal(false);
    pending.current?.(w);
    pending.current = null;
  }, [attach]);

  const devPick = useCallback(async () => {
    const w = await connectBurner().catch((e) => (setError(friendly(e)), null));
    if (w) {
      setWallet(w);
      setWalletInfo({ name: "Dev wallet" });
      try {
        localStorage.setItem("cloak.wallet", "dev");
      } catch {}
    }
    setModal(false);
    pending.current?.(w);
    pending.current = null;
  }, []);

  const closeModal = useCallback(() => {
    setModal(false);
    pending.current?.(null);
    pending.current = null;
  }, []);

  const switchNetwork = useCallback(async () => {
    if (!provider) return;
    try {
      await ensureElysium(provider);
      setWrongChain(false);
    } catch (e) {
      setError(friendly(e));
    }
  }, [provider]);

  const unlock = useCallback(async (given?: Wallet) => {
    if (priv) return priv;
    // also used directly as a click handler, so ignore anything that isn't a wallet (such as the click event)
    const fresh = given && typeof given === "object" && "account" in given && given.account ? given : undefined;
    if (!ROUTER) {
      setError("Private trading isn't available on this deployment yet.");
      return null;
    }
    const w = fresh ?? wallet ?? (await connect());
    if (!w) return null;
    setUnlocking(true);
    try {
      // The first unlock on this device signs twice to check the wallet signs the same way every time; later unlocks
      // compare against the account fingerprint saved then. From v4 on the account is bound to the chain only, so it
      // never changes again.
      const fpKey = `cloak.account.v4.${chain.id}.${w.account.address.toLowerCase()}`;
      let known: string | null = null;
      try {
        known = localStorage.getItem(fpKey);
      } catch {}
      const keys = await CloakPrivate.keysFromWallet(w, { chainId: chain.id, verify: !known });
      const fp = (await keys.main()).pubKey.toString(16).slice(0, 16);
      if (known && known !== fp) throw new Hint("This wallet produced a different private account than last time. Use the same wallet you unlocked with before.");
      try {
        localStorage.setItem(fpKey, fp);
      } catch {}
      const submit = RELAYER_URL ? relayerSubmitter(RELAYER_URL) : walletSubmitter(publicClient, w, ROUTER, BATCHER, MIGRATOR);
      const p = new CloakPrivate(publicClient, ROUTER, keys, getProver, submit, VAULTS_BLOCK, BATCHER, MIGRATOR);
      await p.loadMarkets();
      ASSETS.forEach((a) => p.addAsset(a));
      setPrivAddress(await p.address());
      setShared(sharedFor(p, w));
      setPriv(p);
      getProver(); // warm the 12 MB circuit download
      return p;
    } catch (e) {
      setError(friendly(e));
      return null;
    } finally {
      setUnlocking(false);
    }
  }, [priv, wallet, connect]);

  return (
    <Ctx.Provider value={{ wallet, connect, disconnect, walletInfo, provider, wrongChain, switchNetwork, priv, shared, privAddress, unlock, unlocking, error, setError, theme, setTheme, toast }}>
      {children}
      {modal && <WalletModal onPick={pick} onClose={closeModal} onDevWallet={IS_LOCAL ? devPick : undefined} />}
      {toastMsg && <div className="toast">{toastMsg}</div>}
    </Ctx.Provider>
  );
}
