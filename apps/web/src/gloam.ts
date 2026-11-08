import { gloamProvers as sdkProvers, toJson, fromJson, type GloamCoreConfig, type LaunchRecord } from "@cloakely/sdk";
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
