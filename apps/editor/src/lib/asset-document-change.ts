/** True when an asset-tab commit would actually change the persisted payload. */
export function shouldApplyAssetDocumentChange(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): boolean {
  // Payloads are replaced on edit, never changed in place: the same object is no edit.
  if (previous === next) return false;
  return JSON.stringify(previous) !== JSON.stringify(next);
}
