/**
 * Whether the editor is quiet: a game view (Play or Preview Build) covers it, so editor work that
 * only serves what the editor shows waits until it is back. The editor stays loaded, with its tabs
 * and selection as they were. A Simulation runs inside the editor and never quiets it.
 *
 * One flag for every background service, readable without React: autosave, thumbnail captures,
 * the asset previews, source-control polling and the foreground rescan check it.
 */
let quiet = false;
const listeners = new Set<() => void>();

/** Set by the Play session provider while a game view covers the editor. */
export function setEditorQuiet(next: boolean): void {
  if (quiet === next) return;
  quiet = next;
  for (const listener of [...listeners]) listener();
}

export function editorQuiet(): boolean {
  return quiet;
}

/** Called each time the editor goes quiet or comes back. */
export function subscribeEditorQuiet(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Resolves once the editor is not quiet, or when `signal` aborts. */
export function whenEditorAwake(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!quiet || signal.aborted) { resolve(); return; }
    const settle = () => {
      if (quiet && !signal.aborted) return;
      unsubscribe();
      signal.removeEventListener("abort", settle);
      resolve();
    };
    const unsubscribe = subscribeEditorQuiet(settle);
    signal.addEventListener("abort", settle);
  });
}
