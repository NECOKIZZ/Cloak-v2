import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { GloamPrivate, gloamRelaySubmitter, walletCoreSubmitter, type Wallet } from "@cloakely/sdk";
import { ASSETS, DEPLOYMENT, RELAYER_URL, chain, GLOAM } from "./config";
import { collectOnUnlock, gloamProvers, launchRecords, gloamPending } from "./gloam";
import { friendly, Hint } from "./errors";
import { WalletModal } from "./walletModal";
import { connectProvider, ensureElysium, installedWallets, publicClient, silentReconnect, walletConnectProvider, walletFor, type Eip1193, type WalletOption } from "./wallet";

/** The private account the pages use: Cloak v2 on Gloam (one signature opens Gloam's vault and Cloak's launch vault). */
export type Priv = GloamPrivate;

export type Theme = "light" | "dark" | "auto";

interface AppState {
  wallet: Wallet | null;
  connect: () => Promise<Wallet | null>;
  disconnect: () => void;
  walletInfo: { name: string; icon?: string } | null;
  provider: Eip1193 | null;
  wrongChain: boolean;
  switchNetwork: () => Promise<void>;
  priv: Priv | null;
  privAddress: string;
  /** `given`: a wallet that was just connected, before React state has caught up with it. */
  unlock: (given?: Wallet) => Promise<Priv | null>;
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
  const [priv, setPriv] = useState<Priv | null>(null);
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
    const t = setTimeout(async () => {
      const opt = installedWallets().find((o) => o.id === id);
      if (!opt) return;
      const w = await silentReconnect(opt.provider).catch(() => null);
      if (w) attach(opt.provider, w, { name: opt.name, icon: opt.icon }, opt.id);
    }, 350);
    return () => clearTimeout(t);
  }, [attach]);

  const connect = useCallback(async () => {
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
    if (!GLOAM) {
      setError("Private trading isn't available on this deployment yet.");
      return null;
    }
    const w = fresh ?? wallet ?? (await connect());
    if (!w) return null;
    setUnlocking(true);
    try {
      // one signature opens both vaults (Gloam's and Cloak's launch vault)
      const g = await GloamPrivate.unlock(w, {
        publicClient,
        chainId: chain.id,
        gloamVault: { pool: GLOAM.gloamVault, poolBlock: GLOAM.block },
        launchVault: { pool: GLOAM.launchVault, poolBlock: GLOAM.launchVaultBlock ?? GLOAM.block },
        payMemo: GLOAM.memoBoard,
        provers: gloamProvers(),
        submit: RELAYER_URL ? gloamRelaySubmitter(RELAYER_URL) : walletCoreSubmitter(publicClient, w),
        whype: GLOAM.whype,
        launchSwap: GLOAM.launchSwap,
        launchSwapV4: GLOAM.launchSwapV4,
        router: GLOAM.router,
        poolManager: DEPLOYMENT?.poolManager,
        ecosystemVault: GLOAM.ecosystemVault ? { pool: GLOAM.ecosystemVault, poolBlock: GLOAM.ecosystemVaultBlock ?? GLOAM.block } : undefined,
        batcher: GLOAM.batcher,
        batcherV4: GLOAM.batcherV4,
        receive: GLOAM.receive,
        bids: GLOAM.bids,
        records: launchRecords(w.account.address),
        pendingStore: gloamPending(w.account.address),
        logChunk: 1_000_000n, // the public RPCs cap logs per call, not ranges: 1M blocks answer in under a second
      });
      await g.loadMarkets();
      ASSETS.forEach((a) => g.addAsset({ ...a, pool: a.hop }));
      setPrivAddress(await g.address());
      setPriv(g);
      g.finishPending().catch(() => {}); // a swap's buffer, a bid, a batch payout: whatever can finish now
      collectOnUnlock(g).catch(() => {}); // payments waiting at this account's receive addresses
      return g;
    } catch (e) {
      setError(friendly(e));
      return null;
    } finally {
      setUnlocking(false);
    }
  }, [priv, wallet, connect]);

  return (
    <Ctx.Provider value={{ wallet, connect, disconnect, walletInfo, provider, wrongChain, switchNetwork, priv, privAddress, unlock, unlocking, error, setError, theme, setTheme, toast }}>
      {children}
      {modal && <WalletModal onPick={pick} onClose={closeModal} />}
      {toastMsg && <div className="toast">{toastMsg}</div>}
    </Ctx.Provider>
  );
}
