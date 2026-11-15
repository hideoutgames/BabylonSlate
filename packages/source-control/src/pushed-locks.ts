/** A Git LFS object: a project blob, raw bytes named by their SHA-256 (the LFS oid). */
const LFS_BLOB_PATH = /(?:^|\/)\.blobs\/([0-9a-f]{64})$/;

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Git's object id for file content: SHA-1 of `"blob " + byteLength + "\0" + bytes`. */
export async function gitBlobSha1(bytes: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const object = new Uint8Array(header.byteLength + bytes.byteLength);
  object.set(header);
  object.set(bytes, header.byteLength);
  return hex(await crypto.subtle.digest("SHA-1", object));
}

/** The pointer file Git stores for an LFS object. */
export function lfsPointerText(oid: string, size: number): string {
  return `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${size}\n`;
}

/** The LFS oid a `.blobs` path names, or null for a file Git stores itself. */
export function lfsObjectId(path: string): string | null {
  return LFS_BLOB_PATH.exec(path)?.[1] ?? null;
}

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
