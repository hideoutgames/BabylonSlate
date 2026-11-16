/**
 * The name a write or a native transfer stages its bytes under beside the
 * target before renaming them into place (`.haptic-<uuid>.tmp`). Listings
 * leave such files out: they are never part of the project, and one that a
 * killed app or transfer left behind would otherwise show in the Content
 * Browser and in Git status.
 */
const STAGED_WRITE = /^\.haptic-[0-9a-f-]{36}\.tmp$/;

export function stagedWriteName(): string {
  return `.haptic-${globalThis.crypto.randomUUID()}.tmp`;
}

export function isStagedWrite(name: string): boolean {
  return STAGED_WRITE.test(name);
}
