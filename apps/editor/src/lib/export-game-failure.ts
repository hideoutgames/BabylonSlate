/** Human-facing Export Game failure copy (raw zip/engine messages stay in console). */
export function exportGameFailureMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const lower = raw.toLowerCase();
  if (
    lower.includes("date not in range") ||
    lower.includes("1980-2099") ||
    lower.includes("zip") ||
    lower.includes("fflate")
  ) {
    return "Could not build the zip. Try again.";
  }
  if (!raw.trim()) return "Could not build the zip. Try again.";
  return raw;
}
