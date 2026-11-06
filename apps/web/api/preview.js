// Link previews for launch pages and payment links. X, Telegram, Discord, WhatsApp and similar sites don't run the app, so a rewrite in
// vercel.json sends their link fetchers (by user agent) here for /app/launch/0x…: a tiny page whose meta tags carry
// the token's name, image and status. People who open the link get the normal app.
//   /api/preview?a=0x…        the preview page
//   /api/preview?a=0x…&img=1  the token's image (launch images are stored on-chain as data URIs)
//   /api/preview?kind=claim   a claim link (/claim#…) or a payment request (/pay#…). Link fetchers never see what's
//   /api/preview?kind=pay     after the #, so these cards are the same for every link: no amount, no names.
import { createPublicClient, formatEther, http } from "viem";
import { Cloak, deploymentFor, elysiumTestnet } from "@cloakely/sdk";

export const config = { maxDuration: 15 };

const SITE = "https://cloak.boblabs.tech";
const KEEPER = "https://keeper.boblabs.tech";
const FALLBACK_IMG = `${SITE}/og.jpg`;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const revive = (_k, v) => (v && typeof v === "object" && "$n" in v ? BigInt(v.$n) : v);

const num = (wei) => {
  const n = Number(formatEther(wei));
  if (n >= 1e6) return `${(n / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 })}M`;
  if (n >= 1e3) return `${(n / 1e3).toLocaleString("en-US", { maximumFractionDigits: 1 })}K`;
  if (n > 0 && n < 1e-4) return n.toExponential(2);
  return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
};
const left = (s) => {
  if (s <= 0) return "soon";
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${Math.max(m, 1)}m`;
};

/** The launch and its metadataURI: from the keeper's snapshot, else straight from the chain. */
async function load(a) {
  const snap = await fetch(`${KEEPER}/snapshot`, { signal: AbortSignal.timeout(4000) })
    .then((r) => (r.ok ? r.text() : null))
    .then((t) => (t ? JSON.parse(t, revive) : null))
    .catch(() => null);
  let s = snap?.launches?.find((x) => x.address.toLowerCase() === a);
  let uri = snap?.meta?.find((x) => x.auction.toLowerCase() === a)?.metadataURI;
  if (!s) {
    const d = deploymentFor(elysiumTestnet.id);
    const pub = createPublicClient({ chain: elysiumTestnet, transport: http(undefined, { timeout: 8000 }) });
    s = await new Cloak(pub, undefined, d.factory).getAuction(a).catch(() => null);
  }
  return { s, uri };
}

/** { image (data: or https:), description } from a metadataURI, the same formats the app accepts. */
function parseMeta(uri) {
  try {
    if (!uri) return {};
    if (uri.startsWith("data:application/json;base64,")) {
      const j = JSON.parse(Buffer.from(uri.slice(29), "base64").toString("utf8"));
      return { image: typeof j.image === "string" ? j.image : undefined, description: typeof j.description === "string" ? j.description : undefined };
    }
    if (uri.startsWith("data:image/") || uri.startsWith("https://")) return { image: uri };
  } catch {}
  return {};
}

function summary(s) {
  const now = Date.now() / 1000;
  const sym = `$${s.tokenSymbol}`;
  if (s.failed) return [`${s.tokenName} (${sym}) on Cloak`, "This launch didn't fill. Every deposit is refundable."];
  if (s.phase === "commit")
    return [
      `Bid on ${s.tokenName} (${sym}) on Cloak`,
      `Sealed bidding is open and closes in ${left(s.commitEnd - now)}. ${num(s.saleSupply)} ${sym} for sale from ${num(s.minPrice)} HYPE. Nobody sees a bid until bidding closes, and every winner pays one price.`,
    ];
  if (s.phase === "reveal" || s.phase === "settle") return [`${s.tokenName} (${sym}) on Cloak`, `Bidding has closed and the ${s.commits} sealed bids are opening now. Everyone pays one clearing price.`];
  return [`${s.tokenName} (${sym}) on Cloak`, `Cleared at ${num(s.clearingPrice)} HYPE with ${num(s.sold)} ${sym} sold. Now trading privately on Cloak.`];
}

const LINK_CARDS = {
  claim: ["Someone sent you money, privately", "Open the link to claim it into your private balance on Cloak, or straight to any wallet. No gas needed.", `${SITE}/brand/og-claim.jpg`],
  pay: ["You have a payment request", "Open the link to pay it privately from your Cloak balance. Nobody sees who paid whom.", `${SITE}/brand/og-pay.jpg`],
};

function linkCard(kind) {
  const [title, desc, image] = LINK_CARDS[kind];
  const page = `${SITE}/app/links`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website"><meta property="og:site_name" content="Cloak">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(image)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:site" content="@cloakonelysium">
<meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${esc(image)}">
</head><body><p>${esc(title)}. ${esc(desc)}</p><p><a href="${esc(page)}">Payment links on Cloak</a></p></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, s-maxage=3600" } });
}

export async function GET(req) {
  const q = new URL(req.url).searchParams;
  const kind = q.get("kind");
  if (kind === "claim" || kind === "pay") return linkCard(kind);
  const a = (q.get("a") ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(a)) return Response.redirect(SITE, 302);
  const page = `${SITE}/app/launch/${a}`;
  const { s, uri } = await load(a);
  const meta = parseMeta(uri);

  if (q.get("img")) {
    const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(meta.image ?? "");
    if (!m) return Response.redirect(FALLBACK_IMG, 302);
    return new Response(Buffer.from(m[2], "base64"), { headers: { "content-type": m[1], "cache-control": "public, max-age=86400, s-maxage=604800, stale-while-revalidate=604800" } });
  }

  if (!s) return Response.redirect(page, 302);
  const [title, desc] = summary(s);
  const image = meta.image?.startsWith("data:image/") ? `${SITE}/api/preview?a=${a}&img=1` : meta.image?.startsWith("https://") ? meta.image : FALLBACK_IMG;
  const card = image === FALLBACK_IMG ? "summary_large_image" : "summary";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(page)}">
<meta property="og:type" content="website"><meta property="og:site_name" content="Cloak">
<meta property="og:url" content="${esc(page)}"><meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}"><meta property="og:image" content="${esc(image)}">
<meta name="twitter:card" content="${card}"><meta name="twitter:site" content="@cloakonelysium">
<meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${esc(image)}">
</head><body><p>${esc(title)}. ${esc(desc)}</p><p><a href="${esc(page)}">Open on Cloak</a></p></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, s-maxage=60, stale-while-revalidate=300" } });
}
