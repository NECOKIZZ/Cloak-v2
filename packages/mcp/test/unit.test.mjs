import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEther } from "viem";
import { loadSettings, Spending } from "../dist/server.js";
import { explain } from "../dist/server.js";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

test("testnet by default, read only without a key, dry run off", () => {
  const s = loadSettings({});
  assert.equal(s.network, "testnet");
  assert.equal(s.chain.id, 99801);
  assert.equal(s.privateKey, undefined);
  assert.equal(s.dryRun, false);
  assert.equal(s.limits.hypePerTx, parseEther("1"));
  assert.equal(s.limits.hypePerDay, parseEther("10"));
});

test("mainnet needs an explicit opt-in, and isn't live yet", () => {
  assert.throws(() => loadSettings({ CLOAK_NETWORK: "mainnet" }), /CLOAK_ALLOW_MAINNET=1/);
  assert.throws(() => loadSettings({ CLOAK_NETWORK: "mainnet", CLOAK_ALLOW_MAINNET: "1" }), /isn't live yet/);
  assert.throws(() => loadSettings({ CLOAK_NETWORK: "moon" }), /unknown CLOAK_NETWORK/);
});

test("the key comes from a file or the environment, and must be 32 bytes", () => {
  const dir = mkdtempSync(join(tmpdir(), "cloak-mcp-test-"));
  const file = join(dir, "key");
  writeFileSync(file, `${KEY.slice(2)}\n`);
  assert.equal(loadSettings({ CLOAK_KEY_FILE: file }).privateKey, KEY);
  assert.equal(loadSettings({ CLOAK_PRIVATE_KEY: KEY }).privateKey, KEY);
  assert.throws(() => loadSettings({ CLOAK_PRIVATE_KEY: "0x1234" }), /32 bytes/);
});

test("limits and dry run come from the environment", () => {
  const s = loadSettings({ CLOAK_MAX_HYPE_PER_TX: "0.5", CLOAK_MAX_USDC_PER_DAY: "20", CLOAK_DRY_RUN: "1" });
  assert.equal(s.limits.hypePerTx, parseEther("0.5"));
  assert.equal(s.limits.usdcPerDay, 20_000_000n);
  assert.equal(s.dryRun, true);
  assert.throws(() => loadSettings({ CLOAK_MAX_HYPE_PER_TX: "lots" }), /must be a number/);
});

test("spending limits: per transaction, per day, persisted, reset the next day", () => {
  const dir = mkdtempSync(join(tmpdir(), "cloak-mcp-spend-"));
  let now = new Date("2026-11-09T10:00:00Z");
  const limits = { hypePerTx: parseEther("1"), hypePerDay: parseEther("2"), usdcPerTx: 100_000_000n, usdcPerDay: 150_000_000n, launchesPerDay: 1 };
  const s = new Spending(limits, dir, "0xAbC", () => now);
  assert.throws(() => s.check("hype", parseEther("1.5")), /per transaction/);
  s.check("hype", parseEther("1"));
  s.record("hype", parseEther("1"));
  s.record("hype", parseEther("0.8"));
  assert.throws(() => s.check("hype", parseEther("0.3")), /daily limit \(0.2 HYPE left today\)/);
  s.check("usdc", 100_000_000n); // separate budget
  s.record("launches", 1n);
  assert.throws(() => s.check("launches", 1n), /daily limit/);
  // a new server for the same wallet sees the same day
  const again = new Spending(limits, dir, "0xabc", () => now);
  assert.equal(again.summary().hype.usedToday, "1.8 HYPE");
  assert.equal(again.summary().hype.usedThisSession, "0 HYPE");
  now = new Date("2026-11-10T00:00:01Z");
  again.check("hype", parseEther("1"));
  assert.equal(again.summary().hype.leftToday, "2 HYPE");
});

test("errors become one plain sentence", () => {
  assert.match(explain(new Error("insufficient private balance")), /Not enough private balance/);
  assert.match(explain({ shortMessage: "The contract function \"x\" reverted with the following reason:\nauctions closed" }), /reason: auctions closed$/);
  assert.match(explain(new Error("Execution reverted: gas required exceeds allowance (0)")), /faucet/);
});
