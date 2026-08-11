/**
 * Reason-set pause for the texture encode queue so Play and visibility can
 * both request pause without one resume undoing the other (engineplan §2.4 / §3.5).
 */
type PauseListener = (paused: boolean) => void;

const reasons = new Set<string>();
const listeners = new Set<PauseListener>();

function notify(): void {
  const paused = reasons.size > 0;
  for (const listener of listeners) listener(paused);
}

export function onEncodeQueuePause(listener: PauseListener): () => void {
  listeners.add(listener);
  listener(reasons.size > 0);
  return () => {
    listeners.delete(listener);
  };
}

/** Set or clear a named pause reason (`visibility`, `play`, …). */
export function setEncodeQueuePauseReason(
  reason: string,
  paused: boolean,
): void {
  if (paused) reasons.add(reason);
  else reasons.delete(reason);
  notify();
}

/** @deprecated Prefer setEncodeQueuePauseReason — kept for call-site clarity. */
export function setEncodeQueuePaused(paused: boolean): void {
  setEncodeQueuePauseReason("legacy", paused);
}

export function isEncodeQueuePauseRequested(): boolean {
  return reasons.size > 0;
}
