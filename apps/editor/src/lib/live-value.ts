import { useState, useSyncExternalStore } from "react";

/**
 * A value that changes faster than its owner should render: the owner writes
 * it, and only the leaf components that read it with `useLiveValue` render.
 */
export type LiveValue<T> = {
  get(): T;
  /** Notifies subscribers unless `next` is the current value (`Object.is`). */
  set(next: T): void;
  subscribe(listener: () => void): () => void;
};

export function createLiveValue<T>(initial: T): LiveValue<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      if (Object.is(next, value)) return;
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** A live value created once for the component's lifetime. */
export function useLiveValueOwner<T>(initial: T): LiveValue<T> {
  const [live] = useState(() => createLiveValue(initial));
  return live;
}

/** Renders the caller whenever `live` changes. */
export function useLiveValue<T>(live: LiveValue<T>): T {
  return useSyncExternalStore(live.subscribe, live.get, live.get);
}
