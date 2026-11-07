// Private receive addresses (CloakReceive): apps register the addresses they hand out, the keeper watches them, and when
// HYPE or a token with a vault arrives it delivers it into the vault as the owner's note, after a random delay so the
// arrival and the new note are harder to pair. It keeps a fee for gas (HYPE only, at most the address's own cap: the
// contract refuses more). The keeper never learns who owns an address: an address only names a one-time key.
// The watch list lives in memory; apps register their open addresses again whenever they're opened.
import { erc20Abi, zeroAddress } from "viem";
import { cloakReceiveAbi, receiveAddressOf } from "@cloakely/sdk";

const TICK_MS = 30_000;
const MAX_DELAY_S = 180; // deliver 0 to 3 minutes after funds are first seen
const DELIVER_GAS = 450_000n;
const MAX_WATCHED = 50_000;

export function startReceive({ pub, wallet, account, factory, tokens = [], minGasPrice = 0n, marginBps = 12_500n, log = () => {} }) {
  /** address (lowercase) → { address, params, due: { token → unix s }, deliveries: [] } */
  const watched = new Map();
  let boxCodeHash = null;
  const codeHash = async () => (boxCodeHash ??= await pub.readContract({ address: factory, abi: cloakReceiveAbi, functionName: "boxCodeHash" }));

  const big = (p) => ({ pubKey: BigInt(p.pubKey), blinding: BigInt(p.blinding), memo: p.memo, maxFeeBps: Number(p.maxFeeBps), rescuer: p.rescuer });

  async function deliver(w, token, amount) {
    let fee = 0n;
    if (token === zeroAddress) {
      const gp = await pub.getGasPrice();
      const cost = (DELIVER_GAS * (gp > minGasPrice ? gp : minGasPrice) * marginBps) / 10_000n;
      const cap = (amount * BigInt(w.params.maxFeeBps)) / 10_000n;
      fee = cost < cap ? cost : cap;
    }
    const args = [w.params, token, fee];
    await pub.simulateContract({ address: factory, abi: cloakReceiveAbi, functionName: "deliver", args, account });
    const hash = await wallet.writeContract({ address: factory, abi: cloakReceiveAbi, functionName: "deliver", args, gas: 900_000n });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`deliver reverted ${hash}`);
    w.deliveries.push({ token, amount: amount.toString(), fee: fee.toString(), txHash: hash, at: Math.floor(Date.now() / 1000) });
    log(`${w.address} delivered ${amount} of ${token === zeroAddress ? "HYPE" : token} (${hash})`);
  }

  async function tick() {
    const now = Math.floor(Date.now() / 1000);
    for (const w of watched.values()) {
      for (const token of [zeroAddress, ...tokens]) {
        const bal = token === zeroAddress
          ? await pub.getBalance({ address: w.address }).catch(() => 0n)
          : await pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [w.address] }).catch(() => 0n);
        if (bal === 0n) {
          delete w.due[token];
          continue;
        }
        w.due[token] ??= now + Math.floor(Math.random() * MAX_DELAY_S);
        if (w.due[token] > now || w.busy) continue;
        w.busy = true;
        try {
          await deliver(w, token, bal);
          delete w.due[token];
        } catch (e) {
          // over a deposit cap, no vault for it, a price spike: leave it there (it's safe) and look again later
          w.due[token] = now + 600;
          log(`${w.address} not delivered yet: ${e.shortMessage ?? e.message}`);
        } finally {
          w.busy = false;
        }
      }
    }
  }
  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    tick().catch(() => {}).finally(() => (running = false));
  }, TICK_MS).unref();

  return {
    /** Register addresses (each checked against its parameters: nobody can register a wrong one). */
    async watch(body) {
      const list = body?.addresses;
      if (!Array.isArray(list) || !list.length || list.length > 20) throw Object.assign(new Error("send 1 to 20 addresses"), { status: 400 });
      const h = await codeHash();
      for (const x of list) {
        if (!x?.params || typeof x.address !== "string") throw Object.assign(new Error("malformed address"), { status: 400 });
        let params;
        try {
          params = big(x.params);
        } catch {
          throw Object.assign(new Error("malformed address"), { status: 400 });
        }
        if (receiveAddressOf(factory, h, params).toLowerCase() !== x.address.toLowerCase()) throw Object.assign(new Error("that address doesn't match its parameters"), { status: 400 });
        const k = x.address.toLowerCase();
        if (!watched.has(k)) {
          if (watched.size >= MAX_WATCHED) throw Object.assign(new Error("the relayer is watching too many addresses right now"), { status: 503 });
          watched.set(k, { address: x.address, params, due: {}, deliveries: [] });
        }
      }
    },
    deliveries(addresses) {
      return Object.fromEntries(addresses.map((a) => [a, watched.get(a.toLowerCase())?.deliveries ?? []]));
    },
  };
}
