export * from "./types.js";
export * from "./cloak.js";
export * from "./gloam.js";

/** Which private layer Cloak runs on. One setting: CLOAK_CORE=gloam (or `core` in the app's config). */
export type CoreKind = "cloak" | "gloam";
export function coreKindFrom(value: string | undefined | null): CoreKind {
  return value?.toLowerCase() === "gloam" ? "gloam" : "cloak";
}
export * from "./gloamSwap.js";
export * from "./gloamBids.js";
export * from "./launchVault.js";
export * from "./gloamProofs.js";
export * from "./gloamPrivate.js";
export * from "./gloamProvers.js";
export * from "./gloamLinks.js";
export * from "./gloamTree.js";
