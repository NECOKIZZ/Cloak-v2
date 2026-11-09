import { useEffect, useState } from "react";
import { parseAbi } from "viem";
import { fromJson, scheduleRelay, scheduleStatus, shieldedPoolAbi, toJson, type ScheduledPiece, type ScheduledStatus } from "@cloakely/sdk";
import type { Priv } from "./state";
import { publicClient } from "./wallet";
import { RELAYER_URL } from "./config";
import { openBox, sealBox } from "./deviceBox";
import { useApp } from "./state";
import { every } from "./every";

/** A split-withdrawal piece as this device keeps it (encrypted): the proved call, so it can be handed back to the
 * relayer if the relayer restarted and lost its queue. */
export interface SavedPiece {
  id: string;
  piece: ScheduledPiece;
  symbol: string;
  decimals: number;
  status?: ScheduledStatus;
}

const LABEL = "scheduled";
const GLOAM_VAULT = parseAbi(["function isSpent(bytes32) view returns (bool)"]);

/** Whether a piece's note is spent (it went out, or the owner cancelled it): Cloak's vaults or a Gloam vault. */
async function isSpent(call: ScheduledPiece["call"]): Promise<boolean> {
  if (call.kind === "gloamUnshield") return publicClient.readContract({ address: call.to, abi: GLOAM_VAULT, functionName: "isSpent", args: [call.nullifier] });
  return publicClient.readContract({ address: call.pool, abi: shieldedPoolAbi, functionName: "isSpent", args: [BigInt(call.proof.inputNullifiers[0] as never)] });
}
export async function loadScheduled(p: Priv): Promise<SavedPiece[]> {
  const s = await openBox(p, LABEL);
  try {
    return s ? fromJson<SavedPiece[]>(s) : [];
  } catch {
    return [];
  }
}
export const saveScheduled = (p: Priv, list: SavedPiece[]) => sealBox(p, LABEL, toJson(list));

/** Queue pieces with the relayer and remember them on this device. */
export async function schedule(p: Priv, pieces: ScheduledPiece[], symbol: string, decimals: number): Promise<SavedPiece[]> {
  if (!RELAYER_URL) throw new Error("Scheduled withdrawals need Cloak's relayer.");
  const ids = await scheduleRelay(RELAYER_URL, pieces);
  const mine = pieces.map((piece, i) => ({ id: ids[i], piece, symbol, decimals }));
  await saveScheduled(p, [...(await loadScheduled(p)), ...mine]);
  return mine;
}

/** This account's scheduled pieces with their live state, refreshed every 30 s. Pieces the relayer no longer knows
 * (it restarted) are handed back to it; finished ones are forgotten a day after their time. */
export function useScheduled() {
  const { priv } = useApp();
  const [items, setItems] = useState<SavedPiece[]>([]);
  useEffect(() => {
    if (!priv || !RELAYER_URL) return;
    let live = true;
    const go = async () => {
      const list = await loadScheduled(priv);
      if (!list.length) return live && setItems([]);
      const st = await scheduleStatus(RELAYER_URL!, list.map((x) => x.id)).catch(() => null);
      const now = Date.now() / 1000;
      // pieces the relayer doesn't know (it restarted): already spent means it went out (or was cancelled); otherwise hand it back
      const lost = list.filter((x, i) => st?.[i]?.state === "unknown" && !(x.status && x.status.state !== "waiting"));
      const spent = await Promise.all(lost.map((x) => isSpent(x.piece.call).catch(() => false)));
      lost.forEach((x, i) => spent[i] && (x.status = { id: x.id, state: "sent" }));
      const resend = lost.filter((_, i) => !spent[i]);
      if (resend.length) await scheduleRelay(RELAYER_URL!, resend.map((x) => x.piece)).catch(() => {});
      const next = list
        .map((x, i) => ({ ...x, status: st?.[i]?.state === "unknown" ? x.status : st?.[i] ?? x.status }))
        .filter((x) => !(x.status && x.status.state !== "waiting" && now - x.piece.notBefore > 86_400));
      if (toJson(next) !== toJson(list)) await saveScheduled(priv, next);
      if (live) setItems(next);
    };
    go();
    const stop = every(go, 30_000);
    return () => {
      live = false;
      stop();
    };
  }, [priv]);
  return items;
}
