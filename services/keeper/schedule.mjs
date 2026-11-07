// Split withdrawals: an app proves 2–4 withdrawal pieces up front (each one's recipient fixed by its proof) and hands
// them over with a send-after time each. The keeper checks every piece now (a dry run, fee included), holds it, and
// relays it once it's due. It can only send a piece or refuse it, never change it. A piece whose note was spent
// meanwhile (the owner cancelled it) is dropped. The queue lives in memory: the app keeps its pieces too and hands
// back any the keeper no longer knows (after a restart). The same piece is never queued twice (id = its nullifiers).
import { keccak256, toHex } from "viem";

const MAX_PIECES = 4;
const MAX_AHEAD = 48 * 3600; // a piece can wait at most 48 hours
const TICK_MS = 20_000;
const MAX_TRIES = 8;

export function startSchedule({ check, send, log = () => {} }) {
  /** id → { call, notBefore, state: "waiting"|"sent"|"dropped", tries, txHash?, error? } */
  const q = new Map();
  const idOf = (call) => keccak256(toHex(JSON.stringify([call.pool, ...(call.proof?.inputNullifiers ?? [])].map(String))));

  async function tick() {
    const now = Math.floor(Date.now() / 1000);
    for (const [id, p] of q) {
      if (p.state !== "waiting" || p.notBefore > now || p.busy) continue;
      p.busy = true;
      try {
        p.txHash = await send(p.call);
        p.state = "sent";
        log(`${id.slice(0, 10)} sent ${p.txHash}`);
      } catch (e) {
        const msg = e?.shortMessage ?? e?.message ?? String(e);
        if (e?.status === 409 || /already spent|NullifierAlreadySpent/i.test(msg)) {
          p.state = "dropped";
          p.error = "its note was spent (cancelled)";
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
  setInterval(() => tick().catch(() => {}), TICK_MS).unref();

  return {
    /** Check and queue pieces; returns their ids (already-queued pieces just return their id). */
    async add(body) {
      const pieces = body?.pieces;
      if (!Array.isArray(pieces) || !pieces.length || pieces.length > MAX_PIECES) throw Object.assign(new Error(`send 1 to ${MAX_PIECES} pieces`), { status: 400 });
      const now = Math.floor(Date.now() / 1000);
      const ids = [];
      for (const p of pieces) {
        if (!p?.call || typeof p.call !== "object" || !Number.isFinite(p.notBefore)) throw Object.assign(new Error("malformed piece"), { status: 400 });
        if (p.notBefore > now + MAX_AHEAD) throw Object.assign(new Error("a piece can wait at most 48 hours"), { status: 400 });
        if (p.call.kind !== "transact" && p.call.kind !== "unshieldHype") throw Object.assign(new Error("only withdrawals can be scheduled"), { status: 400 });
        if (!(BigInt(p.call.extData?.extAmount ?? 0) < 0n)) throw Object.assign(new Error("only withdrawals can be scheduled"), { status: 400 });
        const id = idOf(p.call);
        if (!q.has(id)) {
          await check(p.call); // throws (fee, proof, spent) before anything is queued
          q.set(id, { call: p.call, notBefore: Math.max(now, Math.floor(p.notBefore)), state: "waiting", tries: 0 });
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
