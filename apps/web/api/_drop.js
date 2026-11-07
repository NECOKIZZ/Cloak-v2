// A drop's public state and details for link previews (api/preview.js) and the share card image (api/card.js).
// Files starting with _ are not routes. Read from the chain with a short timeout; null when the drop can't be read.
import { createPublicClient, formatEther, http } from "viem";
import { CloakDrops, deploymentFor, elysiumTestnet } from "@cloakely/sdk";

export const SITE = "https://cloak.boblabs.tech";

export async function loadDrop(a) {
  const d = deploymentFor(elysiumTestnet.id);
  if (!d.dropFactory) return null;
  const pub = createPublicClient({ chain: elysiumTestnet, transport: http(undefined, { timeout: 8000 }), batch: { multicall: true } });
  const c = new CloakDrops(pub, undefined, d.dropFactory, BigInt(d.dropFactoryBlock ?? 0), d.escrowDropFactory);
  const s = await c.get(a).catch(() => null);
  if (!s) return null;
  // the details come from a log scan, which can be slow: the card still works without them
  const details = await Promise.race([c.details(a).catch(() => ({})), new Promise((r) => setTimeout(() => r({}), 6000))]);
  return { s, details };
}

/** An image a link fetcher can load: ipfs:// and ar:// through this site's media route, https: as it is. */
export function absImage(uri) {
  if (!uri || typeof uri !== "string") return undefined;
  if (uri.startsWith("ipfs://") || uri.startsWith("ar://")) return `${SITE}/api/media?u=${encodeURIComponent(uri)}`;
  if (uri.startsWith("https://")) return uri;
  if (/^data:image\/(png|jpeg|webp|gif);base64,/.test(uri)) return uri;
  return undefined;
}

export const hypeText = (wei) => {
  const n = Number(formatEther(wei));
  if (n > 0 && n < 1e-4) return n.toExponential(2);
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
};

const left = (s) => {
  if (s <= 0) return "soon";
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${Math.max(m, 1)}m`;
};

/** Title, description, a short status and a price line, in plain words (no colons, semicolons or em dashes). */
export function dropSummary(s) {
  const now = Date.now() / 1000;
  const name = s.name || s.symbol || "An NFT drop";
  const sold = s.sold + s.gtdMinted;
  // the card image is cached for a day, so its status carries no countdown (the text preview, cached 5 minutes, does)
  let status, card, desc;
  if (s.phase === "gtd") {
    status = s.hasGtd ? "Guaranteed mint live" : `Bidding opens in ${left(s.gtdEnd - now)}`;
    card = s.hasGtd ? "Guaranteed mint live" : "Sealed bidding opens soon";
    desc = `${s.supply.toLocaleString()} items. Sealed bidding opens in ${left(s.gtdEnd - now)} and nobody sees a bid until it closes.`;
  } else if (s.phase === "bidding") {
    status = `Sealed bidding · ${left(s.commitEnd - now)} left`;
    card = "Sealed bidding open";
    desc = `${s.supply.toLocaleString()} items from ${hypeText(s.floor)} HYPE. Bids stay sealed until bidding closes, and every winner pays one price.`;
  } else if (s.phase === "reveal" || s.phase === "settle" || s.phase === "numbering") {
    status = "Opening the sealed bids";
    desc = `Bidding has closed and ${s.bids} sealed bids are opening now. Every winner pays one clearing price.`;
  } else if (s.failed) {
    status = "Ended with no sale";
    desc = "This drop didn't sell. Every deposit is refundable.";
  } else {
    status = sold >= s.supply ? "Sold out" : `Sold ${sold.toLocaleString()} of ${s.supply.toLocaleString()}`;
    desc = `Cleared at ${hypeText(s.publicPrice)} HYPE with ${sold.toLocaleString()} of ${s.supply.toLocaleString()} sold in a sealed-bid auction on Cloak.`;
  }
  const price = s.settled && !s.failed ? `${hypeText(s.publicPrice)} HYPE` : `From ${hypeText(s.floor)} HYPE`;
  return { title: `${name} on Cloak`, name, desc, status, card: card ?? status, price, sold };
}
