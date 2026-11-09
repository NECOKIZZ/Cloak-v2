// A real launch on Cloak v2's own factory, live on Elysium testnet: create, two sealed bids, reveal, settle into a
// Uniswap v4 pool behind v2's hook, claim, then the keeper loop admits it to v2's launch vault and registers it for
// batch rounds. Gives v2 a real market on testnet. Small: the sale raises about 0.02 HYPE.
//
//   NODE_USE_ENV_PROXY=1 node e2e-gloam/live-v2-launch.mjs     # reads GLOAM_TESTNET_PK from ../.env (testnet key only)
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatEther, parseAbi, zeroAddress } from "viem";
import { Cloak } from "@cloakely/sdk";
import { createGloamLoop } from "../services/keeper/gloamLoop.mjs";
import { REPO, ELYSIUM_TESTNET_RPC, clients, sendAndLog } from "./lib.mjs";

const T = JSON.parse(readFileSync(join(REPO, "deployments/elysium-testnet-gloam.json"), "utf8"));
const pk = readFileSync(join(REPO, ".env"), "utf8").match(/^GLOAM_TESTNET_PK=(0x[0-9a-fA-F]{64})/m)[1];
const me = clients(ELYSIUM_TESTNET_RPC, pk, 99801);
const pub = me.pub;
const c = new Cloak(pub, me.wallet, T.launchFactory);
const sleepUntil = async (t) => {
  for (;;) {
    const now = Number((await pub.getBlock()).timestamp);
    if (now > t) return;
    await new Promise((r) => setTimeout(r, Math.min(15_000, (t - now + 2) * 1000)));
  }
};
const start = await pub.getBalance({ address: me.account.address });
console.log(`live launch on v2's factory ${T.launchFactory} from ${me.account.address} (${formatEther(start)} HYPE)`);
const now = Number((await pub.getBlock()).timestamp);
const unit = 2n * 10n ** 9n; // 1,000,000 tokens at 10 units raise 0.02 HYPE
const l = await c.createLaunch({ name: "Gloak Genesis", symbol: "GLOAK", metadataURI: "", saleSupply: 1_000_000n * 10n ** 18n, minPrice: unit, tickSize: unit, numTicks: 50, commitEnd: now + 120, revealEnd: now + 120 + 330, lpBps: 8000 });
console.log(`  launch ${l.auction}, token ${l.token}`);
const s0 = await c.getAuction(l.auction);
const qA = c.quoteBid(s0, unit * 12n, 300_000n * 10n ** 18n);
const qB = c.quoteBid(s0, unit * 10n, 700_000n * 10n ** 18n);
const a = await c.bid(l.auction, { maxPrice: unit * 12n, quantity: 300_000n * 10n ** 18n, deposit: qA.cost });
const b = await c.bid(l.auction, { maxPrice: unit * 10n, quantity: 700_000n * 10n ** 18n, deposit: qB.cost });
console.log(`  two sealed bids in (${formatEther(qA.cost + qB.cost)} HYPE); waiting for bidding to close`);
await sleepUntil(Number(s0.commitEnd));
await c.reveal(a);
await c.reveal(b);
console.log("  revealed; waiting for the reveal window to close");
await sleepUntil(Number(s0.revealEnd));
await c.settle(l.auction);
const s1 = await c.getAuction(l.auction);
const pair = await pub.readContract({ address: l.auction, abi: parseAbi(["function pair() view returns (address)"]), functionName: "pair" });
console.log(`  settled: ${s1.phase}, market ${pair}`);
if (pair === zeroAddress) throw new Error("no market");
for (const h of await c.payOut(l.auction).catch(() => [])) console.log(`  paid out ${h}`);
await c.claim(l.auction, [a.id, b.id]).catch((e) => console.log(`  claim skipped: ${e.shortMessage ?? e.message}`));
// the keeper loop: admit to v2's launch vault and register for batch rounds
const loop = createGloamLoop({ publicClient: pub, account: me.account, send: async (x) => (await sendAndLog(pub, x.functionName, me.wallet.writeContract(x))).transactionHash, launchVault: T.launchVault, batcherV4: T.batcherV4, batcherV4Block: BigInt(T.batcherV4Block) });
const t = await loop.tick();
console.log(`  keeper loop: admitted ${t.admitted.length}, registered ${t.registered.length}${t.errors.length ? `, errors ${t.errors.join("; ")}` : ""}`);
const end = await pub.getBalance({ address: me.account.address });
const rec = { auction: l.auction, token: l.token, market: pair, admitted: t.admitted.length, registered: t.registered.length, costHype: formatEther(start - end) };
console.log(JSON.stringify(rec, null, 1));
const p = join(REPO, "deployments/elysium-testnet-gloam.json");
const d = JSON.parse(readFileSync(p, "utf8"));
d.launches = [...(d.launches ?? []), { name: "Gloak Genesis", symbol: "GLOAK", ...rec }];
writeFileSync(p, JSON.stringify(d, null, 2) + "\n");
process.exit(0);
