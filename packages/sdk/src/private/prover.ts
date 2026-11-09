// Circuit files: downloaded from the first source that serves them, checked against their SHA-256.

/** A raw snarkjs Groth16 proof, as `snarkjs.groth16.verify` takes it. */
export interface RawGroth16 {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
  protocol?: string;
  curve?: string;
}
/** Download a circuit's two files from the first source that serves them with the expected hashes. */
/** @internal Downloads two circuit files from the first source that answers, checked against their SHA-256. */
export async function fetchCircuit(baseUrl: string | string[], names: [string, string], want: { wasm: string; zkey: string } | null, what: string): Promise<[Uint8Array, Uint8Array]> {
  const bases = (Array.isArray(baseUrl) ? baseUrl : [baseUrl]).map((b) => b.replace(/\/$/, ""));
  let last: unknown;
  for (const base of bases) {
    try {
      const get = async (name: string) => {
        // a local directory (Node: file:///path), for tools and tests that have the files on disk
        if (base.startsWith("file://")) {
          const spec = "node:fs/promises";
          const fs = (await import(/* @vite-ignore */ spec)) as { readFile(p: string): Promise<Uint8Array> };
          return new Uint8Array(await fs.readFile(`${base.slice("file://".length)}/${name}`));
        }
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

async function sha256(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}
