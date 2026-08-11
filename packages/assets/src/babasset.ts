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
/** Chunks at or above this size externalise to the blob store in thin mode. */
export const DEFAULT_BLOB_THRESHOLD = 64 * 1024;

export const chunkLocatorSchema = z.union([
  z.object({
    inline: z.object({ offset: z.number().int(), length: z.number().int() }),
  }),
  z.object({ blob: z.string().min(1) }),
]);

export const chunkEntrySchema = z.object({
  id: z.string(),
  kind: z.string(),
  mime: z.string(),
  sha256: z.string(),
  locator: chunkLocatorSchema,
});

export const babassetHeaderSchema = z.object({
  chunks: z.array(chunkEntrySchema),
  dependencies: z.array(z.string()).default([]),
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
export type ChunkLocator = z.infer<typeof chunkLocatorSchema>;

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
}

export interface DecodedBabasset {
  header: BabassetHeader;
  /** Absolute file offsets are resolved; payloads may be empty for header-only. */
  chunks: Map<string, Uint8Array>;
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
export function readBabassetHeader(bytes: Uint8Array): BabassetHeader {
  assertMagic(bytes);
  const formatVersion = readU32LE(bytes, 4);
  if (formatVersion !== BABASSET_FORMAT_VERSION) {
    throw new Error(`Unsupported .babasset format version ${formatVersion}`);
  }
  const headerLen = readU32LE(bytes, 8);
  const headerBytes = bytes.subarray(12, 12 + headerLen);
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

  for (const chunk of options.chunks) {
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
        locator: { blob: hash },
      });
    } else {
      table.push({
        id: chunk.id,
        kind: chunk.kind,
        mime: chunk.mime,
        sha256: hash,
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
    chunks: table,
  });
  const headerJson = stableStringify(header);
  const headerBytes = new TextEncoder().encode(headerJson);

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

  for (const entry of header.chunks) {
    if ("inline" in entry.locator) {
      const { offset, length } = entry.locator.inline;
      chunks.set(
        entry.id,
        bytes.subarray(payloadStart + offset, payloadStart + offset + length),
      );
    } else {
      if (!readBlob) {
        throw new Error(
          `Chunk ${entry.id} uses a blob locator but no readBlob was provided`,
        );
      }
      chunks.set(entry.id, await readBlob(entry.locator.blob));
    }
  }

  return { header, chunks };
}
