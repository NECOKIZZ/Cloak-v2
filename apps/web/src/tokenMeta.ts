import { useEffect, useState } from "react";
import type { Address } from "viem";
import { cloakFactoryAbi } from "@cloakely/sdk";
import { FACTORY } from "./config";
import { Hint } from "./errors";
import { publicClient } from "./wallet";

/**
 * Token images and descriptions live on-chain in each launch's `metadataURI`
 * (emitted in LaunchCreated), as a small JSON data URI: { image, description }.
 * Other launchpads can put an https:// or ipfs:// link there instead.
 */
export interface TokenMeta {
  image?: string;
  description?: string;
}

const MAX_BYTES = 40_000;

const b64 = (s: string) => {
  let bin = "";
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
};
const unb64 = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));

export function encodeMeta(m: TokenMeta): string {
  if (!m.image && !m.description) return "";
  return `data:application/json;base64,${b64(JSON.stringify({ image: m.image || undefined, description: m.description?.trim() || undefined }))}`;
}

/** Only images we can show safely: inline raster images, https and ipfs. */
function safeImage(src: unknown): string | undefined {
  if (typeof src !== "string") return undefined;
  if (/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(src)) return src;
  if (/^https:\/\//.test(src)) return src;
  if (/^ipfs:\/\//.test(src)) return `https://ipfs.io/ipfs/${src.slice(7)}`;
  return undefined;
}

async function parseMeta(uri: string): Promise<TokenMeta> {
  try {
    if (uri.startsWith("data:application/json;base64,")) {
      const j = JSON.parse(unb64(uri.slice(29)));
      return { image: safeImage(j.image), description: typeof j.description === "string" ? j.description.slice(0, 400) : undefined };
    }
    if (uri.startsWith("data:image/")) return { image: safeImage(uri) };
    const url = safeImage(uri);
    if (!url) return {};
    if (/\.(png|jpe?g|webp|gif|svg)(\?|$)/i.test(url)) return { image: url };
    // only follow links that are metadata files; a plain website link (e.g. a repo) isn't one
    if (!/\.json(\?|$)/i.test(url) && !url.startsWith("https://ipfs.io/ipfs/")) return {};
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const j = await r.json();
    return { image: safeImage(j.image), description: typeof j.description === "string" ? j.description.slice(0, 400) : undefined };
  } catch {
    return {};
  }
}

let all: Promise<Map<string, TokenMeta>> | null = null;
const subs = new Set<() => void>();

/** Metadata for every launch, keyed by token and by auction address (lowercase). */
export function loadAllMeta(force = false): Promise<Map<string, TokenMeta>> {
  if (all && !force) return all;
  all = (async () => {
    const m = new Map<string, TokenMeta>();
    if (!FACTORY) return m;
    const logs = await publicClient.getContractEvents({ address: FACTORY, abi: cloakFactoryAbi, eventName: "LaunchCreated", fromBlock: 0n, toBlock: "latest", strict: true });
    await Promise.all(
      logs.map(async (l) => {
        const meta = l.args.metadataURI ? await parseMeta(l.args.metadataURI) : {};
        m.set(l.args.token.toLowerCase(), meta);
        m.set(l.args.auction.toLowerCase(), meta);
      }),
    );
    subs.forEach((f) => f());
    return m;
  })().catch(() => {
    all = null;
    return new Map();
  });
  return all;
}

export function useTokenMeta(addr?: string): TokenMeta | undefined {
  const [meta, setMeta] = useState<TokenMeta | undefined>();
  useEffect(() => {
    if (!addr) return;
    let alive = true;
    const go = () => loadAllMeta().then((m) => alive && setMeta(m.get(addr.toLowerCase())));
    go();
    subs.add(go);
    return () => {
      alive = false;
      subs.delete(go);
    };
  }, [addr]);
  return meta;
}

/** Crops an uploaded image to a square and shrinks it until it fits comfortably on-chain. */
export async function compressImage(file: File): Promise<string> {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Hint("Use a PNG, JPG, WebP or GIF image.");
  if (file.size > 10_000_000) throw new Hint("That image is over 10 MB. Pick a smaller one.");
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, bad) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => bad(new Hint("That image couldn't be opened. Try another file."));
      i.src = url;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    for (const size of [256, 192, 128]) {
      const c = document.createElement("canvas");
      c.width = c.height = size;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
      for (const q of [0.86, 0.75, 0.62, 0.5]) {
        let out = c.toDataURL("image/webp", q);
        if (!out.startsWith("data:image/webp")) out = c.toDataURL("image/jpeg", q); // browsers without WebP encoding
        if (out.length <= MAX_BYTES) return out;
      }
    }
    throw new Hint("That image is too detailed to store on-chain. Try a simpler one.");
  } finally {
    URL.revokeObjectURL(url);
  }
}
