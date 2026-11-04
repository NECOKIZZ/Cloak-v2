import { CloakDrops, CloakSpots, erc721Abi, type Wallet } from "@cloakely/sdk";
import type { Address } from "viem";
import { DROP_FACTORY, DROP_FACTORY_BLOCK, ESCROW_DROP_FACTORY, SPOT_BOOK } from "./config";
import { publicClient } from "./wallet";

/** The drops client: reads with no wallet, writes with one. */
export function dropsClient(wallet?: Wallet | null): CloakDrops {
  if (!DROP_FACTORY) throw new Error("NFT drops aren't available on this network yet.");
  return new CloakDrops(publicClient, wallet ?? undefined, DROP_FACTORY, DROP_FACTORY_BLOCK, ESCROW_DROP_FACTORY);
}

/** WL spot sales on top of drops, or null where the network has no spot book. */
export function spotsClient(wallet?: Wallet | null): CloakSpots | null {
  return SPOT_BOOK ? new CloakSpots(dropsClient(wallet), SPOT_BOOK) : null;
}

/** An image link a browser can show: ipfs:// through a public gateway, data: and https: as they are. */
export function imageSrc(uri?: string): string | undefined {
  if (!uri) return undefined;
  // content addresses go through the site's media route: public gateways rate-limit browsers (ipfs.io answers 429)
  if (uri.startsWith("ipfs://") || uri.startsWith("ar://")) return `/api/media?u=${encodeURIComponent(uri)}`;
  if (uri.startsWith("/api/media?")) return uri;
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
  if (uri.startsWith("ipfs://") || uri.startsWith("ar://")) return `/api/media?u=${encodeURIComponent(uri)}`;
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

/** Read a token's metadata from its collection: tokenURI, then the JSON (https, ipfs or a data: URI). */
export async function tokenMeta(collection: Address, id: bigint): Promise<ItemMeta> {
  const base: ItemMeta = { id: Number(id), traits: [] };
  // the site's media route reads tokenURI and the JSON server-side, through several gateways, and caches it
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 20000);
    const r = await fetch(`/api/media?collection=${collection}&id=${id}`, { signal: ctl.signal }).finally(() => clearTimeout(t));
    if (r.ok && (r.headers.get("content-type") ?? "").includes("json")) {
      const j = await r.json();
      return { id: Number(id), name: j.name, image: j.image, traits: Array.isArray(j.traits) ? j.traits : [] };
    }
  } catch {}
  try {
    const uri = await publicClient.readContract({ address: collection, abi: erc721Abi, functionName: "tokenURI", args: [id] });
    let j: { name?: unknown; image?: unknown; attributes?: unknown };
    const m = /^data:application\/json(;base64)?,(.*)$/s.exec(uri);
    if (m) j = JSON.parse(m[1] ? atob(m[2]) : decodeURIComponent(m[2]));
    else {
      const url = fetchable(uri);
      if (!url) return base;
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 8000);
      try {
        j = await (await fetch(url, { signal: ctl.signal })).json();
      } finally {
        clearTimeout(t);
      }
    }
    const attrs = Array.isArray(j?.attributes) ? (j.attributes as { trait_type?: unknown; value?: unknown }[]) : [];
    return {
      id: Number(id),
      name: typeof j?.name === "string" ? j.name.slice(0, 80) : undefined,
      image: typeof j?.image === "string" ? j.image : undefined,
      traits: attrs.filter((a) => a && (typeof a.value === "string" || typeof a.value === "number")).map((a) => ({ trait: String(a.trait_type ?? "").slice(0, 32), value: String(a.value).slice(0, 40) })),
    };
  } catch {
    return base;
  }
}

/** Metadata for many tokens, a few at a time. */
export async function tokenMetas(collection: Address, ids: bigint[], max = 60): Promise<ItemMeta[]> {
  const out: ItemMeta[] = [];
  const list = ids.slice(0, max);
  for (let i = 0; i < list.length; i += 12) out.push(...(await Promise.all(list.slice(i, i + 12).map((id) => tokenMeta(collection, id)))));
  return out;
}

/** A collection's name and symbol, or null when the address isn't an ERC-721 contract. */
export async function collectionInfo(collection: Address): Promise<{ name: string; symbol: string } | null> {
  try {
    const is721 = await publicClient.readContract({ address: collection, abi: erc721Abi, functionName: "supportsInterface", args: ["0x80ac58cd"] }).catch(() => null);
    const [name, symbol] = await Promise.all([
      publicClient.readContract({ address: collection, abi: erc721Abi, functionName: "name" }).catch(() => ""),
      publicClient.readContract({ address: collection, abi: erc721Abi, functionName: "symbol" }).catch(() => ""),
    ]);
    if (is721 === false || (is721 === null && !name)) return null;
    return { name: name || "Unnamed collection", symbol };
  } catch {
    return null;
  }
}
