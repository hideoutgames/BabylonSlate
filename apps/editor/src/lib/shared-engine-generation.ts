/**
 * False for a disposed Engine and for one whose context is lost: a lost
 * WebGPU device never recovers in place, and a WebGL2 Engine draws nothing
 * until Babylon restores it.
 */
export function isUsableEngine(
  engine: { isDisposed?: boolean } | null | undefined,
): boolean {
  if (!engine || engine.isDisposed === true) return false;
  // Pinned Babylon 9.29 lost-context flag (protected on AbstractEngine).
  return (engine as { _contextWasLost?: boolean })._contextWasLost !== true;
}

export function nextSharedEngineGeneration(
  current: number,
  next: unknown,
  previous: unknown,
): number {
  return next === previous ? current : current + 1;
}

/**
 * Next Engine to keep on PlayProvider after a viewport register/unregister:
 * the project-owned Engine, else the incoming one, else the previous one.
 * A still-usable Engine is never dropped when the Scene viewport unregisters,
 * because that would remount overlay Play at Tick 0.
 */
export function nextRegisteredSharedEngine<T extends { isDisposed?: boolean }>(options: {
  incoming: T | null;
  previous: T | null;
  owned: T | null;
}): T | null {
  if (isUsableEngine(options.owned)) return options.owned;
  if (isUsableEngine(options.incoming)) return options.incoming;
  return isUsableEngine(options.previous) ? options.previous : null;
}
