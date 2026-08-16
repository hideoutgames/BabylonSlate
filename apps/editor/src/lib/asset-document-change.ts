/** True when an asset-tab commit would actually change the persisted payload. */
export function shouldApplyAssetDocumentChange(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): boolean {
  return JSON.stringify(previous) !== JSON.stringify(next);
}
