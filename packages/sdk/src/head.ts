/**
 * Reading logs up to the head on a load-balanced RPC. Elysium's public RPC is several nodes behind one address, a block
 * or two apart, so eth_getLogs up to the head one node just reported can land on a node that hasn't reached it and is
 * refused ("invalid block range params", which viem shows as "Missing or invalid parameters"): 4 of 300 tries on
 * Nov 10. Three blocks back failed 0 times in 300.
 *
 * So a read goes up to the head first, and only when a node refuses the range, once more up to HEAD_LAG blocks back.
 * Not a fixed lag: on a chain that makes blocks only with transactions (a local node, a quiet L2) a fixed lag would hide
 * the newest blocks until more arrive. Elysium makes 5 to 7 blocks a second, so the fallback costs about half a second.
 */
export const HEAD_LAG = 3n;

const BEHIND = /invalid block range|block range|missing or invalid parameters|header not found|unknown block|after last accepted block|beyond current head/i;

/** A node behind the head refused a block range. */
export function isBehindHead(e: unknown): boolean {
  const x = e as { shortMessage?: string; message?: string; details?: string } | undefined;
  return BEHIND.test(`${x?.shortMessage ?? ""} ${x?.details ?? ""} ${x?.message ?? ""}`);
}

/**
 * Runs `read` up to the head; if a lagging node refuses the range, runs it again up to HEAD_LAG blocks back. Returns
 * the block it read up to (a cursor's next block is that plus one) and what `read` returned.
 */
export async function readToHead<T>(client: { getBlockNumber(a?: { cacheTime?: number }): Promise<bigint> }, read: (to: bigint) => Promise<T>): Promise<{ to: bigint; value: T }> {
  const head = await client.getBlockNumber({ cacheTime: 0 });
  try {
    return { to: head, value: await read(head) };
  } catch (e) {
    if (!isBehindHead(e) || head < HEAD_LAG) throw e;
    const to = head - HEAD_LAG;
    return { to, value: await read(to) };
  }
}

/**
 * Logs from `from` to the head: in one call (readToHead), else in `step`-block pieces up to HEAD_LAG blocks back, for
 * RPCs that cap ranges. `quiet` skips a piece that fails; `firstOnly` stops at the first piece with any log.
 */
export async function logsToHead<T>(
  client: { getBlockNumber(a?: { cacheTime?: number }): Promise<bigint> },
  from: bigint,
  get: (from: bigint, to: bigint) => Promise<T[]>,
  o: { step: bigint; quiet?: boolean; firstOnly?: boolean },
): Promise<T[]> {
  try {
    return (await readToHead(client, (to) => logsSplitting(get, from, to))).value;
  } catch {
    const head = await client.getBlockNumber({ cacheTime: 0 });
    const last = head > HEAD_LAG ? head - HEAD_LAG : head;
    const out: T[] = [];
    for (let a = from; a <= last; a += o.step) {
      const b = a + o.step - 1n < last ? a + o.step - 1n : last;
      out.push(...(o.quiet ? await logsSplitting(get, a, b).catch(() => [] as T[]) : await logsSplitting(get, a, b)));
      if (o.firstOnly && out.length) break;
    }
    return out;
  }
}

const TOO_MANY = /count limit exceeded|logs? limit exceeded|too many (logs|results)|more than \d+ (logs|results)|query returned more than|response size/i;

/** The RPC refused because the answer would hold too many logs (Elysium mainnet's public RPC: 10,000 per call). */
export function isTooManyLogs(e: unknown): boolean {
  const x = e as { shortMessage?: string; message?: string; details?: string } | undefined;
  return TOO_MANY.test(`${x?.shortMessage ?? ""} ${x?.details ?? ""} ${x?.message ?? ""}`);
}

/**
 * Logs from `from` to `to`, splitting the range in half (and again) whenever the RPC says the answer has too many logs.
 * Measured Nov 10: Elysium mainnet's public RPC caps an eth_getLogs answer at 10,000 logs, whatever the range, and
 * Uniswap's PoolManager alone passes that in under 10,000 blocks. Results stay in block order.
 */
export async function logsSplitting<T>(get: (from: bigint, to: bigint) => Promise<T[]>, from: bigint, to: bigint): Promise<T[]> {
  if (from > to) return [];
  try {
    return await get(from, to);
  } catch (e) {
    if (!isTooManyLogs(e) || from === to) throw e;
    const mid = from + (to - from) / 2n;
    return [...(await logsSplitting(get, from, mid)), ...(await logsSplitting(get, mid + 1n, to))];
  }
}
