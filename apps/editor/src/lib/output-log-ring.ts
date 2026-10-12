export const OUTPUT_LOG_RING_CAP = 500;

/** Keep the Output Log ring at {@link OUTPUT_LOG_RING_CAP} lines, `lines` in arrival order. */
export function appendOutputLogLines(
  prev: readonly string[],
  lines: readonly string[],
): string[] {
  return [...prev, ...lines].slice(-OUTPUT_LOG_RING_CAP);
}
