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
