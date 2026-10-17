/**
 * Run `worker` over `items` with at most `limit` in flight, preserving order.
 * Rejections are captured per item so one failure never kills the batch.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<Array<{ ok: true; value: R } | { ok: false; error: unknown }>> {
  const results = new Array<{ ok: true; value: R } | { ok: false; error: unknown }>(items.length);
  const concurrency = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;

  async function run(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = { ok: true, value: await worker(items[index]!, index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, run));
  return results;
}

/** Same as `mapLimit` but drops failures and returns only the successes. */
export async function mapLimitSettled<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  onError?: (error: unknown, item: T, index: number) => void,
): Promise<R[]> {
  const settled = await mapLimit(items, limit, worker);
  const values: R[] = [];
  settled.forEach((result, index) => {
    if (result.ok) values.push(result.value);
    else onError?.(result.error, items[index]!, index);
  });
  return values;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * A shared cap on how many tasks run at once, for when the callers are spread
 * across the program rather than gathered into one list. Each call to the
 * returned function waits for a free slot, runs, and frees it however the
 * task ends. `max` is read on every call, so a changed setting takes effect.
 */
export function createLimiter(max: () => number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];

  const release = () => {
    active -= 1;
    const next = waiting.shift();
    if (next) next();
  };

  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= Math.max(1, max())) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    active += 1;
    try {
      return await task();
    } finally {
      release();
    }
  };
}
