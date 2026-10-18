import { useEffect, useState, type AnchorHTMLAttributes, type MouseEvent } from "react";

const listeners = new Set<() => void>();

export function navigate(to: string) {
  if (to === location.pathname + location.search) return;
  history.pushState(null, "", to);
  listeners.forEach((l) => l());
  window.scrollTo({ top: 0 });
}

/** Current pathname + query; re-renders on navigation. */
export function useRoute(): { path: string; query: URLSearchParams } {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((x) => x + 1);
    listeners.add(l);
    window.addEventListener("popstate", l);
    return () => {
      listeners.delete(l);
      window.removeEventListener("popstate", l);
    };
  }, []);
  return { path: location.pathname.replace(/\/+$/, "") || "/", query: new URLSearchParams(location.search) };
}

export function Link({ to, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  const external = /^https?:/.test(to);
  return (
    <a
      href={to}
      {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(e);
        if (external || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        if (to.startsWith("#")) return;
        e.preventDefault();
        const [p, hash] = to.split("#");
        navigate(p || location.pathname);
        if (hash) setTimeout(() => document.getElementById(hash)?.scrollIntoView({ behavior: "smooth" }), 30);
      }}
      {...rest}
    />
  );
}
