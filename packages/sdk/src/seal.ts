import { timelockDecrypt, timelockEncrypt, mainnetClient, roundAt, defaultChainInfo, Buffer } from "tlock-js";
import type { Address, Hex } from "viem";
import { bytesToString, stringToHex, hexToString } from "viem";

/** What a sealed bid hides until its drand round: everything needed to call `reveal`. */
export interface BidPreimage {
  auction: Address;
  bidder: Address;
  tick: number;
  quantity: bigint;
  salt: Hex;
  /** Answers to the drop's bid fields (an X username, say), sealed with the bid and readable once it opens. */
  fields?: Record<string, string>;
}

let client: ReturnType<typeof mainnetClient> | undefined;
const drand = () => (client ??= mainnetClient()); // drand quicknet, 3 s rounds

/** First drand quicknet round that is published at or after `unixSeconds`. */
export function drandRoundAt(unixSeconds: number): number {
  return roundAt(unixSeconds * 1000, defaultChainInfo) + 1;
}

/** Unix time (seconds) at which a drand quicknet round is published. */
export function drandRoundTime(round: number): number {
  return defaultChainInfo.genesis_time + (round - 1) * defaultChainInfo.period;
}

/** Encrypt a bid preimage to a future drand round. Nobody — sequencer, DA committee, us — can open it early. */
export async function sealBid(p: BidPreimage, round: number): Promise<Hex> {
  // `x` (the bid fields) is an extra key: readers that only know v1's keys ignore it
  const json = JSON.stringify({ v: 1, a: p.auction, b: p.bidder, t: p.tick, q: p.quantity.toString(), s: p.salt, ...(p.fields && Object.keys(p.fields).length ? { x: p.fields } : {}) });
  const armored = await timelockEncrypt(round, Buffer.from(json), drand());
  return stringToHex(armored);
}

// tlock-js logs every beacon it fetches; keep keeper output readable.
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  console.log = (...a: unknown[]) => {
    if (typeof a[0] === "string" && a[0].startsWith("beacon received")) return;
    log(...a);
  };
  try {
    return await fn();
  } finally {
    console.log = log;
  }
}

/** Decrypt a sealed bid once its round is out. Throws before that (the beacon has not released the key). */
export async function unsealBid(sealed: Hex): Promise<BidPreimage> {
  const plain = await quiet(() => timelockDecrypt(hexToString(sealed), drand()));
  const j = JSON.parse(bytesToString(new Uint8Array(plain)));
  if (j.v !== 1) throw new Error("unknown sealed bid version");
  const fields = j.x && typeof j.x === "object" ? Object.fromEntries(Object.entries(j.x).filter(([k, v]) => typeof k === "string" && typeof v === "string").map(([k, v]) => [k.slice(0, 40), (v as string).slice(0, 100)])) : undefined;
  return { auction: j.a, bidder: j.b, tick: Number(j.t), quantity: BigInt(j.q), salt: j.s, ...(fields ? { fields } : {}) };
}
