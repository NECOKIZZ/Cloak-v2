import { createPublicClient, createWalletClient, custom, http, numberToHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Cloak, type BidSecret, type Wallet } from "@cloakonelysium/sdk";
import { chain, FACTORY, IS_LOCAL, LEGACY_FACTORY, RPC_URL } from "./config";
import { Hint } from "./errors";

export const publicClient = createPublicClient({ chain, transport: http(RPC_URL, { retryCount: 4, retryDelay: 400 }), batch: { multicall: { wait: 16 } }, pollingInterval: 1000 });
export const readCloak = new Cloak(publicClient, undefined, FACTORY, LEGACY_FACTORY);

export type Eip1193 = {
  request: (a: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (ev: string, fn: (...a: never[]) => void) => void;
  removeListener?: (ev: string, fn: (...a: never[]) => void) => void;
  disconnect?: () => Promise<void>;
};

declare global {
  interface Window {
    ethereum?: Eip1193;
  }
}

/** A wallet the user can pick in the connect modal. */
export interface WalletOption {
  id: string;
  name: string;
  icon?: string;
  provider: Eip1193;
}

// EIP-6963: every installed wallet announces itself, so the modal can list them all by name and icon.
const announced = new Map<string, WalletOption>();
const subs = new Set<() => void>();
if (typeof window !== "undefined") {
  window.addEventListener("eip6963:announceProvider", ((e: CustomEvent) => {
    const { info, provider } = e.detail ?? {};
    if (!info || !provider) return;
    announced.set(info.rdns || info.uuid, { id: info.rdns || info.uuid, name: info.name, icon: info.icon, provider });
    subs.forEach((f) => f());
  }) as EventListener);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}

export function installedWallets(): WalletOption[] {
  const list = [...announced.values()];
  if (!list.length && window.ethereum) list.push({ id: "injected", name: "Browser wallet", provider: window.ethereum });
  return list;
}
export function onWalletsChanged(f: () => void) {
  subs.add(f);
  return () => void subs.delete(f);
}

export const WC_PROJECT_ID: string | undefined = import.meta.env.VITE_WC_PROJECT_ID || undefined;

/** WalletConnect (mobile wallets via QR). Loaded only when picked, since it's a large bundle. */
export async function walletConnectProvider(): Promise<Eip1193> {
  if (!WC_PROJECT_ID) throw new Hint("WalletConnect isn't set up on this site yet. Use a browser wallet for now.");
  const { EthereumProvider } = await import("@walletconnect/ethereum-provider");
  const p = await EthereumProvider.init({
    projectId: WC_PROJECT_ID,
    optionalChains: [chain.id],
    rpcMap: { [chain.id]: RPC_URL },
    showQrModal: true,
    metadata: { name: "Cloak", description: "Private launches and trades on Elysium", url: location.origin, icons: [`${location.origin}/logo.svg`] },
  });
  await p.enable();
  return p as unknown as Eip1193;
}

const elysiumParams = () => ({
  chainId: numberToHex(chain.id),
  chainName: chain.name,
  nativeCurrency: chain.nativeCurrency,
  rpcUrls: [RPC_URL],
  blockExplorerUrls: chain.blockExplorers ? [chain.blockExplorers.default.url] : undefined,
});

/** Adds Elysium testnet to the wallet (wallets ignore this if it's already there). */
export async function addElysium(eth: Eip1193) {
  await eth.request({ method: "wallet_addEthereumChain", params: [elysiumParams()] });
}

/** Puts the wallet on Elysium testnet, adding the network first if the wallet doesn't know it. */
export async function ensureElysium(eth: Eip1193) {
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: numberToHex(chain.id) }] });
  } catch (e) {
    const x = e as { code?: number; data?: { originalError?: { code?: number } }; message?: string };
    const missing = x.code === 4902 || x.data?.originalError?.code === 4902 || /unrecognized|not (been )?added|unknown chain|-32603/i.test(x.message ?? "") || x.code === -32603;
    if (!missing) throw e;
    await addElysium(eth);
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: numberToHex(chain.id) }] }).catch(() => {});
  }
}

export const walletFor = (eth: Eip1193, address: Address) => createWalletClient({ chain, transport: custom(eth), account: address }) as unknown as Wallet;

/** Asks the wallet for an account, puts it on Elysium and returns a client for it. */
export async function connectProvider(eth: Eip1193): Promise<Wallet> {
  const accounts = (await eth.request({ method: "eth_requestAccounts" })) as Address[] | undefined;
  if (!accounts?.length) throw new Error("no accounts");
  await ensureElysium(eth);
  return walletFor(eth, accounts[0]);
}

/** Reconnects silently (no popup) to a wallet the user connected before, if it still shares an account. */
export async function silentReconnect(eth: Eip1193): Promise<Wallet | null> {
  const accounts = (await eth.request({ method: "eth_accounts" }).catch(() => [])) as Address[];
  if (!accounts?.length) return null;
  const id = Number(await eth.request({ method: "eth_chainId" }).catch(() => 0));
  return id === chain.id ? walletFor(eth, accounts[0]) : null;
}

/** Local demo only: a burner key in localStorage, auto-funded by anvil. */
export async function connectBurner(): Promise<Wallet> {
  if (!IS_LOCAL) throw new Error("burner wallets are only enabled on a local chain");
  let pk: Hex | null = null;
  try {
    pk = localStorage.getItem("cloak.burner") as Hex | null;
  } catch {}
  if (!pk) {
    pk = generatePrivateKey();
    try {
      localStorage.setItem("cloak.burner", pk);
    } catch {}
  }
  const account = privateKeyToAccount(pk);
  await publicClient.request({
    method: "anvil_setBalance" as never,
    params: [account.address, numberToHex(10n ** 22n)] as never,
  });
  return createWalletClient({ chain, transport: http(RPC_URL), account }) as Wallet;
}

// Bid secrets are a convenience (manual reveal fallback); auto-reveal makes losing them harmless.
const key = (auction: Address) => `cloak.bids.${chain.id}.${auction.toLowerCase()}`;
export function saveSecret(s: BidSecret) {
  try {
    const all = loadSecrets(s.auction);
    all.push(s);
    localStorage.setItem(key(s.auction), JSON.stringify(all, (_, v) => (typeof v === "bigint" ? `${v}n` : v)));
  } catch {}
}
export function loadSecrets(auction: Address): BidSecret[] {
  try {
    const raw = localStorage.getItem(key(auction));
    if (!raw) return [];
    return JSON.parse(raw, (_, v) => (typeof v === "string" && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v));
  } catch {
    return [];
  }
}
