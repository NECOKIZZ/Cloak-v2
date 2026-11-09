// Cloak's launch tokens for wallets, DEX front ends, aggregators and trackers, always current, built from the keeper's
// snapshot (every launch that settled into a market):
//   /tokenlist.json        a standard Uniswap token list (https://tokenlists.org), for any app that imports token lists
//   /api/tokenlist?feed=1  the same launches with their pool, launch page, clearing price and description, for partners
//                          that list new tokens automatically
import { createPublicClient, formatEther, http } from "viem";
import { Cloak, cloakFactoryAbi, deploymentFor, elysiumTestnet } from "@cloakely/sdk";
import hidden from "../src/hidden.json" with { type: "json" };

// Cloak's own test and demo launches stay off the list (src/hidden.json)
const HIDDEN = new Set(hidden.launches.flatMap(([, a, t]) => [a, t]).map((x) => x.toLowerCase()));

export const config = { maxDuration: 15 };

const SITE = "https://gloak.boblabs.tech";
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

/** The launches and their metadata, in the shape the list below reads. */
async function fromChain() {
  const d = deploymentFor(elysiumTestnet.id);
  const pub = createPublicClient({ chain: elysiumTestnet, transport: http(undefined, { timeout: 8000 }) });
  const c = new Cloak(pub, undefined, d.factory);
  const [list, logs] = await Promise.all([
    c.listLaunches(),
    pub.getContractEvents({ address: d.factory, abi: cloakFactoryAbi, eventName: "LaunchCreated", fromBlock: d.factoryBlock, strict: true }),
  ]);
  const launches = await Promise.all(list.map((l) => c.getAuction(l.auction)));
  return { launches, meta: logs.map((l) => ({ auction: l.args.auction, metadataURI: l.args.metadataURI })) };
}

export async function GET(req) {
  const feed = new URL(req.url).searchParams.has("feed");
  // every launch of Cloak v2's factory, read from the chain (the CDN keeps the answer 10 minutes)
  const snap = await fromChain().catch(() => null);
  if (!snap) return new Response(JSON.stringify({ error: "the network didn't answer, try again shortly" }), { status: 503, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });

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
