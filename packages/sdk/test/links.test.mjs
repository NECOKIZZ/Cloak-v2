import { test } from "node:test";
import assert from "node:assert/strict";
import { buildClaimLink, parseClaimLink, buildRequestLink, parseRequestLink, linkKeys, linkAddress, linkCheck, openLinkKeys, WrongPasscodeError, newLinkSecret, normalizeLinkAmount, checkPayee } from "../dist/index.js";

test("claim link round-trips every field", () => {
  const secret = newLinkSecret();
  const url = buildClaimLink({ secret, block: 21500000n, token: "USDC", amount: "25", message: "Happy birthday 🎉", from: "Robin", locked: true, hint: "Our chain?", shares: 5 });
  assert.match(url, /^https:\/\/cloak\.boblabs\.tech\/claim#c[0-9A-Za-z]+$/, "only letters and digits after the #, so chat apps keep the whole link");
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
  const url = buildClaimLink({ secret: newLinkSecret(), block: 1n, message: "gm" });
  for (const cut of [10, 25, 60]) assert.throws(() => parseClaimLink(url.slice(0, -cut)), /cut short|damaged/);
  assert.throws(() => parseClaimLink(url.slice(0, url.indexOf("#") + 30)), /cut short|damaged/);
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

test("links made before the compact format still open", () => {
  const secret = newLinkSecret();
  const b64 = Buffer.from(secret).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const l = parseClaimLink(`https://cloak.boblabs.tech/claim#k=${b64}&b=7&t=HYPE&a=0.01&m=gm&p=1&q=my+name`);
  assert.deepEqual([...l.secret], [...secret]);
  assert.equal(l.amount, "0.01");
  assert.equal(l.hint, "my name");
  assert.equal(l.check, undefined);
});

test("a passcode check catches a wrong code before any network call, and forgives what phones do to a code", async () => {
  const secret = newLinkSecret();
  const keys = await linkKeys(secret, "it’s sage");
  const l = parseClaimLink(buildClaimLink({ secret, block: 1n, locked: true, hint: "my name", check: await linkCheck(keys) }));
  assert.match(l.check, /^[0-9a-f]{8}$/);
  const addr = await linkAddress(keys);
  assert.equal(await linkAddress(await openLinkKeys(l, "  IT’S   Sage ")), addr);
  await assert.rejects(openLinkKeys(l, "sage"), WrongPasscodeError);
  await assert.rejects(openLinkKeys(l, "sage"), /not the answer/);
  // typed with a straight quote, or a full stop from autocorrect, by a sender whose phone made it curly
  const k2 = await linkKeys(secret, "it's sage");
  const l2 = parseClaimLink(buildClaimLink({ secret, block: 1n, locked: true, check: await linkCheck(k2) }));
  assert.equal(await linkAddress(await openLinkKeys(l2, "it’s sage.")), await linkAddress(k2));
  // an unlocked link needs no code
  assert.equal(await linkAddress(await openLinkKeys(parseClaimLink(buildClaimLink({ secret, block: 1n })))), await linkAddress(await linkKeys(secret)));
});
