import { gitBlobSha1, lfsObjectId, lfsPointerText } from "./lfs-pointer";

/** The working copy as the check reads it: bytes, or only the size for LFS objects. */
export interface LocalFiles {
  /** Null when the file is missing. */
  read(path: string): Promise<Uint8Array | null>;
  size(path: string): Promise<number | null>;
}

/**
 * The paths whose local file is exactly what the remote branch holds: the Git
 * blob id of the file (or, for an LFS object, of the pointer Git stores for
 * it) equals the remote's. Each path is read and hashed once; a path the
 * remote lacks is never read. LFS objects are never rewritten, so their name
 * and size stand for their content and the bytes are not hashed.
 */
export async function pushedPaths(
  paths: readonly string[],
  remote: ReadonlyMap<string, string>,
  local: LocalFiles,
): Promise<Set<string>> {
  const pushed = new Set<string>();
  for (const path of new Set(paths)) {
    const remoteId = remote.get(path);
    if (!remoteId) continue;
    const oid = lfsObjectId(path);
    let localId: string | null;
    if (oid) {
      const size = await local.size(path);
      localId = size === null ? null : await gitBlobSha1(new TextEncoder().encode(lfsPointerText(oid, size)));
    } else {
      const bytes = await local.read(path);
      localId = bytes ? await gitBlobSha1(bytes) : null;
    }
    if (localId === remoteId) pushed.add(path);
  }
  return pushed;
}
