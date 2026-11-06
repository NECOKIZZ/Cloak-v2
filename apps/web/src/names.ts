import { useEffect, useState } from "react";
import { isAddress, type Address } from "viem";
import { elyLabel, isElyName, resolveRecipient, elyNameOf } from "@cloakely/sdk";
import { publicClient } from "./wallet";

export type Recipient =
  | { state: "empty" | "invalid" }
  | { state: "looking"; name: string }
  | { state: "missing"; name: string }
  | { state: "ok"; address: Address; name?: string };

/**
 * What a typed recipient points to: a 0x address as it is, or a .ely name looked up as the person types (straight from
 * the chain, nothing goes through the site's server). Pages still resolve again when sending, since names change hands.
 */
export function useRecipient(input: string): Recipient {
  const s = input.trim();
  const [r, setR] = useState<Recipient>({ state: "empty" });
  useEffect(() => {
    if (!s) return setR({ state: "empty" });
    if (isAddress(s)) return setR({ state: "ok", address: s });
    if (!isElyName(s)) return setR({ state: "invalid" });
    const name = `${elyLabel(s)}.ely`;
    setR({ state: "looking", name });
    let live = true;
    const t = setTimeout(() => {
      resolveRecipient(publicClient, s)
        .then((x) => live && setR({ state: "ok", address: x.address, name }))
        .catch(() => live && setR({ state: "missing", name }));
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [s]);
  return r;
}

/** The address to send to right now: resolves a .ely name at the moment of sending (throws a readable error). */
export const recipientNow = (input: string) => resolveRecipient(publicClient, input);

// a wallet's .ely name, looked up once per address per visit
const nameCache = new Map<string, Promise<string | null>>();
export function useElyName(address?: string): string | null {
  const [n, setN] = useState<string | null>(null);
  useEffect(() => {
    if (!address || !isAddress(address)) return setN(null);
    const k = address.toLowerCase();
    if (!nameCache.has(k)) nameCache.set(k, elyNameOf(publicClient, address).catch(() => null));
    let live = true;
    nameCache.get(k)!.then((x) => live && setN(x));
    return () => {
      live = false;
    };
  }, [address]);
  return n;
}
