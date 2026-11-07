import { useEffect, useState } from "react";
import { fromJson, scheduleRelay, scheduleStatus, shieldedPoolAbi, toJson, type CloakPrivate, type ScheduledPiece, type ScheduledStatus } from "@cloakely/sdk";
import { publicClient } from "./wallet";
import { RELAYER_URL } from "./config";
import { openBox, sealBox } from "./deviceBox";
import { useApp } from "./state";

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
export async function loadScheduled(p: CloakPrivate): Promise<SavedPiece[]> {
  const s = await openBox(p, LABEL);
  try {
    return s ? fromJson<SavedPiece[]>(s) : [];
  } catch {
    return [];
  }
}
export const saveScheduled = (p: CloakPrivate, list: SavedPiece[]) => sealBox(p, LABEL, toJson(list));

/** Queue pieces with the relayer and remember them on this device. */
export async function schedule(p: CloakPrivate, pieces: ScheduledPiece[], symbol: string, decimals: number): Promise<SavedPiece[]> {
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
      const spent = await Promise.all(lost.map((x) => publicClient.readContract({ address: x.piece.call.pool, abi: shieldedPoolAbi, functionName: "isSpent", args: [BigInt(x.piece.call.proof.inputNullifiers[0] as never)] }).catch(() => false)));
      lost.forEach((x, i) => spent[i] && (x.status = { id: x.id, state: "sent" }));
      const resend = lost.filter((_, i) => !spent[i]);
      if (resend.length) await scheduleRelay(RELAYER_URL!, resend.map((x) => x.piece)).catch(() => {});
      const next = list
        .map((x, i) => ({ ...x, status: st?.[i]?.state === "unknown" ? x.status : st?.[i] ?? x.status }))
        .filter((x) => !(x.status && x.status.state !== "waiting" && now - x.piece.notBefore > 86_400));
      await saveScheduled(priv, next);
      if (live) setItems(next);
    };
    go();
    const t = setInterval(go, 30_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [priv]);
  return items;
}
