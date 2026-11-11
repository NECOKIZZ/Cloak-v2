// NFT metadata for drops that bring no folder of their own (CloakDropFactory's default base URI):
//   /api/nft/<drop>/<id>          ERC-721 metadata JSON: "<name> #<id>", the collection's description and image
//   /api/nft/<drop>/<id>?img=1    the image itself, when the drop stored it on chain as a data URI
// Only drops made by Cloak's factory are served, and only token ids that exist.
import { createPublicClient, http } from "viem";
import { CloakDrops, cloakDropAbi, deploymentFor, elysiumTestnet } from "@cloakely/sdk";

export const config = { maxDuration: 15 };
const SITE = "https://cloak.boblabs.tech";

export async function GET(req) {
  const u = new URL(req.url);
  const drop = (u.searchParams.get("drop") ?? "").toLowerCase();
  const id = u.searchParams.get("id") ?? "";
  const bad = (status, error) => new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json" } });
  if (!/^0x[0-9a-f]{40}$/.test(drop) || !/^[1-9]\d{0,5}$/.test(id)) return bad(400, "bad drop or id");
  const d = deploymentFor(elysiumTestnet.id);
  if (!d.dropFactory) return bad(404, "no drops here");
  const pub = createPublicClient({ chain: elysiumTestnet, transport: http(undefined, { timeout: 8000 }) });
  const drops = new CloakDrops(pub, undefined, d.dropFactory, d.dropFactoryBlock ?? 0n);
  const c = { address: drop, abi: cloakDropAbi };
  const [details, name, supply] = await Promise.all([
    drops.details(drop),
    pub.readContract({ ...c, functionName: "name" }).catch(() => null),
    pub.readContract({ ...c, functionName: "totalSupply" }).catch(() => 0n),
  ]);
  if (!name) return bad(404, "not a Cloak drop");
  if (BigInt(id) > supply) return bad(404, "not minted yet");
  const img = details.image ?? "";
  if (u.searchParams.get("img")) {
    const m = /^data:(image\/(?:png|jpeg|webp|gif|svg\+xml));base64,([A-Za-z0-9+/=]+)$/.exec(img);
    if (!m) return img.startsWith("https://") ? Response.redirect(img, 302) : bad(404, "no image");
    return new Response(Buffer.from(m[2], "base64"), { headers: { "content-type": m[1], "cache-control": "public, max-age=86400, s-maxage=604800, stale-while-revalidate=604800" } });
  }
  const image = img.startsWith("data:image/") ? `${SITE}/api/nft/${drop}/${id}?img=1` : img.startsWith("https://") || img.startsWith("ipfs://") ? img : `${SITE}/og.jpg`;
  const sk = details.spots?.kind === "GTD" ? "GTD" : "WL";
  const meta = details.spots
    ? { name: `${name} #${id}`, description: details.description ?? `A receipt for a ${details.spots.partner} ${sk} spot won in a sealed sale on Cloak.`, image, external_url: `${SITE}/app/drop/${drop}`, attributes: [{ trait_type: "Partner", value: details.spots.partner }, { trait_type: "Kind", value: `${sk} spot receipt` }] }
    : { name: `${name} #${id}`, description: details.description ?? `${name}, a sealed drop on Cloak.`, image, external_url: `${SITE}/app/drop/${drop}` };
  return new Response(JSON.stringify(meta), { headers: { "content-type": "application/json", "cache-control": "public, s-maxage=3600, stale-while-revalidate=86400", "access-control-allow-origin": "*" } });
}
