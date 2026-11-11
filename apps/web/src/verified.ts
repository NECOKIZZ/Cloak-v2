/**
 * Drops Cloak vouches for: listed by the Cloak team, or reviewed and approved. They get a check mark on the drop
 * list and the drop page. Anyone can create a drop, so the mark is the only thing telling a real partner sale from a
 * copy with the same name and art.
 *
 * Two ways in, both read at build time:
 *   - a creator wallet (the team's): every drop it creates is verified;
 *   - a drop address: one approved drop, made by anyone.
 * Add to the lists below, or set VITE_VERIFIED_CREATORS / VITE_VERIFIED_DROPS (comma-separated) in the host's settings.
 */
import { CHAIN_ID } from "./config";

const env = import.meta.env as Record<string, string | undefined>;

/** Team wallets, by chain id: drops they create are verified. */
const CREATORS: Record<number, string[]> = {
  99801: [
    "0x858f3232e7d6702f20c4d3feab987a405d225f4e", // Cloak team
    "0xc565803b278e09e4fe23cb68f956ce166e877717", // Cloak team lister (partner sales listed for the team)
  ],
};
/** Approved drops, by chain id. */
const DROPS: Record<number, string[]> = {
  99801: [],
};

const set = (list: string[], extra?: string) =>
  new Set([...list, ...(extra ?? "").split(",")].map((a) => a.trim().toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a)));
const creators = set(CREATORS[CHAIN_ID] ?? [], env.VITE_VERIFIED_CREATORS);
const drops = set(DROPS[CHAIN_ID] ?? [], env.VITE_VERIFIED_DROPS);

/** Why a drop is verified ("team" listed it, or it was "approved"), or null. */
export function verifiedBy(drop: string, creator: string): "team" | "approved" | null {
  if (creators.has(creator.toLowerCase())) return "team";
  if (drops.has(drop.toLowerCase())) return "approved";
  return null;
}
