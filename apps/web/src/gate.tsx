import { useApp } from "./state";
import { Icon } from "./ui";

/** Shown in place of a page that needs the private account: says why, and connects or unlocks right here. */
export function Gate({ what }: { what: string }) {
  const { wallet, connect, unlock, unlocking } = useApp();
  return (
    <div className="card gate">
      <span className="gate-ico"><Icon.lock size={18} /></span>
      <p>{wallet ? `Sign one message (free, no transaction) to unlock your private account. Then you can ${what}.` : `Connect a wallet to ${what}.`}</p>
      <button className="btn btn-ink" disabled={unlocking} onClick={() => (wallet ? unlock() : connect().then((w) => w && unlock(w)))}>
        {unlocking ? "Sign in your wallet…" : wallet ? "Unlock private account" : "Connect wallet"}
      </button>
    </div>
  );
}
