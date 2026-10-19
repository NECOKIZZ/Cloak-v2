import { toFunctionSelector } from "viem";

/**
 * Turns any error (wallet, RPC, relayer, prover, contract revert) into one plain sentence.
 * The raw error still goes to the console for debugging.
 */

const FAUCET = "the Elysium faucet";

// custom errors from the contracts, by name. Reverts relayed as raw selectors are mapped below.
const CONTRACT: Record<string, string> = {
  NullifierAlreadySpent: "Part of your private balance was already spent, maybe in another tab. Refresh the page and try again.",
  UnknownRoot: "Your private balance was a moment out of date. It has refreshed, so try again.",
  InvalidProof: "The privacy proof didn't check out. Refresh the page and try again.",
  BadExtDataHash: "The private transaction was changed on its way to the chain, so it was rejected. Try again.",
  BadPublicAmount: "The amounts in this private transaction don't add up. Refresh and try again.",
  InvalidExtAmount: "That amount isn't valid for a private transaction.",
  InvalidFee: "The relayer fee isn't valid. Try again.",
  ZeroRecipient: "Add an address to send to.",
  InvalidNote: "One of your private notes couldn't be used. Refresh the page and try again.",
  TransferFailed: "The token transfer failed. Try again.",
  TreeFull: "This private vault is full. Try a different token.",
  ValueOutOfField: "That value is too large for a private transaction.",
  Reentrancy: "The contract was busy. Try again.",
  NotLaunched: "Private trading opens once the launch has settled.",
  PoolExists: "Private trading is already enabled for this token.",
  UnknownPool: "This token doesn't have private trading yet.",
  BadRecipient: "That recipient isn't allowed here.",
  BadPair: "That market doesn't belong to this launch.",
  Expired: "The trade took too long to reach the chain and expired. Try again.",
  NotStandardSize: "Batch orders have to use the standard sizes (1, 2 or 5 × 10ⁿ).",
  NoMarket: "This token doesn't have a market yet.",
  RoundOpen: "This batch round is still open. It settles when the round ends.",
  AlreadySettled: "This has already been settled.",
  NotSettled: "This round hasn't settled yet. Give it a few seconds.",
  PriceMoved: "The pool price moved too much during this round, so it can't settle at a fair price yet.",
  TooEarly: "It's too early for that. Refunds open a while after the round ends.",
};
const SELECTORS: Record<string, string> = Object.fromEntries(
  Object.keys(CONTRACT).map((n) => [toFunctionSelector(`${n}()`), n]),
);

// require() strings from CloakAuction / CloakPair, and messages thrown by the SDK.
const RULES: [RegExp, string][] = [
  // wallet
  [/user rejected|user denied|rejected the request|action_rejected|request rejected|user cancel|denied transaction|code:4001\b/, "You cancelled the request in your wallet. Nothing was sent."],
  [/already pending|code:-32002\b/, "Your wallet already has a request waiting. Open your wallet to approve or reject it."],
  [/at least one account|must has at least|no accounts|accounts? (is|are) empty|no account/, "Your wallet didn't share an account. Unlock your wallet (or create an account in it), then connect again."],
  [/unrecognized chain|code:4902\b|chain .* not (been )?added|unknown chain/, "Elysium testnet isn't in your wallet yet. Use “Add Elysium testnet”, then try again."],
  [/does not match the target chain|chain mismatch|wrong network|switch.*chain|current chain of the wallet/, "Your wallet is on a different network. Switch it to Elysium testnet and try again."],
  [/unauthorized|code:4100\b|not been authorized/, "Your wallet hasn't approved this site yet. Connect again and approve the connection."],
  [/disconnected|code:490[01]\b/, "Your wallet is disconnected. Reconnect it and try again."],
  [/no browser wallet|window\.ethereum/, "No wallet found in this browser. Install one (like MetaMask or Rabby), or use WalletConnect."],
  // funds and gas
  [/insufficient funds|exceeds (the )?balance|not enough balance/, `Not enough testnet HYPE in your wallet to cover this and the gas. Get some from ${FAUCET}.`],
  [/insufficient private balance/, "Not enough private balance for this. Shield more HYPE on the Portfolio page first."],
  [/too many notes to combine/, "Your private balance is split into many small pieces. Try a smaller amount."],
  [/nonce too low|nonce has already been used|replacement transaction underpriced|known transaction/, "Your wallet has a pending transaction. Wait for it to confirm, then try again."],
  [/intrinsic gas too low|out of gas|gas required exceeds|exceeds block gas limit/, "The transaction ran out of gas. Try again."],
  // network, relayer, prover
  [/status: 429|code:429\b|\b429\b.*too many|rate limit|too many requests/, "The Elysium network is busy right now. Wait a few seconds and try again."],
  [/relay failed \(5|relay disabled|relayer|onrender/, "The Cloak relayer is waking up or busy. Wait about 30 seconds and try again."],
  [/failed to fetch|networkerror|network request failed|fetch failed|http request failed|econnrefused|timed? ?out|took too long|socket/, "Couldn't reach the network. Check your connection and try again in a moment."],
  [/out of memory|memory access out of bounds|webassembly|wasm/, "Your device ran out of memory making the privacy proof. Close some tabs and try again."],
  [/merkle path does not match root/, "Your private balance was a moment out of date. It has refreshed, so try again."],
  // auctions (SDK checks; exact require() reasons are in REASONS)
  [/max price is below/, "Your max price is below this launch's minimum price."],
  [/commit phase is over|commit closed/, "Bidding for this launch has closed."],
  [/deposit is below the bid'?s cost/, "Your deposit doesn't cover price × quantity. Increase the deposit."],
  [/not reveal phase/, "Bids can only be opened during the reveal window."],
  [/invalid reveal|ciphertext does not match|sealed for another auction/, "This bid couldn't be opened because its details don't match the sealed bid."],
  [/slippage/, "The price moved more than the 1% slippage limit. Try again, or trade a smaller amount."],
  // private trading
  [/amount too small for a standard-size order/, "That amount is below the smallest batch order. Increase it, or use Instant."],
  [/not a cloak: address|bad cloak: address/, "That doesn't look like a cloak: address. Ask the recipient to copy it from their Portfolio page."],
  [/no private market for this token/, "This token doesn't have private trading yet. It opens after the launch settles."],
  [/loadmarkets/, "Still loading the markets. Try again in a second."],
  [/no batcher configured|batching disabled/, "Batch mode isn't available on this deployment."],
  [/walletclient is required/, "Connect a wallet first."],
  [/factory address required/, "This site isn't set up with a launch factory."],
  // unknown reverts
  [/execution reverted|transaction reverted|call reverted|shield reverted|reverted/, "The transaction was rejected by the contract, so nothing changed. Refresh the page and try again."],
];

// require() reasons from CloakAuction and CloakPair: short words, so they only match a whole line
const REASONS: Record<string, string> = {
  "commit closed": "Bidding for this launch has closed.",
  deposit: "Add a deposit to place a bid.",
  "not reveal phase": "Bids can only be opened during the reveal window.",
  "invalid reveal": "This bid couldn't be opened because its details don't match the sealed bid.",
  "reveal open": "The reveal window is still open. The launch can be settled once it closes.",
  settled: "This launch has already been settled.",
  "not settled": "This launch hasn't settled yet.",
  claimed: "That bid has already been claimed.",
  "no lp": "This launch has no liquidity to release.",
  locked: "The liquidity is still locked.",
  released: "The liquidity was already released.",
  times: "Check the dates: bidding has to end in the future, and the reveal window has to end after bidding.",
  "supply/price": "Set a sale supply and a minimum price above zero.",
  ticks: "The number of price steps must be between 1 and 256.",
  ticksize: "Set a price step above zero.",
  bps: "The liquidity share must be 100% or less.",
  lock: "The liquidity lock has to end after the reveal window.",
  creator: "A launch needs a creator address.",
  slippage: "The price moved more than the 1% slippage limit. Try again, or trade a smaller amount.",
  zero: "Enter an amount above zero.",
  shares: "You don't have enough liquidity shares for that.",
};

function collect(e: unknown, out: string[] = [], depth = 0): string[] {
  if (!e || depth > 6) return out;
  if (typeof e === "string") return out.push(e), out;
  const x = e as Record<string, unknown>;
  for (const k of ["shortMessage", "message", "details", "reason", "name"]) if (typeof x[k] === "string") out.push(x[k] as string);
  if (typeof x.code === "number" || typeof x.code === "string") out.push(`code:${x.code}`);
  const data = x.data as Record<string, unknown> | string | undefined;
  if (typeof data === "string") out.push(data);
  else if (data && typeof data.errorName === "string") out.push(data.errorName);
  if (Array.isArray(x.metaMessages)) out.push(...(x.metaMessages as string[]));
  return collect(x.cause, out, depth + 1);
}

/** An error whose message is already written for people; friendly() shows it as is. */
export class Hint extends Error {}

export function friendly(e: unknown): string {
  if (e instanceof Hint) return e.message;
  if (e) console.error(e);
  const text = collect(e).join(" \n ");
  for (const [name, msg] of Object.entries(CONTRACT)) if (new RegExp(`\\b${name}\\b`).test(text)) return msg;
  const sel = text.match(/0x[0-9a-fA-F]{8}\b/g)?.find((s) => SELECTORS[s.toLowerCase()]);
  if (sel) return CONTRACT[SELECTORS[sel.toLowerCase()]];
  const low = text.toLowerCase();
  for (const line of low.split(/\n|reason:|reverted with reason string/)) {
    const k = line.trim().replace(/^['"]|['"]$/g, "");
    if (REASONS[k]) return REASONS[k];
  }
  for (const [re, msg] of RULES) if (re.test(low)) return msg;
  return "Something went wrong on our side. Refresh the page and try again. If it keeps happening, tell us on GitHub.";
}
