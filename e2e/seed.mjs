// Seeds a demo launch with a few sealed bids from fresh wallets (for the launch page / demo video).
//   node e2e/seed.mjs                       # local anvil, deploys a factory
//   RPC_URL=… DEPLOYER_PK=… FACTORY=0x… node e2e/seed.mjs
import { generatePrivateKey } from "viem/accounts";
import { anvilLocal, elysiumTestnet } from "@cloakely/sdk";
import { Cloak, clients, deployFactory, parseEther } from "./lib.mjs";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const local = RPC.includes("127.0.0.1") || RPC.includes("localhost");
const chain = local ? anvilLocal : elysiumTestnet;
const PK = process.env.DEPLOYER_PK ?? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const COMMIT_SECS = Number(process.env.COMMIT_SECS ?? 180);
const REVEAL_SECS = Number(process.env.REVEAL_SECS ?? 60);
const BIDS = Number(process.env.BIDS ?? 6);
const unit = local ? 10n ** 14n : 10n ** 9n;

const d = clients(chain, RPC, PK);
const factory = process.env.FACTORY ?? (await deployFactory(d.publicClient, d.walletClient)).factory;
const creator = new Cloak(d.publicClient, d.walletClient, factory);
const now = Number((await d.publicClient.getBlock()).timestamp);
const l = await creator.createLaunch({
  name: process.env.NAME ?? "Shade",
  symbol: process.env.SYMBOL ?? "SHADE",
  saleSupply: 1_000_000n * 10n ** 18n,
  creatorAlloc: 100_000n * 10n ** 18n,
  minPrice: unit,
  tickSize: unit,
  numTicks: 100,
  commitEnd: now + COMMIT_SECS,
  revealEnd: now + COMMIT_SECS + REVEAL_SECS,
  lpBps: 5000,
  lpLockUntil: "burn",
});
const s = await creator.getAuction(l.auction);
for (let i = 0; i < BIDS; i++) {
  const c = clients(chain, RPC, generatePrivateKey());
  const tick = BigInt(8 + ((i * 13) % 40));
  const qty = BigInt(120_000 + ((i * 47_000) % 200_000)) * 10n ** 18n;
  const q = creator.quoteBid(s, unit + tick * unit, qty);
  const deposit = local ? q.deposit : q.cost + q.cost / 4n + 1n;
  const h = await d.walletClient.sendTransaction({ to: c.account.address, value: deposit + parseEther(local ? "1" : "0.002") });
  await d.publicClient.waitForTransactionReceipt({ hash: h });
  await new Cloak(c.publicClient, c.walletClient).bid(l.auction, { maxPrice: unit + tick * unit, quantity: qty, deposit });
}
console.log(JSON.stringify({ factory, auction: l.auction, token: l.token, block: l.block.toString() }));
