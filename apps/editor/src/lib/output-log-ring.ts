export const OUTPUT_LOG_RING_CAP = 500;

/** Keep the Output Log ring at {@link OUTPUT_LOG_RING_CAP} lines. */
export function appendOutputLogLine(
  prev: readonly string[],
  line: string,
): string[] {
  return [...prev, line].slice(-OUTPUT_LOG_RING_CAP);
}
