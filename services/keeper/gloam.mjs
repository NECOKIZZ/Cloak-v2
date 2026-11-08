// Gloam relay for the keeper (Cloak v2 on Gloam). Relays the calls GloamCore and Cloak's Gloam escrows make, so the
// user's wallet is never the sender: vault transfers and cash outs, memo posts, and calls to Cloak's escrows (swaps,
// bids, batch orders). It holds no secrets and can't change a call: every spend is fixed by its proof, every escrow
// action by its escrow key or owner signature.
//
// Gloam's proofs carry no relayer fee, so the relay pays gas from its own wallet. What keeps that from being drained:
//   - only known targets and selectors (the vault's transfer and unshield, the board's postMemo, the escrows' entry
//     points), never anything else;
//   - every call is simulated first: one that would revert is refused and costs nothing;
//   - one in-flight call per spend (by nullifier), and a spend already used on chain is refused;
//   - an hourly HYPE budget (GLOAM_RELAY_HOURLY_SPEND, default 1 HYPE, Gloam's own default), after which it answers 429;
//   - memo bodies capped at the board's own 8 KB.
//
//   POST /gloam/relay {kind, to, data} -> {txHash}
import { decodeFunctionData, parseAbi, parseEther } from "viem";

const VAULT_ABI = parseAbi([
  "function transfer(bytes proof, bytes32 root, bytes32 nullifier, bytes32[2] newCommitments)",
  "function unshield(bytes proof, bytes32 root, bytes32 nullifier, address asset, address to, uint256 amount)",
  "function isSpent(bytes32) view returns (bool)",
]);
const MEMO_ABI = parseAbi(["function postMemo(bytes32 paymentCommitment, bytes memo)"]);
// Calls to an escrow (Cloak's Gloam escrows, Gloam's swap routers) are relayed whatever the function: each one checks
// its own authorization (escrow key, proof or owner signature), and the simulation keeps a failing call free.

export function createGloamRelay({ publicClient, walletClient, vault, memoBoard, escrows = [], hourlySpendWei = parseEther(process.env.GLOAM_RELAY_HOURLY_SPEND ?? "1"), log = () => {} }) {
  const targets = new Map([[vault.toLowerCase(), "vault"], [memoBoard.toLowerCase(), "memo"], ...escrows.map((e) => [e.toLowerCase(), "escrow"])]);
  const inflight = new Map();
  let windowStart = Date.now();
  let spentWei = 0n;
  const fail = (status, message) => Object.assign(new Error(message), { status });

  return async function relay(body) {
    if (!body || typeof body !== "object" || typeof body.to !== "string" || typeof body.data !== "string" || !/^0x[0-9a-fA-F]*$/.test(body.data)) throw fail(400, "malformed request");
    const to = body.to.toLowerCase();
    const role = targets.get(to);
    if (!role) throw fail(400, "not a contract this relay serves");
    if (body.data.length > 2 + 2 * 20_000) throw fail(413, "request too large");
    let spendKey = null;
    if (role === "vault") {
      const d = decodeFunctionData({ abi: VAULT_ABI, data: body.data });
      if (d.functionName !== "transfer" && d.functionName !== "unshield") throw fail(400, "not a call this relay serves");
      spendKey = d.args[2];
      if (await publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "isSpent", args: [spendKey] })) throw fail(409, "already spent");
    } else if (role === "memo") {
      const d = decodeFunctionData({ abi: MEMO_ABI, data: body.data });
      if (d.functionName !== "postMemo" || (d.args[1].length - 2) / 2 > 8192) throw fail(400, "not a memo this relay serves");
    }
    if (spendKey && inflight.has(spendKey)) throw fail(409, "this spend is already being relayed");

    // budget: reset each hour
    if (Date.now() - windowStart > 3_600_000) {
      windowStart = Date.now();
      spentWei = 0n;
    }
    if (spentWei >= hourlySpendWei) throw fail(429, "the relay's hourly gas budget is used up, try again later or send it yourself");

    if (spendKey) inflight.set(spendKey, Date.now());
    try {
      // simulate: a call that would revert is refused before it costs anything
      let gas;
      try {
        gas = await publicClient.estimateGas({ account: walletClient.account, to: body.to, data: body.data });
      } catch (e) {
        throw fail(400, `this call would fail: ${e.shortMessage ?? e.message}`);
      }
      const hash = await walletClient.sendTransaction({ account: walletClient.account, chain: walletClient.chain, to: body.to, data: body.data, gas: (gas * 12n) / 10n });
      const r = await publicClient.waitForTransactionReceipt({ hash });
      spentWei += r.gasUsed * r.effectiveGasPrice;
      log(`[gloam relay] ${role} ${hash} gas ${r.gasUsed}`);
      if (r.status !== "success") throw fail(400, `reverted on chain (${hash})`);
      return hash;
    } finally {
      if (spendKey) inflight.delete(spendKey);
    }
  };
}

