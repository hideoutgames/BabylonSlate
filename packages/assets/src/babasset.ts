import { z } from "zod";
import {
  concatBytes,
  readU32LE,
  sha256Hex,
  stableStringify,
  writeU32LE,
} from "./bytes";

export const BABASSET_MAGIC = new TextEncoder().encode("BABA");
export const BABASSET_FORMAT_VERSION = 1;
export const BABASSET_PREFIX_BYTES = 12;
/** Reject corrupt lengths before allocating a catalog header. */
export const MAX_BABASSET_HEADER_BYTES = 16 * 1024 * 1024;
/** Chunks at or above this size externalise to the blob store in thin mode. */
export const DEFAULT_BLOB_THRESHOLD = 64 * 1024;

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
  /** Older files omit this for blobs; hashes still verify their contents. */
  byteLength: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  locator: chunkLocatorSchema,
});

export const babassetHeaderSchema = z.object({
  chunks: z.array(chunkEntrySchema),
  dependencies: z.array(z.string()).default([]),
  /** Complete references above; only these edges prepare an immediate consumer. */
  requiredDependencies: z.array(z.string()).optional(),
  /** Class properties consumed by synchronous graph readers; applies to instance overrides. */
  requiredVariableNames: z.array(z.string()).optional(),
  classReferences: z.array(z.string()).optional(),
  requiredClassReferences: z.array(z.string()).optional(),
  consoleCommand: z.object({
    name: z.string(), description: z.string(), category: z.string(),
    parameters: z.array(z.object({ name: z.string(), type: z.enum(["string", "float", "int", "bool", "enum"]),
      optional: z.boolean().optional(), defaultValue: z.unknown().optional(), enumValues: z.array(z.string()).optional() })),
  }).optional(),
  /** Missing metadata requires an explicit upgrade, never a scan during open. */
  dependencyMetadataVersion: z.number().int().nonnegative().optional(),
  engineVersion: z.string(),
  guid: z.string(),
  mode: z.enum(["thin", "bundled"]).default("thin"),
  name: z.string(),
  parentClass: z.string().nullable().optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
  type: z.string(),
  version: z.number().int().nonnegative(),
});

export type BabassetHeader = z.infer<typeof babassetHeaderSchema>;
export type ChunkEntry = z.infer<typeof chunkEntrySchema>;

export interface ChunkInput {
  id: string;
  kind: string;
  mime: string;
  data: Uint8Array;
}

export interface EncodeBabassetOptions {
  header: Omit<BabassetHeader, "chunks">;
  chunks: ChunkInput[];
  /** When set, chunks >= threshold use blob locators (thin mode). */
  blobThreshold?: number;
  /** Existing blob store writer; required when externalising. */
  writeBlob?: (sha256: string, data: Uint8Array) => Promise<void>;
  /**
   * Bundled mode: dependency assets embedded as nested `asset` chunks.
   * Each entry's bytes should already be a complete .babasset.
   */
  nestedAssets?: Array<{ guid: string; bytes: Uint8Array }>;
}

export interface DecodedBabasset {
  header: BabassetHeader;
  /** Absolute file offsets are resolved; payloads may be empty for header-only. */
  chunks: Map<string, Uint8Array>;
  /** Nested dependency assets unpacked from bundled mode. */
  nestedAssets: Map<string, Uint8Array>;
}

function assertMagic(bytes: Uint8Array): void {
  if (
    bytes.byteLength < 4 ||
    bytes[0] !== BABASSET_MAGIC[0] ||
    bytes[1] !== BABASSET_MAGIC[1] ||
    bytes[2] !== BABASSET_MAGIC[2] ||
    bytes[3] !== BABASSET_MAGIC[3]
  ) {
    throw new Error("Not a .babasset file (bad magic)");
  }
}

/**
 * Read header + chunk table without allocating chunk payloads.
 */
export function readBabassetHeaderLength(bytes: Uint8Array): number {
  if (bytes.byteLength < BABASSET_PREFIX_BYTES) throw new Error("Truncated .babasset prefix");
  assertMagic(bytes);
  const formatVersion = readU32LE(bytes, 4);
  if (formatVersion !== BABASSET_FORMAT_VERSION) {
    throw new Error(`Unsupported .babasset format version ${formatVersion}`);
  }
  const headerLen = readU32LE(bytes, 8);
  if (headerLen === 0 || headerLen > MAX_BABASSET_HEADER_BYTES) {
    throw new Error(`Invalid .babasset header length ${headerLen}`);
  }
  return headerLen;
}

export function readBabassetHeader(bytes: Uint8Array): BabassetHeader {
  const headerLen = readBabassetHeaderLength(bytes);
  if (bytes.byteLength < BABASSET_PREFIX_BYTES + headerLen) throw new Error("Truncated .babasset header");
  const headerBytes = bytes.subarray(BABASSET_PREFIX_BYTES, BABASSET_PREFIX_BYTES + headerLen);
  const json = new TextDecoder().decode(headerBytes);
  return babassetHeaderSchema.parse(JSON.parse(json));
}

export async function encodeBabasset(
  options: EncodeBabassetOptions,
): Promise<Uint8Array> {
  const threshold = options.blobThreshold ?? DEFAULT_BLOB_THRESHOLD;
  const mode = options.header.mode ?? "thin";
  const chunkBytes: Uint8Array[] = [];
  const table: ChunkEntry[] = [];
  let inlineOffset = 0;

  const allChunks: ChunkInput[] = [...options.chunks];
  if (mode === "bundled" && options.nestedAssets) {
    for (const nested of options.nestedAssets) {
      allChunks.push({
        id: `nested:${nested.guid}`,
        kind: "asset",
        mime: "application/vnd.babylonslate.babasset",
        data: nested.bytes,
      });
    }
  }

  for (const chunk of allChunks) {
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

  const header: BabassetHeader = babassetHeaderSchema.parse({
    ...options.header,
    mode,
    chunks: table,
  });
  const headerJson = stableStringify(header);
  const headerBytes = new TextEncoder().encode(headerJson);
  if (headerBytes.byteLength > MAX_BABASSET_HEADER_BYTES) throw new Error(".babasset header exceeds the catalog size limit");

  return concatBytes([
    BABASSET_MAGIC,
    writeU32LE(BABASSET_FORMAT_VERSION),
    writeU32LE(headerBytes.byteLength),
    headerBytes,
    ...chunkBytes,
  ]);
}

export async function decodeBabasset(
  bytes: Uint8Array,
  readBlob?: (sha256: string) => Promise<Uint8Array>,
): Promise<DecodedBabasset> {
  const header = readBabassetHeader(bytes);
  const headerLen = readU32LE(bytes, 8);
  const payloadStart = 12 + headerLen;
  const chunks = new Map<string, Uint8Array>();
  const nestedAssets = new Map<string, Uint8Array>();

  for (const entry of header.chunks) {
    let data: Uint8Array;
    if ("inline" in entry.locator) {
      const { offset, length } = entry.locator.inline;
      data = bytes.subarray(payloadStart + offset, payloadStart + offset + length);
    } else {
      if (!readBlob) {
        throw new Error(
          `Chunk ${entry.id} uses a blob locator but no readBlob was provided`,
        );
      }
      data = await readBlob(entry.locator.blob);
    }
    chunks.set(entry.id, data);
    if (entry.kind === "asset" && entry.id.startsWith("nested:")) {
      nestedAssets.set(entry.id.slice("nested:".length), data);
    }
  }

  return { header, chunks, nestedAssets };
}
