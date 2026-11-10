/**
 * Money in from other chains and exchanges, through Relay (relay.link), into a Cloak receive address on Elysium.
 *
 * Gloam's app brings money in through Relay too (its lib/bridge.ts, the chain list here comes from it). Cloak's twist is
 * the destination: Relay delivers to one of the account's receive addresses (CloakGloamReceive), never to the wallet,
 * and the app moves what arrives into the private balance as it does with any payment there. So the same flow serves
 *   - an exchange or any wallet: a one-time Relay deposit address on the source chain; send the token there;
 *   - a connected wallet: the wallet signs Relay's transactions on the source chain itself.
 *
 * Nothing here holds money or a key. Every quote is checked before it's shown: the source chain and token, the
 * destination chain and token, and that the recipient is exactly the receive address asked for; in wallet mode, that
 * the transactions are plain ones on the source chain (an exact approve, then the deposit). Anything else is refused.
 *
 * Relay answers browsers directly (CORS open). Deposit addresses from Solana need a Relay API key (`apiKey`), which a
 * public site can't hold: pass it from a server, or leave Solana off.
 */
import { isAddress, type Address, type Hex } from "viem";

export const RELAY_API = "https://api.relay.link";

export type RelayChainKind = "evm" | "svm" | "tvm" | "bvm";

export interface RelayToken {
  symbol: string;
  /** Contract, mint, or Relay's id for the chain's own coin (address 0 on EVM chains). */
  address: string;
  decimals: number;
  /** A dollar stablecoin. */
  stable?: boolean;
}

export interface RelaySource {
  /** Relay's chain id (Solana, Tron and Bitcoin use Relay's own ids). */
  id: number;
  name: string;
  kind: RelayChainKind;
  /** Deposit addresses from this chain need a Relay API key. */
  needsKey?: boolean;
  tokens: RelayToken[];
}

const NATIVE = "0x0000000000000000000000000000000000000000";
const usdc = (address: string, decimals = 6): RelayToken => ({ symbol: "USDC", address, decimals, stable: true });
const usdt = (address: string, decimals = 6, symbol = "USDT"): RelayToken => ({ symbol, address, decimals, stable: true });
const coin = (symbol: string, decimals = 18, address = NATIVE): RelayToken => ({ symbol, address, decimals });

/**
 * Where money can come from. Every pair below gave a live Relay deposit-address quote into Elysium HYPE on Nov 10
 * (Solana's need an API key; Bitcoin's was refused for a test refund address, so check one before relying on it).
 */
export const RELAY_SOURCES: RelaySource[] = [
  { id: 999, name: "HyperEVM", kind: "evm", tokens: [coin("HYPE"), usdc("0xb88339cb7199b77e23db6e890353e22632ba630f")] },
  { id: 42161, name: "Arbitrum", kind: "evm", tokens: [usdc("0xaf88d065e77c8cc2239327c5edb3a432268e5831"), usdt("0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9"), coin("ETH")] },
  { id: 8453, name: "Base", kind: "evm", tokens: [usdc("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"), usdt("0xfde4c96c8593536e31f229ea8f37b2ada2699bb2"), coin("ETH")] },
  { id: 1, name: "Ethereum", kind: "evm", tokens: [usdc("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"), usdt("0xdac17f958d2ee523a2206206994597c13d831ec7"), coin("ETH")] },
  { id: 56, name: "BNB Chain", kind: "evm", tokens: [usdc("0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", 18), usdt("0x55d398326f99059ff775485246999027b3197955", 18), coin("BNB")] },
  { id: 728126428, name: "Tron", kind: "tvm", tokens: [usdt("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"), coin("TRX", 6, "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb")] },
  { id: 792703809, name: "Solana", kind: "svm", needsKey: true, tokens: [usdc("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), usdt("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"), coin("SOL", 9, "11111111111111111111111111111111")] },
  { id: 8253038, name: "Bitcoin", kind: "bvm", tokens: [coin("BTC", 8, "bc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqmql8k8")] },
  { id: 10, name: "Optimism", kind: "evm", tokens: [usdc("0x0b2c639c533813f4aa9d7837caf62653d097ff85"), usdt("0x94b008aa00579c1307b0ef2c499ad98a8ce58e58"), coin("ETH")] },
  { id: 137, name: "Polygon", kind: "evm", tokens: [usdc("0x3c499c542cef5e3811e1192ce70d8cc03d5c3359"), usdt("0xc2132d05d31c914a87c6611c10748aeb04b58e8f")] },
  { id: 43114, name: "Avalanche", kind: "evm", tokens: [usdc("0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e")] },
  { id: 143, name: "Monad", kind: "evm", tokens: [usdc("0x754704bc059f8c67012fed69bc8a327a5aafb603"), usdt("0xe7cd86e13ac4309349f30b3435a9d337750fc82d", 6, "USDT0"), coin("MON")] },
  { id: 130, name: "Unichain", kind: "evm", tokens: [usdc("0x078d782b760474a361dda0af3839290b0ef57ad6"), coin("ETH")] },
  { id: 59144, name: "Linea", kind: "evm", tokens: [usdc("0x176211869ca2b568f2a7d4ee941e073a821ee1ff"), coin("ETH")] },
  { id: 480, name: "World Chain", kind: "evm", tokens: [usdc("0x79a02482a880bce3f13e09da970dc34db4cd24d1"), coin("ETH")] },
  { id: 146, name: "Sonic", kind: "evm", tokens: [usdc("0x29219dd400f2bf60e5a23d13be72b486d4038894")] },
  { id: 5000, name: "Mantle", kind: "evm", tokens: [usdc("0x09bc4e0d864854c6afb6eb9a9cdf58ac190d0df9"), usdt("0x779ded0c9e1022225f8e0630b35a9b54be713736", 6, "USDT0")] },
  { id: 80094, name: "Berachain", kind: "evm", tokens: [usdc("0x549943e04f40284185054145c6e4e9568c1d3241")] },
  { id: 324, name: "zkSync Era", kind: "evm", tokens: [coin("ETH")] },
  { id: 534352, name: "Scroll", kind: "evm", tokens: [coin("ETH")] },
  { id: 57073, name: "Ink", kind: "evm", tokens: [coin("ETH")] },
];

/** What lands on each destination chain: assets Cloak's private vaults take there. */
export const RELAY_DESTINATIONS: Record<number, RelayToken[]> = {
  // Elysium mainnet: HYPE and USDC (Gloam's vault)
  99901: [coin("HYPE"), usdc("0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65")],
};

/** Relay serves `chainId` (Elysium mainnet; not its testnet). */
export const relayServes = (chainId: number): boolean => !!RELAY_DESTINATIONS[chainId];

export const relaySource = (id: number): RelaySource | undefined => RELAY_SOURCES.find((c) => c.id === id);

/** An address on a source chain, roughly checked (where a failed transfer is refunded). */
export function validRefundAddress(kind: RelayChainKind, v: string): boolean {
  if (kind === "svm") return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);
  if (kind === "tvm") return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(v);
  if (kind === "bvm") return /^(bc1[02-9ac-hj-np-z]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/.test(v);
  return /^0x[0-9a-fA-F]{40}$/.test(v);
}

/** One transaction the source wallet signs (wallet mode). */
export interface RelayTx {
  to: Address;
  data: Hex;
  value: bigint;
  chainId: number;
}

export interface RelayQuote {
  requestId: string;
  /** Deposit-address mode: where to send `send.amount` of `send.token` on the source chain. */
  depositAddress: string | null;
  /** Wallet mode: the transactions to sign on the source chain, in order (an approve, then the deposit; or one). */
  txs: RelayTx[] | null;
  send: { chainId: number; chain: string; token: RelayToken; amount: bigint; formatted: string; usd: number | null };
  receive: { chainId: number; token: RelayToken; amount: bigint; minimum: bigint; formatted: string; usd: number | null };
  /** The receive address it lands at (the quote checked Relay names exactly this). */
  recipient: Address;
  refundTo: string;
  /** Relay's fees in dollars. */
  feeUsd: number;
  /** Relay's estimate in seconds (Bitcoin also waits for its confirmations). */
  timeSec: number;
}

export interface RelayQuoteRequest {
  /** Source chain (a RELAY_SOURCES id) and token symbol there. */
  from: { chainId: number; symbol: string };
  /** Destination chain and token symbol (RELAY_DESTINATIONS). */
  to: { chainId: number; symbol: string };
  /** Exact amount sent, in the source token's units. */
  amount: bigint;
  /** The Cloak receive address it lands at. */
  recipient: Address;
  /** Where a failed transfer goes back to, on the source chain. */
  refundTo: string;
  /** Wallet mode: the wallet that signs on the source chain (an EVM chain only). Without it, a deposit address. */
  wallet?: Address;
}

export interface RelayOptions {
  apiKey?: string;
  fetch?: typeof fetch;
  api?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

const lc = (s: unknown) => String(s ?? "").toLowerCase();
const isHex = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-fA-F]*$/.test(v);
const APPROVE = "0x095ea7b3";

/** Relay's message, as a person reads it. */
function plain(msg: string): string {
  if (/api key/i.test(msg)) return "Deposits from this chain aren't switched on yet.";
  if (/amount|too (low|small)|insufficient/i.test(msg)) return "That amount is too small to bridge. Try a little more.";
  if (/not supported/i.test(msg)) return "Relay doesn't serve that chain right now.";
  return "The bridge couldn't make a route right now. Try again.";
}

/**
 * A Relay quote that delivers to `recipient` (a Cloak receive address), checked field by field. Deposit-address mode
 * unless `wallet` is given.
 */
export async function relayQuote(r: RelayQuoteRequest, o: RelayOptions = {}): Promise<RelayQuote> {
  const src = relaySource(r.from.chainId);
  const token = src?.tokens.find((t) => t.symbol === r.from.symbol);
  const dest = RELAY_DESTINATIONS[r.to.chainId]?.find((t) => t.symbol === r.to.symbol);
  if (!src || !token) throw new Error("Pick where the money is coming from.");
  if (!dest) throw new Error("Pick what to receive.");
  if (!isAddress(r.recipient)) throw new Error("No receive address to deliver to.");
  if (!validRefundAddress(src.kind, r.refundTo)) throw new Error(`Add your ${src.name} address, so a failed transfer can be sent back to you.`);
  if (r.amount <= 0n) throw new Error("Enter an amount.");
  const walletMode = !!r.wallet;
  if (walletMode && (src.kind !== "evm" || !isAddress(r.wallet!))) throw new Error("Paying from a connected wallet works from EVM chains only. Use a deposit address.");
  if (!walletMode && src.needsKey && !o.apiKey) throw new Error(`Deposits from ${src.name} aren't switched on yet.`);

  const f = o.fetch ?? fetch;
  let d: Json | null = null;
  let ok = false;
  try {
    const res = await f(`${o.api ?? RELAY_API}/quote`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(o.apiKey ? { "x-api-key": o.apiKey } : {}) },
      body: JSON.stringify({
        // a deposit address is paid by anyone (an exchange), so Relay builds it for no particular sender
        user: walletMode ? r.wallet : src.kind === "evm" ? "0x000000000000000000000000000000000000dEaD" : r.refundTo,
        recipient: r.recipient,
        originChainId: src.id,
        destinationChainId: r.to.chainId,
        originCurrency: token.address,
        destinationCurrency: dest.address,
        amount: r.amount.toString(),
        tradeType: "EXACT_INPUT",
        useDepositAddress: !walletMode,
        refundTo: r.refundTo,
      }),
    });
    ok = res.ok;
    d = (await res.json().catch(() => null)) as Json | null;
  } catch {
    throw new Error("Couldn't reach the bridge. Try again.");
  }
  if (!ok || !d) throw new Error(plain(typeof d?.message === "string" ? d.message : ""));

  // it must do exactly what was asked: this token in, this token out on this chain, to this receive address
  const det = d.details ?? {};
  const cin = det.currencyIn ?? {};
  const cout = det.currencyOut ?? {};
  const steps: Json[] = Array.isArray(d.steps) ? d.steps : [];
  const requestId = steps.find((s) => typeof s?.requestId === "string")?.requestId ?? d.requestId;
  const amountIn = BigInt(cin.amount ?? -1);
  const out = BigInt(cout.amount ?? -1);
  const shapeOk =
    typeof requestId === "string" &&
    Number(cin.currency?.chainId) === src.id &&
    lc(cin.currency?.address) === lc(token.address) &&
    amountIn === r.amount &&
    Number(cout.currency?.chainId) === r.to.chainId &&
    lc(cout.currency?.address) === lc(dest.address) &&
    out > 0n &&
    lc(det.recipient) === lc(r.recipient);
  if (!shapeOk) throw new Error("The bridge's route didn't match what was asked, so it wasn't used. Try again.");

  let depositAddress: string | null = null;
  let txs: RelayTx[] | null = null;
  if (!walletMode) {
    depositAddress = typeof steps[0]?.depositAddress === "string" ? steps[0].depositAddress : null;
    if (steps.length !== 1 || !depositAddress || !validRefundAddress(src.kind, depositAddress)) throw new Error("The bridge couldn't make a deposit address right now. Try again.");
  } else {
    txs = [];
    for (const s of steps) {
      const x = s?.kind === "transaction" && s?.items?.length === 1 ? s.items[0]?.data : null;
      if (!x || Number(x.chainId) !== src.id || !isAddress(String(x.to)) || !isHex(x.data)) throw new Error("The bridge's route couldn't be checked, so it wasn't used. Try again.");
      if (x.from !== undefined && lc(x.from) !== lc(r.wallet)) throw new Error("The bridge's route couldn't be checked, so it wasn't used. Try again.");
      txs.push({ to: x.to as Address, data: x.data as Hex, value: BigInt(x.value ?? 0), chainId: src.id });
    }
    const native = lc(token.address) === lc(NATIVE);
    const deposit = txs[txs.length - 1];
    const valueOk = native ? txs.length === 1 && deposit.value === r.amount : deposit.value === 0n && txs.length <= 2;
    // a token pays with an exact approve to the deposit contract first (when the allowance isn't there already)
    const approveOk =
      txs.length < 2 ||
      (txs[0].data.slice(0, 10) === APPROVE &&
        lc(txs[0].to) === lc(token.address) &&
        txs[0].value === 0n &&
        lc(`0x${txs[0].data.slice(34, 74)}`) === lc(deposit.to) &&
        BigInt(`0x${txs[0].data.slice(74, 138)}`) === r.amount);
    if (!txs.length || !valueOk || !approveOk) throw new Error("The bridge's route couldn't be checked, so it wasn't used. Try again.");
  }

  const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    requestId,
    depositAddress,
    txs,
    send: { chainId: src.id, chain: src.name, token, amount: amountIn, formatted: String(cin.amountFormatted ?? ""), usd: num(cin.amountUsd) },
    receive: { chainId: r.to.chainId, token: dest, amount: out, minimum: BigInt(cout.minimumAmount ?? cout.amount), formatted: String(cout.amountFormatted ?? ""), usd: num(cout.amountUsd) },
    recipient: r.recipient,
    refundTo: r.refundTo,
    feeUsd: Math.round(["relayer", "app"].reduce((s, k) => s + Number(d!.fees?.[k]?.amountUsd ?? 0), 0) * 100) / 100,
    timeSec: Number(det.timeEstimate ?? 0),
  };
}

export type RelayStage = "waiting" | "moving" | "done" | "failed" | "refunded";

/** Where a Relay transfer is: waiting for the deposit, moving, delivered (with the delivery's tx), failed or refunded. */
export async function relayStatus(requestId: string, o: RelayOptions = {}): Promise<{ stage: RelayStage; outTx: string | null }> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(requestId)) throw new Error("Not a Relay request id.");
  const res = await (o.fetch ?? fetch)(`${o.api ?? RELAY_API}/intents/status/v3?requestId=${requestId}`, { headers: o.apiKey ? { "x-api-key": o.apiKey } : {} });
  const d = (await res.json().catch(() => null)) as Json | null;
  if (!res.ok || typeof d?.status !== "string") throw new Error("Couldn't check the transfer.");
  const s = d.status as string;
  const stage: RelayStage = s === "success" ? "done" : s === "refund" || s === "refunded" ? "refunded" : s === "failure" || s === "failed" ? "failed" : s === "waiting" || s === "unknown" ? "waiting" : "moving";
  const tx = d.txHashes?.[0] ?? d.outTxHashes?.[0] ?? null;
  return { stage, outTx: typeof tx === "string" ? tx : null };
}
