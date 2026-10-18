/**
 * False for a disposed Engine and for a WebGPU Engine whose device is lost: it
 * never recovers in place. A lost WebGL2 context stays usable, because Babylon
 * restores it on the same Engine and its clients reload on that restore.
 */
export function isUsableEngine(
  engine: { isDisposed?: boolean; isWebGPU?: boolean } | null | undefined,
): boolean {
  if (!engine || engine.isDisposed === true) return false;
  // Pinned Babylon 9.29 lost-context flag (protected on AbstractEngine).
  return engine.isWebGPU !== true || (engine as { _contextWasLost?: boolean })._contextWasLost !== true;
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
