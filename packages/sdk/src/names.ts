import { isAddress, parseAbi, zeroAddress, type Address, type PublicClient } from "viem";

/**
 * .ely names (Elysium Name Service): type `bona.ely` instead of a long address. Two read-only calls on one contract,
 * no API key and no backend. Mainnet's address is published at launch; until then only testnet resolves.
 */
export const ELY_NAMES: Record<number, Address> = {
  99801: "0x13A130B336400409c956dF042C128238F1486ddD", // Elysium testnet
};

export const elyNamesAbi = parseAbi([
  "function resolve(string label) view returns (address)",
  "function primaryNameOf(address owner) view returns (string)",
  "function text(string label, string key) view returns (string)",
]);

/**
 * The label of a .ely name, or null if the input isn't one: trimmed, lowercased, a trailing `.ely` removed, then
 * 2 to 63 of a-z, 0-9 and hyphens, not starting or ending with a hyphen.
 */
export function elyLabel(input: string): string | null {
  const s = input.trim().toLowerCase().replace(/\.ely$/, "");
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$/.test(s) ? s : null;
}

/** True when the input looks like a .ely name (it ends in `.ely` and its label is valid). */
export const isElyName = (input: string) => /\.ely$/i.test(input.trim()) && elyLabel(input) !== null;

/**
 * The wallet a .ely name points to now, or null if the name isn't registered, has expired, or the chain has no name
 * service. Resolve at the moment of sending and don't store the result: names expire and change hands.
 */
export async function resolveEly(publicClient: PublicClient, name: string): Promise<Address | null> {
  const label = elyLabel(name);
  const at = ELY_NAMES[publicClient.chain?.id ?? (await publicClient.getChainId())];
  if (!label || !at) return null;
  const a = await publicClient.readContract({ address: at, abi: elyNamesAbi, functionName: "resolve", args: [label] });
  return a && a !== zeroAddress ? a : null;
}

/** A wallet's chosen .ely name (like `bona.ely`), or null if it has none. Safe to display: only the owner can set it. */
export async function elyNameOf(publicClient: PublicClient, address: Address): Promise<string | null> {
  const at = ELY_NAMES[publicClient.chain?.id ?? (await publicClient.getChainId())];
  if (!at) return null;
  const n = await publicClient.readContract({ address: at, abi: elyNamesAbi, functionName: "primaryNameOf", args: [address] });
  return n ? (n.endsWith(".ely") ? n : `${n}.ely`) : null;
}

/**
 * A recipient typed by a person: a 0x address as it is, or a .ely name resolved now. Throws a readable error for
 * anything else, and for a name that doesn't resolve (never send to the zero address).
 */
export async function resolveRecipient(publicClient: PublicClient, input: string): Promise<{ address: Address; name?: string }> {
  const s = input.trim();
  if (isAddress(s)) return { address: s };
  if (isElyName(s)) {
    const address = await resolveEly(publicClient, s);
    if (!address) throw new Error(`${elyLabel(s)}.ely isn't registered, or it has expired.`);
    return { address, name: `${elyLabel(s)}.ely` };
  }
  throw new Error("Enter a 0x address or a .ely name.");
}
