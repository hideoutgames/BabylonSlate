/** A Git LFS object: a project blob, raw bytes named by their SHA-256 (the LFS oid). */
const LFS_BLOB_PATH = /(?:^|\/)\.blobs\/([0-9a-f]{64})$/;

const POINTER = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([0-9a-f]{64})\nsize (0|[1-9][0-9]*)\n$/;

/** The longest pointer text: anything longer is file content, never parsed. */
export const MAX_LFS_POINTER_BYTES = 200;

export function hex(bytes: ArrayBuffer | Uint8Array): string {
  let out = "";
  for (const byte of bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** Git's object id for file content: SHA-1 of `"blob " + byteLength + "\0" + bytes`. */
export async function gitBlobSha1(bytes: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const object = new Uint8Array(header.byteLength + bytes.byteLength);
  object.set(header);
  object.set(bytes, header.byteLength);
  return hex(await crypto.subtle.digest("SHA-1", object));
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
}

/** The pointer file Git stores for an LFS object. */
export function lfsPointerText(oid: string, size: number): string {
  return `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${size}\n`;
}

/** The LFS oid a `.blobs` path names, or null for a file Git stores itself. */
export function lfsObjectId(path: string): string | null {
  return LFS_BLOB_PATH.exec(path)?.[1] ?? null;
}

/** The object a pointer names, or null when the bytes are not exactly a pointer Haptic writes. */
export function parseLfsPointer(bytes: Uint8Array): { oid: string; size: number } | null {
  if (bytes.byteLength > MAX_LFS_POINTER_BYTES) return null;
  const match = POINTER.exec(new TextDecoder().decode(bytes));
  if (!match) return null;
  const size = Number(match[2]);
  return Number.isSafeInteger(size) ? { oid: match[1]!, size } : null;
}
