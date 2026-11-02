import { test } from "node:test";
import assert from "node:assert/strict";
import { buildClaimLink, parseClaimLink, buildRequestLink, parseRequestLink, linkKeys, linkAddress, newLinkSecret, normalizeLinkAmount, checkPayee } from "../dist/index.js";

test("claim link round-trips every field", () => {
  const secret = newLinkSecret();
  const url = buildClaimLink({ secret, block: 21500000n, token: "USDC", amount: "25", message: "Happy birthday 🎉", from: "Robin", locked: true, hint: "Our chain?", shares: 5 });
  assert.ok(url.startsWith("https://cloak.boblabs.tech/claim#k="));
  const l = parseClaimLink(url);
  assert.deepEqual([...l.secret], [...secret]);
  assert.equal(l.block, 21500000n);
  assert.equal(l.token, "USDC");
  assert.equal(l.amount, "25");
  assert.equal(l.message, "Happy birthday 🎉");
  assert.equal(l.from, "Robin");
  assert.equal(l.locked, true);
  assert.equal(l.hint, "Our chain?");
  assert.equal(l.shares, 5);
  assert.equal(parseClaimLink(buildClaimLink({ secret, block: 1n })).shares, undefined);
});

test("a damaged or cut link is refused", () => {
  const url = buildClaimLink({ secret: newLinkSecret(), block: 1n });
  assert.throws(() => parseClaimLink(url.slice(0, url.indexOf("&") - 5)), /cut short|damaged/);
  assert.throws(() => parseClaimLink("https://cloak.boblabs.tech/claim#x=1"), /isn't a Cloak claim link/);
});

test("link keys: same secret same account; a passcode changes it and ignores case and spaces", async () => {
  const s = newLinkSecret();
  const a = await linkAddress(await linkKeys(s));
  assert.equal(a, await linkAddress(await linkKeys(s)));
  assert.match(a, /^cloak:[0-9a-f]{128}$/);
  const locked = await linkAddress(await linkKeys(s, "  Elysium  Testnet "));
  assert.notEqual(locked, a);
  assert.equal(locked, await linkAddress(await linkKeys(s, "elysium testnet")));
  assert.notEqual(locked, await linkAddress(await linkKeys(s, "elysium")));
});

test("request link round-trips and checks the payee and amount", () => {
  const to = "0x1111111111111111111111111111111111111111";
  const url = buildRequestLink({ to, token: "USDC", amount: "012.50", note: "Invoice 42", name: "Robin" });
  assert.equal(url, `https://cloak.boblabs.tech/pay#to=${to}&amount=12.5&token=USDC&note=Invoice+42&name=Robin`);
  assert.deepEqual(parseRequestLink(url), { to, token: "USDC", amount: "12.5", note: "Invoice 42", name: "Robin" });
  assert.deepEqual(parseRequestLink(`https://cloak.boblabs.tech/pay?to=${to}`), { to, token: "HYPE", amount: undefined, note: undefined, name: undefined });
  assert.throws(() => buildRequestLink({ to: "bob", token: "HYPE" }), /cloak: address or a 0x/);
  assert.throws(() => normalizeLinkAmount("1.1234567", 6), /6 decimal/);
  assert.equal(normalizeLinkAmount("", 18), "");
  assert.equal(checkPayee(to), "wallet");
});
