/**
 * Sealed bids on Cloak launches from a GloamCore balance, through CloakGloamBids (contracts-gloam): the note goes to a
 * one-time bid account the auction sees as the bidder, and the tokens and refund come back as notes after settlement.
 */
import { encodeFunctionData, parseAbi, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { randomBytes } from "@noble/hashes/utils";
import { commitmentOf } from "../cloak.js";
import { sealBid } from "../seal.js";
import type { Status } from "../private/common.js";
import type { GloamCore } from "./gloam.js";

const SPEND = "(bytes proof, bytes32 root, bytes32 nullifier, address asset, uint256 amount)";
const DEPOSIT = "(bytes proof, bytes32 commitment, address asset, uint256 amount)";
const KEY = "(bytes32 nullifier, uint256 amount, address auction, address ownerKey, address fallbackTo, uint256 exitAfter)";
export const CLOAK_GLOAM_BIDS_ABI = parseAbi([
  `function place(${SPEND} s, ${KEY} k, bytes bidCall, bytes signature) returns (uint256)`,
  `function ownerCall(${KEY} k, address target, uint256 value, bytes data, bytes signature) returns (bytes)`,
  "function callDigest(address account, address target, uint256 value, bytes data, uint256 nonce) view returns (bytes32)",
  "function callNonce(address) view returns (uint256)",
  `function finish(${KEY} k, ${DEPOSIT}[] ds, bytes signature)`,
  `function exit(${KEY} k, address to, address[] tokens, bytes signature)`,
  `function exitAfterTimeout(${KEY} k, address[] tokens)`,
  `function accountFor(${KEY} k) view returns (address)`,
  "function placeDigest(address account, bytes bidCall) view returns (bytes32)",
  `function finishDigest(address account, ${DEPOSIT}[] ds) view returns (bytes32)`,
  "function exitDigest(address account, address to) view returns (bytes32)",
  "function bidIdPlus1(address) view returns (uint256)",
  "event BidPlaced(address indexed account, address indexed auction, uint256 bidId, uint256 deposit)",
]);

// The signatures are built from strings, so viem can't type the calls: an untyped handle, checked by the e2e runs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const BIDS = CLOAK_GLOAM_BIDS_ABI as any;

const COMMITS = parseAbi(["function commit(bytes32 commitment, bytes sealedBid) payable returns (uint256)", "function commit(bytes32 commitment, bytes sealedBid, bool wl, bytes32[] wlProof) payable returns (uint256)"]);

/** CloakAuction.commit(commitment, sealedBid). */
export const launchBidCall = (commitment: Hex, sealedBid: Hex): Hex => encodeFunctionData({ abi: [COMMITS[0]], functionName: "commit", args: [commitment, sealedBid] });
/** CloakDrop.commit(commitment, sealedBid, false, []): a public bid (a WL bid must come from the listed wallet). */
export const dropBidCall = (commitment: Hex, sealedBid: Hex): Hex => encodeFunctionData({ abi: [COMMITS[1]], functionName: "commit", args: [commitment, sealedBid, false, []] });

export interface GloamBidKey {
  nullifier: Hex;
  amount: bigint;
  auction: Address;
  ownerKey: Address;
  fallbackTo: Address;
  exitAfter: bigint;
}

/** What the bidder keeps to finish (or exit) the bid later. Rebuildable from the account seed and the note. */
export interface GloamBidRecord {
  bids: Address;
  key: GloamBidKey;
  account: Address;
  tick: number;
  quantity: bigint;
  salt: Hex;
  txHash: Hex;
}

/**
 * Spend `amount` of private HYPE into a sealed bid. The deposit the auction records is what arrives (the note less the
 * vault's cash-out fee), so `amount` must cover the bid's cost after that fee.
 */
export async function gloamBid(
  core: GloamCore,
  p: {
    bids: Address;
    auction: Address;
    tick: number;
    quantity: bigint;
    tlockRound: number;
    amount: bigint;
    fallbackTo: Address;
    exitAfter: bigint;
    /** Builds the auction call from the commitment and sealed bid. Default: CloakAuction.commit. Drops: dropBidCall. */
    bidCall?: (commitment: Hex, sealedBid: Hex) => Hex;
  },
  onStatus: Status = () => {},
): Promise<GloamBidRecord> {
  const pub = core.config.publicClient;
  const note = await core.exactNote("0x0000000000000000000000000000000000000000", p.amount, onStatus);
  const nullifier = toHex(note.nullifier, { size: 32 });
  const ownerPk = core.exitKeyFor(nullifier);
  const key: GloamBidKey = { nullifier, amount: p.amount, auction: p.auction, ownerKey: privateKeyToAccount(ownerPk).address, fallbackTo: p.fallbackTo, exitAfter: p.exitAfter };
  const account: Address = (await pub.readContract({ address: p.bids, abi: BIDS, functionName: "accountFor", args: [key] })) as Address;
  const salt = toHex(randomBytes(32));
  const commitment = commitmentOf(p.auction, account, p.tick, p.quantity, salt);
  onStatus("Sealing the bid");
  const sealed = await sealBid({ auction: p.auction, bidder: account, tick: p.tick, quantity: p.quantity, salt }, p.tlockRound);
  const s = await core.spendProof(note, account, onStatus);
  const bidCall = (p.bidCall ?? launchBidCall)(commitment, sealed);
  const digest: Hex = (await pub.readContract({ address: p.bids, abi: BIDS, functionName: "placeDigest", args: [account, bidCall] })) as Hex;
  const signature = await privateKeyToAccount(ownerPk).sign({ hash: digest });
  onStatus("Placing the bid");
  const txHash = await core.config.submit({ kind: "escrow", to: p.bids, data: encodeFunctionData({ abi: BIDS, functionName: "place", args: [s, key, bidCall, signature] }) });
  return { bids: p.bids, key, account, tick: p.tick, quantity: p.quantity, salt, txHash };
}

/**
 * After settlement: put the bid's tokens and refund back as new notes of this account: tokens into the launch vault
 * (`core`), the HYPE refund into `hypeCore`'s vault (Gloam's, on a bids contract built for it; else the launch vault).
 */
export async function gloamFinishBid(core: GloamCore, rec: GloamBidRecord, back: { asset: Address; amount: bigint }[], onStatus: Status = () => {}, hypeCore: GloamCore = core): Promise<Hex[]> {
  const pub = core.config.publicClient;
  onStatus("Proving the returning notes");
  const made = [];
  const coreFor = (asset: Address) => (asset === "0x0000000000000000000000000000000000000000" ? hypeCore : core);
  const LIMIT = [{ type: "function", name: "depositLimit", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint128" }, { type: "uint128" }] }] as const;
  for (const b of back.filter((x) => x.amount > 0n)) {
    // over the vault's per-deposit cap (Gloam's vault takes 12 HYPE at a time for now): several notes, each under it
    const c = coreFor(b.asset);
    const [per] = await pub.readContract({ address: c.config.pool, abi: LIMIT, functionName: "depositLimit", args: [b.asset] }).catch(() => [0n, 0n] as const);
    for (let left = b.amount; left > 0n; ) {
      const part = per > 0n && left > per ? per : left;
      made.push({ ...(await c.depositFor(b.asset, part)), core: c });
      left -= part;
    }
  }
  const ds = made.map((m) => m.deposit);
  const digest: Hex = (await pub.readContract({ address: rec.bids, abi: BIDS, functionName: "finishDigest", args: [rec.account, ds] })) as Hex;
  const signature = await privateKeyToAccount(core.exitKeyFor(rec.key.nullifier)).sign({ hash: digest });
  onStatus("Returning the bid to the private balance");
  const tx = await core.config.submit({ kind: "escrow", to: rec.bids, data: encodeFunctionData({ abi: BIDS, functionName: "finish", args: [rec.key, ds, signature] }) });
  for (const m of made) m.core.track({ commitment: m.note.commitment, asset: m.note.asset, amount: m.note.amount, secret: m.note.secret });
  // after the deposit: relays take a memo only for a note already in the vault; one memo per vault's notes
  const out: Hex[] = [tx];
  for (const c of [...new Set(made.map((m) => m.core))]) {
    const mine = made.filter((m) => m.core === c);
    const memo = await c.post(BigInt(mine[0].deposit.commitment), mine.map((m) => m.ticket), onStatus).catch(() => null);
    if (memo) out.push(memo);
  }
  return out;
}

/** One owner-signed call from the bid account: a drop's NFTs out to a wallet, for instance. */
export async function gloamBidOwnerCall(core: GloamCore, rec: GloamBidRecord, call: { target: Address; value?: bigint; data: Hex }): Promise<Hex> {
  const pub = core.config.publicClient;
  const nonce = (await pub.readContract({ address: rec.bids, abi: BIDS, functionName: "callNonce", args: [rec.account] })) as bigint;
  const digest = (await pub.readContract({ address: rec.bids, abi: BIDS, functionName: "callDigest", args: [rec.account, call.target, call.value ?? 0n, call.data, nonce] })) as Hex;
  const signature = await privateKeyToAccount(core.exitKeyFor(rec.key.nullifier)).sign({ hash: digest });
  return core.config.submit({ kind: "escrow", to: rec.bids, data: encodeFunctionData({ abi: BIDS, functionName: "ownerCall", args: [rec.key, call.target, call.value ?? 0n, call.data, signature] }) });
}
