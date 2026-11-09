// Shared cryptography: Poseidon (circomlib's, per arity) and the request a wallet signs to unlock a private account.
import { poseidon1 } from "poseidon-lite/poseidon1";
import { poseidon2 } from "poseidon-lite/poseidon2";
import { poseidon3 } from "poseidon-lite/poseidon3";
import { poseidon4 } from "poseidon-lite/poseidon4";

export const FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// circomlib's Poseidon (the circuits' hash) with per-arity constants: tens of KB instead of circomlibjs's 1.3 MB.
// Identical outputs for arities 1 to 4 (checked against circomlibjs on 10,000+ inputs, field edges included, in
// test/poseidon.test.mjs), which are the only arities Cloak uses.
const POSEIDON = [poseidon1, poseidon2, poseidon3, poseidon4];
export async function poseidon(inputs: bigint[]): Promise<bigint> {
  const f = POSEIDON[inputs.length - 1];
  if (!f) throw new Error(`poseidon: ${inputs.length} inputs, only 1 to 4 are supported`);
  return f(inputs.map((x) => BigInt(x)));
}

/**
 * EIP-712 request whose signature derives a wallet's Cloak private account (v4 on). It is bound to the chain only, never
 * to a contract, so the account and its `cloak:` address stay the same through every upgrade.
 */
export const ACCOUNT_TYPED_DATA = (chainId: number) =>
  ({
    domain: { name: "Cloak", version: "4", chainId },
    types: { PrivateAccount: [{ name: "purpose", type: "string" }] },
    primaryType: "PrivateAccount",
    message: {
      purpose: "Derive my Cloak private account. This costs nothing and moves no funds. Only sign this on cloak.boblabs.tech.",
    },
  }) as const;
