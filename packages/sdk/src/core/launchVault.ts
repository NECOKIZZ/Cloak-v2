/**
 * Cloak's launch vault (CloakLaunchVault, contracts-gloam) from a GloamCore balance: private swaps that give the price
 * buffer back (CloakLaunchSwap), graduation into Gloam's vault (CloakGraduation), and the follow-ups both need.
 *
 * A follow-up needs the account's seed (it signs with the one-time key made from the spent note and makes the new
 * note), so the keeper can't do it. The app keeps a record per action and calls finishPending() on every open: a swap's
 * leftover comes back as a note, and a graduation leaves for Gloam's vault once its round ends (or back into the launch
 * vault if Gloam's vault refuses it). Records hold no secrets: the keys come back from the account seed.
 */
import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Status } from "../private/client.js";
import type { GloamCore } from "./gloam.js";
import { gloamFinishBid, type GloamBidRecord } from "./gloamBids.js";

const SPEND_SWAP = "(bytes proof, bytes32 root, bytes32 nullifier, address asset, uint256 amount)";
const DEPOSIT_SWAP = "(bytes proof, bytes32 commitment, address asset, uint256 amount)";
const SWAP_KEY = "(bytes32 nullifier, address assetIn, uint256 amountIn, bytes32 outCommitment, address assetOut, uint256 amountOut, bytes32 routeHash, address ownerKey, uint256 deadline)";
export const CLOAK_LAUNCH_SWAP_ABI = parseAbi([
  `function swap(${SPEND_SWAP} s, ${DEPOSIT_SWAP} d, bytes route, address ownerKey, uint256 deadline) returns (bytes32 id, uint256 leftover)`,
  `function rescue(${SWAP_KEY} k) returns (uint256)`,
  `function claim(bytes32 id, ${DEPOSIT_SWAP} d, bytes signature)`,
  "function exit(bytes32 id, address to, bytes signature)",
  `function escrowFor(${SWAP_KEY} k) view returns (address)`,
  `function idOf(${SWAP_KEY} k) pure returns (bytes32)`,
  "function owed(bytes32) view returns (address asset, address ownerKey, uint256 amount)",
  "function claimDigest(bytes32 id, bytes32 commitment) view returns (bytes32)",
  "function exitDigest(bytes32 id, address to) view returns (bytes32)",
]);

const SPEND_GRAD = "(bytes proof, bytes32 root, bytes32 nullifier, uint256 amount)";
const DEPOSIT_GRAD = "(bytes proof, bytes32 commitment)";
const ENTRY_KEY = "(bytes32 nullifier, address token, uint128 size, address ownerKey, address fallbackTo)";
export const CLOAK_GRADUATION_ABI = parseAbi([
  `function enter(${SPEND_GRAD} s, ${ENTRY_KEY} k) returns (bytes32)`,
  `function leave(${ENTRY_KEY} k, address toVault, ${DEPOSIT_GRAD} d, bytes signature)`,
  `function exitAfterTimeout(${ENTRY_KEY} k)`,
  `function escrowFor(${ENTRY_KEY} k) view returns (address)`,
  `function idOf(${ENTRY_KEY} k) pure returns (bytes32)`,
  "function entries(bytes32) view returns (address token, uint64 round, bool paid, uint128 net)",
  "function roundEntries(address, uint64) view returns (uint256)",
  "function roundSecs() view returns (uint256)",
  "function gloamVault() view returns (address)",
  "function launchVault() view returns (address)",
  "function isStandard(uint256) pure returns (bool)",
  "function claimDigest(bytes32 id, address toVault, bytes32 commitment) view returns (bytes32)",
]);

const ORDER_KEY = "(bytes32 nullifier, address token, bool buy, uint128 size, address ownerKey, address fallbackTo)";
export const CLOAK_GLOAM_BATCHER_ABI = parseAbi([
  `function claim(${ORDER_KEY} k, ${DEPOSIT_SWAP} d, bytes signature)`,
  `function claimMany(${ORDER_KEY} k, ${DEPOSIT_SWAP}[] ds, bytes signature)`,
  "function claimManyDigest(bytes32 id, bytes32[] commitments) view returns (bytes32)",
  `function idOf(${ORDER_KEY} k) pure returns (bytes32)`,
  "function owed(bytes32) view returns (address asset, uint256 amount)",
  "function orders(bytes32) view returns (address token, uint64 round, bool buy, bool paid, uint128 net)",
  "function claimDigest(bytes32 id, bytes32 commitment) view returns (bytes32)",
]);

// built from strings, so viem can't type the calls: untyped handles, checked by the e2e runs
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const SWAP = CLOAK_LAUNCH_SWAP_ABI as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const GRAD = CLOAK_GRADUATION_ABI as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const BATCHER = CLOAK_GLOAM_BATCHER_ABI as any;

export interface LaunchSwapKey {
  nullifier: Hex;
  assetIn: Address;
  amountIn: bigint;
  outCommitment: Hex;
  assetOut: Address;
  amountOut: bigint;
  routeHash: Hex;
  ownerKey: Address;
  deadline: bigint;
}

export interface GraduationKey {
  nullifier: Hex;
  token: Address;
  size: bigint;
  ownerKey: Address;
  fallbackTo: Address;
}

/** What the app keeps per action until finishPending() reports it done. */
/** A batch order's key (CloakGloamBatcherBase.OrderKey). */
export interface BatchOrderKey {
  nullifier: Hex;
  token: Address;
  buy: boolean;
  size: bigint;
  ownerKey: Address;
  fallbackTo: Address;
}

export type LaunchRecord =
  | { kind: "batchOrder"; batcher: Address; id: Hex; key: BatchOrderKey; round: bigint; txHash: Hex }
  | { kind: "launchSwap"; router: Address; id: Hex; key: LaunchSwapKey; txHash: Hex }
  | { kind: "graduation"; graduation: Address; id: Hex; key: GraduationKey; txHash: Hex }
  | ({ kind: "bid" } & GloamBidRecord);

/** A Uniswap v4 route as CloakLaunchSwapV4 reads it: abi.encode(PoolKey[]), pools from the input to the output. */
export function launchRouteV4(keys: readonly { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }[]): Hex {
  return encodeAbiParameters(
    [{ type: "tuple[]", components: [{ name: "currency0", type: "address" }, { name: "currency1", type: "address" }, { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" }] }],
    [keys.map((k) => ({ currency0: k.currency0, currency1: k.currency1, fee: k.fee, tickSpacing: k.tickSpacing, hooks: k.hooks }))],
  );
}

/** A Uniswap V2 path as the launch swap router reads it: abi.encode(address[]), WHYPE for HYPE. */
export function launchRoute(path: Address[]): Hex {
  return encodeAbiParameters([{ type: "address[]" }], [path]);
}

/**
 * Posts a new note's sealed self-ticket once the note is in a vault (relays refuse memos for notes not there yet). A
 * failed memo doesn't undo the deposit: this device already tracks the note, and only other devices would miss it.
 */
/** @internal */
export async function announce(core: GloamCore, commitment: Hex, ticket: string, onStatus: Status): Promise<Hex | null> {
  // best effort, and kept for a retry on the next sync if it doesn't go out
  return core.postSafe(BigInt(commitment), [ticket], onStatus);
}

const signer = (core: GloamCore, nullifier: Hex) => privateKeyToAccount(core.exitKeyFor(nullifier));

/**
 * Spend exactly `amountIn` of `assetIn` from the launch vault for exactly `amountOut` of `assetOut`. The price buffer
 * (what the swap didn't need, less the vault's fee) stays owed to this swap, and finishPending() takes it back as a note.
 */
export async function launchSwap(
  core: GloamCore,
  p: { router: Address; route: Hex; assetIn: Address; amountIn: bigint; assetOut: Address; amountOut: bigint; deadline: bigint },
  onStatus: Status = () => {},
  /** called with the record before the swap is sent, so its buffer is never forgotten if the answer is lost */
  onRecord: (r: LaunchRecord) => void = () => {},
): Promise<LaunchRecord> {
  const pub = core.config.publicClient;
  const note = await core.exactNote(p.assetIn, p.amountIn, onStatus);
  onStatus("Proving the new note");
  const out = await core.depositFor(p.assetOut, p.amountOut);
  const nullifier = toHex(note.nullifier, { size: 32 });
  const key: LaunchSwapKey = {
    nullifier,
    assetIn: p.assetIn,
    amountIn: p.amountIn,
    outCommitment: out.deposit.commitment,
    assetOut: p.assetOut,
    amountOut: p.amountOut,
    routeHash: keccak256(p.route),
    ownerKey: signer(core, nullifier).address,
    deadline: p.deadline,
  };
  const escrow = (await pub.readContract({ address: p.router, abi: SWAP, functionName: "escrowFor", args: [key] })) as Address;
  const id = (await pub.readContract({ address: p.router, abi: SWAP, functionName: "idOf", args: [key] })) as Hex;
  const s = await core.spendProof(note, escrow, onStatus);
  onRecord({ kind: "launchSwap", router: p.router, id, key, txHash: "0x" });
  onStatus("Swapping");
  let txHash: Hex = "0x";
  try {
    txHash = await core.config.submit({ kind: "escrow", to: p.router, data: encodeFunctionData({ abi: SWAP, functionName: "swap", args: [s, out.deposit, p.route, key.ownerKey, p.deadline] }) });
  } catch (e) {
    if (!(await core.landedAnyway(note.nullifier))) throw e;
    onStatus("It went through, though the relay's answer was lost");
  }
  // the memo lets the account's other devices find the note; relays take it only once the note is in the vault
  await announce(core, out.deposit.commitment, out.ticket, onStatus);
  return { kind: "launchSwap", router: p.router, id, key, txHash };
}

/**
 * Enter a graduation round: one note of a standard size (1, 2 or 5 x 10^n) of a launch token leaves the launch vault.
 * finishPending() moves it into Gloam's vault once the round ends. `fallbackTo` gets it in the clear if nobody finishes
 * it within 30 days of the round.
 */
export async function graduate(
  core: GloamCore,
  p: { graduation: Address; token: Address; size: bigint; fallbackTo: Address },
  onStatus: Status = () => {},
): Promise<LaunchRecord> {
  const pub = core.config.publicClient;
  if (!(await pub.readContract({ address: p.graduation, abi: GRAD, functionName: "isStandard", args: [p.size] }))) throw new Error("Graduation moves standard sizes only (1, 2 or 5 times a power of ten).");
  const note = await core.exactNote(p.token, p.size, onStatus);
  const nullifier = toHex(note.nullifier, { size: 32 });
  const key: GraduationKey = { nullifier, token: p.token, size: p.size, ownerKey: signer(core, nullifier).address, fallbackTo: p.fallbackTo };
  const escrow = (await pub.readContract({ address: p.graduation, abi: GRAD, functionName: "escrowFor", args: [key] })) as Address;
  const id = (await pub.readContract({ address: p.graduation, abi: GRAD, functionName: "idOf", args: [key] })) as Hex;
  const s = await core.spendProof(note, escrow, onStatus);
  onStatus("Entering the graduation round");
  const txHash = await core.config.submit({ kind: "escrow", to: p.graduation, data: encodeFunctionData({ abi: GRAD, functionName: "enter", args: [{ proof: s.proof, root: s.root, nullifier: s.nullifier, amount: s.amount }, key] }) });
  return { kind: "graduation", graduation: p.graduation, id, key, txHash };
}

export interface PendingResult {
  /** Still waiting (a round not over, a swap not landed): keep them. */
  waiting: LaunchRecord[];
  /** Finished, with what happened. */
  done: { record: LaunchRecord; outcome: string; txHashes: Hex[] }[];
  /** Tried and failed this time (kept in `waiting` too), with why. */
  errors: { record: LaunchRecord; error: string }[];
}

/**
 * Run on every app open: finishes every record that can be finished now. Never throws for one record: a failure is
 * reported and the record stays waiting.
 * @param opts.minRoundEntries wait for at least this many entries in a graduation round before leaving it, while the
 *        round is younger than `crowdWaitSecs` (default 3 entries, 1 day), so a lone entry isn't easy to follow
 */
export async function finishPending(
  core: GloamCore,
  records: LaunchRecord[],
  opts: { minRoundEntries?: bigint; crowdWaitSecs?: bigint; now?: bigint } = {},
  onStatus: Status = () => {},
): Promise<PendingResult> {
  const pub = core.config.publicClient;
  const now = opts.now ?? (await pub.getBlock()).timestamp;
  const out: PendingResult = { waiting: [], done: [], errors: [] };
  for (const r of records) {
    try {
      const res =
        r.kind === "launchSwap"
          ? await finishSwap(core, r, now, onStatus)
          : r.kind === "bid"
            ? await finishBid(core, r, onStatus)
            : r.kind === "batchOrder"
              ? await finishBatchOrder(core, r, onStatus)
              : await finishGraduation(core, r, now, opts, onStatus);
      if (res) out.done.push({ record: r, ...res });
      else out.waiting.push(r);
    } catch (e) {
      out.errors.push({ record: r, error: (e as { shortMessage?: string; message?: string }).shortMessage ?? (e as Error).message });
      out.waiting.push(r);
    }
  }
  return out;
}

async function finishSwap(core: GloamCore, r: Extract<LaunchRecord, { kind: "launchSwap" }>, now: bigint, onStatus: Status) {
  const pub = core.config.publicClient;
  let [asset, , amount] = (await pub.readContract({ address: r.router, abi: SWAP, functionName: "owed", args: [r.id] })) as [Address, Address, bigint];
  const txHashes: Hex[] = [];
  if (amount === 0n) {
    const escrow = (await pub.readContract({ address: r.router, abi: SWAP, functionName: "escrowFor", args: [r.key] })) as Address;
    const opened = ((await pub.getCode({ address: escrow })) ?? "0x") !== "0x";
    if (opened) return { outcome: "swapped, no leftover", txHashes };
    const spent = (await pub.readContract({ address: core.config.pool, abi: parseAbi(["function isSpent(bytes32) view returns (bool)"]), functionName: "isSpent", args: [r.key.nullifier] })) as boolean;
    if (!spent) return now > r.key.deadline ? { outcome: "expired, the note never left the vault", txHashes } : null;
    if (now <= r.key.deadline) return null; // the spend landed alone: the swap may still be sent again
    onStatus("Rescuing a swap that didn't finish");
    txHashes.push(await core.config.submit({ kind: "escrow", to: r.router, data: encodeFunctionData({ abi: SWAP, functionName: "rescue", args: [r.key] }) }));
    [asset, , amount] = (await pub.readContract({ address: r.router, abi: SWAP, functionName: "owed", args: [r.id] })) as [Address, Address, bigint];
    if (amount === 0n) return null;
  }
  onStatus("Taking back the swap's leftover");
  const m = await core.depositFor(asset, amount);
  const digest = (await pub.readContract({ address: r.router, abi: SWAP, functionName: "claimDigest", args: [r.id, m.deposit.commitment] })) as Hex;
  const signature = await signer(core, r.key.nullifier).sign({ hash: digest });
  txHashes.push(await core.config.submit({ kind: "escrow", to: r.router, data: encodeFunctionData({ abi: SWAP, functionName: "claim", args: [r.id, m.deposit, signature] }) }));
  core.track({ commitment: m.note.commitment, asset, amount, secret: m.note.secret });
  const memo = await announce(core, m.deposit.commitment, m.ticket, onStatus);
  if (memo) txHashes.push(memo);
  return { outcome: `leftover of ${amount} back as a note`, txHashes };
}

/**
 * A batch order's payout (or its input back, if the round was cancelled) into the launch vault as one note of exactly
 * what it is owed. Waits while the round is open. An order never placed (the spend didn't land) is dropped once its
 * note is still unspent and the round is over.
 */
async function finishBatchOrder(core: GloamCore, r: Extract<LaunchRecord, { kind: "batchOrder" }>, onStatus: Status) {
  const pub = core.config.publicClient;
  const [token, round, , paid] = (await pub.readContract({ address: r.batcher, abi: BATCHER, functionName: "orders", args: [r.id] })) as [Address, bigint, boolean, boolean, bigint];
  if (paid) return { outcome: "already paid", txHashes: [] as Hex[] };
  if (round === 0n && token === "0x0000000000000000000000000000000000000000") {
    const spent = (await pub.readContract({ address: core.config.pool, abi: parseAbi(["function isSpent(bytes32) view returns (bool)"]), functionName: "isSpent", args: [r.key.nullifier] })) as boolean;
    return spent ? null : { outcome: "never placed, the note stayed in the balance", txHashes: [] as Hex[] };
  }
  const [asset, amount] = (await pub.readContract({ address: r.batcher, abi: BATCHER, functionName: "owed", args: [r.id] })) as [Address, bigint];
  if (amount === 0n) return null; // the round hasn't settled (or been cancelled) yet
  onStatus("Bringing a batch order's payout into your private balance");
  // a payout over the vault's per-deposit cap comes back as several notes (claimMany)
  const [perDeposit] = (await pub.readContract({ address: core.config.pool, abi: parseAbi(["function depositLimit(address) view returns (uint128 perDeposit, uint128 total)"]), functionName: "depositLimit", args: [asset] }).catch(() => [0n, 0n])) as [bigint, bigint];
  if (perDeposit > 0n && amount > perDeposit) {
    const parts: bigint[] = [];
    for (let left = amount; left > 0n; left -= left < perDeposit ? left : perDeposit) parts.push(left < perDeposit ? left : perDeposit);
    const made = [];
    for (const part of parts) made.push(await core.depositFor(asset, part));
    const digest = (await pub.readContract({ address: r.batcher, abi: BATCHER, functionName: "claimManyDigest", args: [r.id, made.map((x) => x.deposit.commitment)] })) as Hex;
    const signature = await signer(core, r.key.nullifier).sign({ hash: digest });
    const txHashes: Hex[] = [await core.config.submit({ kind: "escrow", to: r.batcher, data: encodeFunctionData({ abi: BATCHER, functionName: "claimMany", args: [r.key, made.map((x) => x.deposit), signature] }) })];
    for (const x of made) {
      const memo = await announce(core, x.deposit.commitment, x.ticket, onStatus);
      if (memo) txHashes.push(memo);
    }
    return { outcome: `batch payout of ${amount} back as ${parts.length} notes`, txHashes };
  }
  const m = await core.depositFor(asset, amount);
  const digest = (await pub.readContract({ address: r.batcher, abi: BATCHER, functionName: "claimDigest", args: [r.id, m.deposit.commitment] })) as Hex;
  const signature = await signer(core, r.key.nullifier).sign({ hash: digest });
  const txHashes: Hex[] = [await core.config.submit({ kind: "escrow", to: r.batcher, data: encodeFunctionData({ abi: BATCHER, functionName: "claim", args: [r.key, m.deposit, signature] }) })];
  core.track({ commitment: m.note.commitment, asset, amount, secret: m.note.secret });
  const memo = await announce(core, m.deposit.commitment, m.ticket, onStatus);
  if (memo) txHashes.push(memo);
  return { outcome: `batch payout of ${amount} back as a note`, txHashes };
}

async function finishGraduation(
  core: GloamCore,
  r: Extract<LaunchRecord, { kind: "graduation" }>,
  now: bigint,
  opts: { minRoundEntries?: bigint; crowdWaitSecs?: bigint },
  onStatus: Status,
) {
  const pub = core.config.publicClient;
  const [token, round, paid, net] = (await pub.readContract({ address: r.graduation, abi: GRAD, functionName: "entries", args: [r.id] })) as [Address, bigint, boolean, bigint];
  if (round === 0n) return null; // not entered (yet)
  if (paid) return { outcome: "already left", txHashes: [] as Hex[] };
  const roundSecs = (await pub.readContract({ address: r.graduation, abi: GRAD, functionName: "roundSecs", args: [] })) as bigint;
  const ends = (round + 1n) * roundSecs;
  if (now < ends) return null;
  const crowd = (await pub.readContract({ address: r.graduation, abi: GRAD, functionName: "roundEntries", args: [token, round] })) as bigint;
  if (crowd < (opts.minRoundEntries ?? 3n) && now < ends + (opts.crowdWaitSecs ?? 86_400n)) return null;

  const gloamVault = (await pub.readContract({ address: r.graduation, abi: GRAD, functionName: "gloamVault", args: [] })) as Address;
  const launchVault = (await pub.readContract({ address: r.graduation, abi: GRAD, functionName: "launchVault", args: [] })) as Address;
  const m = await core.depositFor(token, net);
  const txHashes: Hex[] = [];
  const call = async (toVault: Address) => {
    const digest = (await pub.readContract({ address: r.graduation, abi: GRAD, functionName: "claimDigest", args: [r.id, toVault, m.deposit.commitment] })) as Hex;
    const signature = await signer(core, r.key.nullifier).sign({ hash: digest });
    return core.config.submit({ kind: "escrow", to: r.graduation, data: encodeFunctionData({ abi: GRAD, functionName: "leave", args: [r.key, toVault, { proof: m.deposit.proof, commitment: m.deposit.commitment }, signature] }) });
  };
  onStatus("Moving into Gloam's vault");
  try {
    txHashes.push(await call(gloamVault));
    const memo = await announce(core, m.deposit.commitment, m.ticket, onStatus);
    if (memo) txHashes.push(memo);
    return { outcome: `${net} moved into Gloam's vault`, txHashes };
  } catch {
    // Gloam hasn't listed the token, or its cap is full: back into the launch vault, never stuck
    onStatus("Gloam's vault can't take it yet, back into the launch vault");
    txHashes.push(await call(launchVault));
    core.track({ commitment: m.note.commitment, asset: token, amount: net, secret: m.note.secret });
    const memo = await announce(core, m.deposit.commitment, m.ticket, onStatus);
    if (memo) txHashes.push(memo);
    return { outcome: `${net} back in the launch vault (Gloam's vault refused it)`, txHashes };
  }
}

/** After its launch settles: the bid's won tokens and refund back into the vault as notes (the auction claim included). */
async function finishBid(core: GloamCore, r: Extract<LaunchRecord, { kind: "bid" }>, onStatus: Status) {
  const pub = core.config.publicClient;
  const A = parseAbi([
    "function settled() view returns (bool)",
    "function failed() view returns (bool)",
    "function allocationOf(uint256) view returns (uint256 tokens, uint256 refund)",
    "function token() view returns (address)",
    "function getBid(uint256) view returns ((address bidder, bytes32 commitment, uint128 quantity, uint64 tick, bool revealed, bool claimed, uint256 deposit))",
  ]);
  const B = parseAbi(["function bidIdPlus1(address) view returns (uint256)", "function closed(address) view returns (bool)"]);
  if (await pub.readContract({ address: r.bids, abi: B, functionName: "closed", args: [r.account] }).catch(() => false)) return { outcome: "already back in the private balance", txHashes: [] as Hex[] };
  const idPlus1 = await pub.readContract({ address: r.bids, abi: B, functionName: "bidIdPlus1", args: [r.account] });
  if (idPlus1 === 0n) return null; // not placed (yet)
  if (!(await pub.readContract({ address: r.key.auction, abi: A, functionName: "settled" }))) return null;
  const [tokens, refund] = await pub.readContract({ address: r.key.auction, abi: A, functionName: "allocationOf", args: [idPlus1 - 1n] });
  const token = await pub.readContract({ address: r.key.auction, abi: A, functionName: "token" });
  onStatus("Bringing the bid back into your private balance");
  // a refund too small to be worth a note (rounding dust) stays in the bid account, where an exit can still take it:
  // a note for it would only add a piece to the balance
  const DUST = 10n ** 12n;
  const back = [{ asset: token, amount: tokens }, { asset: "0x0000000000000000000000000000000000000000" as Address, amount: refund >= DUST ? refund : 0n }];
  const txHashes = await gloamFinishBid(core, r, back, onStatus);
  return { outcome: `${tokens} tokens and ${back[1].amount} wei of HYPE back as notes${refund > back[1].amount ? ` (${refund} wei of dust left in the bid account)` : ""}`, txHashes };
}
