import { useEffect } from "react";

/**
 * Blocking scene loads open in the editor: a Scene viewport's load, a scene
 * document read, a Play scene transition, each while its Scene Loading dialog
 * shows progress (not once it shows a failure, and not for a rendering update,
 * which every settings change starts). Background work
 * on the shared project Engine, such as Content Browser thumbnail captures,
 * waits until none is open: its shader compiles would otherwise count as the
 * load's compile progress and keep a stuck load alive.
 */
let open = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

/** Mark a blocking scene load open until the returned release runs (once). */
export function holdBlockingSceneLoad(): () => void {
  open += 1;
  if (open === 1) notify();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    open -= 1;
    if (open === 0) notify();
  };
}

export function blockingSceneLoadOpen(): boolean {
  return open > 0;
}

/** Called when the first blocking load opens and when the last one closes. */
export function subscribeBlockingSceneLoads(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Resolves once no blocking scene load is open, or when `signal` aborts. */
export function whenNoBlockingSceneLoad(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!blockingSceneLoadOpen() || signal.aborted) { resolve(); return; }
    const settle = () => {
      if (blockingSceneLoadOpen() && !signal.aborted) return;
      unsubscribe();
      signal.removeEventListener("abort", settle);
      resolve();
    };
    const unsubscribe = subscribeBlockingSceneLoads(settle);
    signal.addEventListener("abort", settle);
  });
}

/** Holds a blocking scene load while `active`. */
export function useBlockingSceneLoad(active: boolean): void {
  useEffect(() => (active ? holdBlockingSceneLoad() : undefined), [active]);
}
