import { z } from "zod";
import {
  concatBytes,
  readU32LE,
  sha256Hex,
  stableStringify,
  writeU32LE,
} from "./bytes";
import { AssetFormatVersionError } from "./migration";

export const HASSET_MAGIC = new TextEncoder().encode("BABA");
export const HASSET_FORMAT_VERSION = 1;
export const HASSET_PREFIX_BYTES = 12;
/** Reject corrupt lengths before allocating a catalog header. */
export const MAX_HASSET_HEADER_BYTES = 16 * 1024 * 1024;
/** Chunks at or above this size externalise to the blob store in thin mode. */
export const DEFAULT_BLOB_THRESHOLD = 64 * 1024;
/** Header dependency metadata layout this engine writes and reads. */
export const ASSET_DEPENDENCY_METADATA_VERSION = 1;

export const chunkLocatorSchema = z.union([
  z.object({
    inline: z.object({ offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), length: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }),
  }),
  z.object({ blob: z.string().min(1) }),
]);

export const chunkEntrySchema = z.object({
  id: z.string(),
  kind: z.string(),
  mime: z.string(),
  sha256: z.string(),
  byteLength: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  locator: chunkLocatorSchema,
});

export const hassetHeaderSchema = z.object({
  chunks: z.array(chunkEntrySchema),
  dependencies: z.array(z.string()),
  /** Complete references above; only these edges prepare an immediate consumer. */
  requiredDependencies: z.array(z.string()),
  /** Class properties consumed by synchronous graph readers; applies to instance overrides. */
  requiredVariableNames: z.array(z.string()).optional(),
  classReferences: z.array(z.string()).optional(),
  requiredClassReferences: z.array(z.string()).optional(),
  consoleCommand: z.object({
    name: z.string(), description: z.string(), category: z.string(),
    parameters: z.array(z.object({ name: z.string(), type: z.enum(["string", "float", "int", "bool", "enum"]),
      optional: z.boolean().optional(), defaultValue: z.unknown().optional(), enumValues: z.array(z.string()).optional() })),
  }).optional(),
  /** Always {@link ASSET_DEPENDENCY_METADATA_VERSION}; other values are refused. */
  dependencyMetadataVersion: z.number().int().nonnegative(),
  engineVersion: z.string(),
  guid: z.string(),
  mode: z.enum(["thin", "bundled"]).default("thin"),
  name: z.string(),
  parentClass: z.string().nullable().optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
  type: z.string(),
  version: z.number().int().nonnegative(),
});

export type HassetHeader = z.infer<typeof hassetHeaderSchema>;
export type ChunkEntry = z.infer<typeof chunkEntrySchema>;

export interface ChunkInput {
  id: string;
  kind: string;
  mime: string;
  data: Uint8Array;
}

/**
 * A chunk an existing container already holds, written again without hashing
 * it or uploading it: the table's digest and length are kept as they are. An
 * externalised chunk stays in the blob store; an inline chunk's bytes are
 * copied. The caller owns the proof that those bytes are the ones the digest
 * names (see `carryStoredChunks`), because nothing here re-reads a blob.
 */
export interface CarriedChunkInput {
  id: string;
  kind: string;
  mime: string;
  carried: { sha256: string; byteLength: number } & ({ blob: string } | { bytes: Uint8Array });
}

/** A chunk to write: new bytes, or one carried from the container being replaced. */
export type EncodableChunk = ChunkInput | CarriedChunkInput;

export function isCarriedChunk(chunk: EncodableChunk): chunk is CarriedChunkInput {
  return "carried" in chunk;
}

export interface EncodeHassetOptions {
  header: Omit<HassetHeader, "chunks">;
  chunks: EncodableChunk[];
  /** When set, chunks >= threshold use blob locators (thin mode). */
  blobThreshold?: number;
  /** Existing blob store writer; required when externalising. */
  writeBlob?: (sha256: string, data: Uint8Array) => Promise<void>;
  /**
   * Bundled mode: dependency assets embedded as nested `asset` chunks.
   * Each entry's bytes should already be a complete .hasset.
   */
  nestedAssets?: Array<{ guid: string; bytes: Uint8Array }>;
}

export interface DecodedHasset {
  header: HassetHeader;
  /** Absolute file offsets are resolved; payloads may be empty for header-only. */
  chunks: Map<string, Uint8Array>;
  /** Nested dependency assets unpacked from bundled mode. */
  nestedAssets: Map<string, Uint8Array>;
}

function assertMagic(bytes: Uint8Array): void {
  if (
    bytes.byteLength < 4 ||
    bytes[0] !== HASSET_MAGIC[0] ||
    bytes[1] !== HASSET_MAGIC[1] ||
    bytes[2] !== HASSET_MAGIC[2] ||
    bytes[3] !== HASSET_MAGIC[3]
  ) {
    throw new Error("Not a .hasset file (bad magic)");
  }
}

/**
 * Read header + chunk table without allocating chunk payloads.
 */
export function readHassetHeaderLength(bytes: Uint8Array): number {
  if (bytes.byteLength < HASSET_PREFIX_BYTES) throw new Error("Truncated .hasset prefix");
  assertMagic(bytes);
  const formatVersion = readU32LE(bytes, 4);
  if (formatVersion !== HASSET_FORMAT_VERSION) {
    throw new Error(`Unsupported .hasset format version ${formatVersion}`);
  }
  const headerLen = readU32LE(bytes, 8);
  if (headerLen === 0 || headerLen > MAX_HASSET_HEADER_BYTES) {
    throw new Error(`Invalid .hasset header length ${headerLen}`);
  }
  return headerLen;
}

/**
 * Refuse a header written before chunk lengths and dependency metadata
 * version {@link ASSET_DEPENDENCY_METADATA_VERSION}. The engine is unreleased,
 * so such files are not upgraded.
 */
function assertCurrentHeaderLayout(raw: unknown): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const header = raw as Record<string, unknown>;
  const asset = typeof header.guid === "string" ? `Asset ${header.guid}` : ".hasset";
  const version = header.dependencyMetadataVersion;
  if (typeof version === "number" && version > ASSET_DEPENDENCY_METADATA_VERSION) {
    throw new AssetFormatVersionError(
      `${asset} dependency metadata version ${version} was made with a newer engine version (current ${ASSET_DEPENDENCY_METADATA_VERSION})`,
    );
  }
  const missing: string[] = [];
  if (version !== ASSET_DEPENDENCY_METADATA_VERSION) missing.push("dependencyMetadataVersion");
  for (const field of ["dependencies", "requiredDependencies"]) {
    if (!Array.isArray(header[field])) missing.push(field);
  }
  if (header.type === "Class" && !Array.isArray(header.requiredVariableNames)) missing.push("requiredVariableNames");
  if (Array.isArray(header.chunks) && header.chunks.some((chunk) => !chunk || typeof chunk !== "object" || !("byteLength" in chunk))) {
    missing.push("chunk byteLength");
  }
  if (missing.length) {
    throw new AssetFormatVersionError(
      `${asset} uses an unsupported old .hasset layout (missing ${missing.join(", ")}). This engine reads dependency metadata version ${ASSET_DEPENDENCY_METADATA_VERSION} with chunk lengths; older files are not upgraded.`,
    );
  }
}

/** Validate a header in the current layout; older layouts throw {@link AssetFormatVersionError}. */
function parseHassetHeader(raw: unknown): HassetHeader {
  assertCurrentHeaderLayout(raw);
  return hassetHeaderSchema.parse(raw);
}

export function readHassetHeader(bytes: Uint8Array): HassetHeader {
  const headerLen = readHassetHeaderLength(bytes);
  if (bytes.byteLength < HASSET_PREFIX_BYTES + headerLen) throw new Error("Truncated .hasset header");
  const headerBytes = bytes.subarray(HASSET_PREFIX_BYTES, HASSET_PREFIX_BYTES + headerLen);
  const json = new TextDecoder().decode(headerBytes);
  return parseHassetHeader(JSON.parse(json));
}

export async function encodeHasset(
  options: EncodeHassetOptions,
): Promise<Uint8Array> {
  const threshold = options.blobThreshold ?? DEFAULT_BLOB_THRESHOLD;
  const mode = options.header.mode ?? "thin";
  const chunkBytes: Uint8Array[] = [];
  const table: ChunkEntry[] = [];
  let inlineOffset = 0;

  const allChunks: EncodableChunk[] = [...options.chunks];
  if (mode === "bundled" && options.nestedAssets) {
    for (const nested of options.nestedAssets) {
      allChunks.push({
        id: `nested:${nested.guid}`,
        kind: "asset",
        mime: "application/vnd.haptic.hasset",
        data: nested.bytes,
      });
    }
  }

  for (const chunk of allChunks) {
    if (isCarriedChunk(chunk)) {
      const { sha256, byteLength } = chunk.carried;
      if ("blob" in chunk.carried) {
        if (mode !== "thin") throw new Error(`Chunk ${chunk.id} lives in the blob store, which a ${mode} asset does not use`);
        table.push({
          id: chunk.id,
          kind: chunk.kind,
          mime: chunk.mime,
          sha256,
          byteLength,
          locator: { blob: chunk.carried.blob },
        });
      } else {
        if (chunk.carried.bytes.byteLength !== byteLength) {
          throw new Error(`Carried chunk ${chunk.id} does not have its recorded length`);
        }
        table.push({
          id: chunk.id,
          kind: chunk.kind,
          mime: chunk.mime,
          sha256,
          byteLength,
          locator: { inline: { offset: inlineOffset, length: byteLength } },
        });
        chunkBytes.push(chunk.carried.bytes);
        inlineOffset += byteLength;
      }
      continue;
    }
    const hash = await sha256Hex(chunk.data);
    const externalise =
      mode === "thin" && chunk.data.byteLength >= threshold && options.writeBlob;

    if (externalise) {
      await options.writeBlob!(hash, chunk.data);
      table.push({
        id: chunk.id,
        kind: chunk.kind,
        mime: chunk.mime,
        sha256: hash,
        byteLength: chunk.data.byteLength,
        locator: { blob: hash },
      });
    } else {
      table.push({
        id: chunk.id,
        kind: chunk.kind,
        mime: chunk.mime,
        sha256: hash,
        byteLength: chunk.data.byteLength,
        locator: {
          inline: { offset: inlineOffset, length: chunk.data.byteLength },
        },
      });
      chunkBytes.push(chunk.data);
      inlineOffset += chunk.data.byteLength;
    }
  }

  // A writer must never produce a file the reader refuses.
  const header: HassetHeader = parseHassetHeader({
    ...options.header,
    mode,
    chunks: table,
  });
  const headerJson = stableStringify(header);
  const headerBytes = new TextEncoder().encode(headerJson);
  if (headerBytes.byteLength > MAX_HASSET_HEADER_BYTES) throw new Error(".hasset header exceeds the catalog size limit");

  return concatBytes([
    HASSET_MAGIC,
    writeU32LE(HASSET_FORMAT_VERSION),
    writeU32LE(headerBytes.byteLength),
    headerBytes,
    ...chunkBytes,
  ]);
}

/** One chunk's bytes, checked against its recorded length and sha256. */
async function readVerifiedChunk(
  bytes: Uint8Array,
  payloadStart: number,
  entry: ChunkEntry,
  readBlob?: (sha256: string) => Promise<Uint8Array>,
): Promise<Uint8Array> {
  let data: Uint8Array;
  if ("inline" in entry.locator) {
    const { offset, length } = entry.locator.inline;
    const end = payloadStart + offset + length;
    if (end > bytes.byteLength || entry.byteLength !== length) {
      throw new Error(`Truncated or invalid chunk ${entry.id} in .hasset`);
    }
    data = bytes.subarray(payloadStart + offset, end);
  } else {
    if (!readBlob) {
      throw new Error(
        `Chunk ${entry.id} uses a blob locator but no readBlob was provided`,
      );
    }
    data = await readBlob(entry.locator.blob);
    if (data.byteLength !== entry.byteLength) {
      throw new Error(`Length mismatch for chunk ${entry.id} in .hasset`);
    }
  }
  if ((await sha256Hex(data)) !== entry.sha256) {
    throw new Error(`Hash mismatch for chunk ${entry.id} in .hasset`);
  }
  return data;
}

/**
 * Decode one chunk, verified like {@link decodeHasset}, without reading or
 * hashing the others. Null when the file has no chunk with that id.
 */
export async function decodeHassetChunk(
  bytes: Uint8Array,
  chunkId: string,
  readBlob?: (sha256: string) => Promise<Uint8Array>,
): Promise<Uint8Array | null> {
  const header = readHassetHeader(bytes);
  const entry = header.chunks.find((chunk) => chunk.id === chunkId);
  if (!entry) return null;
  return readVerifiedChunk(bytes, HASSET_PREFIX_BYTES + readU32LE(bytes, 8), entry, readBlob);
}

/**
 * Decode every chunk. Each one must have its recorded length and sha256, so a
 * truncated file or a torn blob is rejected rather than returned as the chunk.
 */
export async function decodeHasset(
  bytes: Uint8Array,
  readBlob?: (sha256: string) => Promise<Uint8Array>,
): Promise<DecodedHasset> {
  const header = readHassetHeader(bytes);
  const headerLen = readU32LE(bytes, 8);
  const payloadStart = HASSET_PREFIX_BYTES + headerLen;
  const chunks = new Map<string, Uint8Array>();
  const nestedAssets = new Map<string, Uint8Array>();

  for (const entry of header.chunks) {
    const data = await readVerifiedChunk(bytes, payloadStart, entry, readBlob);
    chunks.set(entry.id, data);
    if (entry.kind === "asset" && entry.id.startsWith("nested:")) {
      nestedAssets.set(entry.id.slice("nested:".length), data);
    }
  }

  return { header, chunks, nestedAssets };
}
