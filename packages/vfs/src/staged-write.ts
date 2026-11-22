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

/**
 * Where a replace without an atomic rename (the Documents adapter's fallback
 * write) moves the file it replaces while the new one moves in:
 * `.haptic-aside-<8 hex>-<target name>.tmp`, beside the target. The name says
 * which file it holds, so a kill at any step is settled from the folder
 * listing alone: with the target missing the aside copy is the file, beside
 * the target it is stale. Publish's `.gitignore` entry `.haptic-*.tmp`
 * covers it.
 */
const ASIDE_WRITE = /^\.haptic-aside-[0-9a-f]{8}-(.+)\.tmp$/s;

export function asideWriteName(target: string): string {
  return `.haptic-aside-${globalThis.crypto.randomUUID().slice(0, 8)}-${target}.tmp`;
}

/** The name of the file an aside copy holds; null for any other name. */
export function asideWriteTarget(name: string): string | null {
  return ASIDE_WRITE.exec(name)?.[1] ?? null;
}
