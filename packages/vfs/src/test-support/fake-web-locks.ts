type LockCallback<T> = (lock: { name: string } | null) => T | PromiseLike<T>;

/**
 * Origin-wide `navigator.locks` double: exclusive locks granted in request
 * order, `ifAvailable` answered with a null lock while the name is held or
 * queued, and a request that settles only after its lock is released. Every
 * adapter sharing one instance behaves as a tab of the same origin.
 */
export function createFakeWebLocks() {
  const tails = new Map<string, Promise<unknown>>();
  const outstanding = new Map<string, number>();
  return {
    async request<T>(
      name: string,
      optionsOrCallback: { ifAvailable?: boolean } | LockCallback<T>,
      maybeCallback?: LockCallback<T>,
    ): Promise<T> {
      const options = typeof optionsOrCallback === "function" ? {} : optionsOrCallback;
      const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback!;
      const count = outstanding.get(name) ?? 0;
      if (options.ifAvailable && count > 0) return callback(null);
      outstanding.set(name, count + 1);
      const run = (tails.get(name) ?? Promise.resolve()).then(() => callback({ name }));
      tails.set(name, run.then(() => undefined, () => undefined));
      try {
        return await run;
      } finally {
        outstanding.set(name, outstanding.get(name)! - 1);
      }
    },
  };
}
