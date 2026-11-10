/**
 * Provers for Gloam's circuits on Gloam's final ceremony keys, for browsers and Node: the files come from Gloam's own
 * repo at the commit Cloak v2 is pinned to (through jsDelivr), or from sources you pass, and every file is checked
 * against the SHA-256 below before it is used, so a tampered or mismatched download is refused.
 *
 * A final-key vault refuses proofs made on any other keys (Gloam's dev keys included), so these hashes are the ones to
 * trust: they are the files Cloak's live Elysium testnet run proved with (REPORT 16.8).
 */
import * as gloam from "@gloamtrade/sdk";
import { fetchCircuit } from "../private/prover.js";
import type { GloamCoreConfig } from "./gloam.js";
import type { HolderProver } from "./gloamProofs.js";

/** Gloam at the commit Cloak v2 is built and tested against. */
export const GLOAM_COMMIT = "16dac3476be90529ed9578a3701d9fc36d6cd0b5";
export const GLOAM_CIRCUITS_CDN = `https://cdn.jsdelivr.net/gh/gloamtrade/gloam@${GLOAM_COMMIT}/app/public/circuits`;
/** The same commit under Gloam's earlier repo name (it moved to gloamtrade/gloam); every file is hash-checked either way. */
export const GLOAM_CIRCUITS_CDN_OLD = `https://cdn.jsdelivr.net/gh/cryptoduke01/gloam@${GLOAM_COMMIT}/app/public/circuits`;
/** Where the files are tried, in order: jsDelivr from Gloam's repo, then a copy the site serves itself. */
export const GLOAM_CIRCUIT_SOURCES = [GLOAM_CIRCUITS_CDN, GLOAM_CIRCUITS_CDN_OLD, "/circuits/gloam"];

export type GloamCircuit = "shield" | "transfer" | "unshield" | "funds" | "receipt";

/** SHA-256 of each circuit's wasm and final zkey at GLOAM_COMMIT. */
export const GLOAM_CIRCUIT_HASHES: Record<GloamCircuit, { wasm: string; zkey: string }> = {
  shield: { wasm: "58157ec90f8af891acfa998bd599511b4d5cd06803cea32ab28a6eea8a9b2336", zkey: "3054877c35e2e0e9f76c43aa4791ac2b3ac51b8967d51be2215e89c0a5fbb512" },
  transfer: { wasm: "081929509c3477ee264cb2422183018c23122d59952ed4a61c4932c95d360872", zkey: "bdbae966705bc85e76571b4945da74a43fc4503a955fd4e3799358bcff749cdb" },
  unshield: { wasm: "84ac0942b1618c6112a10bfe82ff0a62a80b7a14881565781eb513e9e581c480", zkey: "5a12073f3f84b52f794feaf862fb1d48301124319db95a9c6d0dc58277fa54ed" },
  funds: { wasm: "92107909cf3beed082adfadc26195c450e071a8350632f38ef9f8aca40cac1eb", zkey: "e3fadcf8ce4aeaf07a6a96c2b74b6774ae0a8ba3c1aa4496a033c69f81b54228" },
  receipt: { wasm: "14733e0d4f598d6b392ce8e955eae5624ace80932aa9acdb9298d26c6d1a8fc1", zkey: "b6b2352ecb393c7f0709177f89168d9d4fef53282fb24a98c1c08d9adb7cdd86" },
};

const cache = new Map<string, Promise<[Uint8Array, Uint8Array]>>();

function files(circuit: GloamCircuit, sources: string[]) {
  const k = `${circuit}|${sources.join(",")}`;
  if (!cache.has(k)) {
    const p = fetchCircuit(sources, [`${circuit}.wasm`, `final/${circuit}_final.zkey`], GLOAM_CIRCUIT_HASHES[circuit], `Gloam's ${circuit} circuit`);
    cache.set(k, p.catch((e) => (cache.delete(k), Promise.reject(e))));
  }
  return cache.get(k)!;
}

/** One circuit's prover in GloamCore's shape (packed proof bytes and public signals). Downloads on first use. */
export function gloamProver(circuit: GloamCircuit, sources: string[] = GLOAM_CIRCUIT_SOURCES): GloamCoreConfig["provers"]["shield"] {
  return async (input) => {
    const [wasm, zkey] = await files(circuit, sources);
    const snarkjs = await import("snarkjs");
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input as never, wasm, zkey);
    return { proofBytes: gloam.packGroth16Proof(proof as never), publicSignals: publicSignals as string[], proof };
  };
}

/** The three provers GloamCore needs. Each downloads its files (13.5 MB in all) the first time it proves. */
export function gloamProvers(sources?: string[]): GloamCoreConfig["provers"] {
  return { shield: gloamProver("shield", sources), transfer: gloamProver("transfer", sources), unshield: gloamProver("unshield", sources) };
}

/** A holder-proof prover (funds or receipt) for joinFundsGate, proveReceipt and GloamPrivate.proveFunds. */
export function gloamHolderProver(circuit: "funds" | "receipt", sources: string[] = GLOAM_CIRCUIT_SOURCES): HolderProver {
  return async (input) => {
    const [wasm, zkey] = await files(circuit, sources);
    const snarkjs = await import("snarkjs");
    return (await snarkjs.groth16.fullProve(input as never, wasm, zkey)) as never;
  };
}
