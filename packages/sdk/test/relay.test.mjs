// The Relay bridge's checks (bridge/relay.ts), offline: a quote is used only if it does exactly what was asked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { relayQuote, relayStatus, relayServes } from "../dist/index.js";

const BOX = "0x1111111111111111111111111111111111111111";
const W = "0x3333333333333333333333333333333333333333";
const ARB_USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const DEP = "0x4cd00e387622c35bddb9b4c962c136462338bc31";
const RID = "0x" + "ab".repeat(32);
const pad = (h) => h.replace(/^0x/, "").toLowerCase().padStart(64, "0");

function answer({ recipient = BOX, outAddr = "0x0000000000000000000000000000000000000000", outChain = 99901, inAmount = "20000000", steps }) {
  return {
    steps: steps ?? [{ id: "deposit", kind: "transaction", requestId: RID, depositAddress: "0x59f521189f4421240add8cc3bbd18822f55b8ac5", items: [{ data: {} }] }],
    fees: { relayer: { amountUsd: "0.09" } },
    details: {
      recipient,
      timeEstimate: 2,
      currencyIn: { currency: { chainId: 42161, address: ARB_USDC }, amount: inAmount, amountFormatted: "20.0", amountUsd: "20" },
      currencyOut: { currency: { chainId: outChain, address: outAddr }, amount: "270000000000000000", minimumAmount: "265000000000000000", amountFormatted: "0.27", amountUsd: "19.9" },
    },
  };
}
const fake = (body, status = 200) => async () => new Response(JSON.stringify(body), { status });
const ask = (o = {}) => ({ from: { chainId: 42161, symbol: "USDC" }, to: { chainId: 99901, symbol: "HYPE" }, amount: 20_000_000n, recipient: BOX, refundTo: W, ...o });
const walletSteps = (approveTo = DEP, approveAmt = 20_000_000n) => [
  { id: "approve", kind: "transaction", requestId: RID, items: [{ data: { from: W, to: ARB_USDC, chainId: 42161, value: "0", data: "0x095ea7b3" + pad(approveTo) + pad("0x" + approveAmt.toString(16)) } }] },
  { id: "deposit", kind: "transaction", requestId: RID, items: [{ data: { from: W, to: DEP, chainId: 42161, value: "0", data: "0xe8017952" } }] },
];

test("Relay serves Elysium mainnet, not its testnet", () => {
  assert.equal(relayServes(99901), true);
  assert.equal(relayServes(99801), false);
});

test("a deposit address that lands at the receive address is used", async () => {
  const q = await relayQuote(ask(), { fetch: fake(answer({})) });
  assert.equal(q.depositAddress, "0x59f521189f4421240add8cc3bbd18822f55b8ac5");
  assert.equal(q.receive.amount, 270000000000000000n);
  assert.equal(q.recipient, BOX);
});

test("another recipient, chain, token or amount is refused", async () => {
  for (const bad of [{ recipient: W }, { outChain: 999 }, { outAddr: "0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65" }, { inAmount: "30000000" }]) {
    await assert.rejects(relayQuote(ask(), { fetch: fake(answer(bad)) }), /didn't match/);
  }
});

test("wallet mode: an exact approve to the deposit contract, then the deposit", async () => {
  const q = await relayQuote(ask({ wallet: W }), { fetch: fake(answer({ steps: walletSteps() })) });
  assert.equal(q.txs.length, 2);
  assert.equal(q.txs[1].to, DEP);
});

test("wallet mode: an approve to anyone else, or for more, is refused", async () => {
  await assert.rejects(relayQuote(ask({ wallet: W }), { fetch: fake(answer({ steps: walletSteps(W) })) }), /couldn't be checked/);
  await assert.rejects(relayQuote(ask({ wallet: W }), { fetch: fake(answer({ steps: walletSteps(DEP, 2n ** 255n) })) }), /couldn't be checked/);
});

test("wallet mode: a step on another chain or from another sender is refused", async () => {
  const s = walletSteps();
  s[1].items[0].data.chainId = 1;
  await assert.rejects(relayQuote(ask({ wallet: W }), { fetch: fake(answer({ steps: s })) }), /couldn't be checked/);
  const t = walletSteps();
  t[1].items[0].data.from = BOX;
  await assert.rejects(relayQuote(ask({ wallet: W }), { fetch: fake(answer({ steps: t })) }), /couldn't be checked/);
});

test("bad inputs are refused before asking Relay", async () => {
  const never = async () => assert.fail("asked Relay");
  await assert.rejects(relayQuote(ask({ refundTo: "nope" }), { fetch: never }), /Arbitrum address/);
  await assert.rejects(relayQuote(ask({ to: { chainId: 99801, symbol: "HYPE" } }), { fetch: never }), /what to receive/);
  await assert.rejects(relayQuote(ask({ from: { chainId: 792703809, symbol: "USDC" }, refundTo: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" }), { fetch: never }), /switched on/);
  await assert.rejects(relayQuote(ask({ from: { chainId: 728126428, symbol: "USDT" }, refundTo: "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7", wallet: W }), { fetch: never }), /EVM chains only/);
});

test("Relay's own errors read plainly", async () => {
  await assert.rejects(relayQuote(ask(), { fetch: fake({ message: "Amount is too low" }, 400) }), /too small/);
});

test("status words fold into stages", async () => {
  for (const [s, stage] of [["waiting", "waiting"], ["pending", "moving"], ["success", "done"], ["refund", "refunded"], ["failure", "failed"]]) {
    assert.equal((await relayStatus(RID, { fetch: fake({ status: s, txHashes: ["0xdead"] }) })).stage, stage);
  }
});
