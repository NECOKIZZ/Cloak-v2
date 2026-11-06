export interface ProofArgs {
  a: [bigint, bigint];
  b: [[bigint, bigint], [bigint, bigint]];
  c: [bigint, bigint];
  root: bigint;
  publicAmount: bigint;
  extDataHash: bigint;
  inputNullifiers: [bigint, bigint];
  outputCommitments: [bigint, bigint];
  /** Shared-vault proofs only: the token named publicly, or 0 for a send that hides it. */
  publicAsset?: bigint;
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

/** Groth16 prover for the shared launch-token vault (`transactionMA2x2`, 8 public signals). */
export function createSharedProver(wasm: Uint8Array, zkey: Uint8Array): Prover {
  return async (input) => {
    const snarkjs = await import("snarkjs");
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
      publicAsset: s[3],
      inputNullifiers: [s[4], s[5]],
      outputCommitments: [s[6], s[7]],
    };
  };
}

/** Hosted circuit artifacts. */
/**
 * Where the circuit files are served: a free CDN (jsDelivr, pinned to the commit that last changed them, so the files
 * never change), then Cloak's own site if the CDN can't be reached. Every download is checked against the pinned
 * hashes, so where it came from doesn't matter for safety.
 */
export const CIRCUITS_CDN = "https://cdn.jsdelivr.net/gh/NECOKIZZ/Cloak@f55a12a40d475561ce2b4db933ab82855419eb2d/apps/web/public/circuits";
export const CIRCUITS_URL = "https://cloak.boblabs.tech/circuits";
export const CIRCUITS_SOURCES = [CIRCUITS_CDN, CIRCUITS_URL];

/** Download a circuit's two files from the first source that serves them with the expected hashes. */
async function fetchCircuit(baseUrl: string | string[], names: [string, string], want: { wasm: string; zkey: string } | null, what: string): Promise<[Uint8Array, Uint8Array]> {
  const bases = (Array.isArray(baseUrl) ? baseUrl : [baseUrl]).map((b) => b.replace(/\/$/, ""));
  let last: unknown;
  for (const base of bases) {
    try {
      const get = async (name: string) => {
        const res = await fetch(`${base}/${name}`);
        if (!res.ok) throw new Error(`could not download ${name} from ${base} (${res.status})`);
        return new Uint8Array(await res.arrayBuffer());
      };
      const [wasm, zkey] = await Promise.all(names.map(get));
      if (want) {
        const [hw, hz] = await Promise.all([sha256(wasm), sha256(zkey)]);
        if (hw !== want.wasm || hz !== want.zkey) throw new Error(`${what} files from ${base} don't match this SDK version's hashes; refusing to prove with them`);
      }
      return [wasm, zkey];
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

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
 * Fetch the circuit artifacts (15 MB, once; from the CDN, else Cloak's site, or the URL or URLs you pass) and build a prover. Works in browsers and Node 18+. The files are checked
 * against `CIRCUIT_HASHES`, so a tampered or mismatched download is refused; pass `hashes: null` to skip that when
 * serving your own build. In Node you can also read the files yourself and call `createProver`.
 */
export async function loadProver(baseUrl: string | string[] = CIRCUITS_SOURCES, opts: { hashes?: { wasm: string; zkey: string } | null } = {}): Promise<Prover> {
  const want = opts.hashes === undefined ? CIRCUIT_HASHES : opts.hashes;
  const [wasm, zkey] = await fetchCircuit(baseUrl, ["transaction2x2.wasm", "transaction2x2_final.zkey"], want, "circuit");
  return createProver(wasm, zkey);
}

/** SHA-256 of the shared-vault circuit artifacts this SDK version was built and tested against. */
export const SHARED_CIRCUIT_HASHES = {
  wasm: "55712f66e67fd9345daac5c881c2e73c546864dbd1e23481463b603b47aa53ed",
  zkey: "86ecee336f022ac1d2dbcc4db7e85ef838aee34c4d75fe8bc7446db86f3b97b3",
} as const;

/**
 * Fetch the shared launch-token vault's circuit (`transactionMA2x2`, 15 MB, once) and build its prover. Checked against
 * `SHARED_CIRCUIT_HASHES` like `loadProver`; pass `hashes: null` to skip that when serving your own build.
 */
export async function loadSharedProver(baseUrl: string | string[] = CIRCUITS_SOURCES, opts: { hashes?: { wasm: string; zkey: string } | null } = {}): Promise<Prover> {
  const want = opts.hashes === undefined ? SHARED_CIRCUIT_HASHES : opts.hashes;
  const [wasm, zkey] = await fetchCircuit(baseUrl, ["transactionMA2x2.wasm", "transactionMA2x2_final.zkey"], want, "shared-vault circuit");
  return createSharedProver(wasm, zkey);
}
