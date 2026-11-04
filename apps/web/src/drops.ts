import { CloakDrops, CloakSpots, type Wallet } from "@cloakely/sdk";
import { DROP_FACTORY, DROP_FACTORY_BLOCK, SPOT_BOOK } from "./config";
import { publicClient } from "./wallet";

/** The drops client: reads with no wallet, writes with one. */
export function dropsClient(wallet?: Wallet | null): CloakDrops {
  if (!DROP_FACTORY) throw new Error("NFT drops aren't available on this network yet.");
  return new CloakDrops(publicClient, wallet ?? undefined, DROP_FACTORY, DROP_FACTORY_BLOCK);
}

/** WL spot sales on top of drops, or null where the network has no spot book. */
export function spotsClient(wallet?: Wallet | null): CloakSpots | null {
  return SPOT_BOOK ? new CloakSpots(dropsClient(wallet), SPOT_BOOK) : null;
}

/** An image link a browser can show: ipfs:// through a public gateway, data: and https: as they are. */
export function imageSrc(uri?: string): string | undefined {
  if (!uri) return undefined;
  if (uri.startsWith("ipfs://")) return `https://ipfs.io/ipfs/${uri.slice(7)}`;
  if (/^data:image\/(png|jpeg|webp|gif);/.test(uri) || uri.startsWith("https://")) return uri;
  return undefined;
}

/** "20%" from basis points. */
export const pct = (bps: number) => `${(bps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;

/** One item's public metadata (ERC-721 JSON), for the drop page's preview. */
export interface ItemMeta {
  id: number;
  name?: string;
  image?: string;
  traits: { trait: string; value: string }[];
}

/** Fetch a link the browser can read: ipfs:// through a public gateway, https: as it is. */
function fetchable(uri: string): string | undefined {
  if (uri.startsWith("ipfs://")) return `https://ipfs.io/ipfs/${uri.slice(7)}`;
  if (uri.startsWith("https://")) return uri;
  return undefined;
}

/**
 * The first `n` items of a collection that brings its own metadata folder (baseURI + id, as tokenURI reads it).
 * Drops without one are served by Cloak with the collection image on every token, so they get no preview.
 */
export async function itemPreview(baseURI: string, n: number): Promise<ItemMeta[]> {
  if (!baseURI || baseURI.includes("/api/nft/")) return [];
  const out = await Promise.all(
    Array.from({ length: n }, async (_, i): Promise<ItemMeta | null> => {
      const id = i + 1;
      const url = fetchable(baseURI + id);
      if (!url) return null;
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 8000);
      try {
        const r = await fetch(url, { signal: ctl.signal });
        if (!r.ok) return null;
        const j = await r.json();
        const attrs = Array.isArray(j?.attributes) ? j.attributes : [];
        return {
          id,
          name: typeof j?.name === "string" ? j.name.slice(0, 80) : undefined,
          image: typeof j?.image === "string" ? j.image : undefined,
          traits: attrs
            .filter((a: { trait_type?: unknown; value?: unknown }) => a && (typeof a.value === "string" || typeof a.value === "number"))
            .map((a: { trait_type?: unknown; value: string | number }) => ({ trait: String(a.trait_type ?? "").slice(0, 32), value: String(a.value).slice(0, 40) })),
        };
      } catch {
        return null;
      } finally {
        clearTimeout(t);
      }
    }),
  );
  return out.filter((x): x is ItemMeta => !!x);
}
