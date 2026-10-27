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

/** Hosted circuit artifacts. */
export const CIRCUITS_URL = "https://cloak.boblabs.tech/circuits";

/** SHA-256 of the artifacts this SDK version was built and tested against. */
export const CIRCUIT_HASHES = {
  wasm: "e44f07497b34f3498352da5bfd9fd7a100c2e8cb7ebddc643f1e6e29d4dfcf6a",
  zkey: "5d64f2162ef439ae53f0e3c61f276245f7fa1b934907ef66ce3cf149056acad0",
} as const;

async function sha256(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Fetch the circuit artifacts (12 MB, once) and build a prover. Works in browsers and Node 18+. The files are checked
 * against `CIRCUIT_HASHES`, so a tampered or mismatched download is refused; pass `hashes: null` to skip that when
 * serving your own build. In Node you can also read the files yourself and call `createProver`.
 */
export async function loadProver(baseUrl: string = CIRCUITS_URL, opts: { hashes?: { wasm: string; zkey: string } | null } = {}): Promise<Prover> {
  const base = baseUrl.replace(/\/$/, "");
  const get = async (name: string) => {
    const res = await fetch(`${base}/${name}`);
    if (!res.ok) throw new Error(`could not download ${name} from ${base} (${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  };
  const [wasm, zkey] = await Promise.all([get("transaction2x2.wasm"), get("transaction2x2_final.zkey")]);
  const want = opts.hashes === undefined ? CIRCUIT_HASHES : opts.hashes;
  if (want) {
    const [hw, hz] = await Promise.all([sha256(wasm), sha256(zkey)]);
    if (hw !== want.wasm || hz !== want.zkey) throw new Error("circuit files don't match this SDK version's hashes; refusing to prove with them");
  }
  return createProver(wasm, zkey);
}
