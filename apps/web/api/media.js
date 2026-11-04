// NFT media and metadata for the drop pages, from wherever a collection keeps them:
//   /api/media?u=ipfs://<cid>/<path>      the file itself (an image or a metadata JSON), through several IPFS gateways
//                                         at once, first good answer wins, cached for a week (IPFS content never changes)
//   /api/media?collection=0x…&id=<n>      one token's metadata: tokenURI read on chain, the JSON fetched (IPFS, Arweave,
//                                         https or a data: URI), its image rewritten to a link this site serves
// Public gateways rate-limit browsers hard (ipfs.io answers 429), so pages ask here instead. Only ipfs:// and ar:// are
// fetched by address, and only images and JSON under the size limits are passed on: this is not an open proxy.
import { createPublicClient, http } from "viem";
import { elysiumTestnet } from "@cloakely/sdk";

export const config = { maxDuration: 20 };
const GATEWAYS = ["https://gateway.pinata.cloud/ipfs/", "https://w3s.link/ipfs/", "https://dweb.link/ipfs/", "https://ipfs.io/ipfs/", "https://nftstorage.link/ipfs/"];
const MAX_IMAGE = 8_000_000;
const MAX_JSON = 256_000;
const ERC721 = [{ type: "function", name: "tokenURI", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "string" }] }];

const json = (body, status = 200, cache = "public, s-maxage=86400, stale-while-revalidate=604800") =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": status === 200 ? cache : "no-store" } });

/** The places a content address can be read from, in the order to try them. */
function sources(uri) {
  const ipfs = /^ipfs:\/\/(?:ipfs\/)?([A-Za-z0-9]{40,100}(?:\/[^?#\s]*)?)$/.exec(uri);
  if (ipfs) return GATEWAYS.map((g) => g + ipfs[1]);
  const ar = /^ar:\/\/([A-Za-z0-9_-]{43}(?:\/[^?#\s]*)?)$/.exec(uri);
  if (ar) return [`https://arweave.net/${ar[1]}`];
  return [];
}

/** Fetch from every source at once; the first that answers with an allowed type and size wins. */
async function fetchFirst(urls, accept) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    return await Promise.any(
      urls.map(async (url, i) => {
        await new Promise((r) => setTimeout(r, i * 150)); // a head start for the faster gateways
        const r = await fetch(url, { signal: ctl.signal, redirect: "follow" });
        if (!r.ok) throw new Error(`${r.status}`);
        const type = (r.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
        const body = Buffer.from(await r.arrayBuffer());
        if (!accept(type, body)) throw new Error("not allowed");
        return { type, body };
      }),
    );
  } finally {
    clearTimeout(timer);
    ctl.abort();
  }
}

const isImage = (t, b) => /^image\/(png|jpeg|gif|webp|avif|svg\+xml)$/.test(t) && b.length <= MAX_IMAGE;
const sniffImage = (b) => (b[0] === 0x89 && b[1] === 0x50 ? "image/png" : b[0] === 0xff && b[1] === 0xd8 ? "image/jpeg" : b.slice(0, 4).toString() === "GIF8" ? "image/gif" : b.slice(8, 12).toString() === "WEBP" ? "image/webp" : /<svg[\s>]/i.test(b.slice(0, 512).toString()) ? "image/svg+xml" : "");
const isJson = (b) => b.length <= MAX_JSON && /^\s*[{[]/.test(b.slice(0, 64).toString());

/** An image link the browser can load: content addresses through this route, https as it is. */
const imageLink = (img) => (typeof img !== "string" ? undefined : sources(img).length ? `/api/media?u=${encodeURIComponent(img)}` : /^https:\/\//.test(img) || /^data:image\/(png|jpeg|gif|webp|svg\+xml)[;,]/.test(img) ? img : undefined);

async function readJson(uri) {
  const data = /^data:application\/json(;base64)?,(.*)$/s.exec(uri);
  if (data) return JSON.parse(data[1] ? Buffer.from(data[2], "base64").toString() : decodeURIComponent(data[2]));
  const urls = sources(uri).length ? sources(uri) : /^https:\/\//.test(uri) ? [uri] : [];
  if (!urls.length) throw new Error("unsupported metadata link");
  const r = await fetchFirst(urls, (t, b) => t.includes("json") || t.startsWith("text/") || t === "application/octet-stream" ? isJson(b) : isJson(b));
  return JSON.parse(r.body.toString());
}

export async function GET(req) {
  const q = new URL(req.url).searchParams;
  const u = q.get("u");
  try {
    if (u) {
      const urls = sources(u);
      if (!urls.length) return json({ error: "only ipfs:// and ar:// links" }, 400);
      const r = await fetchFirst(urls, (t, b) => isImage(t, b) || isImage(sniffImage(b), b) || isJson(b));
      const type = isImage(r.type, r.body) ? r.type : sniffImage(r.body) || "application/json";
      const headers = { "content-type": type, "access-control-allow-origin": "*", "cache-control": "public, max-age=604800, s-maxage=31536000, immutable", "x-content-type-options": "nosniff" };
      if (type === "image/svg+xml") headers["content-security-policy"] = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";
      return new Response(r.body, { headers });
    }
    const collection = (q.get("collection") ?? "").toLowerCase();
    const id = q.get("id") ?? "";
    if (!/^0x[0-9a-f]{40}$/.test(collection) || !/^\d{1,78}$/.test(id)) return json({ error: "bad collection or id" }, 400);
    const pub = createPublicClient({ chain: elysiumTestnet, transport: http(undefined, { timeout: 8000 }) });
    const uri = await pub.readContract({ address: collection, abi: ERC721, functionName: "tokenURI", args: [BigInt(id)] });
    const m = await readJson(uri);
    const attrs = Array.isArray(m?.attributes) ? m.attributes : [];
    return json({
      id,
      name: typeof m?.name === "string" ? m.name.slice(0, 80) : undefined,
      image: imageLink(m?.image ?? m?.image_url),
      traits: attrs.filter((a) => a && (typeof a.value === "string" || typeof a.value === "number")).slice(0, 30).map((a) => ({ trait: String(a.trait_type ?? "").slice(0, 32), value: String(a.value).slice(0, 40) })),
    });
  } catch (e) {
    return json({ error: String(e?.message ?? e).slice(0, 120) }, 502);
  }
}
