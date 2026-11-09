import { gloamProvers as sdkProvers, toJson, fromJson, type GloamCoreConfig, type GloamPrivate, type LaunchRecord } from "@cloakely/sdk";
import type { Hex } from "viem";
import { openBox } from "./deviceBox";
import { CHAIN_ID } from "./config";

/** Gloam's final-key provers, made once per page load (their 13.5 MB of files download on the first proof). */
let provers: GloamCoreConfig["provers"] | null = null;
export const gloamProvers = () => (provers ??= sdkProvers());

/**
 * The follow-ups this device owes (a swap's buffer, a graduation), per wallet. They hold no secrets: the keys come back
 * from the account's one signature. Lost storage only delays them until the account acts again.
 */
export function launchRecords(wallet: string): { load(): LaunchRecord[]; save(r: LaunchRecord[]): void } {
  const k = `cloak.gloam.pending.v1.${CHAIN_ID}.${wallet.toLowerCase()}`;
  return {
    load() {
      try {
        const s = localStorage.getItem(k);
        return s ? (fromJson(s) as LaunchRecord[]) : [];
      } catch {
        return [];
      }
    },
    save(r) {
      try {
        localStorage.setItem(k, toJson(r));
      } catch {}
    },
  };
}

/** What this device moved in from each receive address, per address (amount text and transaction), for the Receive page. */
const delivered = new Map<string, { token: string; amount: string; fee: string; txHash: Hex }[]>();

/** Move what waits at these receive addresses into the private balance. Returns how many deposits it made. */
export async function collectIssued(p: GloamPrivate, issued: { n: number; address: string }[]): Promise<number> {
  let made = 0;
  for (const x of issued.slice(-12)) {
    for (const d of await p.collectReceived(x.n)) {
      const k = x.address.toLowerCase();
      delivered.set(k, [...(delivered.get(k) ?? []), { token: d.asset, amount: d.amount.toString(), fee: "0", txHash: d.txHash }]);
      made++;
    }
  }
  return made;
}

/** The addresses this account handed out (the Receive page keeps them on this device), moved in on every unlock. */
export async function collectOnUnlock(p: GloamPrivate): Promise<number> {
  try {
    const issued = JSON.parse((await openBox(p, "receive")) ?? "[]") as { n: number; address: string }[];
    return issued.length ? await collectIssued(p, issued) : 0;
  } catch {
    return 0;
  }
}

/** In the shape the Receive page reads from the keeper for Cloak's own addresses. */
export async function gloamDelivered(_p: GloamPrivate, addrs: string[]) {
  return Object.fromEntries(addrs.map((a) => [a, delivered.get(a.toLowerCase()) ?? []]));
}

/**
 * Per vault: notes this device made that the vault hasn't shown yet, and memos not yet posted (GloamCore keeps an own
 * note as its nonce, worthless without the account's signature). Keeps a dropped relay answer or a closed tab from
 * losing a note.
 */
export function gloamPending(wallet: string): (vault: string) => { load(): string | null; save(s: string): void } {
  return (vault) => {
    const k = `cloak.gloam.notes.v1.${CHAIN_ID}.${wallet.toLowerCase()}.${vault.toLowerCase()}`;
    return {
      load() {
        try {
          return localStorage.getItem(k);
        } catch {
          return null;
        }
      },
      save(v) {
        try {
          localStorage.setItem(k, v);
        } catch {}
      },
    };
  };
}
