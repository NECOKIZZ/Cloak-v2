// Cloak's launch tokens for wallets, DEX front ends, aggregators and trackers, always current, built from the keeper's
// snapshot (every launch that settled into a market):
//   /tokenlist.json        a standard Uniswap token list (https://tokenlists.org), for any app that imports token lists
//   /api/tokenlist?feed=1  the same launches with their pool, launch page, clearing price and description, for partners
//                          that list new tokens automatically
import { formatEther } from "viem";
import hidden from "../src/hidden.json" with { type: "json" };

// Cloak's own test and demo launches stay off the list (src/hidden.json)
const HIDDEN = new Set(hidden.launches.flatMap(([, a, t]) => [a, t]).map((x) => x.toLowerCase()));

export const config = { maxDuration: 15 };

const SITE = "https://cloak.boblabs.tech";
const KEEPER = "https://cloak-keeper.onrender.com";
const CHAIN_ID = 99801;
const revive = (_k, v) => (v && typeof v === "object" && "$n" in v ? BigInt(v.$n) : v);

function parseMeta(uri) {
  try {
    if (uri?.startsWith("data:application/json;base64,")) {
      const j = JSON.parse(Buffer.from(uri.slice(29), "base64").toString("utf8"));
      return { image: typeof j.image === "string" ? j.image : undefined, description: typeof j.description === "string" ? j.description.slice(0, 500) : undefined };
    }
    if (uri?.startsWith("data:image/") || uri?.startsWith("https://")) return { image: uri };
  } catch {}
  return {};
}

// the token list schema's limits: names up to 40 characters, symbols up to 20 from a small alphabet
const okName = (s) => typeof s === "string" && s.length > 0 && s.length <= 40 && /^[ \w.'+\-%/À-ÖØ-öø-ÿ:&[\]()]+$/.test(s);
const okSymbol = (s) => typeof s === "string" && /^[a-zA-Z0-9+\-%/$.]{1,20}$/.test(s);

export async function GET(req) {
  const feed = new URL(req.url).searchParams.has("feed");
  const snap = await fetch(`${KEEPER}/snapshot`, { signal: AbortSignal.timeout(8000) })
    .then((r) => (r.ok ? r.text() : null))
    .then((t) => (t ? JSON.parse(t, revive) : null))
    .catch(() => null);
  if (!snap) return new Response(JSON.stringify({ error: "snapshot unavailable, try again shortly" }), { status: 503, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });

  const meta = new Map((snap.meta ?? []).map((m) => [m.auction.toLowerCase(), parseMeta(m.metadataURI)]));
  const zero = /^0x0{40}$/i;
  const launched = (snap.launches ?? [])
    .filter((l) => l.settled && !l.failed && l.pair && !zero.test(l.pair) && !HIDDEN.has(l.address.toLowerCase()) && !HIDDEN.has(String(l.token).toLowerCase()))
    .sort((a, b) => a.revealEnd - b.revealEnd);
  const logo = (l) => {
    const img = meta.get(l.address.toLowerCase())?.image;
    return img?.startsWith("data:image/") ? `${SITE}/api/preview?a=${l.address.toLowerCase()}&img=1` : img?.startsWith("https://") ? img : undefined;
  };

  const headers = { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "public, s-maxage=600, stale-while-revalidate=3600" };
  if (feed) {
    const tokens = launched.map((l) => ({
      chainId: CHAIN_ID,
      address: l.token,
      name: l.tokenName,
      symbol: l.tokenSymbol,
      decimals: 18,
      logoURI: logo(l) ?? null,
      description: meta.get(l.address.toLowerCase())?.description ?? null,
      uniswapV2Pool: l.pool !== "v4" && l.uniPair && !zero.test(l.uniPair) ? l.uniPair : null,
      ...(l.pool === "v4" ? { uniswapV4: { hook: l.hook ?? null, market: l.pair } } : {}),
      market: l.pair,
      quote: l.pool === "v4" ? "HYPE" : "WHYPE",
      launchedAt: new Date(l.revealEnd * 1000).toISOString(),
      clearingPriceHype: formatEther(l.clearingPrice),
      launchPage: `${SITE}/app/launch/${l.address}`,
      auction: l.address,
      lp: l.lpLockUntil === 0 ? "burned" : l.lpLockUntil >= 2 ** 63 ? "locked forever, trading fees to the creator" : `locked until ${new Date(l.lpLockUntil * 1000).toISOString()}`,
    }));
    return new Response(JSON.stringify({ chainId: CHAIN_ID, updated: new Date(snap.at).toISOString(), count: tokens.length, tokens }, null, 2), { headers });
  }

  const tokens = launched
    .filter((l) => okName(l.tokenName) && okSymbol(l.tokenSymbol))
    .map((l) => ({ chainId: CHAIN_ID, address: l.token, name: l.tokenName, symbol: l.tokenSymbol, decimals: 18, ...(logo(l) ? { logoURI: logo(l) } : {}), tags: ["cloak-launch"] }));
  const list = {
    name: "Cloak Launches",
    timestamp: new Date(snap.at).toISOString(),
    // a token added is a minor bump; the list only ever grows
    version: { major: 1, minor: tokens.length, patch: 0 },
    logoURI: `${SITE}/logo.svg`,
    keywords: ["cloak", "elysium", "sealed-bid", "fair-launch"],
    tags: { "cloak-launch": { name: "Cloak launch", description: "Launched through a Cloak sealed-bid auction, with its pool opened at the clearing price and the LP burned or locked" } },
    tokens,
  };
  return new Response(JSON.stringify(list, null, 2), { headers });
}
