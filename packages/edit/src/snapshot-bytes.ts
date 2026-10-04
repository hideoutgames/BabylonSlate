/** Conservative serialized size of retained document snapshots. */
export function snapshotBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
