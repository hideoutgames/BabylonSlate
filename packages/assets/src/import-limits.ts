/**
 * Caps on what one imported file may make an importer read, decode or
 * allocate. Each is far above real game assets and only stops malformed or
 * hostile files before they cost memory or time. A file over a cap fails with
 * an {@link ImportLimitError} that names the limit and the measured value; the
 * Content Browser prefixes the file's path. `docs/editor/importing.md` lists
 * them for users.
 */

/** Longest image edge, read from the header before anything decodes it. */
export const IMPORT_IMAGE_MAX_EDGE = 8192;
/** Image pixels (width × height): 8192 × 8192. */
export const IMPORT_IMAGE_MAX_PIXELS = IMPORT_IMAGE_MAX_EDGE * IMPORT_IMAGE_MAX_EDGE;
/** Pixels an HDR panorama decodes to; a larger one is box-downsampled to fit, never refused. */
export const HDR_MAX_DECODED_PIXELS = 16 * 1024 * 1024;
/** Vertices in one glTF primitive (the `POSITION` accessor's count): 2^24. */
export const GLTF_MAX_PRIMITIVE_VERTICES = 16_777_216;
/** Indices in one glTF primitive: three per vertex the vertex cap allows. */
export const GLTF_MAX_PRIMITIVE_INDICES = 3 * GLTF_MAX_PRIMITIVE_VERTICES;
/** Depth of a glTF node hierarchy (a root is depth 1); long bone chains such as ropes and tails stay well inside it. */
export const GLTF_MAX_NODE_DEPTH = 256;
/** Nesting of objects inside one glTF material, which real exporters keep to a handful of levels. */
export const GLTF_MAX_MATERIAL_DEPTH = 64;
/** Bytes all `data:` URIs in one glTF file decode to, together. */
export const GLTF_MAX_DATA_URI_BYTES = 256 * 1024 * 1024;
/** Levels of `.hasset` files nested inside a bundled `.hasset` (the file itself is level 0). */
export const HASSET_MAX_NESTING_DEPTH = 8;
/** Assets nested inside one bundled `.hasset`, at every level together. */
export const HASSET_MAX_NESTED_ASSETS = 500;
/** Bytes of the assets nested inside one bundled `.hasset`, at every level together. */
export const HASSET_MAX_NESTED_BYTES = 256 * 1024 * 1024;
/** Size of an OBJ or STL file, which converts on the editor's main thread. */
export const MESH_CONVERSION_MAX_SOURCE_BYTES = 256 * 1024 * 1024;
/** Triangles in a binary STL; STL vertices are not shared, so this keeps its one primitive under the vertex cap. */
export const STL_MAX_TRIANGLES = Math.floor(GLTF_MAX_PRIMITIVE_VERTICES / 3);

/** A file is over one of the import caps above. */
export class ImportLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportLimitError";
  }
}

const MIB = 1024 * 1024;

/** A count for an import message: `16,777,216`. */
export function formatImportCount(value: number): string {
  return value.toLocaleString("en-US");
}

/** Bytes for an import message, in MiB above one MiB: `256 MiB`, `1.5 MiB`, `900 bytes`. */
export function formatImportBytes(bytes: number): string {
  if (bytes < MIB) return `${formatImportCount(bytes)} bytes`;
  const mib = bytes / MIB;
  return `${Number.isInteger(mib) ? formatImportCount(mib) : mib.toFixed(1)} MiB`;
}

/** `<what> is <measured>; the import limit is <limit>. <remedy>` */
export function importLimitError(what: string, measured: string, limit: string, remedy: string): ImportLimitError {
  return new ImportLimitError(`${what} is ${measured}; the import limit is ${limit}. ${remedy}`);
}
