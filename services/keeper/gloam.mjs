// Gloam relay for the keeper (Cloak v2 on Gloam). Relays the calls GloamCore and Cloak's escrows make, so the user's
// wallet is never the sender: vault transfers and cash outs (Gloam's vault and Cloak's launch vault), memo posts, and
// calls to Cloak's escrows (launch swaps, graduation, bids, batch orders). It holds no secrets and can't change a call:
// every spend is fixed by its proof, every escrow action by its escrow key or owner signature.
//
// Gloam's proofs carry no relayer fee, so the relay pays gas from its own wallet. What keeps that from being drained:
//   - only known targets and selectors (each vault's transfer and unshield, the board's postMemo, the escrows), never
//     anything else;
//   - every call is simulated first: one that would revert is refused and costs nothing;
//   - one in-flight call per spend (by nullifier), and a spend already used on chain, or with a proof against a tree the
//     vault doesn't know, is refused before the gas estimate. Each spend's last send is kept a day: the spend isn't sent
//     again while that send could still land, and its lock goes only when nothing was sent or the send reverted;
//   - no cash out to the zero address, the token itself, a vault, the memo board or an escrow;
//   - failed sends count against their sender, capped (10% of the hour's budget each);
//   - memos only for a payment commitment already in a vault this relay serves, at most one per commitment, and bodies
//     capped at the board's own 8 KB;
//   - an hourly HYPE budget (GLOAM_RELAY_HOURLY_SPEND, default 1 HYPE, Gloam's own default), after which it answers 429,
//     shared the way Gloam's relay shares its own: new sends may use up to 80% of it and refunds and exits all of it,
//     so the top is always there for getting money out; one sender (an IP, as the keeper's HTTP layer passes it) gets
//     at most 60% for its sends and another 60% for its refunds and exits, so its own sends never block its refund;
//     memos have their own budget (8% of the hour's), so free memo posts can't use up what sends need;
//   - per-IP rate limits, in the keeper's HTTP layer (RELAY_PER_MIN).
//
// Paid from the launch vault's fee. When the relay's wallet is the launch vault's fee recipient, the relay collects the
// vault's HYPE fees (collectFees, anyone may call it, the destination is fixed) once they pass a threshold, and that
// income becomes extra budget for calls about Cloak's own contracts (the launch vault and Cloak's escrows). Calls to
// Gloam's vault use the base budget only. So the more Cloak's vault is used, the more relaying it pays for, and spam
// still can't spend more than what came in plus the base budget. Fees in launch tokens stay owed to the recipient.
//
//   POST /gloam/relay {kind, to, data} -> {txHash}
import { decodeFunctionData, parseAbi, parseEther, toFunctionSelector, zeroAddress } from "viem";

const VAULT_ABI = parseAbi([
  "function transfer(bytes proof, bytes32 root, bytes32 nullifier, bytes32[2] newCommitments)",
  "function unshield(bytes proof, bytes32 root, bytes32 nullifier, address asset, address to, uint256 amount)",
  "function isSpent(bytes32) view returns (bool)",
  "function isKnownRoot(bytes32) view returns (bool)",
  "function commitmentSeen(bytes32) view returns (bool)",
  "function feesOwed(address) view returns (uint256)",
  "function feeRecipient() view returns (address)",
  "function collectFees(address asset)",
]);
const MEMO_ABI = parseAbi(["function postMemo(bytes32 paymentCommitment, bytes memo)"]);
const MAX_MEMOS_REMEMBERED = 100_000;

// Budget shares, in percent of the hour's budget (Gloam's relay uses the same split). Settable per relay (`shares`).
const SHARES = { newSends: 80n, other: 92n, sender: 60n, back: 60n, memo: 8n, reverts: 10n };
const DAY_MS = 86_400_000;
/** Escrow calls that take money out or back (refunds, exits, claims): they may use the whole budget. */
const EXIT_SELECTORS = new Set(
  [
    // CloakGraduation
    "leave((bytes32,address,uint128,address,address),address,(bytes,bytes32),bytes)",
    "exitAfterTimeout((bytes32,address,uint128,address,address))",
    // CloakLaunchSwap
    "rescue((bytes32,address,uint256,bytes32,address,uint256,bytes32,address,uint256))",
    "claim(bytes32,(bytes,bytes32,address,uint256),bytes)",
    "exit(bytes32,address,bytes)",
    // CloakGloamBatcher
    "claim((bytes32,address,bool,uint128,address,address),(bytes,bytes32,address,uint256),bytes)",
    "exitAfterTimeout((bytes32,address,bool,uint128,address,address))",
    "cancel(address,uint64)",
    // CloakGloamBids
    "finish((bytes32,uint256,address,address,address,uint256),(bytes,bytes32,address,uint256)[],bytes)",
    "exit((bytes32,uint256,address,address,address,uint256),address,address[],bytes)",
    "exitAfterTimeout((bytes32,uint256,address,address,address,uint256),address[])",
    // Gloam's routers: a refund is a swap() on a spent note, so only the exit is recognised here
    "exit(address,(bytes32,uint256,bytes32,address,uint256,bytes32,uint256,bytes32,address,uint256),address,bytes)",
  ].map((sig) => toFunctionSelector(`function ${sig}`)),
);

/**
 * @param vault Gloam's vault (base budget only), or omit it
 * @param launchVault Cloak's launch vault (CloakLaunchVault), or omit it
 * @param escrows Cloak's escrow contracts (fee-backed budget). Each checks its own authorization, and the simulation
 *        keeps a failing call free, so any function on them is relayed
 * @param gloamEscrows Gloam's own routers (base budget only)
 * @param feeCollectWei collect the launch vault's HYPE fees once this much is owed (default 0.05 HYPE)
 * @param feeSpendPerHourWei the most fee income spent in one hour (default 1 HYPE), so a flood can't burn a week's income
 * @param shares percent of the hour's budget: new sends may reach (newSends, 80), one sender's sends (sender, 60), one
 *        sender's refunds and exits (back, 60), all memos (memo, 8, a budget of its own), one sender's failed sends
 *        (reverts, 10)
 * @param lockTtlMs how long a spend's lock outlives a send whose end is unknown (a day; tests shorten it)
 */
export function createGloamRelay({
  publicClient,
  walletClient,
  vault,
  launchVault,
  memoBoard,
  escrows = [],
  gloamEscrows = [],
  hourlySpendWei = parseEther(process.env.GLOAM_RELAY_HOURLY_SPEND ?? "1"),
  feeCollectWei = parseEther(process.env.GLOAM_RELAY_FEE_COLLECT ?? "0.05"),
  feeSpendPerHourWei = parseEther(process.env.GLOAM_RELAY_FEE_SPEND_PER_HOUR ?? "1"),
  shares = SHARES,
  lockTtlMs = DAY_MS,
  log = () => {},
}) {
  const { newSends: NEW_SEND_PCT, sender: SENDER_PCT, back: BACK_PCT, memo: MEMO_PCT, reverts: REVERT_PCT } = { ...SHARES, ...shares };
  const lc = (a) => a.toLowerCase();
  const targets = new Map();
  if (vault) targets.set(lc(vault), { role: "vault", cloak: false, address: vault });
  if (launchVault) targets.set(lc(launchVault), { role: "vault", cloak: true, address: launchVault });
  if (memoBoard) targets.set(lc(memoBoard), { role: "memo", cloak: false, address: memoBoard });
  for (const e of escrows) targets.set(lc(e), { role: "escrow", cloak: true, address: e });
  for (const e of gloamEscrows) targets.set(lc(e), { role: "escrow", cloak: false, address: e });
  const vaults = [...targets.values()].filter((t) => t.role === "vault");

  const inflight = new Map(); // spend -> when it was locked
  const sends = new Map(); // spend -> { hash, nonce, at }: the last send for it, kept a day
  let memoSpentWei = 0n; // the memo budget spent this hour
  const memoed = new Set();
  let windowStart = Date.now();
  let spentWei = 0n; // from the base budget this hour
  let feeSpentWei = 0n; // from fee income this hour
  let feeCreditWei = 0n; // fee income not spent yet
  let feeIncomeWei = 0n; // all fee income so far
  const bySender = new Map(); // sender -> { base, fee } spent this hour
  const fail = (status, message) => Object.assign(new Error(message), { status });

  const read = (address, functionName, args = []) => publicClient.readContract({ address, abi: VAULT_ABI, functionName, args });

  function roll() {
    if (Date.now() - windowStart > 3_600_000) {
      windowStart = Date.now();
      spentWei = 0n;
      feeSpentWei = 0n;
      bySender.clear();
      memoSpentWei = 0n;
    }
  }

  const feeRoom = () => {
    const capLeft = feeSpendPerHourWei > feeSpentWei ? feeSpendPerHourWei - feeSpentWei : 0n;
    return feeCreditWei < capLeft ? feeCreditWei : capLeft;
  };

  /** Collect the launch vault's HYPE fees into the relay's wallet, when the relay is the recipient. Returns what came in. */
  async function collectLaunchFees() {
    if (!launchVault) return 0n;
    const me = walletClient.account.address;
    if (lc(await read(launchVault, "feeRecipient")) !== lc(me)) return 0n;
    const owed = await read(launchVault, "feesOwed", [zeroAddress]);
    if (owed < feeCollectWei) return 0n;
    const hash = await walletClient.writeContract({ account: walletClient.account, chain: walletClient.chain, address: launchVault, abi: VAULT_ABI, functionName: "collectFees", args: [zeroAddress] });
    const r = await publicClient.waitForTransactionReceipt({ hash });
    if (r.status !== "success") return 0n;
    const gas = r.gasUsed * r.effectiveGasPrice;
    const net = owed > gas ? owed - gas : 0n;
    feeCreditWei += net;
    feeIncomeWei += net;
    log(`[gloam relay] collected ${owed} wei of launch vault fees (${net} after gas)`);
    return net;
  }

  /** new: a new send or entry; exit: money out or back; other: memos and the rest. */
  function classOf(t, decoded, data) {
    if (t.role === "vault") return decoded.functionName === "unshield" ? "exit" : "new";
    if (t.role === "memo") return "other";
    return EXIT_SELECTORS.has(data.slice(0, 10).toLowerCase()) ? "exit" : "new";
  }

  /**
   * @param body {to, data}
   * @param ctx.sender who asks (the keeper passes the caller's IP); unnamed callers share one allowance
   */
  async function relay(body, ctx = {}) {
    if (!body || typeof body !== "object" || typeof body.to !== "string" || typeof body.data !== "string" || !/^0x[0-9a-fA-F]*$/.test(body.data)) throw fail(400, "malformed request");
    const t = targets.get(lc(body.to));
    if (!t) throw fail(400, "not a contract this relay serves");
    if (body.data.length > 2 + 2 * 20_000) throw fail(413, "request too large");

    let spendKey = null;
    let memoKey = null;
    let cloakCall = t.cloak;
    let decoded;
    if (t.role === "vault") {
      try {
        decoded = decodeFunctionData({ abi: VAULT_ABI, data: body.data });
      } catch {
        throw fail(400, "not a call this relay serves");
      }
      if (decoded.functionName !== "transfer" && decoded.functionName !== "unshield") throw fail(400, "not a call this relay serves");
      const [, root, nullifier] = decoded.args;
      spendKey = `${lc(t.address)}:${nullifier}`;
      // spent and root first: a spent note or an unknown root never reaches the gas estimate
      if (await read(t.address, "isSpent", [nullifier])) throw fail(409, "already spent");
      if (!(await read(t.address, "isKnownRoot", [root]))) throw fail(400, "the proof's tree isn't one this vault knows");
      if (decoded.functionName === "unshield") {
        const [, , , asset, to] = decoded.args;
        // nowhere the money would stop or be lost: the zero address, a vault, the memo board, the token itself, an escrow
        if (lc(to) === lc(zeroAddress) || lc(to) === lc(asset) || targets.has(lc(to))) throw fail(400, "a cash out can't go to that address");
      }
    } else if (t.role === "memo") {
      try {
        decoded = decodeFunctionData({ abi: MEMO_ABI, data: body.data });
      } catch {
        throw fail(400, "not a memo this relay serves");
      }
      const [commitment, memo] = decoded.args;
      if (decoded.functionName !== "postMemo" || (memo.length - 2) / 2 > 8192) throw fail(400, "not a memo this relay serves");
      memoKey = lc(commitment);
      if (memoed.has(memoKey)) throw fail(409, "a memo for this payment was already relayed");
      let seenIn = null;
      for (const v of vaults) if (!seenIn && (await read(v.address, "commitmentSeen", [commitment]))) seenIn = v;
      if (!seenIn) throw fail(400, "no payment with this commitment in the vaults this relay serves");
      // a memo for a payment in Cloak's launch vault is Cloak's call
      cloakCall = seenIn.cloak;
    }
    if (spendKey) {
      expireLocks();
      if (inflight.has(spendKey)) throw fail(409, "this spend is already being relayed");
      await assertEarlierSendSettled(spendKey);
    }

    roll();
    const cls = classOf(t, decoded, body.data);
    const sender = String(ctx.sender ?? "anonymous");
    const mine = bySender.get(sender) ?? { base: 0n, back: 0n, fee: 0n, reverted: 0n, memo: 0n };
    const limit = (pct) => (hourlySpendWei * pct) / 100n;
    if (mine.reverted > 0n && mine.reverted >= limit(REVERT_PCT)) throw fail(429, "too many of your calls failed on chain this hour, try again later");
    // a call about Cloak's own contracts (a memo for a payment in the launch vault included) may use fee income first;
    // anything else only the base budget, or for memos the memo budget
    let fromFees = false;
    if (cloakCall && feeRoom() === 0n) await collectLaunchFees().catch((e) => log(`[gloam relay] fee collect failed: ${e.shortMessage ?? e.message}`));
    if (cloakCall && feeRoom() > 0n && mine.fee < (feeSpendPerHourWei * SENDER_PCT) / 100n) fromFees = true;
    else if (cls === "other") {
      // memos have their own small budget, so free memo posts can never use up what sends need
      if (memoSpentWei >= limit(MEMO_PCT)) throw fail(429, "the relay's memo budget is used up this hour, try again later or post it yourself");
      if (mine.memo >= (limit(MEMO_PCT) * SENDER_PCT) / 100n) throw fail(429, "you've used your share of the relay's memo budget this hour");
    } else {
      if (spentWei >= limit(cls === "new" ? NEW_SEND_PCT : 100n)) {
        throw fail(429, cls === "exit" ? "the relay's hourly gas budget is used up, try again later or send it yourself" : "the relay is keeping its last gas for refunds and cash outs this hour, try again later or send it yourself");
      }
      // refunds and exits have their own share per sender, so a sender's own sends can never block their refund
      if (cls === "exit" ? mine.back >= limit(BACK_PCT) : mine.base >= limit(SENDER_PCT)) throw fail(429, "you've used your share of the relay's gas this hour, try again later or send it yourself");
    }

    if (spendKey) inflight.set(spendKey, Date.now());
    if (memoKey) memoed.add(memoKey);
    let sent = false;
    let reverted = false;
    try {
      // simulate: a call that would revert is refused before it costs anything
      let gas;
      try {
        gas = await publicClient.estimateGas({ account: walletClient.account, to: body.to, data: body.data });
      } catch (e) {
        throw fail(400, `this call would fail: ${e.shortMessage ?? e.message}`);
      }
      const nonce = await publicClient.getTransactionCount({ address: walletClient.account.address, blockTag: "pending" });
      const hash = await walletClient.sendTransaction({ account: walletClient.account, chain: walletClient.chain, to: body.to, data: body.data, gas: (gas * 12n) / 10n, nonce });
      sent = true;
      // what was sent for this spend, kept a day: a later request for it waits until this send can no longer land
      if (spendKey) sends.set(spendKey, { hash, nonce, at: Date.now() });
      const r = await publicClient.waitForTransactionReceipt({ hash });
      reverted = r.status !== "success";
      const cost = r.gasUsed * r.effectiveGasPrice;
      if (fromFees) {
        const use = cost < feeCreditWei ? cost : feeCreditWei;
        feeCreditWei -= use;
        feeSpentWei += use;
        mine.fee += use;
        if (cls === "other") {
          memoSpentWei += cost - use;
          mine.memo += cost - use;
        } else {
          spentWei += cost - use;
          if (cls === "exit") mine.back += cost - use;
          else mine.base += cost - use;
        }
      } else if (cls === "other") {
        memoSpentWei += cost;
        mine.memo += cost;
      } else {
        spentWei += cost;
        if (cls === "exit") mine.back += cost;
        else mine.base += cost;
      }
      if (reverted) mine.reverted += cost;
      bySender.set(sender, mine);
      log(`[gloam relay] ${t.role}${cloakCall ? " (cloak)" : ""} ${hash} gas ${r.gasUsed}${fromFees ? " paid from fees" : ""}`);
      if (reverted) throw fail(400, `reverted on chain (${hash})`);
      return hash;
    } catch (e) {
      // a memo that never went out may be tried again
      if (memoKey && !sent) memoed.delete(memoKey);
      throw e;
    } finally {
      // the lock goes only when nothing was sent, or the send provably reverted: never on a timeout or an unknown end
      if (spendKey && (!sent || reverted)) inflight.delete(spendKey);
      if (memoed.size > MAX_MEMOS_REMEMBERED) memoed.clear();
    }
  }

  /** Locks for spends whose send landed or was lost long ago (a day by default); send records go after a day. */
  function expireLocks() {
    for (const [k, at] of inflight) if (at < Date.now() - lockTtlMs) inflight.delete(k);
    for (const [k, x] of sends) if (x.at < Date.now() - DAY_MS) sends.delete(k);
  }

  /**
   * Refuses a spend while an earlier send for it could still land: no receipt yet and the relay account hasn't used that
   * nonce for anything else. A send that reverted, or whose nonce went to another transaction, is settled.
   */
  async function assertEarlierSendSettled(spendKey) {
    const prev = sends.get(spendKey);
    if (!prev) return;
    const rc = await publicClient.getTransactionReceipt({ hash: prev.hash }).catch(() => null);
    if (rc) {
      if (rc.status === "success") throw fail(409, "this spend already went through");
      return; // it reverted: free to try again
    }
    const used = await publicClient.getTransactionCount({ address: walletClient.account.address, blockTag: "latest" });
    if (used <= prev.nonce) throw fail(409, "an earlier send of this spend could still land, try again in a few minutes");
  }

  relay.collectLaunchFees = collectLaunchFees;
  relay.stats = () => {
    roll();
    return { baseSpentWei: spentWei, baseBudgetWei: hourlySpendWei, memoSpentWei, feeCreditWei, feeSpentWei, feeIncomeWei, feeRoomWei: feeRoom() };
  };
  return relay;
}
