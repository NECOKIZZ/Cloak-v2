// Private receive addresses (CloakReceive): apps register the addresses they hand out, the keeper watches them, and when
// HYPE or a token with a vault arrives it delivers it into the vault as the owner's note, seconds after it lands. It keeps
// a fee for gas (HYPE only, at most the address's own cap: the contract refuses more). The keeper never learns who owns
// an address: an address only names a one-time key. The delivery itself shows on chain which address paid into the
// vault (as any deposit does), so waiting would hide little; an address registered with `delay` still gets a random
// wait of up to 3 minutes for whoever wants it.
// The watch list lives in memory; apps register their open addresses again whenever they're opened. Addresses
// registered in the last couple of hours (a payment usually follows soon after an address is shown) are checked every
// few seconds, the rest every half minute, all in one multicall per round.
import { erc20Abi, zeroAddress } from "viem";
import { cloakReceiveAbi, receiveAddressOf } from "@cloakely/sdk";

const HOT_TICK_MS = 3_000; // recently registered addresses
const COLD_TICK_MS = 30_000; // the rest
const HOT_FOR_S = 2 * 3600;
const MAX_DELAY_S = 180; // with `delay`: deliver 0 to 3 minutes after funds are first seen
const CHUNK = 400; // reads per multicall
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const mc3Abi = [{ type: "function", name: "getEthBalance", stateMutability: "view", inputs: [{ name: "addr", type: "address" }], outputs: [{ name: "balance", type: "uint256" }] }];
const DELIVER_GAS = 1_400_000n; // a first delivery deploys the box and inserts into the vault's tree
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
    const est = await pub.estimateContractGas({ address: factory, abi: cloakReceiveAbi, functionName: "deliver", args, account: account.address });
    const hash = await wallet.writeContract({ address: factory, abi: cloakReceiveAbi, functionName: "deliver", args, gas: (est * 13n) / 10n + 100_000n });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`deliver reverted ${hash}`);
    w.deliveries.push({ token, amount: amount.toString(), fee: fee.toString(), txHash: hash, at: Math.floor(Date.now() / 1000) });
    log(`${w.address} delivered ${amount} of ${token === zeroAddress ? "HYPE" : token} (${hash})`);
  }

  // every balance this round needs, in as few calls as possible (one by one where the chain has no multicall3)
  async function balances(list) {
    const reads = list.flatMap((w) => [zeroAddress, ...tokens].map((token) => ({ w, token })));
    const mc = pub.chain?.contracts?.multicall3?.address ?? (pub.chain?.id === 31337 ? null : MULTICALL3);
    const out = [];
    for (let i = 0; i < reads.length; i += CHUNK) {
      const part = reads.slice(i, i + CHUNK);
      const call = ({ w, token }) =>
        token === zeroAddress
          ? { address: mc, abi: mc3Abi, functionName: "getEthBalance", args: [w.address] }
          : { address: token, abi: erc20Abi, functionName: "balanceOf", args: [w.address] };
      let vals;
      if (mc) {
        const r = await pub.multicall({ contracts: part.map(call), allowFailure: true, multicallAddress: mc }).catch(() => null);
        vals = r ? r.map((x) => (x.status === "success" ? x.result : null)) : part.map(() => null);
      } else {
        vals = await Promise.all(part.map(({ w, token }) =>
          (token === zeroAddress ? pub.getBalance({ address: w.address }) : pub.readContract(call({ w, token }))).catch(() => null)));
      }
      part.forEach((x, j) => out.push({ ...x, bal: vals[j] }));
    }
    return out;
  }

  async function tick(hotOnly) {
    const now = Math.floor(Date.now() / 1000);
    const list = [...watched.values()].filter((w) => !hotOnly || now - w.seen < HOT_FOR_S);
    if (!list.length) return;
    for (const { w, token, bal } of await balances(list)) {
      if (bal == null) continue; // the read failed: look again next round
      if (bal === 0n) {
        delete w.due[token];
        continue;
      }
      w.due[token] ??= now + (w.delay ? Math.floor(Math.random() * MAX_DELAY_S) : 0);
      if (w.due[token] > now || w.busy) continue;
      w.busy = true;
      try {
        await deliver(w, token, bal);
        delete w.due[token];
      } catch (e) {
        // over a deposit cap, no vault for it, a price spike: leave it there (it's safe) and look again later
        w.due[token] = Math.floor(Date.now() / 1000) + 600;
        log(`${w.address} not delivered yet: ${e.shortMessage ?? e.message}`);
      } finally {
        w.busy = false;
      }
    }
  }
  let running = false;
  let lastCold = 0;
  setInterval(() => {
    if (running) return;
    running = true;
    const cold = Date.now() - lastCold >= COLD_TICK_MS;
    if (cold) lastCold = Date.now();
    tick(!cold).catch(() => {}).finally(() => (running = false));
  }, HOT_TICK_MS).unref();

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
        const seen = Math.floor(Date.now() / 1000);
        const w = watched.get(k);
        if (w) {
          w.seen = seen; // registered again: the app is open, check it often
          w.delay = x.delay === true;
        } else {
          if (watched.size >= MAX_WATCHED) throw Object.assign(new Error("the relayer is watching too many addresses right now"), { status: 503 });
          watched.set(k, { address: x.address, params, due: {}, deliveries: [], seen, delay: x.delay === true });
        }
      }
    },
    deliveries(addresses) {
      return Object.fromEntries(addresses.map((a) => [a, watched.get(a.toLowerCase())?.deliveries ?? []]));
    },
  };
}
