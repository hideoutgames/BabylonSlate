/** `value` when it is a finite number, else `fallback`: for numbers read from untyped command and scene data. */
export function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
