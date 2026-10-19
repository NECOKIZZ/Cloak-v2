import { useEffect, useState } from "react";
import { chain, IS_LOCAL } from "./config";
import { friendly } from "./errors";
import { addElysium, installedWallets, onWalletsChanged, WC_PROJECT_ID, type WalletOption } from "./wallet";

export const FAUCET_URL = "https://elysium.kinetiq.xyz/testnet-faucet";

const INSTALL = [
  { name: "MetaMask", url: "https://metamask.io/download/" },
  { name: "Rabby", url: "https://rabby.io/" },
];

function WcIcon() {
  return (
    <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden>
      <rect width="32" height="32" rx="9" fill="#3B99FC" />
      <path d="M9.6 12.6c3.5-3.4 9.3-3.4 12.8 0l.4.4c.2.2.2.5 0 .6l-1.5 1.4a.2.2 0 0 1-.3 0l-.6-.6c-2.5-2.4-6.4-2.4-8.9 0l-.6.6a.2.2 0 0 1-.3 0l-1.5-1.4a.4.4 0 0 1 0-.6l.5-.4zm15.8 2.9 1.3 1.3c.2.2.2.5 0 .6l-6 5.8c-.2.2-.5.2-.7 0l-4.2-4.1h-.2l-4.2 4.1c-.2.2-.5.2-.7 0l-6-5.8a.4.4 0 0 1 0-.6l1.3-1.3c.2-.2.5-.2.7 0l4.2 4.1h.2l4.2-4.1c.2-.2.5-.2.7 0l4.2 4.1h.2l4.2-4.1c.2-.2.5-.2.6 0z" fill="#fff" />
    </svg>
  );
}

export function WalletModal({ onPick, onClose, onDevWallet }: { onPick: (o: WalletOption | "walletconnect") => Promise<void>; onClose: () => void; onDevWallet?: () => void }) {
  const [wallets, setWallets] = useState<WalletOption[]>(installedWallets);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => onWalletsChanged(() => setWallets(installedWallets())), []);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, [busy, onClose]);

  async function choose(o: WalletOption | "walletconnect") {
    setErr("");
    setNote("");
    setBusy(o === "walletconnect" ? "WalletConnect" : o.name);
    try {
      await onPick(o);
    } catch (e) {
      setErr(friendly(e));
    } finally {
      setBusy("");
    }
  }

  async function addNetwork() {
    setErr("");
    setNote("");
    const w = wallets[0];
    if (!w) return setErr("Install a browser wallet first, then you can add Elysium testnet to it.");
    try {
      await addElysium(w.provider);
      setNote(`Elysium testnet is now in ${w.name}.`);
    } catch (e) {
      setErr(friendly(e));
    }
  }

  return (
    <div className="modal-bg" onClick={() => !busy && onClose()}>
      <div className="modal wallet-modal" role="dialog" aria-label="Connect a wallet" onClick={(e) => e.stopPropagation()}>
        <div className="wm-head">
          <div>
            <h2>Connect a wallet</h2>
            <p className="mute small">Cloak runs on {chain.name}. Use test funds only.</p>
          </div>
          <button className="icon-btn" aria-label="Close" onClick={onClose} disabled={!!busy}>✕</button>
        </div>

        <div className="wm-list">
          {wallets.map((w) => (
            <button key={w.id} className="wm-item" disabled={!!busy} onClick={() => choose(w)}>
              {w.icon ? <img src={w.icon} alt="" width={28} height={28} /> : <span className="wm-blank" />}
              <span className="wm-name">{w.name}</span>
              <span className="wm-tag">{busy === w.name ? "Check your wallet…" : "Installed"}</span>
            </button>
          ))}
          {WC_PROJECT_ID && (
            <button className="wm-item" disabled={!!busy} onClick={() => choose("walletconnect")}>
              <WcIcon />
              <span className="wm-name">WalletConnect</span>
              <span className="wm-tag">{busy === "WalletConnect" ? "Scan the QR code…" : "Mobile wallets"}</span>
            </button>
          )}
          {IS_LOCAL && onDevWallet && (
            <button className="wm-item" disabled={!!busy} onClick={onDevWallet}>
              <span className="wm-blank" />
              <span className="wm-name">Dev wallet</span>
              <span className="wm-tag">Local chain only</span>
            </button>
          )}
          {!wallets.length && (
            <div className="wm-empty">
              <b>No wallet found in this browser.</b>
              <span className="small mute">Install one, then refresh this page{WC_PROJECT_ID ? ", or use WalletConnect with a phone wallet" : ""}.</span>
              <div className="row-flex" style={{ gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                {INSTALL.map((i) => <a key={i.name} className="btn btn-ghost btn-sm" href={i.url} target="_blank" rel="noreferrer">Get {i.name} ↗</a>)}
              </div>
            </div>
          )}
        </div>

        {busy && <p className="xs mute" style={{ marginTop: 12 }}>Approve the request in {busy}. Cloak will also ask it to switch to {chain.name}.</p>}
        {err && <div className="err">{err}</div>}
        {note && <div className="okmsg">{note}</div>}

        <div className="wm-setup">
          <div className="eyebrow">New to Elysium?</div>
          <div className="wm-steps">
            <button className="btn btn-ghost btn-sm" onClick={addNetwork}>Add Elysium testnet</button>
            <a className="btn btn-ghost btn-sm" href={FAUCET_URL} target="_blank" rel="noreferrer">Get testnet HYPE ↗</a>
          </div>
          <p className="xs mute">Network: {chain.name} · Chain ID {chain.id} · Gas token HYPE</p>
        </div>
      </div>
    </div>
  );
}
