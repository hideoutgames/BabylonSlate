/**
 * Counts the Behaviour Tree editor panels that are showing live Play state. The running session asks
 * its runtime to publish `btState` only while the count is above zero, so panels and documents share
 * one request and the last one to leave stops it.
 */
export interface BtStateObservers {
  /** Counts one observer until the returned release runs; running it again changes nothing. */
  observe(): () => void;
  /** Whether any observer is registered. */
  observed(): boolean;
  /** Calls `listener` when `observed()` changes (not for every observer). */
  subscribe(listener: (observed: boolean) => void): () => void;
}

export function createBtStateObservers(): BtStateObservers {
  let count = 0;
  const listeners = new Set<(observed: boolean) => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener(count > 0);
  };
  return {
    observe() {
      count += 1;
      if (count === 1) notify();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        count -= 1;
        if (count === 0) notify();
      };
    },
    observed: () => count > 0,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
