/**
 * Whether the editor viewports' frames are held while Save All runs. Save All
 * is a chain of storage awaits on the main thread, and each await resumes only
 * after any viewport frame drawn meanwhile, so a viewport drawing continuously
 * multiplies its duration.
 *
 * Reference-counted: overlapping holds keep the frames held until the last one
 * is released. Readable without React, like `editor-quiet.ts`: Save All runs in
 * the document provider, above the Play session provider that owns the editor
 * viewports' scheduler registry, which follows this state.
 */
let holds = 0;
const listeners = new Set<(held: boolean) => void>();

function publish(held: boolean): void {
  for (const listener of [...listeners]) listener(held);
}

/** Hold the editor viewports' frames until the returned release is called; releasing twice is a no-op. */
export function holdEditorViewportFrames(): () => void {
  holds += 1;
  if (holds === 1) publish(true);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds -= 1;
    if (holds === 0) publish(false);
  };
}

/** Run `work` with the editor viewports' frames held, releasing the hold however it settles. */
export async function withEditorViewportFramesHeld<T>(work: () => Promise<T>): Promise<T> {
  const release = holdEditorViewportFrames();
  try {
    return await work();
  } finally {
    release();
  }
}

export function editorViewportFramesHeld(): boolean {
  return holds > 0;
}

/** Called with the current state now, then each time the frames become held or free. */
export function subscribeEditorViewportFrameHold(listener: (held: boolean) => void): () => void {
  listeners.add(listener);
  listener(holds > 0);
  return () => {
    listeners.delete(listener);
  };
}
