import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicClient, http } from "viem";
import { elyLabel, isElyName, resolveRecipient, elysiumTestnet } from "../dist/index.js";

test("elyLabel normalizes and validates like the name service asks", () => {
  assert.equal(elyLabel("  Bona.ELY "), "bona");
  assert.equal(elyLabel("my-name"), "my-name");
  assert.equal(elyLabel("a"), null); // too short
  assert.equal(elyLabel("-bad"), null);
  assert.equal(elyLabel("bad-"), null);
  assert.equal(elyLabel("no_underscores"), null);
  assert.equal(elyLabel("x".repeat(64)), null);
  assert.equal(elyLabel("x".repeat(63)), "x".repeat(63));
});

test("isElyName needs the .ely ending", () => {
  assert.equal(isElyName("bona.ely"), true);
  assert.equal(isElyName("bona"), false);
  assert.equal(isElyName("0x13A130B336400409c956dF042C128238F1486ddD"), false);
});

test("resolveRecipient passes addresses through and refuses junk without a network call", async () => {
  const pub = createPublicClient({ chain: elysiumTestnet, transport: http("http://127.0.0.1:9") });
  const a = "0x13A130B336400409c956dF042C128238F1486ddD";
  assert.deepEqual(await resolveRecipient(pub, ` ${a} `), { address: a });
  await assert.rejects(resolveRecipient(pub, "not a name"), /0x address or a \.ely name/);
});
