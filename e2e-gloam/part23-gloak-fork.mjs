// Part 23: GLOAK's launch scripts, rehearsed on a fork of Elysium MAINNET (99901).
//   1. Cloak v2's launch factory and hook on Uniswap's official PoolManager (deployV2Factory, as the mainnet deploy), the
//      token deployer's door belonging to the owner wallet.
//   2. GLOAK's private zone: Cloak's launch vault on Gloam's real verifiers and Poseidon, the router (CloakRouterV4 on
//      Gloam's real vault), batch rounds and private bids, written to a partner-style record.
//   3. deploy-gloak.mjs from the proposed mainnet parameters (deployments/elysium-mainnet-gloak.input.example.json):
//      checks, plan, GloakMaker, and the owner wallet's door call.
//   4. Bids from public wallets, the reveal and settlement; claims are free; the keeper's admit and register.
//   5. gloak-after-settle.mjs --end-setup: the adapter approved and setup ended by the owner wallet.
//   6. Checks: the pool is private (Uniswap's real Universal Router refused), public transfers burn 10%, nothing can be
//      paid into Uniswap from a wallet. (Private trading with real proofs is part 22's flow; the GLOAK token's private
//      paths are covered by contracts-v4/test/GloakExperiment.t.sol and GloakSimulation.t.sol on a mainnet fork.)
//
//   NODE_USE_ENV_PROXY=1 node e2e-gloam/part23-gloak-fork.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeAbiParameters, encodeFunctionData, formatEther, keccak256, parseAbi, parseEther, toHex } from "viem";
import { deployV2Factory } from "./v2factory.mjs";
import { ANVIL_KEYS, REPO, assert, clients, ourArtifact, rpc, sendAndLog, startAnvil } from "./lib.mjs";
import { AUCTION_ABI, GLOAK_ABI, HOOK_ABI, ROLES } from "./gloak.mjs";

const MAINNET = 99901;
const MAINNET_RPC = process.env.MAINNET_RPC ?? "https://rpc.elysium.kinetiq.xyz";
const POOL_MANAGER = "0xe2e105d3f7209a9da11f83ccf3e7398a753823f1";
const UNIVERSAL_ROUTER = "0x1B341FDD55d56F8E08409A2C25DDFad93Eb03C1a";
const G = { vault: "0x89d3042390204f57b8b4F8949D3c2203E4002164", verifier: "0x29053A713E3a7D37053374446869a6f55858FcEf", shieldVerifier: "0xAEB8cb99B3BB43eB230F9fEB7293fB5E39080016", poseidon: "0x62c435CE6886fa91e3b0e91500c6dC9219723457" };
const TREASURY = "0x000000000000000000000000000000000000c7ea";
const t0 = performance.now();
const anvil = await startAnvil({ port: 8577, forkUrl: MAINNET_RPC, chainId: MAINNET });
const rpcUrl = anvil.rpcUrl;
const who = (i) => clients(rpcUrl, ANVIL_KEYS[i], MAINNET);
const [dep, owner] = [who(0), who(5)];
const bidders = [who(1), who(2), who(3)];
const pub = dep.pub;
const tmp = mkdtempSync(join(tmpdir(), "cloak-gloak-"));
const A = AUCTION_ABI();
const GL = GLOAK_ABI();
const warp = async (to) => {
  const now = Number((await pub.getBlock()).timestamp);
  if (to > now) await rpc(rpcUrl, "evm_increaseTime", [to - now]);
  await rpc(rpcUrl, "evm_mine");
};

try {
  // 1. the factory, as the mainnet deploy makes it
  const rules = JSON.parse(readFileSync(join(REPO, "deployments/elysium-mainnet-v2-factory.input.example.json"), "utf8"));
  const f = await deployV2Factory({ pub, wallet: dep.wallet, treasury: TREASURY, poolManager: POOL_MANAGER, rules, hookFees: rules.hook, owner: owner.account.address, vaultVerifier: G.verifier });
  const factoryRecord = join(tmp, "factory.json");
  writeFileSync(factoryRecord, JSON.stringify({ ...f, treasury: TREASURY, poolManager: POOL_MANAGER, v4Hook: f.hook }, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
  console.log(`1. factory ${f.factory}, hook ${f.hook}, token deployer ${f.vestingDeployer} (door: the owner wallet)`);

  // 2. GLOAK's private zone on Gloam's real vault and verifiers
  const deploy = async (label, a, args = []) => (await sendAndLog(pub, `deploy ${label}`, dep.wallet.deployContract({ ...a, args }))).contractAddress;
  const lvArt = ourArtifact("CloakLaunchVault.sol", "CloakLaunchVault");
  const lv = await deploy("CloakLaunchVault", lvArt, [G.poseidon, G.verifier, f.factory, 10n ** 30n, 10n ** 32n, owner.account.address]);
  for (const [fn, args] of [["setShieldVerifier", [G.shieldVerifier]], ["turnOnDepositLimits", []], ["endSetup", []]]) await sendAndLog(pub, fn, dep.wallet.writeContract({ address: lv, abi: lvArt.abi, functionName: fn, args }));
  const whype = await deploy("CloakWHYPE", ourArtifact("CloakWHYPE.sol", "CloakWHYPE"));
  const router = await deploy("CloakRouterV4", ourArtifact("CloakLaunchSwapV4.sol", "CloakRouterV4"), [lv, G.vault, "0x0000000000000000000000000000000000000000", POOL_MANAGER, whype, f.hook, "0x0000000000000000000000000000000000000000"]);
  const batcherV4 = await deploy("CloakGloamBatcherV4", ourArtifact("CloakGloamBatcherV4.sol", "CloakGloamBatcherV4"), [lv, G.vault, f.factory, 60n, 200n, 600n, "0x0000000000000000000000000000000000000000"]);
  const bids = await deploy("CloakGloamBids", ourArtifact("CloakGloamBids.sol", "CloakGloamBids"), [lv, G.vault]);
  const partnerRecord = join(tmp, "partner.json");
  writeFileSync(partnerRecord, JSON.stringify({ launchVault: lv, router, batcherV4, bids }));
  console.log(`2. zone: launch vault ${lv}, router ${router}, batch rounds ${batcherV4}, private bids ${bids}`);

  // 3. deploy-gloak.mjs from the proposed mainnet parameters, bidding closing in an hour
  const example = JSON.parse(readFileSync(join(REPO, "deployments/elysium-mainnet-gloak.input.example.json"), "utf8"));
  const now = Number((await pub.getBlock()).timestamp);
  const cfg = { ...example, admin: owner.account.address, factoryRecord, partnerRecord, launch: { ...example.launch, commitEnd: now + 3600 } };
  const cfgPath = join(tmp, "gloak.json");
  writeFileSync(cfgPath, JSON.stringify(cfg));
  const recPath = join(tmp, "gloak-record.json");
  const env = { ...process.env, DEPLOYER_PK: ANVIL_KEYS[0], OWNER_PK: ANVIL_KEYS[5] };
  const log = execFileSync("node", [join(REPO, "e2e-gloam/deploy-gloak.mjs"), "--config", cfgPath, "--rpc", rpcUrl, "--out", recPath], { env, encoding: "utf8" });
  console.log(log.split("\n").map((x) => "   " + x).join("\n"));
  const rec = JSON.parse(readFileSync(recPath, "utf8"));
  assert(rec.token && rec.auction, "3. the owner wallet's door call made GLOAK's launch");
  const D = parseAbi(["function doorUsed() view returns (bool)", "function doorToken() view returns (address)"]);
  assert(await pub.readContract({ address: f.vestingDeployer, abi: D, functionName: "doorUsed" }), "   the door is closed for good");
  for (const z of rec.zone) assert((Number(await pub.readContract({ address: rec.token, abi: GL, functionName: "rolesOf", args: [z.address] })) & z.roles) === z.roles, `   GLOAK was born approving the ${z.what}`);

  // 4. public bids, the reveal, settlement and free claims
  const p = await pub.readContract({ address: rec.auction, abi: A, functionName: "params" });
  const [, , , minPrice, tickSize, , commitEnd, revealEnd] = p;
  const plans = [
    [bidders[0], 40, parseEther("90")],
    [bidders[1], 25, parseEther("60")],
    [bidders[2], 5, parseEther("30")],
  ];
  const placed = [];
  for (const [b, tick, deposit] of plans) {
    const price = minPrice + BigInt(tick) * tickSize;
    const qty = (deposit * 10n ** 18n) / price;
    const salt = keccak256(toHex(`salt-${tick}`));
    const commitment = await pub.readContract({ address: rec.auction, abi: A, functionName: "commitmentOf", args: [b.account.address, tick, qty, salt] });
    await sendAndLog(pub, "commit", b.wallet.writeContract({ address: rec.auction, abi: A, functionName: "commit", args: [commitment, "0x"], value: deposit }));
    const id = (await pub.readContract({ address: rec.auction, abi: A, functionName: "bidsCount" })) - 1n;
    placed.push({ b, id, tick, qty, salt });
  }
  console.log(`4. three public bids: 90, 60 and 30 HYPE at different prices`);
  await warp(Number(commitEnd));
  for (const x of placed) await sendAndLog(pub, "reveal", dep.wallet.writeContract({ address: rec.auction, abi: A, functionName: "reveal", args: [x.id, x.tick, x.qty, x.salt] }));
  await warp(Number(revealEnd));
  await sendAndLog(pub, "settle", dep.wallet.writeContract({ address: rec.auction, abi: A, functionName: "settle" }));
  const [price, sold, raised] = await Promise.all(["clearingPrice", "sold", "raised"].map((functionName) => pub.readContract({ address: rec.auction, abi: A, functionName })));
  console.log(`   settled at ${formatEther(price)} HYPE per GLOAK: ${formatEther(sold)} sold, ${formatEther(raised)} HYPE raised`);
  for (const x of placed) {
    const [tokens] = await pub.readContract({ address: rec.auction, abi: A, functionName: "allocationOf", args: [x.id] });
    await sendAndLog(pub, "claim", dep.wallet.writeContract({ address: rec.auction, abi: A, functionName: "claim", args: [x.id] }));
    const got = await pub.readContract({ address: rec.token, abi: GL, functionName: "balanceOf", args: [x.b.account.address] });
    assert(got === tokens, `   a public claim is free: ${formatEther(got)} GLOAK, exactly its allocation`);
  }

  // 5. the keeper's two calls, then gloak-after-settle.mjs for the owner wallet's
  const before = execFileSync("node", [join(REPO, "e2e-gloam/gloak-after-settle.mjs"), "--record", recPath, "--rpc", rpcUrl], { env: { ...process.env }, encoding: "utf8" });
  const keeperCalls = [...before.matchAll(/to (0x[0-9a-fA-F]{40}), data (0x[0-9a-fA-F]+)/g)];
  for (const [, to, data] of keeperCalls) await sendAndLog(pub, "keeper: admit / register", dep.wallet.sendTransaction({ to, data }));
  assert(keeperCalls.length === 2, "5. the keeper admits GLOAK to the launch vault and registers it for batch rounds (anyone can)");
  const after = execFileSync("node", [join(REPO, "e2e-gloam/gloak-after-settle.mjs"), "--record", recPath, "--rpc", rpcUrl, "--end-setup"], { env: { ...process.env, OWNER_PK: ANVIL_KEYS[5] }, encoding: "utf8" });
  console.log(after.split("\n").map((x) => "   " + x).join("\n"));
  const rec2 = JSON.parse(readFileSync(recPath, "utf8"));
  assert((Number(await pub.readContract({ address: rec.token, abi: GL, functionName: "rolesOf", args: [rec2.adapter] })) & ROLES.SWAP) !== 0, "   the owner wallet approved the batch-round adapter");
  assert((await pub.readContract({ address: rec.token, abi: GL, functionName: "setupMode" })) === false, "   and ended setup: new approvals now wait 3 days");

  // 6. the rules hold on mainnet's real Uniswap contracts
  const key = await pub.readContract({ address: f.hook, abi: HOOK_ABI(), functionName: "keyFor", args: [rec.token] });
  const K = [{ type: "tuple", components: [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }] }];
  const swap = encodeAbiParameters([{ type: "tuple", components: [...K, { type: "bool" }, { type: "uint128" }, { type: "uint128" }, { type: "bytes" }] }], [[[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks], true, parseEther("1"), 0n, "0x"]]);
  const settleAll = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [key.currency0, parseEther("1")]);
  const takeAll = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [key.currency1, 0n]);
  const input = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], ["0x060c0f", [swap, settleAll, takeAll]]);
  const UR = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);
  let refused = false;
  try {
    await pub.simulateContract({ account: bidders[0].account, address: UNIVERSAL_ROUTER, abi: UR, functionName: "execute", args: ["0x10", [input], 2n ** 255n], value: parseEther("1") });
  } catch {
    refused = true;
  }
  assert(refused, "6. Uniswap's real Universal Router can't buy GLOAK: its pool is private");
  const b0 = bidders[0].account.address;
  const bal = await pub.readContract({ address: rec.token, abi: GL, functionName: "balanceOf", args: [b0] });
  const supplyBefore = await pub.readContract({ address: rec.token, abi: GL, functionName: "totalSupply" });
  await sendAndLog(pub, "public transfer", bidders[0].wallet.writeContract({ address: rec.token, abi: GL, functionName: "transfer", args: [bidders[1].account.address, bal / 2n] }));
  const burned = supplyBefore - (await pub.readContract({ address: rec.token, abi: GL, functionName: "totalSupply" }));
  assert(burned === bal / 2n / 10n, `   a public transfer burns 10% (${formatEther(burned)} GLOAK)`);
  let blocked = false;
  try {
    await pub.simulateContract({ account: bidders[0].account, address: rec.token, abi: GL, functionName: "transfer", args: [POOL_MANAGER, 1n] });
  } catch {
    blocked = true;
  }
  assert(blocked, "   a wallet can't pay GLOAK into Uniswap");
  const m = await pub.readContract({ address: rec.token, abi: GL, functionName: "meter" });
  console.log(`   meter: vaults ${formatEther(m[0])}, pool ${formatEther(m[1])}, contracts ${formatEther(m[2])}, 0xdEaD ${formatEther(m[3])}, public ${formatEther(m[4])}`);
  console.log(`\nPart 23 passed in ${Math.round((performance.now() - t0) / 1000)} s`);
} finally {
  anvil.stop();
}
