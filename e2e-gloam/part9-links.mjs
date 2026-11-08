// Part 9: payment links on Cloak v2 on Gloam, as the Links and Claim pages use them: a link's secret (and passcode)
// opens a small Gloam account, the sender pays it one payment per share, and whoever opens the link sweeps it to a
// wallet or into their own private balance. Anvil (chain 99801), Gloam's final keys, through the relay.
//
//   node e2e-gloam/part9-links.mjs
import { parseEther, zeroAddress } from "viem";
import { GloamPrivate, WrongPasscodeError, buildClaimLink, gloamLinkAddress, gloamLinkCheck, gloamLinkKeys, newLinkSecret, openGloamLinkKeys, parseClaimLink } from "@cloakely/sdk";
import { createGloamRelay } from "../services/keeper/gloam.mjs";
import { createGloamLoop } from "../services/keeper/gloamLoop.mjs";
import { deployCloakGloam } from "./stack.mjs";
import { ANVIL_KEYS, ELYSIUM_TESTNET_ID, assert, clients, finalProver, rejects, rpc, sendAndLog, startAnvil, writeMeasurements } from "./lib.mjs";

const t0 = performance.now();
const anvil = await startAnvil({ port: 8562 });
const rpcUrl = anvil.rpcUrl;
const who = (i) => clients(rpcUrl, ANVIL_KEYS[i], ELYSIUM_TESTNET_ID);
const [dep, alice, bob, keeper] = [who(0), who(1), who(2), who(8)];
const pub = dep.pub;
try {
  console.log("Part 9 on anvil (chain 99801): payment links on Gloam");
  const warp = async (s) => (await rpc(rpcUrl, "evm_increaseTime", [s]), await rpc(rpcUrl, "evm_mine"));
  const { contracts: c, block } = await deployCloakGloam({ me: dep, rpcUrl, pk: ANVIL_KEYS[0], warp });
  const relay = createGloamRelay({ publicClient: pub, walletClient: keeper.wallet, vault: c.gloamVault, launchVault: c.launchVault, memoBoard: c.memoBoard, hourlySpendWei: parseEther("1") });
  await createGloamLoop({ publicClient: pub, account: keeper.account, send: async (x) => (await sendAndLog(pub, x.functionName, keeper.wallet.writeContract(x))).transactionHash, launchVault: c.launchVault }).tick();
  const provers = { shield: await finalProver("shield"), transfer: await finalProver("transfer"), unshield: await finalProver("unshield") };
  const cfg = {
    publicClient: pub,
    chainId: ELYSIUM_TESTNET_ID,
    gloamVault: { pool: c.gloamVault, poolBlock: block },
    launchVault: { pool: c.launchVault, poolBlock: block },
    payMemo: c.memoBoard,
    provers,
    submit: (call) => relay({ kind: call.kind, to: call.to, data: call.data }),
    whype: c.whypeStandIn,
  };
  const A = await GloamPrivate.unlock(alice.wallet, cfg);
  const B = await GloamPrivate.unlock(bob.wallet, cfg);
  await A.loadMarkets();
  await B.loadMarkets();
  const H = A.hypeMarket.pool;
  await A.shieldHype(alice.wallet, parseEther("2"));

  // the Links page: a locked link with a riddle, 2 shares of 0.3 HYPE
  const secret = newLinkSecret();
  const code = "Elysium";
  const k = await gloamLinkKeys(secret, code);
  const addr = gloamLinkAddress(k);
  for (let i = 0; i < 2; i++) await A.send(A.hypeMarket.token, addr, parseEther("0.3"));
  const url = buildClaimLink({ secret, block: await pub.getBlockNumber(), token: "HYPE", amount: "0.3", message: "", from: "", locked: true, hint: "Where does Cloak live?", shares: 2, check: gloamLinkCheck(k) }, "https://cloak.example");
  assert(addr.startsWith("cloak:gloamr1."), "the link's account is a Gloam receive tag in Cloak's address form");

  // the Claim page: a wrong answer is caught before any network call, the right one in any spelling opens it
  const link = parseClaimLink(url);
  let wrong = null;
  await openGloamLinkKeys(link, "mars").catch((e) => (wrong = e));
  assert(wrong instanceof WrongPasscodeError, "a wrong passcode is refused on the claimer's device");
  const open = (keys) => new GloamPrivate({ ...cfg, spendReceived: true }, keys);
  const L = open(await openGloamLinkKeys(link, "  ELYSIUM "));
  await L.loadMarkets();
  assert((await L.balance(H)) === parseEther("0.6"), "the passcode in another spelling opens it: 0.6 HYPE waiting in 2 shares");

  // one share to a wallet that has never held gas (the relay pays)
  const fresh = who(9).account.address;
  const before = await pub.getBalance({ address: fresh });
  const r1 = await L.sweep(L.hypeMarket.token, fresh, () => {}, { one: true });
  assert(r1.amount === parseEther("0.3") && (await pub.getBalance({ address: fresh })) - before === parseEther("0.2985"), "one share claimed to a wallet: 0.2985 HYPE (0.3 less the vault's 0.5%)");
  assert(r1.left === parseEther("0.3"), "and the other share is still waiting");

  // the other share into Bob's private balance
  const L2 = open(await openGloamLinkKeys(link, code));
  await L2.loadMarkets();
  await L2.sweep(L2.hypeMarket.token, await B.address(), () => {}, { one: true });
  assert((await B.balance(H)) === parseEther("0.3"), "the second share claimed into Bob's private balance");

  // the sender's Your links: who claimed, and where it went
  const L3 = open(await openGloamLinkKeys(link, code));
  await L3.loadMarkets();
  const claims = await L3.claims(H);
  assert(claims.length === 2 && claims.some((x) => x.to === "private") && claims.some((x) => x.to.toLowerCase?.() === fresh.toLowerCase()), "the link's claims: one to wallet 0xa0Ee…, one into a private balance");
  await rejects(L3.sweep(L3.hypeMarket.token, fresh), "an emptied link has nothing left to claim");

  // a plain link, taken back by its sender before anyone opens it
  const s2 = newLinkSecret();
  const k2 = await gloamLinkKeys(s2);
  await A.send(A.hypeMarket.token, gloamLinkAddress(k2), parseEther("0.25"));
  const back = open(k2);
  await back.loadMarkets();
  const aBefore = await A.balance(H);
  await back.sweep(back.hypeMarket.token, await A.address());
  assert((await A.balance(H)) - aBefore === parseEther("0.25"), "the sender takes an unclaimed link back into their private balance");

  writeMeasurements("part9-links", { seconds: Math.round((performance.now() - t0) / 1000) });
  console.log(`\nPart 9 passed in ${Math.round((performance.now() - t0) / 1000)} s`);
} finally {
  anvil.stop();
}
process.exit(0);
