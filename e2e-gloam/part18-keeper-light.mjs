// Part 18: the keeper on a free host (OPTIMIZATION.md S3, H1), the real keeper process over HTTP, on anvil.
//
//   node e2e-gloam/part18-keeper-light.mjs
//
// GET /leaves serves the Gloam vaults' public leaf lists (an unchanged list costs a bodiless 304), a new device seeds its
// tree from it and shows the same balance, and the keeper pings its own public address only while it has work.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fetchLeaves, GloamTree } from "@cloakely/sdk";
import { setup, launchCore, unshieldCall, ANVIL_KEYS, zeroAddress, parseEther, rpc } from "./stress/common.mjs";
import { REPO, assert } from "./lib.mjs";

const t0 = performance.now();
const S = await setup({ port: 8611 });
const { c, block } = S;
const KEEPER = "http://127.0.0.1:8612";
let proc;
const logs = [];
// stands in for the keeper's public address: counts the keeper's pings to itself
let pings = 0;
const self = createServer((req, res) => (pings++, res.end("{}"))).listen(8613);
try {
  console.log("Part 18: the keeper on a free host");
  const { core: A, w: alice } = await launchCore(S, 1);
  for (let i = 0; i < 3; i++) await A.shield(alice.wallet, zeroAddress, parseEther("0.2"));
  await A.sync();
  const mc = "0xcA11bde05977b3631167028862bE2a173976CA11";
  const code = await fetch("https://testnet-rpc.elysium.kinetiq.xyz", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [mc, "latest"] }) }).then((r) => r.json());
  await rpc(S.rpcUrl, "anvil_setCode", [mc, code.result]);

  proc = spawn(process.execPath, [`${REPO}/services/keeper/index.mjs`], {
    cwd: `${REPO}/services/keeper`,
    env: {
      PATH: process.env.PATH,
      KEEPER_PK: ANVIL_KEYS[7],
      FACTORY: c.factoryStandIn,
      RPC_URL: "http://127.1:8611",
      PORT: "8612",
      SNAPSHOT: "0",
      GLOAM_MEMO: c.memoBoard,
      GLOAM_VAULT: c.gloamVault,
      GLOAM_LAUNCH_VAULT: c.launchVault,
      GLOAM_VAULT_BLOCK: String(block),
      GLOAM_ESCROWS: [c.launchSwap, c.batcher, c.receive].join(","),
      GLOAM_LOOP_SECS: "3600",
      KEEP_AWAKE_URL: "http://127.0.0.1:8613",
      KEEP_AWAKE_MS: "1500",
    },
  });
  proc.stdout.on("data", (d) => logs.push(String(d)));
  proc.stderr.on("data", (d) => logs.push(String(d)));
  for (let i = 0; i < 60; i++) {
    if (await fetch(KEEPER + "/health").then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  // ── /leaves: the Gloam vaults' lists ───────────────────────────────────
  const r1 = await fetch(KEEPER + "/leaves");
  const etag = r1.headers.get("etag");
  const body = await r1.json();
  if (!body.vaults) console.log("leaves answered", r1.status, body);
  const lv = body.vaults.find((v) => v.pool.toLowerCase() === c.launchVault.toLowerCase());
  const t = new GloamTree(c.launchVault, block);
  await t.update(S.pub);
  assert(lv && lv.leaves.length === t.leafCount && lv.leaves.every(([i, x]) => x.toLowerCase() === t.list()[i].toLowerCase()), `GET /leaves serves the launch vault's leaves in order (${lv?.leaves.length})`);
  assert(body.vaults.some((v) => v.pool.toLowerCase() === c.gloamVault.toLowerCase()), "and Gloam's vault's");
  const r2 = await fetch(KEEPER + "/leaves", { headers: { "if-none-match": etag } });
  assert(r2.status === 304, "an unchanged list costs a bodiless 304");

  // ── a new device seeds from it ─────────────────────────────────────────
  const B = (await launchCore(S, 1)).core;
  const src = (await fetchLeaves(KEEPER)).get(c.launchVault.toLowerCase());
  assert(await B.seedLeaves(src), "a new device's tree starts from the keeper's list (the vault knows its root)");
  await B.sync();
  assert((await B.balances()).get(zeroAddress) === (await A.balances()).get(zeroAddress), "and shows the same balance");

  // ── staying awake only with work ───────────────────────────────────────
  await new Promise((r) => setTimeout(r, 4000));
  const health = await fetch(KEEPER + "/health").then((r) => r.json());
  assert(pings === 0, `with nothing pending the keeper doesn't ping itself (why: ${JSON.stringify(health.awake?.why)})`);
  const s = A.ownNotes(zeroAddress)[0];
  const now = Number((await S.pub.getBlock()).timestamp);
  const call = { kind: "gloamUnshield", to: c.launchVault, data: (await unshieldCall(A, s, S.who(9).account.address)).data };
  const sch = await fetch(KEEPER + "/schedule", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pieces: [{ call, notBefore: now + 3600 }] }) });
  assert(sch.ok, `a withdrawal piece is queued (${sch.status})`);
  await new Promise((r) => setTimeout(r, 4000));
  assert(pings > 0, `and with it queued the keeper pings itself to stay awake (${pings} pings)`);
  console.log(`\nPart 18 passed in ${Math.round((performance.now() - t0) / 1000)} s`);
} catch (e) {
  console.error(logs.join("").slice(-3000), e);
  throw e;
} finally {
  proc?.kill();
  self.close();
  S.stop();
}
process.exit(0);
