/**
 * Reason-set pause for the texture encode queue so Play and visibility can
 * both request pause without one resume undoing the other (engineplan §2.4 / §3.5).
 * A pause stops the queue from starting jobs; an encode already running finishes.
 */
type PauseListener = (paused: boolean) => void;

const reasons = new Set<string>();
/** Scoped holds: each blocking load owns one, so overlapping loads never release each other's. */
const holds = new Set<symbol>();
const listeners = new Set<PauseListener>();

function isPaused(): boolean {
  return reasons.size > 0 || holds.size > 0;
}

function notify(): void {
  const paused = isPaused();
  for (const listener of listeners) listener(paused);
}

export function onEncodeQueuePause(listener: PauseListener): () => void {
  listeners.add(listener);
  listener(isPaused());
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

/**
 * Pause the queue until the returned release runs, for work such as a
 * blocking scene load (`reason` names it for debugging). Release once, on
 * every outcome; later calls do nothing.
 */
export function holdEncodeQueuePause(reason: string): () => void {
  const hold = Symbol(reason);
  holds.add(hold);
  notify();
  return () => {
    if (holds.delete(hold)) notify();
  };
}
