import qrcode from "qrcode-generator";
import { useMemo } from "react";

/** A QR code as crisp SVG, dark on light whatever the theme so every phone camera reads it. */
export function QR({ text, size = 200, label }: { text: string; size?: number; label?: string }) {
  const svg = useMemo(() => {
    const q = qrcode(0, "M");
    q.addData(text, "Byte");
    q.make();
    const n = q.getModuleCount();
    let d = "";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c},${r}h1v1h-1z`;
    return { n, d };
  }, [text]);
  return (
    <div className="qr" style={{ width: size }}>
      <svg viewBox={`-3 -3 ${svg.n + 6} ${svg.n + 6}`} width={size} height={size} role="img" aria-label={label ?? "QR code"} shapeRendering="crispEdges">
        <rect x={-3} y={-3} width={svg.n + 6} height={svg.n + 6} fill="#fff" />
        <path d={svg.d} fill="#111" />
      </svg>
    </div>
  );
}
