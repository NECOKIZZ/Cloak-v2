// Split withdrawals: an app proves 2–4 withdrawal pieces up front (each one's recipient fixed by its proof) and hands
// them over with a send-after time each. The keeper checks every piece now (a dry run, fee included), holds it, and
// relays it once it's due. It can only send a piece or refuse it, never change it. A piece whose note was spent
// meanwhile (the owner cancelled it) is dropped. The queue lives in memory: the app keeps its pieces too and hands
// back any the keeper no longer knows (after a restart). The same piece is never queued twice (id = its nullifiers).
//
// Cloak v2 on Gloam: a piece can also be a Gloam vault cash out ({ kind: "gloamUnshield", to: vault, data }). Gloam's
// vault keeps every root valid for good, so a cash out proved now still goes through later, until its note is spent.
// Those go through the Gloam relay (`gloam`), which allows only vault cash outs to a safe address here.
import { decodeFunctionData, keccak256, parseAbi, toHex } from "viem";

const GLOAM_UNSHIELD = parseAbi(["function unshield(bytes proof, bytes32 root, bytes32 nullifier, address asset, address to, uint256 amount)"]);

const MAX_PIECES = 4;
const MAX_AHEAD = 48 * 3600; // a piece can wait at most 48 hours
const TICK_MS = 20_000;
const MAX_TRIES = 8;

/** The nullifier a Gloam cash out spends, or throws if the call isn't one. */
function gloamNullifier(call) {
  if (typeof call.to !== "string" || typeof call.data !== "string") throw Object.assign(new Error("malformed piece"), { status: 400 });
  let d;
  try {
    d = decodeFunctionData({ abi: GLOAM_UNSHIELD, data: call.data });
  } catch {
    throw Object.assign(new Error("only withdrawals can be scheduled"), { status: 400 });
  }
  return d.args[2];
}

/**
 * @param check, send the Cloak relay (dry run, real)
 * @param gloam { check, send } for Gloam vault cash outs, or omit it
 */
export function startSchedule({ check, send, gloam, log = () => {}, now: clock = () => Math.floor(Date.now() / 1000), tickMs = TICK_MS }) {
  /** id → { call, notBefore, state: "waiting"|"sent"|"dropped", tries, txHash?, error? } */
  const q = new Map();
  const idOf = (call) =>
    call.kind === "gloamUnshield"
      ? keccak256(toHex(JSON.stringify(["gloam", call.to.toLowerCase(), gloamNullifier(call)])))
      : keccak256(toHex(JSON.stringify([call.pool, ...(call.proof?.inputNullifiers ?? [])].map(String))));
  const viaFor = (call) => (call.kind === "gloamUnshield" ? gloam : { check, send });

  async function tick() {
    const now = clock();
    for (const [id, p] of q) {
      if (p.state !== "waiting" || p.notBefore > now || p.busy) continue;
      p.busy = true;
      try {
        p.txHash = await viaFor(p.call).send(p.call, p.requester);
        p.state = "sent";
        log(`${id.slice(0, 10)} sent ${p.txHash}`);
      } catch (e) {
        const msg = e?.shortMessage ?? e?.message ?? String(e);
        if ((e?.status === 409 && /spent/i.test(msg)) || /already spent|NullifierAlreadySpent|AlreadySpent/i.test(msg)) {
          p.state = "dropped";
          p.error = "its note was spent (cancelled)";
        } else if (e?.status === 429) {
          p.notBefore = now + 120; // the relay's budget is busy: wait, it isn't this piece's fault (review O-10)
        } else if (++p.tries >= MAX_TRIES) {
          p.state = "dropped";
          p.error = msg;
        } else p.notBefore = now + 60 * p.tries; // try again a little later
        log(`${id.slice(0, 10)} ${p.state === "dropped" ? "dropped" : "retry"}: ${msg}`);
      } finally {
        p.busy = false;
      }
    }
    // forget finished pieces after a day
    for (const [id, p] of q) if (p.state !== "waiting" && now - p.notBefore > 86_400) q.delete(id);
  }
  const timer = tickMs > 0 ? setInterval(() => tick().catch(() => {}), tickMs) : null;
  timer?.unref();

  return {
    /** Pieces still waiting to go out (the keeper stays awake while any are queued). */
    waiting: () => [...q.values()].filter((p) => p.state === "waiting").length,
    /** Send what's due now (runs on its own every tickMs; tests call it directly). */
    tick,
    stop: () => timer && clearInterval(timer),
    /** Check and queue pieces; returns their ids (already-queued pieces just return their id). */
    async add(body, requester = "schedule") {
      const pieces = body?.pieces;
      if (!Array.isArray(pieces) || !pieces.length || pieces.length > MAX_PIECES) throw Object.assign(new Error(`send 1 to ${MAX_PIECES} pieces`), { status: 400 });
      const now = clock();
      const ids = [];
      for (const p of pieces) {
        if (!p?.call || typeof p.call !== "object" || !Number.isFinite(p.notBefore)) throw Object.assign(new Error("malformed piece"), { status: 400 });
        if (p.notBefore > now + MAX_AHEAD) throw Object.assign(new Error("a piece can wait at most 48 hours"), { status: 400 });
        if (p.call.kind === "gloamUnshield") {
          if (!gloam) throw Object.assign(new Error("this relayer doesn't serve Gloam vaults"), { status: 400 });
          gloamNullifier(p.call); // a vault cash out, or refused
        } else {
          if (p.call.kind !== "transact" && p.call.kind !== "unshieldHype") throw Object.assign(new Error("only withdrawals can be scheduled"), { status: 400 });
          if (!(BigInt(p.call.extData?.extAmount ?? 0) < 0n)) throw Object.assign(new Error("only withdrawals can be scheduled"), { status: 400 });
        }
        const id = idOf(p.call);
        if (!q.has(id)) {
          await viaFor(p.call).check(p.call, requester); // throws (fee, proof, spent) before anything is queued
          q.set(id, { call: p.call, notBefore: Math.max(now, Math.floor(p.notBefore)), state: "waiting", tries: 0, requester });
          log(`${id.slice(0, 10)} queued for ${new Date(Math.max(now, p.notBefore) * 1000).toISOString()}`);
        }
        ids.push(id);
      }
      return ids;
    },
    status(ids) {
      return ids.map((id) => {
        const p = q.get(id);
        return p ? { id, state: p.state, notBefore: p.notBefore, txHash: p.txHash, error: p.error } : { id, state: "unknown" };
      });
    },
  };
}
