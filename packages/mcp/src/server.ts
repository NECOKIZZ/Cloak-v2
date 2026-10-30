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
  cloakPairAbi,
  createProver,
  loadProver,
  privateRouterAbi,
  relayerSubmitter,
  shieldedPoolAbi,
  type AuctionState,
  type Prover,
  type Wallet,
} from "@cloakely/sdk";
import type { Settings } from "./config.js";
import { Spending, show, type Budget } from "./limits.js";

export { loadSettings, type Settings, type Limits } from "./config.js";
export { Spending } from "./limits.js";

export const VERSION = "0.1.2";
export const HOSTED_URL = "https://cloak.boblabs.tech/mcp";

const INSTRUCTIONS = `Cloak: sealed-bid token launches and private trading on Kinetiq's Elysium (HYPE is the gas and base currency).

Launches: create_launch starts a sealed-bid auction. place_sealed_bid commits a bid that nobody can read until bidding closes; bids then open by themselves (the keeper reveals them from the drand beacon), so there is nothing to come back for. Everyone who wins pays one clearing price. After settlement, claim pays out tokens and refunds (the keeper usually pushes claims already), and enable_private_trading opens a private vault for the token if nobody has yet.

Private balances: shield moves HYPE or USDC from the wallet into a private balance (the one public step). private_swap, batch_order, private_send and withdraw then run from that balance: each is proven on this machine and sent by a relayer, so the wallet never appears on chain. batch_order also hides trade size. withdraw lands funds at a normal address, ideally a fresh one. Amounts are in whole units ("0.5" HYPE), and send, sell and withdraw accept "max".

Safety: every action that moves value is checked against per-transaction and daily spending limits (see cloak_info), and any write tool takes dry_run: true to see exactly what would happen without signing anything. Use dry_run first when unsure.`;

const HOSTED_INSTRUCTIONS = `Cloak's hosted MCP server: read and plan for Cloak, sealed-bid token launches and private trading on Kinetiq's Elysium testnet (HYPE is the gas and base currency).

It never signs and never holds keys. Use it to find launches (list_launches, get_launch), price a sealed bid (quote_bid) or a private swap (quote_swap), see vault totals (vault_stats) and plan a launch (plan_launch). Bids stay sealed until bidding closes, so demand only shows after that. To actually launch, bid or trade, the agent needs the local server: connect_full_agent explains it. Never send a private key, note secret or recovery phrase here; calls that look like they carry one are refused.`;

type Asset =
  | { kind: "hype"; symbol: "HYPE"; token: Address; pool: Address; decimals: 18 }
  | { kind: "asset"; symbol: string; token: Address; pool: Address; decimals: number }
  | { kind: "token"; symbol: string; token: Address; pool: Address; pair: Address; decimals: 18 };

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
  const cloak = new Cloak(pub, wallet, d.factory);
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

  let privP: Promise<CloakPrivate> | undefined;
  async function priv(): Promise<CloakPrivate> {
    if (!wallet) throw new Error("No wallet configured: set CLOAK_KEY_FILE (or CLOAK_PRIVATE_KEY) to use private balances.");
    privP ??= (async () => {
      const keys = await CloakPrivate.keysFromWallet(wallet, { chainId: settings.chain.id, router: d.router, verify: true });
      const p = new CloakPrivate(pub, d.router, keys, prover, submit, d.routerBlock, d.batcher, d.migrator);
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

  /** Every asset with a private vault: HYPE, USDC-like assets, and every launch token with a private market. */
  async function vaults(): Promise<Asset[]> {
    const c = { address: d.router, abi: privateRouterAbi } as const;
    const n = await pub.readContract({ ...c, functionName: "tokensCount" });
    const out: Asset[] = [{ kind: "hype", symbol: "HYPE", token: d.whype, pool: d.hypePool, decimals: 18 }];
    for (const a of d.assets ?? []) out.push({ kind: "asset", symbol: a.symbol, token: a.token, pool: a.pool, decimals: a.decimals });
    const toks = await Promise.all(Array.from({ length: Number(n) - 1 }, (_, i) => pub.readContract({ ...c, functionName: "tokens", args: [BigInt(i + 1)] })));
    for (const token of toks) {
      const [pool, pair, symbol] = await Promise.all([
        pub.readContract({ ...c, functionName: "poolOf", args: [token] }),
        pub.readContract({ ...c, functionName: "pairOf", args: [token] }),
        symbolOf(token),
      ]);
      out.push({ kind: "token", symbol, token, pool, pair, decimals: 18 });
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
    const fee = await submit.quote!("privateSwap", poolIn).then((q) => q.fee, () => 0n);
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
      liquidity: `${s.lpBps / 100}% of the raise seeds the pool at the clearing price; LP ${s.lpLockUntil === 0 ? "burned" : `locked until ${iso(s.lpLockUntil)}`}`,
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
          toPool: `${lp}% of the raise, paired with tokens at the clearing price; the LP is burned unless you lock it`,
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
        steps: [
          "Make a fresh wallet just for the agent and fund it with testnet HYPE from https://elysium.kinetiq.xyz/testnet-faucet",
          "Save its private key to a file only you can read, for example ~/.cloak-agent-key",
          "Claude Code: claude mcp add cloak --env CLOAK_KEY_FILE=$HOME/.cloak-agent-key -- npx -y @cloakely/mcp",
          'Other clients: { "mcpServers": { "cloak": { "command": "npx", "args": ["-y", "@cloakely/mcp"], "env": { "CLOAK_KEY_FILE": "/path/to/key" } } } }',
        ],
        safety: "Spending limits per transaction and per day (1 HYPE and 10 HYPE by default, set with CLOAK_MAX_HYPE_PER_TX and CLOAK_MAX_HYPE_PER_DAY), dry_run on every action, testnet by default. Never paste a key into a chat or into this hosted server.",
        docs: "https://github.com/NECOKIZZ/Cloak/tree/main/packages/mcp",
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
        lp_lock_days: z.number().min(0).optional().describe("Lock the LP for this many days instead of burning it (default: burn)"),
        creator_share: amt("Tokens for the creator, at most 20% of supply, vesting linearly").optional(),
        vest_days: z.number().min(30).optional().describe("Vesting length for the creator share (default 90)"),
        metadata_uri: z.string().optional(),
        dry_run: dry,
      },
      annotations: WRITE,
    },
    safe(async (p: { name: string; symbol: string; sale_supply: string; min_price: string; tick_size?: string; price_ticks?: number; bidding_minutes?: number; reveal_minutes?: number; lp_percent?: number; lp_tokens?: string; lp_lock_days?: number; creator_share?: string; vest_days?: number; metadata_uri?: string; dry_run?: boolean }) => {
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
        lpLockUntil: p.lp_lock_days ? now + Math.round(p.lp_lock_days * 86400) : ("burn" as const),
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
      const bids = await cloak.bidsOf(s.address, account.address, settings.launchesFromBlock);
      return {
        launch: s.tokenSymbol,
        phase: s.phase,
        bids: bids.map((b) => ({ id: b.id, deposit: hype(b.deposit), opened: b.revealed, claimed: b.claimed, ...(s.settled ? { tokensWon: formatEther(b.tokens), refund: hype(b.refund), penalty: hype(b.penalty) } : {}) })),
      };
    }),
  );

  server.registerTool(
    "claim",
    { title: "Claim tokens and refunds", description: "After bids open, settle the launch if nobody has yet, then claim the wallet's tokens and refunds. Cloak's keeper usually pushes claims already.", inputSchema: { auction: addr, dry_run: dry }, annotations: WRITE },
    safe(async ({ auction, dry_run }: { auction: string; dry_run?: boolean }) => {
      const { account } = needWallet();
      let s = await cloak.getAuction(auction as Address);
      if (s.phase === "commit" || s.phase === "reveal") throw new Error(`${s.tokenSymbol} can't settle yet: bids are ${s.phase === "commit" ? "still being placed" : "still opening"} until ${iso(s.phase === "commit" ? s.commitEnd : s.revealEnd)}.`);
      const bids = await cloak.bidsOf(s.address, account.address, settings.launchesFromBlock);
      const open = bids.filter((b) => !b.claimed);
      if (isDry(dry_run)) return { dryRun: true, wouldSettle: !s.settled, wouldClaim: open.map((b) => b.id) };
      return exclusive(async () => {
        const txs: string[] = [];
        if (!s.settled) {
          txs.push(link(await cloak.settle(s.address)));
          s = await cloak.getAuction(s.address);
        }
        if (open.length) txs.push(link(await cloak.claim(s.address, open.map((b) => b.id))));
        const after = await cloak.bidsOf(s.address, account.address, settings.launchesFromBlock);
        return {
          launch: s.tokenSymbol,
          settled: s.settled,
          ...(s.failed ? { failed: "No demand was revealed, so every bid was refunded in full." } : { clearingPrice: `${formatEther(s.clearingPrice)} HYPE per token` }),
          claimed: open.length ? open.map((b) => b.id) : "nothing left to claim (already paid out)",
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
      const idx = (await cloak.listLaunches()).findIndex((l) => l.auction.toLowerCase() === s.address.toLowerCase());
      if (idx < 0) throw new Error("This launch isn't from the current Cloak factory, so it can't get a private vault.");
      if (isDry(dry_run)) return { dryRun: true, wouldEnable: s.tokenSymbol, launchIndex: idx };
      return exclusive(async () => {
        const h = await wallet.writeContract({ address: d.router, abi: privateRouterAbi, functionName: "createPool", args: [BigInt(idx)] });
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
        const b = await p.balance(a.pool);
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
      description: "Deposit HYPE or USDC from the wallet into the private balance. This is the one public step: it lands on a one-time key, so it can't be linked to what comes next.",
      inputSchema: { asset: z.string().describe('"HYPE" or "USDC"'), amount: amt("Amount"), dry_run: dry },
      annotations: WRITE,
    },
    safe(async ({ asset, amount, dry_run }: { asset: string; amount: string; dry_run?: boolean }) => {
      const { wallet, spending } = needWallet();
      const a = await resolve(asset);
      if (a.kind === "token") throw new Error("Launch tokens enter a private balance by buying privately (private_swap), not by shielding.");
      const x = amountOf(amount, a.decimals);
      if (x === null) throw new Error("Give an exact amount to shield.");
      const c = await cost(a, x);
      spending.check(c.budget, c.value);
      if (isDry(dry_run)) return { dryRun: true, wouldShield: fmtAmt(a, x), ...(a.kind === "asset" ? { note: "The first time takes two transactions: an approval, then the deposit." } : {}) };
      return exclusive(async () => {
        const p = await priv();
        const h = a.kind === "hype" ? await p.shieldHype(wallet, x) : await p.shieldToken(wallet, a.token, x);
        spending.record(c.budget, c.value);
        return { shielded: fmtAmt(a, x), privateBalance: fmtAmt(a, await p.balance(a.pool)), tx: link(h) };
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
      const x = amountOf(amount, 18) ?? (await p.maxSpendable(poolIn, "privateSwap"));
      if (x <= 0n) throw new Error("Not enough private balance for this, counting the relayer's fee.");
      const c = await cost(side === "buy" ? (await vaults())[0] : t, x);
      spending.check(c.budget, c.value);
      const q = await quoteSwap(t, side, x);
      const inSym = side === "buy" ? "HYPE" : t.symbol;
      const outSym = side === "buy" ? t.symbol : "HYPE";
      if (isDry(dry_run)) return { dryRun: true, wouldSwap: `${formatEther(x)} ${inSym} for about ${formatEther(q.out)} ${outSym}`, relayerFee: `${formatEther(q.fee)} ${inSym}`, slippage: `${(slippage_bps ?? 100) / 100}%` };
      return exclusive(async () => {
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
      const round = await p.roundInfo();
      if (isDry(dry_run)) return { dryRun: true, wouldPlace: `${formatEther(x)} ${side === "buy" ? "HYPE" : t.symbol} as standard-size ${side} orders`, roundEndsAt: iso(round.endsAt) };
      return exclusive(async () => {
        const r = await p.batch(t.token, side, x);
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
      description: "Pay someone's cloak: address from the private balance. The chain sees that a private transaction happened, but not who sent it, who got it or how much.",
      inputSchema: { asset: z.string().describe('"HYPE", "USDC" or a launch token'), to: z.string().describe("Recipient cloak: address"), amount: amt('Amount, or "max"'), dry_run: dry },
      annotations: WRITE,
    },
    safe(async ({ asset, to, amount, dry_run }: { asset: string; to: string; amount: string; dry_run?: boolean }) => {
      const { spending } = needWallet();
      if (!to.startsWith("cloak:")) throw new Error("The recipient must be a cloak: address (the receiver gets it from unlock or the Portfolio page).");
      const a = await resolve(asset);
      const p = await priv();
      const x = amountOf(amount, a.decimals) ?? (await p.maxSpendable(a.pool, "transact"));
      if (x <= 0n) throw new Error("Not enough private balance for this, counting the relayer's fee.");
      const c = await cost(a, x);
      spending.check(c.budget, c.value);
      if (isDry(dry_run)) return { dryRun: true, wouldSend: fmtAmt(a, x), to };
      return exclusive(async () => {
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
      const x = amountOf(amount, a.decimals) ?? (await p.maxSpendable(a.pool, kind));
      if (x <= 0n) throw new Error("Not enough private balance for this, counting the relayer's fee.");
      const c = await cost(a, x);
      spending.check(c.budget, c.value);
      const arrives = await pub.readContract({ address: a.pool, abi: shieldedPoolAbi, functionName: "afterFee", args: [x] });
      if (isDry(dry_run)) return { dryRun: true, wouldWithdraw: fmtAmt(a, x), arrives: fmtAmt(a, arrives), to };
      return exclusive(async () => {
        const h = a.kind === "hype" ? await p.unshieldHype(to as Address, x) : await p.unshieldToken(a.token, to as Address, x);
        await receipt(h);
        spending.record(c.budget, c.value);
        return { withdrew: fmtAmt(a, x), arrived: fmtAmt(a, arrives), to, privateBalance: fmtAmt(a, await p.balance(a.pool)), tx: link(h) };
      });
    }),
  );

  return server;
}
