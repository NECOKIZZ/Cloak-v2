// Part 11: receive addresses on Cloak v2 on Gloam (CloakGloamReceive). Anyone pays a public address; the owner's app
// moves it into the private balance (a proof made with the note's secret, signed by the address's owner key, sent by
// the relay). Anvil (chain 99801), a realistic Gloam vault, Gloam's final keys.
//
//   node e2e-gloam/part11-receive.mjs
import { parseAbi, parseEther, parseUnits, zeroAddress } from "viem";
import { GloamPrivate } from "@cloakely/sdk";
import { createGloamRelay } from "../services/keeper/gloam.mjs";
import { createGloamLoop } from "../services/keeper/gloamLoop.mjs";
import { deployCloakGloam } from "./stack.mjs";
import { ANVIL_KEYS, ELYSIUM_TESTNET_ID, assert, clients, finalProver, rpc, sendAndLog, startAnvil, writeMeasurements } from "./lib.mjs";

const t0 = performance.now();
const anvil = await startAnvil({ port: 8564 });
const rpcUrl = anvil.rpcUrl;
const who = (i) => clients(rpcUrl, ANVIL_KEYS[i], ELYSIUM_TESTNET_ID);
const [dep, alice, payer, keeper] = [who(0), who(1), who(6), who(8)];
const pub = dep.pub;
const ERC = parseAbi(["function mint(address to, uint256 amount)", "function transfer(address to, uint256 amount) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
try {
  console.log("Part 11 on anvil (chain 99801): receive addresses");
  const warp = async (s) => (await rpc(rpcUrl, "evm_increaseTime", [s]), await rpc(rpcUrl, "evm_mine"));
  const { contracts: c, block } = await deployCloakGloam({ me: dep, rpcUrl, pk: ANVIL_KEYS[0], warp });
  const relay = createGloamRelay({ publicClient: pub, walletClient: keeper.wallet, vault: c.gloamVault, launchVault: c.launchVault, memoBoard: c.memoBoard, escrows: [c.receive], hourlySpendWei: parseEther("5") });
  await createGloamLoop({ publicClient: pub, account: keeper.account, send: async (x) => (await sendAndLog(pub, x.functionName, keeper.wallet.writeContract(x))).transactionHash, launchVault: c.launchVault }).tick();
  const provers = { shield: await finalProver("shield"), transfer: await finalProver("transfer"), unshield: await finalProver("unshield") };
  const cfg = { publicClient: pub, chainId: ELYSIUM_TESTNET_ID, gloamVault: { pool: c.gloamVault, poolBlock: block }, launchVault: { pool: c.launchVault, poolBlock: block }, payMemo: c.memoBoard, provers, submit: (call) => relay({ kind: call.kind, to: call.to, data: call.data }), whype: c.whypeStandIn, receive: c.receive };
  const A = await GloamPrivate.unlock(alice.wallet, cfg);
  await A.loadMarkets();
  A.addAsset({ symbol: "USDC", token: c.usdc, decimals: 6 });

  const addr0 = await A.receiveAddress(0);
  const addr1 = await A.receiveAddress(1);
  assert(addr0 !== addr1 && (await pub.getCode({ address: addr0 })) === undefined, "receive addresses are fixed before anything is deployed, and each number gives another address");

  // a payer with no Cloak account pays the public address: 25 HYPE and 300 USDC
  await sendAndLog(pub, "pay HYPE", payer.wallet.sendTransaction({ to: addr0, value: parseEther("25") }));
  await sendAndLog(pub, "mint USDC", dep.wallet.writeContract({ address: c.usdc, abi: ERC, functionName: "mint", args: [payer.account.address, parseUnits("300", 6)] }));
  await sendAndLog(pub, "pay USDC", payer.wallet.writeContract({ address: c.usdc, abi: ERC, functionName: "transfer", args: [addr0, parseUnits("300", 6)] }));

  // Alice opens the app: everything waiting moves into her private balance
  const moved = await A.collectReceived(0);
  const hypeParts = moved.filter((m) => m.asset === zeroAddress).map((m) => m.amount);
  assert(hypeParts.length === 3 && hypeParts.reduce((a, b) => a + b, 0n) === parseEther("25"), "25 HYPE moved in 3 deposits of at most 10 (the launch vault's per-deposit cap)");
  assert((await A.balance(A.hypeMarket.pool)) === parseEther("25"), "Alice's private balance shows the 25 HYPE");
  assert((await A.balance(c.usdc)) === parseUnits("300", 6), "and 300 USDC, deposited into Gloam's vault (the only vault listing USDC)");
  assert((await pub.getBalance({ address: addr0 })) === 0n, "nothing left at the address");
  const tx = await pub.getTransaction({ hash: moved[0].txHash });
  assert(tx.from.toLowerCase() === keeper.account.address.toLowerCase(), "the relay sent it: Alice's wallet never appears, and needs no gas");

  // the same address is paid again later
  await sendAndLog(pub, "pay again", payer.wallet.sendTransaction({ to: addr0, value: parseEther("1.5") }));
  const again = await A.collectReceived(0);
  assert(again.length === 1 && (await A.balance(A.hypeMarket.pool)) === parseEther("26.5"), "a later payment to the same address moves in too");
  assert((await A.collectReceived(0)).length === 0, "and with nothing waiting, nothing is sent");

  writeMeasurements("part11-receive", { deposits: moved.length + again.length, seconds: Math.round((performance.now() - t0) / 1000) });
  console.log(`\nPart 11 passed in ${Math.round((performance.now() - t0) / 1000)} s`);
} finally {
  anvil.stop();
}
process.exit(0);
