export interface ProofArgs {
  a: [bigint, bigint];
  b: [[bigint, bigint], [bigint, bigint]];
  c: [bigint, bigint];
  root: bigint;
  publicAmount: bigint;
  extDataHash: bigint;
  inputNullifiers: [bigint, bigint];
  outputCommitments: [bigint, bigint];
}
export type Prover = (input: Record<string, unknown>) => Promise<ProofArgs>;

const str = (v: unknown): unknown => (Array.isArray(v) ? v.map(str) : String(v));

/** Groth16 prover for the 2-in/2-out circuit (`transaction2x2`). Runs on the user's device. */
export function createProver(wasm: Uint8Array, zkey: Uint8Array): Prover {
  return async (input) => {
    const snarkjs = await import("snarkjs"); // ~1 MB, loaded on the first proof only
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      Object.fromEntries(Object.entries(input).map(([k, v]) => [k, str(v)])),
      wasm,
      zkey,
    );
    const s = (publicSignals as string[]).map(BigInt);
    return {
      a: [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])],
      b: [
        [BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])],
        [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])],
      ],
      c: [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])],
      root: s[0],
      publicAmount: s[1],
      extDataHash: s[2],
      inputNullifiers: [s[3], s[4]],
      outputCommitments: [s[5], s[6]],
    };
  };
}

/** Fetch the circuit artifacts (browser: from /circuits; node: pass file bytes to createProver instead). */
export async function loadProver(baseUrl: string): Promise<Prover> {
  const [w, z] = await Promise.all([fetch(`${baseUrl}/transaction2x2.wasm`), fetch(`${baseUrl}/transaction2x2_final.zkey`)]);
  return createProver(new Uint8Array(await w.arrayBuffer()), new Uint8Array(await z.arrayBuffer()));
}
