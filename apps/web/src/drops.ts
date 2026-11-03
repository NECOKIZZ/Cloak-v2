import { CloakDrops, type Wallet } from "@cloakely/sdk";
import { DROP_FACTORY, DROP_FACTORY_BLOCK } from "./config";
import { publicClient } from "./wallet";

/** The drops client: reads with no wallet, writes with one. */
export function dropsClient(wallet?: Wallet | null): CloakDrops {
  if (!DROP_FACTORY) throw new Error("NFT drops aren't available on this network yet.");
  return new CloakDrops(publicClient, wallet ?? undefined, DROP_FACTORY, DROP_FACTORY_BLOCK);
}

/** An image link a browser can show: ipfs:// through a public gateway, data: and https: as they are. */
export function imageSrc(uri?: string): string | undefined {
  if (!uri) return undefined;
  if (uri.startsWith("ipfs://")) return `https://ipfs.io/ipfs/${uri.slice(7)}`;
  if (uri.startsWith("data:image/") || uri.startsWith("https://")) return uri;
  return undefined;
}

/** "20%" from basis points. */
export const pct = (bps: number) => `${(bps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
