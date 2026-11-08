/**
 * Private swaps for GloamCore through Gloam's own escrow router (GloamVaultSwap2 family, e.g. GloamVaultSwapV4c on a
 * Uniswap v4 PoolManager such as Cloak's). One note goes out of the vault to a one-time escrow whose address binds
 * everything about the swap, the router buys exactly `amountOut` and deposits it as a new note of this account.
 *
 * Never stuck: if the spend lands without the swap (someone sends the unshield alone, or the swap reverts after it),
 * anyone can call the same swap again and the money goes back in as the refund note made in advance; if even that
 * can't land, the exit key signs the escrow out to a public address (`swapExit`).
 */
import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Status } from "../private/client.js";
import type { GloamCore } from "./gloam.js";

export interface V4PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

const SPEND = "(bytes proof, bytes32 root, bytes32 nullifier, address asset, uint256 amount)";
const DEPOSIT = "(bytes proof, bytes32 commitment, address asset, uint256 amount)";
const KEY = "(bytes32 nullifier, uint256 amountIn, bytes32 outCommitment, address assetOut, uint256 amountOut, bytes32 refundCommitment, uint256 refundAmount, bytes32 routeHash, address exitKey, uint256 deadline)";
export const GLOAM_SWAP_ROUTER_ABI = parseAbi([
  `function swap(${SPEND} s, ${DEPOSIT} d, ${DEPOSIT} r, bytes route, address exitKey, uint256 deadline) returns (uint256)`,
  `function escrowFor(address assetIn, ${KEY} k) view returns (address)`,
  `function exit(address assetIn, ${KEY} k, address to, bytes signature) returns (uint256)`,
  "function exitDigest(address escrow, address to) view returns (bytes32)",
  "event VaultSwap(bytes32 indexed nullifier, bytes32 indexed commitment, address indexed assetIn, address assetOut, uint256 amountIn, uint256 amountOut, uint256 leftover)",
  "event VaultSwapRefund(bytes32 indexed nullifier, bytes32 indexed commitment, address indexed asset, uint256 amount)",
]);

/** The vault's highest possible cash-out fee (MAX_WITHDRAW_FEE_BPS), so a refund note always fits what arrives. */
const MAX_FEE_BPS = 100n;

export function v4Route(hops: V4PoolKey[]): Hex {
  return encodeAbiParameters(
    [{ type: "tuple[]", components: [{ name: "currency0", type: "address" }, { name: "currency1", type: "address" }, { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" }] }],
    [hops],
  );
}

export interface PreparedSwap {
  router: Address;
  escrow: Address;
  s: { proof: Hex; root: Hex; nullifier: Hex; asset: Address; amount: bigint };
  d: { proof: Hex; commitment: Hex; asset: Address; amount: bigint };
  r: { proof: Hex; commitment: Hex; asset: Address; amount: bigint };
  route: Hex;
  exitKey: Address;
  exitPk: Hex;
  deadline: bigint;
  key: { nullifier: Hex; amountIn: bigint; outCommitment: Hex; assetOut: Address; amountOut: bigint; refundCommitment: Hex; refundAmount: bigint; routeHash: Hex; exitKey: Address; deadline: bigint };
  tickets: string[];
  track: Parameters<GloamCore["track"]>[0][];
}

/** Everything a swap needs, proved on this device; nothing sent yet. */
export async function prepareGloamSwap(
  core: GloamCore,
  p: { router: Address; route: Hex; assetIn: Address; amountIn: bigint; assetOut: Address; amountOut: bigint; deadline: bigint },
  onStatus: Status = () => {},
): Promise<PreparedSwap> {
  const note = await core.exactNote(p.assetIn, p.amountIn, onStatus);
  onStatus("Proving the new note and the refund note");
  const out = await core.depositFor(p.assetOut, p.amountOut);
  const refundAmount = p.amountIn - (p.amountIn * MAX_FEE_BPS + 9_999n) / 10_000n;
  const refund = await core.depositFor(p.assetIn, refundAmount);
  const nullifier = `0x${note.nullifier.toString(16).padStart(64, "0")}` as Hex;
  const exitPk = core.exitKeyFor(nullifier);
  const exitKey = privateKeyToAccount(exitPk).address;
  const key = {
    nullifier,
    amountIn: p.amountIn,
    outCommitment: out.deposit.commitment,
    assetOut: p.assetOut,
    amountOut: p.amountOut,
    refundCommitment: refund.deposit.commitment,
    refundAmount,
    routeHash: keccak256(p.route),
    exitKey,
    deadline: p.deadline,
  };
  const escrow = await core.config.publicClient.readContract({ address: p.router, abi: GLOAM_SWAP_ROUTER_ABI, functionName: "escrowFor", args: [p.assetIn, key] });
  const s = await core.spendProof(note, escrow, onStatus);
  return {
    router: p.router,
    escrow,
    s,
    d: out.deposit,
    r: refund.deposit,
    route: p.route,
    exitKey,
    exitPk,
    deadline: p.deadline,
    key,
    tickets: [out.ticket, refund.ticket],
    track: [
      { commitment: out.note.commitment, asset: p.assetOut, amount: p.amountOut, secret: out.note.secret },
      { commitment: refund.note.commitment, asset: p.assetIn, amount: refundAmount, secret: refund.note.secret },
    ],
  };
}

export function swapCalldata(x: PreparedSwap): Hex {
  return encodeFunctionData({ abi: GLOAM_SWAP_ROUTER_ABI, functionName: "swap", args: [x.s, x.d, x.r, x.route, x.exitKey, x.deadline] });
}

/** Prove and send a private swap. Returns the transactions (the swap, then the memo that lets other devices see the new note). */
export async function gloamSwap(core: GloamCore, p: Parameters<typeof prepareGloamSwap>[1], onStatus: Status = () => {}): Promise<{ txHashes: Hex[]; prepared: PreparedSwap }> {
  const x = await prepareGloamSwap(core, p, onStatus);
  onStatus("Swapping");
  const tx = await core.config.submit({ kind: "escrow", to: x.router, data: swapCalldata(x) });
  for (const t of x.track) core.track(t);
  // after the swap: relays (Gloam's and Cloak's) take a memo only for a note already in the vault. The out note or the
  // refund note landed, and the memo carries both tickets, keyed by whichever is in the vault.
  let memo: Hex | null = null;
  for (const c of [x.d.commitment, x.r.commitment]) {
    if (memo) break;
    try {
      memo = await core.post(BigInt(c), x.tickets, onStatus);
    } catch {
      /* try the other note */
    }
  }
  return { txHashes: memo ? [tx, memo] : [tx], prepared: x };
}

/** The way out when even the refund can't land: the exit key signs the escrow's money out to `to`, in the clear. */
export async function swapExitCalldata(core: GloamCore, x: PreparedSwap, to: Address): Promise<Hex> {
  const digest = await core.config.publicClient.readContract({ address: x.router, abi: GLOAM_SWAP_ROUTER_ABI, functionName: "exitDigest", args: [x.escrow, to] });
  const signature = await privateKeyToAccount(x.exitPk).sign({ hash: digest });
  return encodeFunctionData({ abi: GLOAM_SWAP_ROUTER_ABI, functionName: "exit", args: [x.s.asset, x.key, to, signature] });
}
