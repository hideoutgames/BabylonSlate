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
 * Next Engine to keep on PlayProvider after a viewport register/unregister.
 * Overlay Play must not drop a still-usable Engine when the Scene viewport
 * unregisters — that remounts PlayOverlay at Tick 0.
 */
export function nextRegisteredSharedEngine<T extends { isDisposed?: boolean }>(options: {
  incoming: T | null;
  previous: T | null;
  owned: T | null;
  overlayPlaying: boolean;
}): T | null {
  if (isUsableEngine(options.owned)) return options.owned;
  if (isUsableEngine(options.incoming)) return options.incoming;
  if (options.overlayPlaying && isUsableEngine(options.previous)) {
    return options.previous;
  }
  return isUsableEngine(options.previous) ? options.previous : null;
}
