/** A shimmering placeholder in the shape of what's loading (a number, a name, an icon), so the page keeps its layout. */
export function Skel({ w = "100%", h = "0.9em", round, className = "" }: { w?: number | string; h?: number | string; round?: boolean; className?: string }) {
  return <span className={`skel${round ? " skel-round" : ""} ${className}`} style={{ width: w, height: h }} aria-hidden="true" />;
}

/** A whole page loading: its title row and two cards, in the shape the page will take. */
export function PageSkel({ label }: { label: string }) {
  return (
    <div aria-busy="true" aria-label={label}>
      <div className="row-flex" style={{ gap: 14, margin: "6px 0 22px", justifyContent: "flex-start" }}>
        <Skel w={56} h={56} round />
        <div style={{ display: "grid", gap: 8, flex: 1 }}><Skel w="14ch" h={26} /><Skel w="24ch" h={12} /></div>
      </div>
      <div className="grid">
        <div className="card" style={{ display: "grid", gap: 14 }}><Skel h={180} /><Skel w="60%" /><Skel w="40%" /></div>
        <div className="card" style={{ display: "grid", gap: 14 }}><Skel w="50%" /><Skel h={44} /><Skel h={44} /><Skel w="70%" /></div>
      </div>
    </div>
  );
}
