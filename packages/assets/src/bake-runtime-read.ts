/** Cancellation settles the owner even when an existing storage backend cannot cancel its IO. */
export function awaitBakeRuntimeRead<T>(
  signal: AbortSignal | undefined,
  read: () => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return read();
  return new Promise<T>((resolve, reject) => {
    const cancel = () => {
      signal.removeEventListener("abort", cancel);
      reject(signal.reason);
    };
    signal.addEventListener("abort", cancel, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return read();
      })
      .then(
        (value) => {
          signal.removeEventListener("abort", cancel);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", cancel);
          reject(error);
        },
      );
  });
}
