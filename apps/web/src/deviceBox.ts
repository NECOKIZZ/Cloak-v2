import { keccak256, toBytes } from "viem";
import type { CloakPrivate } from "@cloakely/sdk";
import { CHAIN_ID } from "./config";

/**
 * Small encrypted copies of a private account's data on this device (its last balance, its sync progress). The key
 * comes from the account's view key, which only exists after the wallet signs to unlock, so anyone reading this
 * browser's storage sees opaque blobs. Every read and write is best effort: these are speed-ups, never the truth.
 */
const slot = (p: CloakPrivate, label: string) => `cloak.${label}.v1.${CHAIN_ID}.${keccak256(p.keys.encPub).slice(2, 18)}`;
const keyOf = (p: CloakPrivate, label: string) =>
  crypto.subtle.importKey("raw", toBytes(keccak256(new Uint8Array([...toBytes(`cloak-${label}-cache-v1`), ...p.keys.encPriv]))), "AES-GCM", false, ["encrypt", "decrypt"]);
const b64 = (u: Uint8Array) => btoa(Array.from(u, (c) => String.fromCharCode(c)).join(""));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function openBox(p: CloakPrivate, label: string): Promise<string | null> {
  try {
    const s = localStorage.getItem(slot(p, label));
    if (!s) return null;
    const { iv, ct } = JSON.parse(s);
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await keyOf(p, label), unb64(ct)));
  } catch {
    return null; // missing, blocked or from another key
  }
}

export async function sealBox(p: CloakPrivate, label: string, text: string): Promise<void> {
  try {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await keyOf(p, label), new TextEncoder().encode(text)));
    localStorage.setItem(slot(p, label), JSON.stringify({ iv: b64(iv), ct: b64(ct) }));
  } catch {} // full or blocked storage
}
