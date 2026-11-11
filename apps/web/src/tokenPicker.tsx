import { useEffect, useRef, useState } from "react";
import type { Address } from "viem";
import { Icon, TokenIcon } from "./ui";

/** One choice in a token dropdown. `key` is "HYPE" or the token's address; `sub` sits under the symbol (a balance). */
export type PickerOption<K extends string = string> = { a: { key: K; symbol: string; name: string; iconToken?: Address }; sub: string };

/**
 * A token dropdown with logos and a search box (name, symbol or contract address), shown inline under the field. The
 * list scrolls past a few rows, so it stays the same size however many tokens there are; the search box shows once
 * there are enough tokens to need it.
 */
export function TokenPicker<K extends string>({ options, value, onChange, searchFrom = 6 }: { options: PickerOption<K>[]; value?: K; onChange: (k: K) => void; searchFrom?: number }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const cur = options.find((o) => o.a.key === value);
  const s = q.trim().toLowerCase();
  const search = options.length >= searchFrom;
  const shown = options.filter((o) => !s || o.a.symbol.toLowerCase().includes(s) || o.a.name.toLowerCase().includes(s) || (o.a.key !== "HYPE" && o.a.key.toLowerCase().includes(s)));
  const detail = (o: PickerOption<K>) => (o.a.key === "HYPE" || !o.a.key.startsWith("0x") ? o.a.name : `${o.a.name} · ${o.a.key.slice(0, 6)}…${o.a.key.slice(-4)}`);
  return (
    <div className="picker" ref={box}>
      <button type="button" className="picker-btn" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="listbox">
        {cur ? (
          <>
            <TokenIcon symbol={cur.a.symbol} token={cur.a.iconToken} size={28} />
            <span className="nm"><b>{cur.a.symbol}</b><span className="xs mute">{cur.sub}</span></span>
          </>
        ) : (
          <span className="mute">{options.length ? "Select a token" : "Nothing to pick yet"}</span>
        )}
        <span className="spacer" />
        <Icon.chev size={16} />
      </button>
      {open && (
        <div className="picker-panel">
          {search && <input className="input" autoFocus placeholder="Search name or contract address" value={q} onChange={(e) => setQ(e.target.value)} />}
          <div className="picker-list" role="listbox" style={search ? undefined : { marginTop: 0 }}>
            {shown.length === 0 && <div className="xs mute" style={{ padding: 12 }}>No token matches.</div>}
            {shown.map((o) => (
              <button type="button" role="option" aria-selected={o.a.key === value} key={o.a.key} className={`asset-row ${o.a.key === value ? "on" : ""}`} onClick={() => { onChange(o.a.key); setOpen(false); setQ(""); }}>
                <TokenIcon symbol={o.a.symbol} token={o.a.iconToken} size={30} />
                <div className="nm"><b>{o.a.symbol}</b><span className="xs mute">{detail(o)}</span></div>
                <div className="amt"><span className="small mono">{o.sub}</span></div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** One token in the search sheet. `key` is "HYPE" or the token's address; `bal` is the private balance, if any. */
export type SheetToken = { key: string; symbol: string; name: string; iconToken?: Address; bal?: string; tag?: string; off?: string };

/**
 * The token search sheet for swapping and bridging: a search box (name, symbol or contract address), quick picks for
 * the main assets, then every token with its private balance. Opens over the page, closes on Escape or a click outside.
 */
export function TokenSheet({ title, tokens, value, quick = [], filters = [], placeholder = "Search name, symbol or address", onPick, onClose }: { title: string; tokens: SheetToken[]; value?: string; quick?: string[]; /** words to narrow the list with one tap (networks, on the bridge) */ filters?: string[]; placeholder?: string; onPick: (key: string) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, []);
  const s = q.trim().toLowerCase().replace(/^\$/, "");
  const shown = tokens.filter((t) => !s || t.symbol.toLowerCase().includes(s) || t.name.toLowerCase().includes(s) || (t.key.startsWith("0x") && t.key.toLowerCase().includes(s)));
  const quicks = quick.map((k) => tokens.find((t) => t.key === k)).filter((t): t is SheetToken => !!t);
  const pick = (t: SheetToken) => !t.off && (onPick(t.key), onClose());
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal tsheet" role="dialog" aria-label={title}>
        <div className="tsheet-head"><h3>{title}</h3><button className="icon-btn" onClick={onClose} aria-label="Close">×</button></div>
        <div className="tsearch-wrap"><Icon.search /><input className="input" autoFocus placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && shown.length === 1 && pick(shown[0])} aria-label="Search tokens" /></div>
        {!s && quicks.length > 1 && (
          <div className="tsheet-quick">
            {quicks.map((t) => (
              <button key={t.key} className={`token-sel ${t.key === value ? "on" : ""}`} disabled={!!t.off} onClick={() => pick(t)}><TokenIcon symbol={t.symbol} token={t.iconToken} size={22} />{t.symbol}</button>
            ))}
          </div>
        )}
        {filters.length > 1 && (
          <div className="tsheet-quick">
            {filters.map((f) => (
              <button key={f} className={`chip pick ${s === f.toLowerCase() ? "on" : ""}`} onClick={() => setQ(s === f.toLowerCase() ? "" : f)}>{f}</button>
            ))}
          </div>
        )}
        <div className="tsheet-list" role="listbox">
          {shown.length === 0 && <div className="small mute" style={{ padding: "28px 12px", textAlign: "center" }}>No token matches "{q.trim()}".</div>}
          {shown.map((t) => (
            <button type="button" role="option" aria-selected={t.key === value} aria-disabled={!!t.off} key={t.key} className={`asset-row ${t.key === value ? "on" : ""} ${t.off ? "off" : ""}`} onClick={() => pick(t)}>
              <TokenIcon symbol={t.symbol} token={t.iconToken} size={36} />
              <div className="nm"><b>{t.symbol}{t.tag && <span className="chip">{t.tag}</span>}</b><span className="xs mute">{t.off ?? (t.key.startsWith("0x") ? `${t.name} · ${t.key.slice(0, 6)}…${t.key.slice(-4)}` : t.name)}</span></div>
              {t.bal !== undefined && <div className="amt"><span className="mono">{t.bal}</span></div>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
