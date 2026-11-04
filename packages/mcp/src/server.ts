import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  formatEther,
  formatUnits,
  http,
  isAddress,
  parseEther,
  parseUnits,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  Cloak,
  CloakPrivate,
  cloakAuctionAbi,
  cloakPairAbi,
  cloakVaultsAbi,
  legacyFactories,
  createProver,
  loadProver,
  createSharedProver,
  loadSharedProver,
  privateRouterAbi,
  relayerSubmitter,
  sharedRelayerSubmitter,
  sharedVaultAbi,
  SharedVaultClient,
  shieldedPoolAbi,
  buildClaimLink,
  buildRequestLink,
  linkAddress,
  linkCheck,
  linkKeys,
  openLinkKeys,
  newLinkSecret,
  parseClaimLink,
  parseRequestLink,
  LINK_SHARES_MAX,
  CloakDrops,
  CloakSpots,
  type DropBid,
  type DropState,
  type AuctionState,
  type Prover,
  type Wallet,
} from "@cloakely/sdk";
import type { Settings } from "./config.js";
import { Spending, show, type Budget } from "./limits.js";

export { loadSettings, type Settings, type Limits } from "./config.js";
export { Spending } from "./limits.js";

export const VERSION = "0.8.3";
export const HOSTED_URL = "https://cloak.boblabs.tech/mcp";

const INSTRUCTIONS = `Cloak: sealed-bid token launches and private trading on Kinetiq's Elysium (HYPE is the gas and base currency).

Launches: create_launch starts a sealed-bid auction. place_sealed_bid commits a bid that nobody can read until bidding closes; bids then open by themselves (the keeper reveals them from the drand beacon), so there is nothing to come back for. Everyone who wins pays one clearing price. After settlement, claim puts won tokens straight into the private balance (and refunds into the wallet); the keeper opens each launch's private vault at settlement, and pushes bids nobody claimed to wallets publicly about an hour later. enable_private_trading opens a private vault for an older launch if nobody has yet.

Private balances: shield moves HYPE or USDC from the wallet into a private balance (the one public step). private_swap, batch_order, private_send and withdraw then run from that balance: each is proven on this machine and sent by a relayer, so the wallet never appears on chain. batch_order also hides trade size. withdraw lands funds at a normal address, ideally a fresh one.

Payment links (HYPE, USDC): create_payment_link puts money in a link anyone can claim (into their private balance, or to any wallet with no gas), optionally locked with a passcode and riddle or split into shares; claim_payment_link claims one (or takes back your own), check_payment_link shows what is left. request_payment_link makes a link that asks to be paid, and pay_payment_request pays one. Amounts are in whole units ("0.5" HYPE), and send, sell and withdraw accept "max".

NFT drops and WL spot sales: list_drops and get_drop show sealed NFT drops (and sales of a partner collection's whitelist spots). place_drop_bid seals a bid at the creator's price or more (WL wallets get their public boost automatically); bids open by themselves after bidding closes and every winner pays one price. claim_drop takes NFTs (optionally to a fresh wallet) and refunds without waiting for the keeper. In a WL spot sale, set_whitelist_wallets names the Elysium wallet to whitelist for each spot won, until the sale's deadline.

Safety: every action that moves value is checked against per-transaction and daily spending limits (see cloak_info), and any write tool takes dry_run: true to see exactly what would happen without signing anything. Use dry_run first when unsure.`;

const HOSTED_INSTRUCTIONS = `Cloak's hosted MCP server: read and plan for Cloak, sealed-bid token launches and private trading on Kinetiq's Elysium testnet (HYPE is the gas and base currency).

It never signs and never holds keys. Use it to find launches (list_launches, get_launch), price a sealed bid (quote_bid) or a private swap (quote_swap), see vault totals (vault_stats) and plan a launch (plan_launch). Bids stay sealed until bidding closes, so demand only shows after that. To actually launch, bid or trade, the agent needs the local server: connect_full_agent explains it. Never send a private key, note secret or recovery phrase here; calls that look like they carry one are refused.`;

type Asset =
  | { kind: "hype"; symbol: "HYPE"; token: Address; pool: Address; decimals: 18 }
  | { kind: "asset"; symbol: string; token: Address; pool: Address; decimals: number }
  | { kind: "token"; symbol: string; token: Address; pool: Address; pair: Address; decimals: 18; shared?: true };

const j = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
const reply = (x: unknown) => ({ content: [{ type: "text" as const, text: j(x) }] });
const fail = (msg: string) => ({ isError: true, content: [{ type: "text" as const, text: msg }] });
const iso = (t: number) => new Date(t * 1000).toISOString();
const hype = (x: bigint) => `${formatEther(x)} HYPE`;

/** Turn an SDK or chain error into one plain sentence an agent can act on. */
export function explain(e: unknown): string {
  const m = String((e as { shortMessage?: string })?.shortMessage ?? (e as Error)?.message ?? e);
  if (/insufficient private balance/.test(m)) return "Not enough private balance for this, counting the relayer's fee. Check private_balance, try a smaller amount, or use amount \"max\".";
  if (/insufficient token balance in wallet/.test(m)) return "The wallet doesn't hold that many tokens. Check cloak_info for the wallet's public balances.";
  if (/insufficient funds|exceeds the balance|gas required exceeds allowance/i.test(m)) return "The wallet doesn't have enough HYPE for this and its gas. Get testnet HYPE from https://elysium.kinetiq.xyz/testnet-faucet.";
  if (/OverDepositLimit/.test(m)) return "That's over the vault's deposit cap during the beta. Try a smaller amount.";
  if (/BidOverCap|DepositOverCap|over cap/i.test(m)) return "That bid is over the auction's cap (100 HYPE per bid, 10,000 in total during the beta).";
  if (/commit phase is over/.test(m)) return "Bidding has closed for this launch.";
  if (/below the auction's minimum price/.test(m)) return m;
  return m.replace(/\s*\n\s*/g, " ").slice(0, 400);
}

/** Parse a whole-unit amount ("1.5") into base units, or null for "max". */
function amountOf(s: string, decimals: number): bigint | null {
  if (s.trim().toLowerCase() === "max") return null;
  if (!/^\d+(\.\d+)?$/.test(s.trim())) throw new Error(`"${s}" isn't an amount: use a number like 0.5, or "max"`);
  const a = parseUnits(s.trim(), decimals);
  if (a <= 0n) throw new Error("the amount must be above zero");
  return a;
}

/** A tool argument that looks like a private key, a note secret or a recovery phrase. */
export function looksSecret(args: unknown): boolean {
  const text = JSON.stringify(args ?? {});
  return /(0x)?[0-9a-fA-F]{64}(?![0-9a-fA-F])/.test(text) || /\b([a-z]{3,8}\s+){11,23}[a-z]{3,8}\b/.test(text);
}

/**
 * The Cloak MCP server. `hosted` is the public read-and-plan server (https://cloak.boblabs.tech/mcp): it never has a
 * key, never signs, and refuses any call that looks like it carries a secret. Without `hosted`, it's the local server
 * that signs for one agent wallet under spending limits.
 */
export function createCloakServer(settings: Settings, opts: { prover?: () => Promise<Prover>; hosted?: boolean } = {}) {
  if (opts.hosted) settings = { ...settings, privateKey: undefined };
  const d = settings.deployment;
  // reads in the same tick go out as one multicall where the chain has Multicall3 (a launch list is ~20 reads per
  // launch, more than a public RPC takes at once), and failed requests are retried
  const pub = createPublicClient({
    chain: settings.chain,
    transport: http(settings.rpcUrl, { retryCount: 4, retryDelay: 400, timeout: 20_000 }),
    batch: settings.chain.contracts?.multicall3 ? { multicall: true } : undefined,
  }) as PublicClient;
  const account = settings.privateKey ? privateKeyToAccount(settings.privateKey) : undefined;
  const wallet = account ? (createWalletClient({ chain: settings.chain, transport: http(settings.rpcUrl), account }) as Wallet) : undefined;
  // earlier deployments' launches still list, settle and pay out
  const cloak = new Cloak(pub, wallet, d.factory, legacyFactories(d));
  /** Where to start scanning a launch's bids: this deployment's first factory block, or the start for an older launch. */
  const ours = new Set([d.factory, ...(d.earlierFactories ?? [])].map((f) => f.toLowerCase()));
  const bidsFrom = async (auction: Address) =>
    ours.has((await pub.readContract({ address: auction, abi: [{ type: "function", name: "factory", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }], functionName: "factory" }).catch(() => zeroAddress)).toLowerCase())
      ? (d.firstFactoryBlock !== undefined && d.firstFactoryBlock < settings.launchesFromBlock ? d.firstFactoryBlock : settings.launchesFromBlock)
      : 0n;
  const spending = account ? new Spending(settings.limits, settings.stateDir, account.address) : undefined;
  const submit = relayerSubmitter(d.relayerUrl);
  const explorer = settings.chain.blockExplorers?.default.url;
  const link = (h: Hex) => (explorer ? `${explorer}/tx/${h}` : h);

  let proverP: Promise<Prover> | undefined;
  const prover =
    opts.prover ??
    (() =>
      (proverP ??= settings.circuitsDir
        ? Promise.resolve(createProver(readFileSync(join(settings.circuitsDir, "transaction2x2.wasm")), readFileSync(join(settings.circuitsDir, "transaction2x2_final.zkey"))))
        : loadProver(d.circuitsUrl)));

  let sharedProverP: Promise<Prover> | undefined;
  const sharedProver = () =>
    (sharedProverP ??= settings.circuitsDir
      ? Promise.resolve(createSharedProver(readFileSync(join(settings.circuitsDir, "transactionMA2x2.wasm")), readFileSync(join(settings.circuitsDir, "transactionMA2x2_final.zkey"))))
      : loadSharedProver(d.circuitsUrl));
  let sharedC: SharedVaultClient | undefined;
  /** The shared launch-token vault (new Uniswap launches keep their private balances there). */
  async function shared(): Promise<SharedVaultClient> {
    if (!d.shared || !d.sharedRouter) throw new Error("This deployment has no shared launch-token vault.");
    const p = await priv();
    if (!sharedC || sharedC.priv !== p) sharedC = new SharedVaultClient(p, d.shared, d.sharedRouter, sharedProver, sharedRelayerSubmitter(d.relayerUrl), d.sharedBlock ?? 0n, d.sharedBatcher);
    return sharedC;
  }
  /** Private balance of one asset, wherever its vault is. */
  async function balanceOf(a: Asset): Promise<bigint> {
    if (a.kind === "token" && a.shared) return (await shared()).balance(a.token);
    return (await priv()).balance(a.pool);
  }

  let privP: Promise<CloakPrivate> | undefined;
  async function priv(): Promise<CloakPrivate> {
    if (!wallet) throw new Error("No wallet configured: set CLOAK_KEY_FILE (or CLOAK_PRIVATE_KEY) to use private balances.");
    privP ??= (async () => {
      const keys = await CloakPrivate.keysFromWallet(wallet, { chainId: settings.chain.id, verify: true });
      // notes are scanned from the permanent vaults' first block, whichever router is current
      const p = new CloakPrivate(pub, d.router, keys, prover, submit, d.vaultsBlock ?? d.routerBlock, d.batcher, d.migrator);
      for (const a of d.assets ?? []) p.addAsset(a);
      return p;
    })().catch((e) => {
      privP = undefined;
      throw e;
    });
    const p = await privP;
    await p.loadMarkets(); // new private markets appear as launches settle
    return p;
  }

  // one write at a time: two private calls must not pick the same notes, and nonces stay in order
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  const needWallet = () => {
    if (!wallet || !account || !spending) throw new Error("No wallet configured: set CLOAK_KEY_FILE (or CLOAK_PRIVATE_KEY). Read tools work without one.");
    return { wallet, account, spending };
  };

  const symbols = new Map<string, string>();
  async function symbolOf(token: Address): Promise<string> {
    const k = token.toLowerCase();
    if (!symbols.has(k)) symbols.set(k, await pub.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }).catch(() => "?"));
    return symbols.get(k)!;
  }
  async function decimalsOf(token: Address): Promise<number> {
    return Number(await pub.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }).catch(() => 18));
  }

  /** Every asset with a private vault: HYPE, USDC-like assets, and every launch token with a private market. */
  async function vaults(): Promise<Asset[]> {
    const c = { address: d.router, abi: privateRouterAbi } as const;
    const n = await pub.readContract({ ...c, functionName: "tokensCount" });
    const out: Asset[] = [{ kind: "hype", symbol: "HYPE", token: d.whype, pool: d.hypePool, decimals: 18 }];
    for (const a of d.assets ?? []) out.push({ kind: "asset", symbol: a.symbol, token: a.token, pool: a.pool, decimals: a.decimals });
    const toks = await Promise.all(Array.from({ length: Number(n) }, (_, i) => pub.readContract({ ...c, functionName: "tokens", args: [BigInt(i)] })));
    for (const token of toks) {
      if (out.some((a) => a.token.toLowerCase() === token.toLowerCase())) continue; // HYPE, or an asset already listed
      const [pool, pair, symbol] = await Promise.all([
        pub.readContract({ ...c, functionName: "poolOf", args: [token] }),
        pub.readContract({ ...c, functionName: "pairOf", args: [token] }),
        symbolOf(token),
      ]);
      // a vault without a launch pair holds an existing token (USDC): an asset, not a market
      if (pair === zeroAddress) out.push({ kind: "asset", symbol, token, pool, decimals: await decimalsOf(token) });
      else out.push({ kind: "token", symbol, token, pool, pair, decimals: 18 });
    }
    // tokens in the shared launch-token vault (every Uniswap launch from Nov 2 on)
    if (d.shared) {
      const v = { address: d.shared, abi: sharedVaultAbi } as const;
      const m = Number(await pub.readContract({ ...v, functionName: "tokensCount" }));
      for (let i = 0; i < m; i++) {
        const token = await pub.readContract({ ...v, functionName: "tokens", args: [BigInt(i)] });
        if (out.some((a) => a.token.toLowerCase() === token.toLowerCase())) continue;
        const [pair, symbol] = await Promise.all([pub.readContract({ ...v, functionName: "marketOf", args: [token] }), symbolOf(token)]);
        out.push({ kind: "token", symbol, token, pool: d.shared, pair, decimals: 18, shared: true });
      }
    }
    return out;
  }

  /** "HYPE", "USDC", a launch token's symbol, or any of their addresses. */
  async function resolve(ref: string): Promise<Asset> {
    const all = await vaults();
    const r = ref.trim();
    if (isAddress(r)) {
      const hit = all.find((a) => a.token.toLowerCase() === r.toLowerCase() || a.pool.toLowerCase() === r.toLowerCase());
      if (hit) return hit;
      throw new Error(`${r} has no private vault yet. If it's a settled Cloak launch, enable_private_trading opens one.`);
    }
    const hits = all.filter((a) => a.symbol.toLowerCase() === r.replace(/^\$/, "").toLowerCase());
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) throw new Error(`Several tokens are called ${r}: ${hits.map((h) => h.token).join(", ")}. Pass the token address instead.`);
    throw new Error(`No private vault for "${r}". Private vaults: ${[...new Set(all.map((a) => a.symbol))].join(", ")}.`);
  }

  /** Expected output of a private swap of `amountIn` (after the vault's withdrawal fee), and the relayer's fee. */
  async function quoteSwap(t: Extract<Asset, { kind: "token" }>, side: "buy" | "sell", amountIn: bigint) {
    const poolIn = side === "buy" ? d.hypePool : t.pool;
    const net = await pub.readContract({ address: poolIn, abi: shieldedPoolAbi, functionName: "afterFee", args: [amountIn] });
    const [rH, rT] = await Promise.all([
      pub.readContract({ address: t.pair, abi: cloakPairAbi, functionName: "reserveHype" }),
      pub.readContract({ address: t.pair, abi: cloakPairAbi, functionName: "reserveToken" }),
    ]);
    const out = await pub.readContract({ address: t.pair, abi: cloakPairAbi, functionName: "getAmountOut", args: side === "buy" ? [net, rH, rT] : [net, rT, rH] });
    const fee = t.shared
      ? await (side === "buy" ? sharedRelayerSubmitter(d.relayerUrl).quote!("sharedBuy", t.token) : sharedRelayerSubmitter(d.relayerUrl).quote!("sharedSell", t.token)).then((q) => q.fee, () => 0n)
      : await submit.quote!("privateSwap", poolIn).then((q) => q.fee, () => 0n);
    return { out, net, fee };
  }

  /** What an amount of an asset counts against: HYPE value (launch tokens at the pool's price), or USDC. */
  async function cost(a: Asset, amount: bigint): Promise<{ budget: Budget; value: bigint }> {
    if (a.kind === "hype") return { budget: "hype", value: amount };
    if (a.kind === "asset") return { budget: "usdc", value: (amount * 10n ** 6n) / 10n ** BigInt(a.decimals) };
    const [rH, rT] = await Promise.all([
      pub.readContract({ address: a.pair, abi: cloakPairAbi, functionName: "reserveHype" }),
      pub.readContract({ address: a.pair, abi: cloakPairAbi, functionName: "reserveToken" }),
    ]);
    return { budget: "hype", value: rT === 0n ? 0n : (amount * rH) / rT }; // at the pool's spot price, before impact
  }

  const fmtAmt = (a: Asset, x: bigint) => `${formatUnits(x, a.decimals)} ${a.symbol}`;

  async function receipt(h: Hex) {
    const r = await pub.waitForTransactionReceipt({ hash: h });
    if (r.status !== "success") throw new Error(`transaction reverted: ${link(h)}`);
    return r;
  }

  function launchView(s: AuctionState) {
    const now = Math.floor(Date.now() / 1000);
    return {
      auction: s.address,
      token: s.token,
      name: s.tokenName,
      symbol: s.tokenSymbol,
      phase: s.failed ? "failed (every bid refunded)" : s.phase,
      biddingEnds: iso(s.commitEnd),
      revealsEnd: iso(s.revealEnd),
      ...(s.phase === "commit" ? { biddingClosesInMinutes: Math.max(0, Math.round((s.commitEnd - now) / 6) / 10) } : {}),
      tokensForSale: formatEther(s.saleSupply),
      minPrice: `${formatEther(s.minPrice)} HYPE per token`,
      tickSize: `${formatEther(s.tickSize)} HYPE`,
      priceTicks: s.numTicks,
      bids: s.commits,
      bidsOpened: s.reveals,
      ...(s.settled
        ? { clearingPrice: `${formatEther(s.clearingPrice)} HYPE per token`, sold: formatEther(s.sold), raised: hype(s.raised), pool: s.pair }
        : {}),
      liquidity: `${s.lpBps / 100}% of the raise seeds the pool at the clearing price; LP ${s.lpLockUntil === 0 ? "burned" : s.creatorFees || s.lpLockUntil >= 2 ** 63 ? "locked forever, trading fees to the creator" : `locked until ${iso(s.lpLockUntil)}`}`,
      noRevealPenalty: `${s.noRevealPenaltyBps / 100}%`,
      launchFee: `${s.launchFeeBps / 100}% of a successful raise`,
      caps: { perBid: s.bidCap ? hype(s.bidCap) : "none", total: s.depositCap ? hype(s.depositCap) : "none" },
    };
  }

  async function privateTradingOn(token: Address) {
    return (await pub.readContract({ address: d.router, abi: privateRouterAbi, functionName: "poolOf", args: [token] })) !== zeroAddress;
  }

  const bidsFile = (a: Address) => join(settings.stateDir, `bids-${a.toLowerCase()}.json`);
  function saveBid(a: Address, secret: object) {
    mkdirSync(settings.stateDir, { recursive: true });
    let all: unknown[] = [];
    try {
      all = JSON.parse(readFileSync(bidsFile(a), "utf8"));
    } catch {
      // first bid
    }
    all.push(secret);
    writeFileSync(bidsFile(a), j(all));
  }

  const server = new McpServer({ name: opts.hosted ? "cloak-hosted" : "cloak", version: VERSION }, { instructions: opts.hosted ? HOSTED_INSTRUCTIONS : INSTRUCTIONS });
  const dry = z.boolean().optional().describe("Return what would happen without signing or sending anything.");
  const addr = z.string().describe("0x address");
  const amt = (what: string) => z.string().describe(`${what}, in whole units (e.g. "0.5")`);
  const isDry = (x?: boolean) => settings.dryRun || x === true;
  const READ = { readOnlyHint: true, openWorldHint: true };
  const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

  /** Wrap a handler: plain-sentence errors instead of stack traces. */
  const safe =
    <A>(fn: (a: A) => Promise<unknown>) =>
    async (a: A) => {
      if (opts.hosted && looksSecret(a)) return fail("This hosted server never takes private keys, note secrets or recovery phrases, and refused the call. Nothing was stored. If that was a real key, treat it as exposed and move its funds to a new wallet.");
      try {
        return reply(await fn(a));
      } catch (e) {
        return fail(explain(e));
      }
    };

  // ───────────── read ─────────────

  server.registerTool(
    "cloak_info",
    { title: "Cloak setup and limits", description: "Network, contract addresses, the configured wallet and its public balances, dry-run mode, and spending limits with what's left today.", inputSchema: {}, annotations: READ },
    safe(async () => {
      const usdc = d.assets?.[0];
      const wallet = account
        ? {
            address: account.address,
            publicBalances: {
              HYPE: formatEther(await pub.getBalance({ address: account.address })),
              ...(usdc ? { [usdc.symbol]: formatUnits(await pub.readContract({ address: usdc.token, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }), usdc.decimals) } : {}),
            },
          }
        : null;
      return {
        server: opts.hosted ? `Cloak hosted MCP ${VERSION} (${HOSTED_URL})` : `@cloakely/mcp ${VERSION}`,
        network: settings.network,
        chainId: settings.chain.id,
        mode: opts.hosted ? "hosted: read and plan only, never signs (connect_full_agent explains how to launch, bid and trade)" : account ? "read and write" : "read only (no wallet configured)",
        ...(opts.hosted
          ? {}
          : { dryRun: settings.dryRun ? "on for every write (CLOAK_DRY_RUN=1)" : "off (pass dry_run: true on any write to preview it)", wallet, limits: spending?.summary() ?? null }),
        contracts: { factory: d.factory, router: d.router, batcher: d.batcher, hypeVault: d.hypePool, ...(usdc ? { [`${usdc.symbol.toLowerCase()}Vault`]: usdc.pool } : {}) },
        relayer: d.relayerUrl,
        ...(settings.network === "testnet" ? { faucet: "https://elysium.kinetiq.xyz/testnet-faucet", note: "Testnet: play money only." } : {}),
      };
    }),
  );

  server.registerTool(
    "list_launches",
    {
      title: "List launches",
      description: "Cloak launches, newest first, with phase, timing, prices and whether private trading is on.",
      inputSchema: { limit: z.number().int().min(1).max(50).optional().describe("How many (default 10)"), phase: z.enum(["commit", "reveal", "settle", "settled"]).optional().describe("Only launches in this phase") },
      annotations: READ,
    },
    safe(async ({ limit, phase }: { limit?: number; phase?: string }) => {
      const all = (await cloak.listLaunches()).reverse();
      const out = [];
      for (let i = 0; i < all.length && out.length < (limit ?? 10); i += 10) {
        const states = await Promise.all(all.slice(i, i + 10).map((l) => cloak.getAuction(l.auction)));
        for (const s of states) {
          if (phase && s.phase !== phase) continue;
          if (out.length >= (limit ?? 10)) break;
          const v = launchView(s);
          out.push({ symbol: v.symbol, name: v.name, auction: v.auction, token: v.token, phase: v.phase, biddingEnds: v.biddingEnds, bids: v.bids, minPrice: v.minPrice, ...(s.settled ? { clearingPrice: v.clearingPrice, raised: v.raised, privateTrading: await privateTradingOn(s.token) } : {}) });
        }
      }
      return { total: all.length, launches: out };
    }),
  );

  server.registerTool(
    "get_launch",
    { title: "Launch details", description: "Everything about one launch: phase, timing, prices, caps, results once settled, revealed demand once bids open, and whether private trading is on.", inputSchema: { auction: addr }, annotations: READ },
    safe(async ({ auction }: { auction: string }) => {
      const s = await cloak.getAuction(auction as Address);
      const v = launchView(s);
      const demand = s.phase === "commit" ? [] : (await cloak.demandCurve(s.address)).filter((x) => x.demand > 0n).map((x) => ({ price: formatEther(x.price), tokensWanted: formatEther(x.demand) }));
      return {
        ...v,
        ...(s.phase === "commit" ? { demand: "hidden until bidding closes: every bid is sealed" } : { revealedDemand: demand }),
        ...(s.settled && !s.failed ? { poolPrice: `${formatEther(await cloak.pairPrice(s.pair))} HYPE per token`, privateTrading: await privateTradingOn(s.token) } : {}),
      };
    }),
  );

  server.registerTool(
    "quote_bid",
    {
      title: "Quote a sealed bid",
      description: "What a bid would cost: the price tick it lands on, its cost, and the rounded deposit that hides its size (the unused part is refunded).",
      inputSchema: { auction: addr, max_price: amt("Highest price you'd pay, in HYPE per token"), quantity: amt("Tokens wanted") },
      annotations: READ,
    },
    safe(async ({ auction, max_price, quantity }: { auction: string; max_price: string; quantity: string }) => {
      const s = await cloak.getAuction(auction as Address);
      const q = cloak.quoteBid(s, parseEther(max_price), parseEther(quantity));
      return { phase: s.phase, tick: q.tick, price: `${formatEther(q.price)} HYPE per token`, cost: hype(q.cost), deposit: hype(q.deposit), note: "The deposit is rounded up to 1, 2 or 5 × 10ⁿ so it doesn't reveal the bid's size. Whatever isn't used at the clearing price is refunded." };
    }),
  );

  server.registerTool(
    "quote_swap",
    {
      title: "Quote a private swap",
      description: "Expected output of a private buy (HYPE in) or sell (tokens in), after the vault's withdrawal fee, plus the relayer's fee.",
      inputSchema: { token: z.string().describe("Launch token symbol or address"), side: z.enum(["buy", "sell"]), amount: amt("HYPE to spend (buy) or tokens to sell (sell)") },
      annotations: READ,
    },
    safe(async ({ token, side, amount }: { token: string; side: "buy" | "sell"; amount: string }) => {
      const t = await resolve(token);
      if (t.kind !== "token") throw new Error(`${t.symbol} isn't a launch token: private swaps trade launch tokens against HYPE.`);
      const a = parseEther(amount);
      const q = await quoteSwap(t, side, a);
      const outSym = side === "buy" ? t.symbol : "HYPE";
      return { side, in: side === "buy" ? hype(a) : `${amount} ${t.symbol}`, expectedOut: `${formatEther(q.out)} ${outSym}`, relayerFee: `${formatEther(q.fee)} ${side === "buy" ? "HYPE" : t.symbol}`, withdrawalFee: `${formatEther(a - q.net)} ${side === "buy" ? "HYPE" : t.symbol}` };
    }),
  );


  server.registerTool(
    "vault_stats",
    { title: "Private vault totals", description: "How much sits in each private vault (HYPE, USDC and every launch token). Totals are public; who owns what isn't.", inputSchema: {}, annotations: READ },
    safe(async () => {
      const out = [];
      for (const a of await vaults()) {
        const held = await pub.readContract({ address: a.pool, abi: shieldedPoolAbi, functionName: "deposited" });
        if (held === 0n && a.kind === "token") continue;
        out.push({ asset: a.symbol, token: a.token, vault: a.pool, held: fmtAmt(a, held) });
      }
      return { vaults: out, note: "Each vault is one shared pool of encrypted notes. The chain shows the total, not the owners or their balances." };
    }),
  );

  // ───────────── NFT drops and WL spot sales ─────────────

  const dropsFor = (w?: Wallet) => {
    if (!d.dropFactory) throw new Error("NFT drops aren't deployed on this network yet.");
    return new CloakDrops(pub, w, d.dropFactory, d.dropFactoryBlock ?? 0n, d.escrowDropFactory);
  };
  const spotsFor = (w?: Wallet) => (d.spotBook ? new CloakSpots(dropsFor(w), d.spotBook) : null);
  const dropPhase = (s: DropState) => (s.failed ? "ended with no sale (every bid refunded)" : s.phase === "gtd" ? "gtd (guaranteed list minting; bidding opens after)" : s.phase === "settle" || s.phase === "numbering" ? "settling" : s.phase);
  async function dropView(s: DropState) {
    const c = dropsFor();
    const [det, sale] = await Promise.all([c.details(s.address).catch(() => ({}) as Awaited<ReturnType<CloakDrops["details"]>>), spotsFor()?.sale(s.address).catch(() => null) ?? null]);
    return {
      drop: s.address,
      name: s.name,
      symbol: s.symbol,
      kind: sale ? `WL spot sale for ${sale.partner}` : s.escrow ? "auction of existing NFTs" : "NFT drop",
      ...(s.escrow ? { collection: s.escrow.collection, tokenIds: s.escrow.tokenIds.map(String), heldInEscrow: `${s.escrow.held} of ${s.supply}` } : {}),
      phase: dropPhase(s),
      ...(s.phase === "gtd" ? { biddingOpens: iso(s.gtdEnd) } : {}),
      biddingEnds: iso(s.commitEnd),
      [sale ? "spots" : "supply"]: s.supply,
      floor: `${formatEther(s.floor)} HYPE each (the creator's price; bids go up in ${formatEther(s.tickSize)} HYPE steps)`,
      maxPerBid: s.maxPerBid,
      ...(s.hasWl ? { wlBoost: `${s.wlBoostBps / 100}% (WL bids rank this much higher, and WL winners pay that much less, never under the floor)` } : {}),
      ...(s.hasGtd ? { gtd: `${s.gtdMinted} minted at ${formatEther(s.gtdPrice)} HYPE` } : {}),
      sealedBids: s.bids,
      bidsOpened: s.reveals,
      ...(s.settled && !s.failed ? { sold: s.sold, publicWinnersPaid: hype(s.publicPrice), ...(s.hasWl ? { wlWinnersPaid: hype(s.wlPrice) } : {}) } : {}),
      ...(sale ? { walletsDeadline: iso(sale.deadline) } : {}),
      ...(det.description ? { description: det.description } : {}),
      page: `https://cloak.boblabs.tech/app/drop/${s.address}`,
    };
  }
  const bidView = (b: DropBid, settled: boolean) => ({
    id: b.id.toString(),
    wl: b.wl,
    deposit: hype(b.deposit),
    ...(b.revealed ? { bid: `${b.quantity} at ${formatEther(b.price)} HYPE` } : { bid: "sealed" }),
    ...(settled ? (b.revealed ? { won: b.nfts, paid: hype(b.paid), refund: hype(b.refund) } : { won: 0, note: "never opened: 90% of the deposit comes back" }) : {}),
    delivered: b.claimed,
  });

  server.registerTool(
    "list_drops",
    {
      title: "List NFT drops",
      description: "Sealed NFT drops and WL spot sales, newest first, with phase, floor, WL boost and results.",
      inputSchema: { limit: z.number().int().min(1).max(50).optional().describe("How many (default 10)"), live_only: z.boolean().optional().describe("Only drops still minting or taking bids") },
      annotations: READ,
    },
    safe(async ({ limit, live_only }: { limit?: number; live_only?: boolean }) => {
      const c = dropsFor();
      const all = (await c.list()).reverse();
      const out = [];
      for (const a of all) {
        if (out.length >= (limit ?? 10)) break;
        const s = await c.get(a);
        if (live_only && s.phase !== "gtd" && s.phase !== "bidding") continue;
        out.push(await dropView(s));
      }
      return { total: all.length, drops: out };
    }),
  );

  server.registerTool(
    "get_drop",
    {
      title: "Drop details",
      description: "One NFT drop, WL spot sale or auction of existing NFTs: phase, timing, floor, WL boost, results once settled, whether a wallet is on its GTD list or WL, and for a spot sale the whitelist so far.",
      inputSchema: { drop: addr, wallet: addr.optional().describe("A wallet to check against the drop's GTD list and WL") },
      annotations: READ,
    },
    safe(async ({ drop, wallet: w }: { drop: string; wallet?: string }) => {
      if (!isAddress(drop)) throw new Error("That isn't a drop address.");
      const c = dropsFor();
      const s = await c.get(drop as Address);
      const view = await dropView(s);
      const who = (w && isAddress(w) ? w : account?.address) as Address | undefined;
      const listed = who ? await c.listed(s.address, who) : null;
      const sp = spotsFor();
      const sale = sp ? await sp.sale(s.address) : null;
      const whitelist = sale && s.phase === "settled" && !s.failed ? (await sp!.winners(s.address)).flatMap((x) => Array.from({ length: x.spots }, (_, i) => ({ bid: x.bidId.toString(), wallet: x.wallets[i] ?? "not named yet" }))) : undefined;
      return {
        ...view,
        ...(listed && who ? { listing: { wallet: who, onWl: listed.wl, gtdSpots: listed.gtdSpots, gtdMinted: listed.gtdMinted } } : {}),
        ...(whitelist ? { whitelist } : {}),
        ...(s.phase === "bidding" ? { note: "Bids are sealed: nobody can see demand until bidding closes." } : {}),
      };
    }),
  );

  if (opts.hosted) {
    server.registerTool(
      "plan_launch",
      {
        title: "Plan a launch",
        description: "Check a launch's settings and see its schedule, price range and what it raises at the lowest and highest price, before creating it on the site or with the local server.",
        inputSchema: {
          sale_supply: amt("Tokens sold in the auction"),
          min_price: amt("Lowest price, in HYPE per token"),
          tick_size: amt("Price step between ticks, in HYPE").optional(),
          price_ticks: z.number().int().min(1).max(256).optional().describe("Number of price ticks (default 100)"),
          bidding_minutes: z.number().positive().max(60 * 24 * 14).optional().describe("How long bidding stays open (default 60)"),
          reveal_minutes: z.number().min(1).max(60 * 24).optional().describe("Time for bids to open after bidding closes (default 10)"),
          lp_percent: z.number().min(0).max(100).optional().describe("Share of the raise that seeds the pool (default 50)"),
        },
        annotations: READ,
      },
      safe(async (p: { sale_supply: string; min_price: string; tick_size?: string; price_ticks?: number; bidding_minutes?: number; reveal_minutes?: number; lp_percent?: number }) => {
        const supply = parseEther(p.sale_supply);
        const min = parseEther(p.min_price);
        const tick = parseEther(p.tick_size ?? p.min_price);
        const ticks = p.price_ticks ?? 100;
        const top = min + BigInt(ticks - 1) * tick;
        const now = Number((await pub.getBlock()).timestamp);
        const commitEnd = now + Math.round((p.bidding_minutes ?? 60) * 60);
        const revealEnd = commitEnd + Math.round((p.reveal_minutes ?? 10) * 60);
        const raise = (price: bigint) => (price * supply) / 10n ** 18n;
        const lp = p.lp_percent ?? 50;
        return {
          ifCreatedNow: { biddingEnds: iso(commitEnd), revealsEnd: iso(revealEnd) },
          priceRange: `${formatEther(min)} to ${formatEther(top)} HYPE per token, ${ticks} ticks`,
          raiseIfFullySold: { atLowestPrice: hype(raise(min)), atHighestPrice: hype(raise(top)) },
          toPool: `${lp}% of the raise, paired with tokens at the clearing price in a Uniswap V2 pool; the LP is locked forever and its 0.3% trading fees go to you (or burned, or locked for a set time)`,
          launchFee: "1.5% of a successful raise; nothing if the launch doesn't fill",
          caps: "During the beta a bid can be at most 100 HYPE and an auction can take at most 10,000 HYPE.",
          create: { onTheSite: "https://cloak.boblabs.tech/app/create", withAnAgent: "the local server's create_launch tool (see connect_full_agent)" },
        };
      }),
    );

    server.registerTool(
      "connect_full_agent",
      { title: "Connect a full agent", description: "How to let an agent launch, bid and trade privately: the local Cloak MCP server, which signs on your own machine under spending limits.", inputSchema: {}, annotations: READ },
      safe(async () => ({
        why: "This hosted server never holds keys, so it can read and plan but not sign. Launching, bidding and private trading run in the local server, on the machine that holds the agent's wallet. Its proofs are made there too, so nobody else, Cloak included, can see or move the funds.",
        easiest: "If you can run terminal commands, read https://cloak.boblabs.tech/agent.md and follow it: it sets everything up and says what to ask the person. If you can't (a chat app), tell the person to open that link in Claude Code, Claude Desktop or Cursor and ask the agent there to follow it.",
        steps: [
          "npx -y @cloakely/mcp setup (makes the agent's own wallet in ~/.cloak-agent-key and prints its address; the key is never printed)",
          "Claude Code: claude mcp add cloak -- npx -y @cloakely/mcp. Other clients: { \"mcpServers\": { \"cloak\": { \"command\": \"npx\", \"args\": [\"-y\", \"@cloakely/mcp\"] } } }",
          "The person gets free testnet HYPE for the agent's address at https://elysium.kinetiq.xyz/testnet-faucet",
        ],
        safety: "Spending limits per transaction and per day (1 HYPE and 10 HYPE by default, set with CLOAK_MAX_HYPE_PER_TX and CLOAK_MAX_HYPE_PER_DAY), dry_run on every action, testnet by default. Never paste a key into a chat or into this hosted server.",
        docs: "https://cloak.boblabs.tech/agent.md",
      })),
    );
    return server;
  }

  // ───────────── launches ─────────────

  server.registerTool(
    "create_launch",
    {
      title: "Create a sealed-bid launch",
      description: "Start a token launch: a sealed-bid auction that ends in one clearing price, with liquidity seeded at that price. Counts against the daily launch limit.",
      inputSchema: {
        name: z.string().min(1).max(40),
        symbol: z.string().min(1).max(12),
        sale_supply: amt("Tokens sold in the auction"),
        min_price: amt("Lowest price, in HYPE per token"),
        tick_size: amt("Price step between ticks, in HYPE").optional(),
        price_ticks: z.number().int().min(1).max(256).optional().describe("Number of price ticks (default 100)"),
        bidding_minutes: z.number().positive().max(60 * 24 * 14).optional().describe("How long bidding stays open (default 60)"),
        reveal_minutes: z.number().min(1).max(60 * 24).optional().describe("Time for bids to open after bidding closes (default 10)"),
        lp_percent: z.number().min(0).max(100).optional().describe("Share of the raise that seeds the pool (default 50)"),
        lp_tokens: amt("Tokens paired with that HYPE (default: same as sale_supply)").optional(),
        lp_lock_days: z.number().min(0).optional().describe("Lock the LP for this many days, after which the creator can take it (overrides creator_fees)"),
        creator_fees: z.boolean().optional().describe("Lock the LP forever and pay the pool's 0.3% trading fees to the creator (default true; false burns the LP)"),
        creator_share: amt("Tokens for the creator, at most 20% of supply, vesting linearly").optional(),
        vest_days: z.number().min(30).optional().describe("Vesting length for the creator share (default 90)"),
        metadata_uri: z.string().optional(),
        dry_run: dry,
      },
      annotations: WRITE,
    },
    safe(async (p: { name: string; symbol: string; sale_supply: string; min_price: string; tick_size?: string; price_ticks?: number; bidding_minutes?: number; reveal_minutes?: number; lp_percent?: number; lp_tokens?: string; lp_lock_days?: number; creator_fees?: boolean; creator_share?: string; vest_days?: number; metadata_uri?: string; dry_run?: boolean }) => {
      const { account, spending } = needWallet();
      const now = Number((await pub.getBlock()).timestamp);
      const commitEnd = now + Math.round((p.bidding_minutes ?? 60) * 60);
      const revealEnd = commitEnd + Math.round((p.reveal_minutes ?? 10) * 60);
      const params = {
        name: p.name,
        symbol: p.symbol,
        saleSupply: parseEther(p.sale_supply),
        lpReserve: p.lp_tokens ? parseEther(p.lp_tokens) : undefined,
        creatorAlloc: p.creator_share ? parseEther(p.creator_share) : undefined,
        creatorVestSecs: Math.round((p.vest_days ?? 90) * 86400),
        minPrice: parseEther(p.min_price),
        tickSize: parseEther(p.tick_size ?? p.min_price),
        numTicks: p.price_ticks ?? 100,
        commitEnd,
        revealEnd,
        lpBps: Math.round((p.lp_percent ?? 50) * 100),
        lpLockUntil: p.lp_lock_days ? revealEnd + Math.round(p.lp_lock_days * 86400) : p.creator_fees === false ? ("burn" as const) : ("fees" as const),
        metadataURI: p.metadata_uri,
      };
      spending.check("launches", 1n);
      const plan = { creator: account.address, ...p, biddingEnds: iso(commitEnd), revealsEnd: iso(revealEnd), topPrice: `${formatEther(params.minPrice + BigInt(params.numTicks - 1) * params.tickSize)} HYPE per token` };
      if (isDry(p.dry_run)) return { dryRun: true, wouldCreate: plan };
      return exclusive(async () => {
        const l = await cloak.createLaunch(params);
        spending.record("launches", 1n);
        return { created: true, auction: l.auction, token: l.token, tx: link(l.txHash), biddingEnds: plan.biddingEnds, revealsEnd: plan.revealsEnd, next: "Share the auction address. Bids open by themselves after bidding closes, and the keeper settles the launch." };
      });
    }),
  );

  server.registerTool(
    "place_sealed_bid",
    {
      title: "Place a sealed bid",
      description: "Commit a sealed bid: only a hash and a timelocked ciphertext go on chain, so nobody (other bidders, bots, the sequencer) sees price or size until bidding closes. It opens by itself afterwards. Spends the rounded deposit from the wallet; the unused part is refunded at settlement.",
      inputSchema: { auction: addr, max_price: amt("Highest price you'd pay, in HYPE per token"), quantity: amt("Tokens wanted"), dry_run: dry },
      annotations: WRITE,
    },
    safe(async ({ auction, max_price, quantity, dry_run }: { auction: string; max_price: string; quantity: string; dry_run?: boolean }) => {
      const { account, spending } = needWallet();
      const s = await cloak.getAuction(auction as Address);
      if (s.phase !== "commit") throw new Error(`Bidding has closed for ${s.tokenSymbol} (phase: ${s.phase}).`);
      const q = cloak.quoteBid(s, parseEther(max_price), parseEther(quantity));
      spending.check("hype", q.deposit);
      const plan = { launch: s.tokenSymbol, price: `${formatEther(q.price)} HYPE per token`, quantity, cost: hype(q.cost), deposit: hype(q.deposit), biddingEnds: iso(s.commitEnd) };
      if (isDry(dry_run)) return { dryRun: true, wouldBid: plan };
      return exclusive(async () => {
        const b = await cloak.bid(s.address, { maxPrice: parseEther(max_price), quantity: parseEther(quantity) });
        spending.record("hype", b.deposit);
        saveBid(account.address, b);
        return { placed: true, bidId: b.id, ...plan, tx: link(b.txHash), next: "Nothing else to do: the bid opens by itself after bidding closes. Check my_bids after settlement." };
      });
    }),
  );

  server.registerTool(
    "my_bids",
    { title: "My bids", description: "The wallet's bids on a launch: deposit, whether each has opened, and once settled the tokens won, refund and any penalty.", inputSchema: { auction: addr }, annotations: READ },
    safe(async ({ auction }: { auction: string }) => {
      const { account } = needWallet();
      const s = await cloak.getAuction(auction as Address);
      const bids = await cloak.bidsOf(s.address, account.address, await bidsFrom(s.address));
      return {
        launch: s.tokenSymbol,
        phase: s.phase,
        bids: bids.map((b) => ({ id: b.id, deposit: hype(b.deposit), opened: b.revealed, claimed: b.claimed, ...(s.settled ? { tokensWon: formatEther(b.tokens), refund: hype(b.refund), penalty: hype(b.penalty) } : {}) })),
      };
    }),
  );

  server.registerTool(
    "claim",
    {
      title: "Claim tokens and refunds",
      description:
        "After bids open, settle the launch if nobody has yet, then claim the wallet's tokens and refunds. Won tokens go straight into the private balance (privately: true, the default) when the launch supports it, so later trades can't be linked to the bid; refunds go to the wallet. Cloak's keeper pushes unclaimed bids to wallets publicly about an hour after bidding closes.",
      inputSchema: { auction: addr, privately: z.boolean().optional().describe("Claim won tokens into the private balance (default true where supported)"), dry_run: dry },
      annotations: WRITE,
    },
    safe(async ({ auction, privately, dry_run }: { auction: string; privately?: boolean; dry_run?: boolean }) => {
      const { account } = needWallet();
      let s = await cloak.getAuction(auction as Address);
      if (s.phase === "commit" || s.phase === "reveal") throw new Error(`${s.tokenSymbol} can't settle yet: bids are ${s.phase === "commit" ? "still being placed" : "still opening"} until ${iso(s.phase === "commit" ? s.commitEnd : s.revealEnd)}.`);
      const bids = await cloak.bidsOf(s.address, account.address, await bidsFrom(s.address));
      const open = bids.filter((b) => !b.claimed);
      // private claims: launches from this deployment's factory, once their private vault is open
      const canPrivate = async () =>
        privately !== false && !s.failed && (await bidsFrom(s.address)) === settings.launchesFromBlock && (await privateTradingOn(s.token));
      if (isDry(dry_run)) return { dryRun: true, wouldSettle: !s.settled, wouldClaim: open.map((b) => b.id), privately: s.settled ? await canPrivate() : privately !== false };
      return exclusive(async () => {
        const txs: string[] = [];
        if (!s.settled) {
          txs.push(link(await cloak.settle(s.address)));
          s = await cloak.getAuction(s.address);
        }
        const priv8 = await canPrivate();
        const won: typeof open = [];
        let publicWhy: string | undefined;
        if (priv8) {
          const p = await priv();
          for (const b of open.filter((x) => x.tokens > 0n)) {
            // a deposit limit can refuse a large claim; that bid is then claimed to the wallet instead
            const ok = await pub
              .simulateContract({ address: s.address, abi: cloakAuctionAbi, functionName: "claimPrivate", args: [b.id, 1n, 1n, "0x"], account: account.address })
              .then(() => true, (e) => ((publicWhy = explain(e)), false));
            if (!ok) continue;
            txs.push(link((await p.claimPrivately(wallet!, s.address, b.id)).txHash));
            won.push(b);
          }
        }
        const rest = open.filter((b) => !won.includes(b));
        if (rest.length) txs.push(link(await cloak.claim(s.address, rest.map((b) => b.id))));
        const after = await cloak.bidsOf(s.address, account.address, await bidsFrom(s.address));
        return {
          launch: s.tokenSymbol,
          settled: s.settled,
          ...(s.failed ? { failed: "No demand was revealed, so every bid was refunded in full." } : { clearingPrice: `${formatEther(s.clearingPrice)} HYPE per token` }),
          claimed: open.length ? open.map((b) => b.id) : "nothing left to claim (already paid out)",
          ...(won.length ? { claimedPrivately: won.map((b) => b.id), privateBalance: "won tokens are in the private balance (private_balance)" } : {}),
          ...(publicWhy ? { claimedToWallet: `some won tokens went to the wallet instead of the private balance: ${publicWhy}` } : {}),
          tokensWon: formatEther(after.reduce((a, b) => a + b.tokens, 0n)),
          refunds: hype(after.reduce((a, b) => a + b.refund, 0n)),
          txs,
        };
      });
    }),
  );

  server.registerTool(
    "enable_private_trading",
    { title: "Enable private trading", description: "Open a private vault for a settled launch's token so it can be traded from private balances. Anyone can do this once per token; it costs only gas.", inputSchema: { auction: addr, dry_run: dry }, annotations: WRITE },
    safe(async ({ auction, dry_run }: { auction: string; dry_run?: boolean }) => {
      const { wallet } = needWallet();
      const s = await cloak.getAuction(auction as Address);
      if (!s.settled || s.failed) throw new Error(`${s.tokenSymbol} needs to settle successfully first (phase: ${s.phase}).`);
      if (await privateTradingOn(s.token)) return { alreadyOn: true, token: s.token };
      const l = (await cloak.listLaunches()).find((x) => x.auction.toLowerCase() === s.address.toLowerCase());
      if (!l) throw new Error("This launch isn't from a Cloak factory, so it can't get a private vault.");
      const vaults = d.vaults ?? (await pub.readContract({ address: d.router, abi: privateRouterAbi, functionName: "vaults" }));
      if (isDry(dry_run)) return { dryRun: true, wouldEnable: s.tokenSymbol, factory: l.factory, launchIndex: l.index };
      return exclusive(async () => {
        const h = await wallet.writeContract({ address: vaults, abi: cloakVaultsAbi, functionName: "createPool", args: [l.factory, l.index] });
        await receipt(h);
        return { enabled: true, token: s.token, vault: await pub.readContract({ address: d.router, abi: privateRouterAbi, functionName: "poolOf", args: [s.token] }), tx: link(h) };
      });
    }),
  );

  // ───────────── private balances ─────────────

  server.registerTool(
    "unlock",
    { title: "Unlock the private account", description: "Derive the private account from one local signature (no transaction, nothing sent anywhere) and return its cloak: address, which others use to pay it privately.", inputSchema: {}, annotations: READ },
    safe(async () => {
      const p = await priv();
      return { cloakAddress: await p.address(), note: "Share the cloak: address to receive private payments. It doesn't reveal the wallet." };
    }),
  );

  server.registerTool(
    "private_balance",
    { title: "Private balances", description: "Balances only this account can see: HYPE, USDC and every launch token held privately.", inputSchema: { include_zero: z.boolean().optional() }, annotations: READ },
    safe(async ({ include_zero }: { include_zero?: boolean }) => {
      const p = await priv();
      const out: Record<string, string> = {};
      const tokens: Record<string, { token: Address; balance: string }> = {};
      for (const a of await vaults()) {
        const b = await balanceOf(a);
        if (b === 0n && !include_zero && a.kind === "token") continue;
        if (a.kind === "token") tokens[`${a.symbol} ${a.token.slice(0, 8)}`] = { token: a.token, balance: formatUnits(b, a.decimals) };
        else out[a.symbol] = formatUnits(b, a.decimals);
      }
      return { cloakAddress: await p.address(), balances: out, launchTokens: tokens };
    }),
  );

  server.registerTool(
    "shield",
    {
      title: "Shield into a private balance",
      description: "Deposit HYPE, USDC or a new launch token (one in the shared launch-token vault) from the wallet into the private balance. This is the one public step: it lands on a one-time key, so it can't be linked to what comes next.",
      inputSchema: { asset: z.string().describe('"HYPE", "USDC" or a launch token in the shared vault'), amount: amt("Amount"), dry_run: dry },
      annotations: WRITE,
    },
    safe(async ({ asset, amount, dry_run }: { asset: string; amount: string; dry_run?: boolean }) => {
      const { wallet, spending } = needWallet();
      const a = await resolve(asset);
      if (a.kind === "token" && !a.shared) throw new Error("Launch tokens enter a private balance by buying privately (private_swap), not by shielding.");
      const x = amountOf(amount, a.decimals);
      if (x === null) throw new Error("Give an exact amount to shield.");
      const c = await cost(a, x);
      spending.check(c.budget, c.value);
      if (isDry(dry_run)) return { dryRun: true, wouldShield: fmtAmt(a, x), ...(a.kind === "asset" ? { note: "The first time takes two transactions: an approval, then the deposit." } : {}) };
      return exclusive(async () => {
        const p = await priv();
        const h = a.kind === "hype" ? await p.shieldHype(wallet, x) : a.kind === "token" ? await (await shared()).shield(wallet, a.token, x) : await p.shieldToken(wallet, a.token, x);
        spending.record(c.budget, c.value);
        return { shielded: fmtAmt(a, x), privateBalance: fmtAmt(a, await balanceOf(a)), tx: link(h) };
      });
    }),
  );

  server.registerTool(
    "private_swap",
    {
      title: "Private swap",
      description: "Buy a launch token with private HYPE, or sell it for private HYPE. Proven on this machine and sent by a relayer, so the wallet never appears on the trade. The output lands back in the private balance.",
      inputSchema: { token: z.string().describe("Launch token symbol or address"), side: z.enum(["buy", "sell"]), amount: amt('HYPE to spend (buy) or tokens to sell (sell); "max" for the whole balance'), slippage_bps: z.number().int().min(1).max(5000).optional().describe("Max slippage in basis points (default 100 = 1%)"), dry_run: dry },
      annotations: WRITE,
    },
    safe(async ({ token, side, amount, slippage_bps, dry_run }: { token: string; side: "buy" | "sell"; amount: string; slippage_bps?: number; dry_run?: boolean }) => {
      const { spending } = needWallet();
      const t = await resolve(token);
      if (t.kind !== "token") throw new Error(`${t.symbol} isn't a launch token: private swaps trade launch tokens against HYPE.`);
      const p = await priv();
      const poolIn = side === "buy" ? d.hypePool : t.pool;
      const x = amountOf(amount, 18) ?? (t.shared && side === "sell" ? await (await shared()).maxWithdraw(t.token, "sharedSell") : await p.maxSpendable(d.hypePool === poolIn ? d.hypePool : poolIn, "privateSwap"));
      if (x <= 0n) throw new Error("Not enough private balance for this, counting the relayer's fee.");
      const c = await cost(side === "buy" ? (await vaults())[0] : t, x);
      spending.check(c.budget, c.value);
      const q = await quoteSwap(t, side, x);
      const inSym = side === "buy" ? "HYPE" : t.symbol;
      const outSym = side === "buy" ? t.symbol : "HYPE";
      if (isDry(dry_run)) return { dryRun: true, wouldSwap: `${formatEther(x)} ${inSym} for about ${formatEther(q.out)} ${outSym}`, relayerFee: `${formatEther(q.fee)} ${inSym}`, slippage: `${(slippage_bps ?? 100) / 100}%` };
      return exclusive(async () => {
        if (t.shared) {
          const sh = await shared();
          const h = side === "buy" ? await sh.buy(t.token, x, { slippageBps: slippage_bps ?? 100 }) : await sh.sell(t.token, x, { slippageBps: slippage_bps ?? 100 });
          await receipt(h);
          spending.record(c.budget, c.value);
          const hypeA = (await vaults())[0];
          return { swapped: `${formatEther(x)} ${inSym}`, expected: `${formatEther(q.out)} ${outSym}`, relayerFee: `${formatEther(q.fee)} HYPE or ${t.symbol}`, privateBalance: { HYPE: formatEther(await balanceOf(hypeA)), [t.symbol]: formatEther(await balanceOf(t)) }, tx: link(h), sentBy: "the relayer, not this wallet" };
        }
        const r = await (side === "buy" ? p.buy(t.token, x, { slippageBps: slippage_bps }) : p.sell(t.token, x, { slippageBps: slippage_bps }));
        await receipt(r.txHash);
        spending.record(c.budget, c.value);
        const outPool = side === "buy" ? t.pool : d.hypePool;
        return { swapped: `${formatEther(x)} ${inSym}`, expected: `${formatEther(r.expectedOut)} ${outSym}`, minimum: `${formatEther(r.minOut)} ${outSym}`, relayerFee: `${formatEther(r.relayerFee)} ${inSym}`, privateBalance: { [inSym]: formatEther(await p.balance(poolIn)), [outSym]: formatEther(await p.balance(outPool)) }, tx: link(r.txHash), sentBy: "the relayer, not this wallet" };
      });
    }),
  );

  server.registerTool(
    "batch_order",
    {
      title: "Batch order (hides size)",
      description: "Trade in the next batch round: the amount is split into standard sizes everyone uses, buys and sells cross at the round's average price, and only the net hits the pool. Observers can't tell how much any one trader moved. Fills when the round settles (about 30 s on testnet). A round only settles if its net trade moves the pool less than 5%, so keep orders small next to the pool; a round that can't settle is refunded after a delay.",
      inputSchema: { token: z.string().describe("Launch token symbol or address"), side: z.enum(["buy", "sell"]), amount: amt("HYPE to spend (buy) or tokens to sell (sell)"), dry_run: dry },
      annotations: WRITE,
    },
    safe(async ({ token, side, amount, dry_run }: { token: string; side: "buy" | "sell"; amount: string; dry_run?: boolean }) => {
      const { spending } = needWallet();
      const t = await resolve(token);
      if (t.kind !== "token") throw new Error(`${t.symbol} isn't a launch token: batch orders trade launch tokens against HYPE.`);
      const x = amountOf(amount, 18);
      if (x === null) throw new Error('Give an exact amount for a batch order ("max" works for private_swap).');
      const c = await cost(side === "buy" ? (await vaults())[0] : t, x);
      spending.check(c.budget, c.value);
      const p = await priv();
      if (t.shared && !d.sharedBatcher) throw new Error(`${t.symbol} is in the shared launch-token vault, which has no batch rounds on this deployment. Use private_swap.`);
      const round = t.shared ? await (await shared()).roundInfo() : await p.roundInfo();
      if (isDry(dry_run)) return { dryRun: true, wouldPlace: `${formatEther(x)} ${side === "buy" ? "HYPE" : t.symbol} as standard-size ${side} orders`, roundEndsAt: iso(round.endsAt) };
      return exclusive(async () => {
        const r = t.shared ? await (await shared()).batch(t.token, side, x) : await p.batch(t.token, side, x);
        const placed = r.orders.reduce((a, o) => a + o.size, 0n);
        const pc = await cost(side === "buy" ? (await vaults())[0] : t, placed);
        spending.record(pc.budget, pc.value);
        return {
          placed: r.orders.map((o) => ({ size: formatEther(o.size), round: o.round, tx: link(o.txHash) })),
          leftInBalance: formatEther(r.rest),
          next: "The output arrives in the private balance when the round settles. Check private_balance in a minute.",
        };
      });
    }),
  );

  server.registerTool(
    "private_send",
    {
      title: "Send privately",
      description: "Pay someone's cloak: address from the private balance. The chain sees that a private transaction happened, but not who sent it, who got it or how much. For tokens in the shared launch-token vault it can't even tell which token (the relayer is paid from private HYPE, so keep a little private HYPE).",
      inputSchema: { asset: z.string().describe('"HYPE", "USDC" or a launch token'), to: z.string().describe("Recipient cloak: address"), amount: amt('Amount, or "max"'), dry_run: dry },
      annotations: WRITE,
    },
    safe(async ({ asset, to, amount, dry_run }: { asset: string; to: string; amount: string; dry_run?: boolean }) => {
      const { spending } = needWallet();
      if (!to.startsWith("cloak:")) throw new Error("The recipient must be a cloak: address (the receiver gets it from unlock or the Portfolio page).");
      const a = await resolve(asset);
      const p = await priv();
      const sharedTok = a.kind === "token" && a.shared;
      const x = amountOf(amount, a.decimals) ?? (sharedTok ? await balanceOf(a) : await p.maxSpendable(a.pool, "transact"));
      if (x <= 0n) throw new Error("Not enough private balance for this, counting the relayer's fee.");
      const c = await cost(a, x);
      spending.check(c.budget, c.value);
      if (isDry(dry_run)) return { dryRun: true, wouldSend: fmtAmt(a, x), to, ...(sharedTok ? { relayerFee: "paid from your private HYPE, so the send doesn't show which token moved" } : {}) };
      return exclusive(async () => {
        if (sharedTok) {
          const h = await (await shared()).send(a.token, x, to);
          await receipt(h);
          spending.record(c.budget, c.value);
          return { sent: fmtAmt(a, x), to, privateBalance: fmtAmt(a, await balanceOf(a)), tx: link(h), visibleOnChain: "a private transaction happened; no sender, recipient, amount, or even which token" };
        }
        const h = await p.send(a.kind === "hype" ? p.hypeMarket.token : a.token, to, x);
        await receipt(h);
        spending.record(c.budget, c.value);
        return { sent: fmtAmt(a, x), to, privateBalance: fmtAmt(a, await p.balance(a.pool)), tx: link(h), visibleOnChain: "a private transaction happened; no sender, recipient or amount" };
      });
    }),
  );

  server.registerTool(
    "withdraw",
    {
      title: "Withdraw to an address",
      description: "Move funds from the private balance to a normal 0x address (public on purpose). A brand-new address keeps the most privacy. Cloak keeps 0.25%, and the relayer takes a small fee for gas.",
      inputSchema: { asset: z.string().describe('"HYPE", "USDC" or a launch token'), to: addr, amount: amt('Amount, or "max"'), dry_run: dry },
      annotations: WRITE,
    },
    safe(async ({ asset, to, amount, dry_run }: { asset: string; to: string; amount: string; dry_run?: boolean }) => {
      const { spending } = needWallet();
      if (!isAddress(to)) throw new Error("`to` must be a 0x address.");
      const a = await resolve(asset);
      const p = await priv();
      const kind = a.kind === "hype" ? "unshieldHype" : "transact";
      const sharedTok = a.kind === "token" && a.shared;
      const x = amountOf(amount, a.decimals) ?? (sharedTok ? await (await shared()).maxWithdraw(a.token) : await p.maxSpendable(a.pool, kind));
      if (x <= 0n) throw new Error("Not enough private balance for this, counting the relayer's fee.");
      const c = await cost(a, x);
      spending.check(c.budget, c.value);
      const arrives = await pub.readContract({ address: a.pool, abi: shieldedPoolAbi, functionName: "afterFee", args: [x] });
      if (isDry(dry_run)) return { dryRun: true, wouldWithdraw: fmtAmt(a, x), arrives: fmtAmt(a, arrives), to };
      return exclusive(async () => {
        const h = a.kind === "hype" ? await p.unshieldHype(to as Address, x) : sharedTok ? await (await shared()).unshield(a.token, x, to as Address) : await p.unshieldToken(a.token, to as Address, x);
        await receipt(h);
        spending.record(c.budget, c.value);
        return { withdrew: fmtAmt(a, x), arrived: fmtAmt(a, arrives), to, privateBalance: fmtAmt(a, await balanceOf(a)), tx: link(h) };
      });
    }),
  );

  // ───────────── payment links ─────────────

  /** HYPE or USDC: the only tokens a payment link carries today. */
  async function linkAsset(asset: string): Promise<Asset> {
    const a = await resolve(asset);
    if (a.kind === "token") throw new Error("Payment links carry HYPE or USDC.");
    return a;
  }
  /** A wallet-less client for the private account a claim link opens. */
  async function linkClient(url: string, passcode?: string) {
    const l = parseClaimLink(url);
    if (l.locked && passcode === undefined) throw new Error(`This link is locked. Pass its passcode${l.hint ? ` (the answer to: "${l.hint}")` : ""}.`);
    // a locked link with a check refuses a wrong passcode here, before anything touches the network
    const c = new CloakPrivate(pub, d.router, await openLinkKeys(l, passcode), prover, submit, d.vaultsBlock ?? d.routerBlock, d.batcher, d.migrator);
    for (const a of d.assets ?? []) c.addAsset(a);
    await c.loadMarkets();
    return { l, c };
  }
  const linkTokenOf = (c: CloakPrivate, a: Asset) => (a.kind === "hype" ? c.hypeMarket.token : a.token);

  server.registerTool(
    "create_payment_link",
    {
      title: "Send money as a link",
      description: "Put HYPE or USDC from the private balance into a link anyone can claim: into their private balance, or straight to any wallet with no gas (the relayer takes its fee from the link). Optional: a message, a passcode (with a riddle shown to whoever opens it), or several equal shares that different people each claim (a red envelope). Treat the link like cash and keep it: it is the only way to the money, and take_back works with it until someone claims.",
      inputSchema: {
        asset: z.enum(["HYPE", "USDC"]),
        amount: amt("Total the link holds (split evenly across shares)"),
        message: z.string().max(140).optional().describe("A message shown to whoever opens it"),
        from: z.string().max(40).optional().describe("A name to show as the sender"),
        passcode: z.string().max(80).optional().describe("Lock it: the link alone then opens nothing"),
        hint: z.string().max(120).optional().describe("A riddle or hint shown on the claim page, whose answer is the passcode"),
        shares: z.number().int().min(1).max(LINK_SHARES_MAX).optional().describe("Split into this many equal shares (default 1)"),
        cover_claim_fee: z.boolean().optional().describe("Add the relayer's claim fee so they get the full amount (default true)"),
        dry_run: dry,
      },
      annotations: WRITE,
    },
    safe(async (x: { asset: string; amount: string; message?: string; from?: string; passcode?: string; hint?: string; shares?: number; cover_claim_fee?: boolean; dry_run?: boolean }) => {
      const { spending } = needWallet();
      const a = await linkAsset(x.asset);
      const whole = amountOf(x.amount, a.decimals);
      if (whole === null) throw new Error("Give an exact amount for the link.");
      if (x.hint && !x.passcode) throw new Error("A hint needs a passcode: the hint is the riddle, the passcode its answer.");
      const n = x.shares ?? 1;
      const share = whole / BigInt(n);
      if (share === 0n) throw new Error("That's too little to split that many ways.");
      const p = await priv();
      const kinds = a.kind === "hype" ? (["transact", "unshieldHype"] as const) : (["transact"] as const);
      const fees = await Promise.all(kinds.map((k) => p.relayFee(k, a.pool)));
      const claimFee = x.cover_claim_fee === false ? 0n : fees.reduce((m, q) => (q.fee > m ? q.fee : m), 0n);
      const each = share + claimFee;
      const total = each * BigInt(n);
      const c = await cost(a, total);
      spending.check(c.budget, c.value);
      if (isDry(x.dry_run)) return { dryRun: true, wouldLock: `${fmtAmt(a, total)} in ${n} share${n > 1 ? "s" : ""} of ${fmtAmt(a, each)}`, claimFeeCovered: fmtAmt(a, claimFee * BigInt(n)), locked: !!x.passcode };
      return exclusive(async () => {
        const secret = newLinkSecret();
        const keys = await linkKeys(secret, x.passcode);
        const to = await linkAddress(keys);
        const check = x.passcode ? await linkCheck(keys) : undefined;
        let block = 0n;
        const txs: string[] = [];
        for (let i = 0; i < n; i++) {
          const h = await p.send(linkTokenOf(p, a), to, each);
          block = (await receipt(h)).blockNumber;
          txs.push(link(h));
        }
        spending.record(c.budget, c.value);
        const url = buildClaimLink({ secret, block, token: a.symbol as "HYPE" | "USDC", amount: formatUnits(n > 1 ? share : whole, a.decimals), message: x.message, from: x.from, locked: !!x.passcode, hint: x.hint, shares: n, check });
        return {
          link: url,
          holds: `${fmtAmt(a, whole)}${n > 1 ? ` in ${n} shares of ${fmtAmt(a, share)}` : ""}`,
          ...(x.passcode ? { passcode: x.passcode, sendThePasscodeSeparately: true } : {}),
          txs,
          keepThisLink: "Anyone with the link can claim it. To take the money back before then, call claim_payment_link with it.",
        };
      });
    }),
  );

  server.registerTool(
    "check_payment_link",
    {
      title: "Check a payment link",
      description: "What a claim link still holds (and how many shares are left), without claiming it.",
      inputSchema: { link: z.string().describe("The claim link (https://…/claim#…)"), passcode: z.string().optional() },
      annotations: READ,
    },
    safe(async ({ link: url, passcode }: { link: string; passcode?: string }) => {
      const { l, c } = await linkClient(url, passcode);
      const out: Record<string, string> = {};
      let notes = 0;
      let spent = 0;
      for (const sym of ["HYPE", "USDC"]) {
        const a = await linkAsset(sym).catch(() => null);
        if (!a) continue;
        const all = await c.history(a.pool);
        const live = all.filter((x) => !x.spent);
        notes += live.length;
        spent += all.length - live.length;
        out[sym] = fmtAmt(a, live.reduce((s, x) => s + x.amount, 0n));
      }
      const status = notes > 0 ? (spent > 0 ? "partly claimed" : "waiting") : spent > 0 ? "claimed" : l.locked && !l.check ? "empty (a wrong passcode, already claimed, or not funded yet)" : "not funded yet";
      return { holds: out, status, claimed: spent, ...(l.shares ? { sharesLeft: `${notes} of ${l.shares}` } : {}), ...(l.message ? { message: l.message } : {}), ...(l.from ? { from: l.from } : {}), empty: notes === 0 };
    }),
  );

  server.registerTool(
    "claim_payment_link",
    {
      title: "Claim a payment link",
      description: "Claim the money in a claim link: into this account's private balance (default), or out to any 0x address. Also how a sender takes back a link nobody claimed. The relayer submits it and takes its fee from the link, so no gas is needed. On a link split into shares, it claims one share.",
      inputSchema: { link: z.string().describe("The claim link"), passcode: z.string().optional(), to: z.string().optional().describe('"private" (default) or a 0x address'), dry_run: dry },
      annotations: WRITE,
    },
    safe(async ({ link: url, passcode, to, dry_run }: { link: string; passcode?: string; to?: string; dry_run?: boolean }) => {
      const { l, c } = await linkClient(url, passcode);
      const out = to && to !== "private";
      if (out && !isAddress(to)) throw new Error('`to` must be "private" or a 0x address.');
      const held: Asset[] = [];
      let spent = 0;
      for (const sym of ["HYPE", "USDC"]) {
        const a = await linkAsset(sym).catch(() => null);
        if (!a) continue;
        const all = await c.history(a.pool);
        spent += all.filter((x) => x.spent).length;
        if (all.some((x) => !x.spent)) held.push(a);
      }
      if (!held.length)
        throw new Error(
          spent > 0 ? "This link is empty: it was already claimed, or the sender took it back."
          : l.locked && !l.check ? "Nothing opens with that passcode: it's wrong, the link was already claimed, or its payment hasn't landed yet."
          : "This link holds nothing yet: the sender's payment hasn't landed. Try again in a minute.",
        );
      if (isDry(dry_run)) return { dryRun: true, holds: await Promise.all(held.map(async (a) => fmtAmt(a, await c.balance(a.pool)))), wouldClaimTo: out ? to : "this account's private balance", ...(l.shares ? { oneShareOf: l.shares } : {}) };
      return exclusive(async () => {
        const dest = out ? (to as string) : await (await priv()).address();
        const claimed = [];
        for (const a of held) {
          let r;
          for (let attempt = 0; ; attempt++) {
            try {
              r = await c.sweep(linkTokenOf(c, a), dest, () => {}, { one: !!l.shares });
              await receipt(r.txHash);
              break;
            } catch (e) {
              if (!l.shares || attempt >= 3 || !/already|spent|nullifier|being used/i.test(String(e))) throw e;
            }
          }
          const got = out ? await pub.readContract({ address: a.pool, abi: shieldedPoolAbi, functionName: "afterFee", args: [r.amount] }) : r.amount;
          claimed.push({ claimed: fmtAmt(a, got), tx: link(r.txHash) });
          if (l.shares) break;
        }
        return { claimed, to: out ? to : "this account's private balance", ...(l.message ? { message: l.message } : {}) };
      });
    }),
  );

  server.registerTool(
    "request_payment_link",
    {
      title: "Request a payment with a link",
      description: "A link that asks to be paid HYPE or USDC, with an optional amount (leave it out for a tip jar), note and name. By default it pays this account's cloak: address privately; pass a 0x address to be paid there instead. Nothing goes on chain until someone pays.",
      inputSchema: { asset: z.enum(["HYPE", "USDC"]), amount: z.string().optional().describe('Amount in whole units, e.g. "25"'), note: z.string().max(140).optional(), name: z.string().max(40).optional(), to: z.string().optional().describe("A 0x address or cloak: address to be paid at (default: this account's cloak: address)") },
      annotations: READ,
    },
    safe(async ({ asset, amount, note, name, to }: { asset: "HYPE" | "USDC"; amount?: string; note?: string; name?: string; to?: string }) => {
      const payTo = to ?? (await (await priv()).address());
      return { link: buildRequestLink({ to: payTo, token: asset, amount, note, name }), payTo, howTheyPay: payTo.startsWith("cloak:") ? "a private transfer: nobody sees who paid whom, or how much" : "from their private balance to this address: their wallet never shows; the amount and this address are public" };
    }),
  );

  server.registerTool(
    "pay_payment_request",
    {
      title: "Pay a request link",
      description: "Pay a request link (https://…/pay#to=…) from the private balance: a private transfer to a cloak: address, or a withdrawal to a 0x address that covers Cloak's fee so the payee gets the exact amount.",
      inputSchema: { link: z.string().describe("The request link"), amount: z.string().optional().describe("Needed when the request leaves the amount to the payer"), dry_run: dry },
      annotations: WRITE,
    },
    safe(async ({ link: url, amount, dry_run }: { link: string; amount?: string; dry_run?: boolean }) => {
      const { spending } = needWallet();
      const r = parseRequestLink(url);
      const a = await linkAsset(r.token);
      const raw = r.amount ?? amount;
      if (!raw) throw new Error("This request leaves the amount to you: pass `amount`.");
      if (r.amount && amount && amount !== r.amount) throw new Error(`The request is for ${r.amount} ${r.token}; it can't be paid with a different amount.`);
      const units = amountOf(raw, a.decimals);
      if (units === null) throw new Error("Give an exact amount.");
      const p = await priv();
      const toCloak = r.to.startsWith("cloak:");
      let gross = units;
      if (!toCloak) {
        const one = 10n ** BigInt(a.decimals);
        const after = await pub.readContract({ address: a.pool, abi: shieldedPoolAbi, functionName: "afterFee", args: [one] });
        gross = after > 0n ? (units * one + after - 1n) / after : units;
      }
      const c = await cost(a, gross);
      spending.check(c.budget, c.value);
      if (isDry(dry_run)) return { dryRun: true, wouldPay: fmtAmt(a, units), to: r.to, ...(r.note ? { note: r.note } : {}), ...(r.name ? { requestedBy: r.name } : {}), ...(toCloak ? {} : { leavesYourBalance: fmtAmt(a, gross) }) };
      return exclusive(async () => {
        const h = toCloak ? await p.send(linkTokenOf(p, a), r.to, gross) : a.kind === "hype" ? await p.unshieldHype(r.to as Address, gross) : await p.unshieldToken(a.token, r.to as Address, gross);
        await receipt(h);
        spending.record(c.budget, c.value);
        return { paid: fmtAmt(a, units), to: r.to, ...(r.note ? { for: r.note } : {}), tx: link(h), privateBalance: fmtAmt(a, await p.balance(a.pool)) };
      });
    }),
  );

  server.registerTool(
    "place_drop_bid",
    {
      title: "Bid on an NFT drop",
      description: "Seal a bid on an NFT drop or WL spot sale: up to max_price HYPE each for quantity NFTs (or spots). Nobody can read it until bidding closes; it opens by itself afterwards. A wallet on the drop's WL bids with its boost automatically. Spends the deposit from the wallet; whatever isn't paid at the clearing price comes back.",
      inputSchema: { drop: addr, max_price: amt("Most you'd pay for each, in HYPE (at least the floor)"), quantity: z.number().int().min(1).max(20).optional().describe("How many (default 1)"), dry_run: dry },
      annotations: WRITE,
    },
    safe(async ({ drop, max_price, quantity, dry_run }: { drop: string; max_price: string; quantity?: number; dry_run?: boolean }) => {
      const { wallet: w, account, spending } = needWallet();
      if (!isAddress(drop)) throw new Error("That isn't a drop address.");
      const c = dropsFor(w);
      const s = await c.get(drop as Address);
      if (s.phase !== "bidding") throw new Error(s.phase === "gtd" ? `Bidding opens at ${iso(s.gtdEnd)}, when the GTD window closes.` : "Bidding on this drop has closed.");
      const price = amountOf(max_price, 18);
      if (price === null) throw new Error(`"${max_price}" isn't an amount of HYPE.`);
      if (price < s.floor) throw new Error(`Bid at least the floor, ${formatEther(s.floor)} HYPE.`);
      const qty = quantity ?? 1;
      if (qty > s.maxPerBid) throw new Error(`This drop takes at most ${s.maxPerBid} per bid.`);
      const tick = CloakDrops.tickFor(s, price);
      const level = CloakDrops.priceAt(s, tick);
      const deposit = level * BigInt(qty);
      const { wl } = await c.listed(s.address, account.address);
      spending.check("hype", deposit);
      const plan = { drop: s.address, quantity: qty, bidLevel: `${formatEther(level)} HYPE each${level < price ? ` (your ${max_price} snaps down to the nearest level)` : ""}`, deposit: hype(deposit), wl, ...(wl ? { ranksAs: `${formatEther((level * BigInt(10_000 + s.wlBoostBps)) / 10_000n)} HYPE each` } : {}), biddingEnds: iso(s.commitEnd) };
      if (isDry(dry_run)) return { dryRun: true, wouldBid: plan };
      return exclusive(async () => {
        const b = await c.bid(s.address, { price: level, quantity: qty, wl });
        spending.record("hype", deposit);
        return { placed: true, bidId: b.id.toString(), ...plan, tx: link(b.txHash), next: "The bid opens by itself after bidding closes. Check results with get_drop or my_drop_bids, then claim_drop." };
      });
    }),
  );

  server.registerTool(
    "my_drop_bids",
    { title: "My drop bids", description: "This wallet's bids on a drop: sealed or opened, and once settled what each won, paid and gets back.", inputSchema: { drop: addr }, annotations: READ },
    safe(async ({ drop }: { drop: string }) => {
      const { account } = needWallet();
      if (!isAddress(drop)) throw new Error("That isn't a drop address.");
      const c = dropsFor();
      const s = await c.get(drop as Address);
      const mine = await c.bids(s.address, account.address);
      const held = s.settled ? await c.refundOwed(s.address, account.address) : 0n;
      return { drop: s.address, phase: dropPhase(s), bids: mine.map((b) => bidView(b, s.phase === "settled")), ...(held > 0n ? { refundWaiting: hype(held) } : {}) };
    }),
  );

  server.registerTool(
    "claim_drop",
    {
      title: "Claim from a drop",
      description: "Once a drop settles, take this wallet's NFTs and refunds now instead of waiting for the keeper (which delivers about an hour after settling). to sends the NFTs to another wallet, a fresh one say; refunds always come back to the bidding wallet.",
      inputSchema: { drop: addr, to: addr.optional().describe("Where the NFTs go (default: this wallet)"), dry_run: dry },
      annotations: WRITE,
    },
    safe(async ({ drop, to, dry_run }: { drop: string; to?: string; dry_run?: boolean }) => {
      const { wallet: w, account } = needWallet();
      if (!isAddress(drop)) throw new Error("That isn't a drop address.");
      if (to && !isAddress(to)) throw new Error(`${to} isn't a wallet address.`);
      const c = dropsFor(w);
      const s = await c.get(drop as Address);
      if (s.phase !== "settled") throw new Error("This drop hasn't settled yet. Bids open by themselves after bidding closes, then it settles.");
      const open = (await c.bids(s.address, account.address)).filter((b) => !b.claimed);
      const held = await c.refundOwed(s.address, account.address);
      if (!open.length && held === 0n) return { nothingToClaim: true, note: "Every bid from this wallet has already been delivered." };
      const plan = { bids: open.map((b) => ({ id: b.id.toString(), nfts: b.nfts, refund: hype(b.refund) })), nftsTo: to ?? account.address, ...(held > 0n ? { heldRefund: hype(held) } : {}) };
      if (isDry(dry_run)) return { dryRun: true, wouldClaim: plan };
      return exclusive(async () => {
        const txs: string[] = [];
        for (const b of open) txs.push(link(to && b.nfts > 0 ? await c.claimTo(s.address, b.id, to as Address) : await c.claim(s.address, b.id)));
        if (held > 0n) txs.push(link(await c.withdrawRefund(s.address, account.address)));
        return { claimed: true, ...plan, txs };
      });
    }),
  );

  server.registerTool(
    "set_whitelist_wallets",
    {
      title: "Name wallets for WL spots",
      description: "In a WL spot sale this wallet won, name the Elysium wallets to whitelist, one per spot won (a fresh wallet is fine). Calling again replaces them, until the sale's deadline.",
      inputSchema: { drop: addr, wallets: z.array(z.string()).min(1).max(20).describe("One 0x wallet per spot won, in order"), dry_run: dry },
      annotations: WRITE,
    },
    safe(async ({ drop, wallets, dry_run }: { drop: string; wallets: string[]; dry_run?: boolean }) => {
      const { wallet: w, account } = needWallet();
      if (!isAddress(drop)) throw new Error("That isn't a drop address.");
      const sp = spotsFor(w);
      if (!sp) throw new Error("WL spot sales aren't deployed on this network yet.");
      const sale = await sp.sale(drop as Address);
      if (!sale) throw new Error("This drop isn't a WL spot sale.");
      const s = await sp.drops.get(drop as Address);
      if (s.phase !== "settled") throw new Error("Wallets can be named once the sale settles.");
      if (Date.now() / 1000 >= sale.deadline) throw new Error(`The deadline to name wallets passed at ${iso(sale.deadline)}, so the whitelist is final.`);
      const wins = (await sp.drops.bids(s.address, account.address)).filter((b) => b.nfts > 0);
      const spots = wins.reduce((a, b) => a + b.nfts, 0);
      if (!spots) throw new Error("This wallet didn't win a spot in this sale.");
      const bad = wallets.find((x) => !isAddress(x.trim()));
      if (bad !== undefined) throw new Error(`${bad} isn't a wallet address.`);
      if (wallets.length !== spots) throw new Error(`This wallet won ${spots} spot${spots > 1 ? "s" : ""}: name exactly ${spots} wallet${spots > 1 ? "s" : ""}.`);
      if (new Set(wallets.map((x) => x.trim().toLowerCase())).size !== wallets.length) throw new Error("Each spot needs a different wallet.");
      let k = 0;
      const plan = wins.map((b) => ({ bid: b.id.toString(), wallets: wallets.slice(k, (k += b.nfts)).map((x) => x.trim()) }));
      if (isDry(dry_run)) return { dryRun: true, partner: sale.partner, wouldName: plan, deadline: iso(sale.deadline) };
      return exclusive(async () => {
        const txs: string[] = [];
        for (const p of plan) txs.push(link(await sp.setWallets(s.address, BigInt(p.bid), p.wallets)));
        return { named: true, partner: sale.partner, wallets: plan, deadline: iso(sale.deadline), txs, note: "Change them any time before the deadline by calling this again." };
      });
    }),
  );

  return server;
}
