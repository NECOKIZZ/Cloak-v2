import { useEffect, useState } from "react";

/** The "Getting started" checklist: its steps, which are done, and whether it's hidden. Kept in this browser only. */
export type Step = "unlock" | "shield" | "swap" | "bid";
export const STEPS: Step[] = ["unlock", "shield", "swap", "bid"];
type State = { done: Step[]; hidden: boolean; shown: boolean };

const KEY = "cloak.guide";
const listeners = new Set<() => void>();

function read(): State {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return { done: Array.isArray(s.done) ? s.done : [], hidden: !!s.hidden, shown: !!s.shown };
  } catch {
    return { done: [], hidden: false, shown: false };
  }
}
function write(s: State) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {}
  listeners.forEach((f) => f());
}

/** Tick a step off (called where the step actually happens: unlock, a shield, a swap, a sealed bid). */
export function markDone(step: Step) {
  const s = read();
  if (!s.done.includes(step)) write({ ...s, done: [...s.done, step] });
}
export const hideGuide = () => write({ ...read(), hidden: true });
export const guideShown = () => write({ ...read(), shown: true });

export function useGuide(): State {
  const [s, setS] = useState(read);
  useEffect(() => {
    const f = () => setS(read());
    listeners.add(f);
    return () => {
      listeners.delete(f);
    };
  }, []);
  return s;
}
