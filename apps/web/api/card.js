// The share card for an NFT drop: a 1200x630 image with the collection's art, name, status and price, in Cloak's look.
// Only link-preview bots ask for it (through api/preview.js), and the CDN keeps each card for a day, so a collection is
// drawn about once a day however often it is shared. If drawing fails, the collection's own art (or Cloak's card) is
// sent instead, so a preview never comes back broken.
//   /api/card?drop=0x…
import { ImageResponse } from "@vercel/og";
import sharp from "sharp";
import { SITE, absImage, dropSummary, loadDrop } from "./_drop.js";

export const config = { maxDuration: 20 };

const FALLBACK = `${SITE}/og.jpg`;
const C = { paper: "#0b1013", ink: "#eef1f0", mute: "#8fa0a6", signal: "#6cb6cb", seal: "#e3a95a", line: "rgba(238,241,240,0.14)" };

// a tiny element helper, so this file needs no JSX build step
const h = (type, style, ...children) => ({ type, props: { style, children: children.length === 1 ? children[0] : children } });

/**
 * The art as a 420x420 PNG data URI the renderer can draw, or null. Collections store WebP, SVG, PNG, JPEG or GIF
 * (on chain as data: URIs, or at https, ipfs or ar links), so everything is converted to PNG first.
 */
async function artData(uri) {
  const src = absImage(uri);
  if (!src) return null;
  try {
    let buf;
    const m = /^data:image\/[a-z+]+;base64,(.+)$/.exec(src);
    if (m) buf = Buffer.from(m[1], "base64");
    else {
      const r = await fetch(src, { signal: AbortSignal.timeout(5000) });
      if (!r.ok || !(r.headers.get("content-type") ?? "").startsWith("image/")) return null;
      buf = Buffer.from(await r.arrayBuffer());
    }
    if (buf.length > 8_000_000) return null;
    // small pixel art stays crisp when scaled up
    const meta = await sharp(buf, { limitInputPixels: 50_000_000 }).metadata();
    const small = (meta.width ?? 999) <= 256;
    const png = await sharp(buf, { limitInputPixels: 50_000_000 }).resize(420, 420, { fit: "cover", kernel: small ? "nearest" : "lanczos3" }).png().toBuffer();
    return `data:image/png;base64,${png.toString("base64")}`;
  } catch {
    return null;
  }
}

const cache = { "cache-control": "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800" };

export async function GET(req) {
  const a = (new URL(req.url).searchParams.get("drop") ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(a)) return Response.redirect(FALLBACK, 302);
  const got = await loadDrop(a).catch(() => null);
  if (!got) return Response.redirect(FALLBACK, 302);
  const { s, details } = got;
  const sum = dropSummary(s);
  const art = await artData(details.image ?? details.banner);
  try {
    // fractal glass: soft vertical ribs over the brand dark, with the art's colour glowing through on the left
    const rib = (i) => h("div", { width: 28, height: 630, display: "flex", backgroundImage: "linear-gradient(90deg, rgba(255,255,255,0.05), rgba(255,255,255,0) 50%, rgba(0,0,0,0.18))" });
    const tile = art
      ? { type: "img", props: { src: art, width: 420, height: 420, style: { width: 420, height: 420, borderRadius: 28, objectFit: "cover", border: `1px solid ${C.line}` } } }
      : h("div", { width: 420, height: 420, borderRadius: 28, display: "flex", alignItems: "center", justifyContent: "center", background: "linear-gradient(135deg, #1b2a30, #0f171b)", border: `1px solid ${C.line}`, color: C.signal, fontSize: 140, fontWeight: 700 }, sum.name.slice(0, 2).toUpperCase());
    const live = s.phase === "gtd" || s.phase === "bidding";
    const el = h(
      "div",
      { width: 1200, height: 630, display: "flex", background: C.paper, color: C.ink, fontFamily: "sans-serif", position: "relative" },
      h("div", { position: "absolute", top: 0, left: 0, width: 1200, height: 630, display: "flex", backgroundImage: "radial-gradient(circle at 24% 50%, rgba(108,182,203,0.28), rgba(11,16,19,0) 60%)" }),
      h("div", { position: "absolute", top: 0, left: 0, width: 1200, height: 630, display: "flex" }, ...Array.from({ length: 43 }, (_, i) => rib(i))),
      h(
        "div",
        { display: "flex", alignItems: "center", gap: 56, padding: "0 80px", width: "100%", position: "relative" },
        tile,
        h(
          "div",
          { display: "flex", flexDirection: "column", flex: 1, gap: 18 },
          h("div", { display: "flex", alignItems: "center", gap: 12, fontSize: 26, color: C.mute, letterSpacing: 2 }, "CLOAK · NFT DROP"),
          h("div", { display: "flex", fontSize: sum.name.length > 22 ? 56 : 72, fontWeight: 700, lineHeight: 1.05 }, sum.name.length > 40 ? `${sum.name.slice(0, 38)}…` : sum.name),
          h(
            "div",
            { display: "flex", alignItems: "center", gap: 12, fontSize: 30, color: live ? C.signal : C.ink },
            h("div", { width: 14, height: 14, borderRadius: 7, background: live ? C.signal : C.seal, display: "flex" }),
            sum.status,
          ),
          h("div", { display: "flex", fontSize: 34, color: C.seal, fontWeight: 600 }, sum.price),
          h("div", { display: "flex", fontSize: 24, color: C.mute, marginTop: 12 }, "Sealed bids. One price for every winner."),
          h("div", { display: "flex", fontSize: 22, color: C.mute }, "cloak.boblabs.tech"),
        ),
      ),
    );
    const img = new ImageResponse(el, { width: 1200, height: 630, headers: cache });
    // drawing happens as the body streams; read it here so a failure falls back instead of sending a broken image
    const body = await img.arrayBuffer();
    return new Response(body, { headers: { "content-type": "image/png", ...cache } });
  } catch {
    const own = absImage(details.image);
    return Response.redirect(own && own.startsWith("https://") ? own : FALLBACK, 302);
  }
}
