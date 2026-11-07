/**
 * Run `fn` every `ms` while this tab is visible, and once at once when it becomes visible again (if a tick was
 * missed). A tab in the background costs the keeper and the RPC nothing. Returns the cleanup for a useEffect.
 * Does not run `fn` immediately: call it yourself first.
 */
export function every(fn: () => unknown, ms: number): () => void {
  let missed = false;
  const tick = () => {
    if (document.visibilityState === "visible") fn();
    else missed = true;
  };
  const back = () => {
    if (document.visibilityState === "visible" && missed) {
      missed = false;
      fn();
    }
  };
  const t = setInterval(tick, ms);
  document.addEventListener("visibilitychange", back);
  return () => {
    clearInterval(t);
    document.removeEventListener("visibilitychange", back);
  };
}
