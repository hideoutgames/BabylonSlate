import { z } from "zod";
import type {
  BakedGeometryManifest,
  GeneratedBakeTopology,
  BakeGeometrySource,
} from "@babylonslate/core";
import {
  readBabassetHeader,
  encodeBabasset,
  type BabassetHeader,
  type ChunkInput,
  type ChunkEntry,
} from "./babasset";
import { readU32LE, sha256Hex, stableStringify } from "./bytes";
import { bakedReceiverKey } from "./baked-lighting";
import {
  BAKE_GEOMETRY_MAX_INDICES,
  BAKE_GEOMETRY_MAX_VERTICES,
  fingerprintBakeGeometry,
  remapBakeGeometry,
  validateBakeTopology,
} from "./bake-geometry";
import type { ImportResult } from "./importers/types";

export const BAKED_GEOMETRY_ASSET_TYPE = "BakedGeometry";
const MAX_DOCUMENT_BYTES = 64 * 1024;
const MAX_TOPOLOGY_BYTES =
  BAKE_GEOMETRY_MAX_INDICES * 4 + BAKE_GEOMETRY_MAX_VERTICES * 12;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value.trim() === value);
const integer = z.number().int();
const manifestSchema = z
  .object({
    version: z.literal(1),
    sceneGuid: id,
    receiver: z.unknown(),
    sourceHash: hash,
    sourceVertexCount: integer.min(3).max(BAKE_GEOMETRY_MAX_VERTICES),
    indexCount: integer
      .min(3)
      .max(BAKE_GEOMETRY_MAX_INDICES)
      .refine((value) => value % 3 === 0),
    vertexCount: integer.min(3).max(BAKE_GEOMETRY_MAX_VERTICES),
    contentHash: hash,
    provider: z.object({ id, version: id, adapterVersion: id }).strict(),
    layout: z
      .object({
        width: integer.min(1).max(4096),
        height: integer.min(1).max(4096),
        paddingTexels: integer.min(0).max(64),
        uvSet: z.literal(1),
        coordinates: z.literal("normalized-bottom-first"),
        mipLevels: z.literal(1),
      })
      .strict(),
  })
  .strict();

export function parseBakedGeometryManifest(
  value: unknown,
): BakedGeometryManifest {
  const manifest = manifestSchema.parse(value) as BakedGeometryManifest;
  // Shared strict authored identity validation; no engine IDs or permissive object copies.
  manifest.receiver = JSON.parse(bakedReceiverKey(manifest.receiver));
  if (
    manifest.layout.paddingTexels * 2 >=
    Math.min(manifest.layout.width, manifest.layout.height)
  )
    throw new Error("Generated UV padding consumes the entire atlas.");
  return manifest;
}

function dependencies(manifest: BakedGeometryManifest): string[] {
  return manifest.receiver.primitive.kind === "model"
    ? [manifest.receiver.primitive.assetGuid]
    : [];
}
function topologyLength(manifest: BakedGeometryManifest): number {
  return manifest.indexCount * 4 + manifest.vertexCount * 12;
}

/** Canonical sequence: u32 triangle indices, u32 original vertices, f32 normalized UV2; all LE. */
export function encodeBakeTopology(
  topology: GeneratedBakeTopology,
  sourceVertexCount: number,
): Uint8Array {
  validateBakeTopology(topology, sourceVertexCount, topology.indices.length);
  const bytes = new Uint8Array(
    topology.indices.byteLength +
      topology.originalVertices.byteLength +
      topology.uv2.byteLength,
  );
  const view = new DataView(bytes.buffer);
  let offset = 0;
  for (const array of [topology.indices, topology.originalVertices])
    for (const value of array) {
      view.setUint32(offset, value, true);
      offset += 4;
    }
  for (const value of topology.uv2) {
    view.setFloat32(offset, value, true);
    offset += 4;
  }
  return bytes;
}

function decodeTopology(
  manifest: BakedGeometryManifest,
  bytes: Uint8Array,
): GeneratedBakeTopology {
  if (bytes.byteLength !== topologyLength(manifest))
    throw new Error(
      "Generated topology byte length differs from its manifest.",
    );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  const readIndices = (count: number) => {
    const values = new Uint32Array(count);
    for (let i = 0; i < count; i++, offset += 4)
      values[i] = view.getUint32(offset, true);
    return values;
  };
  const indices = readIndices(manifest.indexCount);
  const originalVertices = readIndices(manifest.vertexCount);
  const uv2 = new Float32Array(manifest.vertexCount * 2);
  for (let i = 0; i < uv2.length; i++, offset += 4)
    uv2[i] = view.getFloat32(offset, true);
  const topology = { indices, originalVertices, uv2 };
  validateBakeTopology(
    topology,
    manifest.sourceVertexCount,
    manifest.indexCount,
  );
  return topology;
}

export interface DecodedBakedGeometry {
  guid: string;
  manifest: BakedGeometryManifest;
  topology: GeneratedBakeTopology;
}

export async function validateBakedGeometryChunks(
  header: Pick<BabassetHeader, "guid" | "type" | "version" | "dependencies">,
  chunks: readonly ChunkInput[],
): Promise<DecodedBakedGeometry> {
  if (header.type !== BAKED_GEOMETRY_ASSET_TYPE || header.version !== 1)
    throw new Error("Unsupported baked geometry asset.");
  const guid = id.parse(header.guid);
  const document = chunks.find((chunk) => chunk.id === "document");
  const binary = chunks.find((chunk) => chunk.id === "topology");
  if (
    chunks.length !== 2 ||
    !document ||
    document.kind !== "document" ||
    document.mime !== "application/json" ||
    document.data.byteLength > MAX_DOCUMENT_BYTES ||
    !binary ||
    binary.kind !== "geometry" ||
    binary.mime !== "application/octet-stream" ||
    binary.data.byteLength > MAX_TOPOLOGY_BYTES
  )
    throw new Error("Unexpected or oversized baked geometry chunks.");
  const manifest = parseBakedGeometryManifest(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(document.data)),
  );
  if (
    stableStringify(header.dependencies) !==
    stableStringify(dependencies(manifest))
  )
    throw new Error(
      "Baked geometry dependencies differ from its source identity.",
    );
  const owned = binary.data.slice();
  const topology = decodeTopology(manifest, owned);
  if ((await sha256Hex(owned)) !== manifest.contentHash)
    throw new Error("Generated topology hash mismatch.");
  return { guid, manifest, topology };
}

export async function bakedGeometryImportResult(options: {
  guid: string;
  name: string;
  manifest: BakedGeometryManifest;
  topology: GeneratedBakeTopology;
}): Promise<ImportResult> {
  const manifest = parseBakedGeometryManifest(options.manifest);
  const result: ImportResult = {
    guid: options.guid,
    name: options.name,
    type: BAKED_GEOMETRY_ASSET_TYPE,
    version: 1,
    dependencies: dependencies(manifest),
    parentClass: null,
    payload: {},
    chunks: [
      {
        id: "document",
        kind: "document",
        mime: "application/json",
        data: new TextEncoder().encode(stableStringify(manifest)),
      },
      {
        id: "topology",
        kind: "geometry",
        mime: "application/octet-stream",
        data: encodeBakeTopology(options.topology, manifest.sourceVertexCount),
      },
    ],
  };
  await validateBakedGeometryChunks(result, result.chunks);
  return result;
}

export async function encodeBakedGeometryAsset(
  result: ImportResult,
): Promise<Uint8Array> {
  const decoded = await validateBakedGeometryChunks(result, result.chunks);
  return encodeBabasset({
    header: {
      guid: decoded.guid,
      name: result.name,
      type: BAKED_GEOMETRY_ASSET_TYPE,
      version: 1,
      engineVersion: "1",
      mode: "bundled",
      dependencies: dependencies(decoded.manifest),
      payload: {},
    },
    chunks: [
      {
        id: "document",
        kind: "document",
        mime: "application/json",
        data: new TextEncoder().encode(stableStringify(decoded.manifest)),
      },
      {
        id: "topology",
        kind: "geometry",
        mime: "application/octet-stream",
        data: encodeBakeTopology(
          decoded.topology,
          decoded.manifest.sourceVertexCount,
        ),
      },
    ],
  });
}

/** Admit the strict manifest/counts before loading the binary, including thin assets. */
export async function readBakedGeometryAssetChunks(
  sourceHeader: BabassetHeader,
  read: (entry: ChunkEntry) => Promise<Uint8Array>,
): Promise<DecodedBakedGeometry> {
  const header = structuredClone(sourceHeader);
  if (
    header.type !== BAKED_GEOMETRY_ASSET_TYPE ||
    header.version !== 1 ||
    header.chunks.length !== 2
  )
    throw new Error("Unexpected baked geometry header.");
  const document = header.chunks.find((entry) => entry.id === "document");
  const topology = header.chunks.find((entry) => entry.id === "topology");
  if (
    !document ||
    document.kind !== "document" ||
    document.mime !== "application/json" ||
    !topology ||
    topology.kind !== "geometry" ||
    topology.mime !== "application/octet-stream"
  )
    throw new Error("Unexpected baked geometry chunk kind.");
  const bounded = async (entry: ChunkEntry, maximum: number) => {
    if (
      "inline" in entry.locator &&
      (!Number.isInteger(entry.locator.inline.length) ||
        entry.locator.inline.length < 0 ||
        entry.locator.inline.length > maximum)
    )
      throw new Error("Oversized baked geometry chunk.");
    const bytes = await read(entry);
    if (bytes.byteLength > maximum)
      throw new Error("Oversized baked geometry chunk.");
    const owned = bytes.slice();
    if ((await sha256Hex(owned)) !== entry.sha256)
      throw new Error("Baked geometry container hash mismatch.");
    return { id: entry.id, kind: entry.kind, mime: entry.mime, data: owned };
  };
  // Reject known oversized binary declarations even before requesting the document.
  if (
    "inline" in topology.locator &&
    topology.locator.inline.length > MAX_TOPOLOGY_BYTES
  )
    throw new Error("Oversized baked geometry topology.");
  const documentChunk = await bounded(document, MAX_DOCUMENT_BYTES);
  const manifest = parseBakedGeometryManifest(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(documentChunk.data),
    ),
  );
  if (
    "inline" in topology.locator &&
    topology.locator.inline.length !== topologyLength(manifest)
  )
    throw new Error("Generated topology length differs from its manifest.");
  const topologyChunk = await bounded(topology, topologyLength(manifest));
  return validateBakedGeometryChunks(header, [documentChunk, topologyChunk]);
}

export async function decodeBakedGeometryAsset(
  bytes: Uint8Array,
  readBlob?: (hash: string) => Promise<Uint8Array>,
): Promise<DecodedBakedGeometry> {
  if (bytes.byteLength < 12 || readU32LE(bytes, 8) > MAX_DOCUMENT_BYTES)
    throw new Error("Oversized baked geometry header.");
  const headerSize = readU32LE(bytes, 8);
  if (12 + headerSize > bytes.byteLength)
    throw new Error("Truncated baked geometry header.");
  const header = readBabassetHeader(bytes);
  return readBakedGeometryAssetChunks(header, async (entry) => {
    if ("blob" in entry.locator) {
      if (!readBlob) throw new Error("Baked geometry blob is unavailable.");
      return readBlob(entry.locator.blob);
    }
    const { offset, length } = entry.locator.inline;
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      12 + headerSize + offset + length > bytes.byteLength
    )
      throw new Error("Truncated baked geometry chunk.");
    return bytes.subarray(
      12 + headerSize + offset,
      12 + headerSize + offset + length,
    );
  });
}

/** Instance-local output only after exact original buffers match; shared source geometry is untouched. */
export async function applyBakedGeometry(
  source: BakeGeometrySource,
  baked: DecodedBakedGeometry,
): Promise<BakeGeometrySource> {
  // remap snapshots first, before hashing yields; both outputs refer to the same source generation.
  const remapped = remapBakeGeometry(source, baked.topology);
  const expected = baked.manifest.sourceHash;
  if ((await fingerprintBakeGeometry(source)) !== expected)
    throw new Error("Baked geometry source is stale.");
  return remapped;
}
