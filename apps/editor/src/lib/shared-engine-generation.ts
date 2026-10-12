export function isUsableEngine(
  engine: { isDisposed?: boolean } | null | undefined,
): boolean {
  return Boolean(engine) && engine!.isDisposed !== true;
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
