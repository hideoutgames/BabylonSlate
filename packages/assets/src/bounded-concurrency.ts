/**
 * Small helpers for overlapping storage reads without changing the order in
 * which results are consumed. Callers keep their sequential decision logic and
 * only prefetch the I/O, so the first failure and the order of side effects stay
 * what a plain `for ... await` loop produced.
 */

const ignore = (): void => undefined;

/** At most `limit` tasks run at once; waiting tasks start in the order they were submitted. */
export function createLimiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  const capacity = Math.max(1, Math.floor(limit));
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= capacity) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try { return await task(); }
    finally {
      // A finished task hands its slot straight to the next waiter.
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

/**
 * Map `items` with at most `limit` tasks in flight, in item order. Results keep
 * item order. After a failure no further task starts; the tasks already running
 * settle, and the failure of the lowest item index is thrown. That is the error a
 * sequential loop would have thrown, because every lower item had started first.
 */
export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failedAt = Infinity;
  let failure: unknown;
  const worker = async (): Promise<void> => {
    while (failedAt === Infinity && next < items.length) {
      const index = next++;
      try {
        signal?.throwIfAborted();
        results[index] = await task(items[index]!, index);
      } catch (error) {
        if (index < failedAt) { failedAt = index; failure = error; }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, Math.floor(limit)), items.length) }, worker));
  if (failedAt !== Infinity) throw failure;
  return results;
}

/** See `createReadAhead`. */
export interface ReadAhead<K, V> {
  (order: readonly K[], index: number): Promise<V>;
  /** Resolves once every read that was started but not yet consumed has settled. Never rejects. */
  settle(): Promise<void>;
}

/**
 * Ordered read-ahead. The returned function starts `start(key)` for `order[index]`
 * and for up to `window - 1` keys after it (so the window counts the current key)
 * that have not started, then returns the promise for `order[index]`. Only keys of
 * the `order` passed to that call are started, so a caller that passes a run of
 * keys never reads beyond the run. The consumer awaits keys in order, so decisions
 * and errors surface in the same order as without read-ahead. A prefetched failure
 * that the consumer never reaches (because an earlier key failed) is not reported
 * as an unhandled rejection, and a consumed result is released. A consumer that
 * stops early calls `settle()` to wait for the reads it leaves running.
 */
export function createReadAhead<K, V>(
  window: number,
  start: (key: K) => Promise<V>,
): ReadAhead<K, V> {
  const ahead = Math.max(1, Math.floor(window));
  const started = new Map<K, Promise<V>>();
  const begin = (key: K): Promise<V> => {
    let promise = started.get(key);
    if (!promise) {
      try { promise = start(key); }
      catch (error) { promise = Promise.reject(error); }
      promise.catch(ignore);
      started.set(key, promise);
    }
    return promise;
  };
  const take = (order: readonly K[], index: number): Promise<V> => {
    const current = begin(order[index]!);
    for (let next = index + 1; next < Math.min(order.length, index + ahead); next++) begin(order[next]!);
    started.delete(order[index]!);
    return current;
  };
  return Object.assign(take, {
    settle: async (): Promise<void> => { await Promise.allSettled([...started.values()]); },
  });
}
