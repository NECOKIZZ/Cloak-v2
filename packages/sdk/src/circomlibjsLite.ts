/**
 * A stand-in for circomlibjs's `buildPoseidon`, for browser builds (OPTIMIZATION.md V4).
 *
 * Gloam's SDK hashes with circomlibjs, which ships about 1.4 MB gzipped of round constants for every arity up to 16
 * plus other primitives. Gloam uses only `buildPoseidon()`, the hash it returns, and `F.toObject`, at 2 and 3 inputs.
 * The site's bundler points the `circomlibjs` import here (resolve.alias in apps/web/vite.config.ts), so Gloam's code
 * runs unchanged on poseidon-lite (circomlib's constants, per arity). Outputs are identical for 1 to 4 inputs: checked
 * against the real circomlibjs on thousands of inputs and the field edges (test/circomlibjs-lite.test.mjs). Node tools
 * (keeper, MCP) keep the real circomlibjs.
 */
import { poseidon1, poseidon2, poseidon3, poseidon4 } from "poseidon-lite";

const BY_ARITY = [poseidon1, poseidon2, poseidon3, poseidon4];

type Poseidon = ((inputs: (bigint | number | string)[]) => bigint) & { F: { toObject(x: bigint): bigint; e(x: bigint | number | string): bigint } };

export async function buildPoseidon(): Promise<Poseidon> {
  const f = ((inputs: (bigint | number | string)[]) => {
    const h = BY_ARITY[inputs.length - 1];
    if (!h) throw new Error(`poseidon: ${inputs.length} inputs, this build supports 1 to 4`);
    return h(inputs.map((x) => BigInt(x)));
  }) as Poseidon;
  f.F = { toObject: (x) => x, e: (x) => BigInt(x) };
  return f;
}
