const INCOMPLETE_DRAFTS = new Set(["", "-", ".", "-."]);

/** Parse a typed number draft. Empty and incomplete strings are not zero. */
export function parseNumberInput(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (INCOMPLETE_DRAFTS.has(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}
