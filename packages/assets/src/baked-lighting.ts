import { z } from "zod";
import type { BakeInputHashes, BakedLightingManifest, BakedLightingValidity } from "@babylonslate/core";
import { readBabassetHeader, encodeBabasset, type BabassetHeader, type ChunkInput, type ChunkEntry } from "./babasset";
import { readU32LE, sha256Hex, stableStringify } from "./bytes";
import type { ImportResult } from "./importers/types";

export const BAKED_LIGHTING_ASSET_TYPE = "BakedLighting";
export const BAKED_LIGHTING_MANIFEST_CHUNK = "document";
/** Authoring/import bounds, independent of viewport quality and GPU admission. */
export const BAKED_LIGHTING_MAX_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const id = z.string().min(1).max(512).refine((value) => value.trim() === value, "Identifiers must not contain surrounding whitespace.");
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().nonnegative();
const hashFields = {
  geometry: hash, uv: hash, transforms: hash, materials: hash,
  lights: hash, environment: hash, settings: hash, provider: hash,
};
const hashesSchema = z.object(hashFields).strict();
const receiverHashesSchema = z.object({
  geometry: hash, uv: hash, transforms: hash, materials: hash,
}).strict();
const identitySchema = z.object({
  actorId: id,
  componentId: id,
  primitive: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("mesh") }).strict(),
    z.object({ kind: z.literal("model"), assetGuid: id, nodeIndex: integer,
      meshIndex: integer, primitiveIndex: integer }).strict(),
  ]),
}).strict();
const atlasSchema = z.object({
  guid: id, chunkId: id, width: integer.min(1).max(4096), height: integer.min(1).max(4096),
  sha256: hash, encoding: z.literal("rgba32float-le"), colorSpace: z.literal("linear"),
  quantity: z.literal("diffuseIrradiance"), convention: z.literal("physical-E"),
  alpha: z.literal("coverage"), rowOrder: z.literal("bottomFirst"), uvSet: z.literal(1),
  mipLevels: z.literal(1), gutterTexels: integer,
}).strict();
const manifestSchema = z.object({
  version: z.literal(1), sceneGuid: id, inputs: hashesSchema,
  provider: z.object({ id, version: id, adapterVersion: id }).strict(),
  settingsVersion: id,
  dependencies: z.array(id).max(10000),
  sources: z.array(z.discriminatedUnion("kind", [
    z.object({ id, kind: z.literal("light"), actorId: id, componentId: id,
      mobility: z.enum(["static", "stationary"]), inputHash: hash }).strict(),
    z.object({ id, kind: z.literal("environment"), assetGuid: id, inputHash: hash }).strict(),
  ])).max(10000),
  receivers: z.array(z.object({
    identity: identitySchema, mobility: z.literal("static"), hashes: receiverHashesSchema, atlasGuid: id,
    scale: z.tuple([z.number().positive().max(1), z.number().positive().max(1)]),
    offset: z.tuple([z.number().nonnegative().max(1), z.number().nonnegative().max(1)]),
    contributions: z.array(z.object({ sourceId: id,
      term: z.enum(["directAndIndirect", "indirectOnly", "environmentDiffuse"]),
    }).strict()).max(10000),
  }).strict())).min(1).max(10000),
  atlases: z.array(atlasSchema).min(1).max(16),
}).strict();

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label} in baked lighting.`);
}

/** Stable even when names or runtime object allocation order change. */
export function bakedReceiverKey(identity: BakedLightingManifest["receivers"][number]["identity"]): string {
  return stableStringify(identitySchema.parse(identity));
}

/** Strict V1 validation: unsupported representations are rejected, never normalized into a plausible bake. */
export function parseBakedLightingManifest(value: unknown): BakedLightingManifest {
  const manifest = manifestSchema.parse(value);
  unique(manifest.dependencies, "dependency");
  if (manifest.dependencies.includes(manifest.sceneGuid)) throw new Error("A bake must not depend on its owning Scene.");
  unique(manifest.sources.map((source) => source.id), "source ID");
  unique(manifest.sources.map((source) => source.kind === "light"
    ? stableStringify([source.kind, source.actorId, source.componentId])
    : stableStringify([source.kind, source.assetGuid])), "source identity");
  unique(manifest.atlases.map((atlas) => atlas.guid), "atlas GUID");
  unique(manifest.atlases.map((atlas) => atlas.chunkId), "atlas chunk");
  unique(manifest.receivers.map((receiver) => bakedReceiverKey(receiver.identity)), "receiver identity");
  const sources = new Map(manifest.sources.map((source) => [source.id, source]));
  const atlases = new Map(manifest.atlases.map((atlas) => [atlas.guid, atlas]));
  let bytes = 0;
  for (const atlas of manifest.atlases) {
    if (atlas.chunkId === BAKED_LIGHTING_MANIFEST_CHUNK || atlas.chunkId.startsWith("nested:"))
      throw new Error("Atlas chunk uses a reserved asset chunk ID.");
    bytes += atlas.width * atlas.height * 16;
  }
  if (bytes > BAKED_LIGHTING_MAX_BYTES) throw new Error("Baked lighting exceeds the 64 MiB authoring payload limit.");
  const used = new Set<string>();
  for (const receiver of manifest.receivers) {
    const atlas = atlases.get(receiver.atlasGuid);
    if (!atlas) throw new Error("Baked receiver references a missing atlas.");
    used.add(atlas.guid);
    for (const axis of [0, 1] as const) {
      const size = axis === 0 ? atlas.width : atlas.height;
      const gutter = atlas.gutterTexels / size;
      if (receiver.offset[axis] < gutter || receiver.offset[axis] + receiver.scale[axis] > 1 - gutter + 1e-12)
        throw new Error("Baked receiver atlas rectangle or gutter is outside the atlas.");
    }
    unique(receiver.contributions.map((contribution) => contribution.sourceId), "receiver contribution");
    for (const contribution of receiver.contributions) {
      const source = sources.get(contribution.sourceId);
      if (!source) throw new Error("Baked receiver references a missing source.");
      if (source.kind === "environment" ? contribution.term !== "environmentDiffuse"
        : contribution.term === "environmentDiffuse" ||
          (source.mobility === "stationary" && contribution.term !== "indirectOnly"))
        throw new Error("Baked contribution is incompatible with its source or mobility.");
    }
    if (receiver.identity.primitive.kind === "model" && !manifest.dependencies.includes(receiver.identity.primitive.assetGuid))
      throw new Error("Baked model input is missing from asset dependencies.");
  }
  for (const source of manifest.sources)
    if (source.kind === "environment" && !manifest.dependencies.includes(source.assetGuid))
      throw new Error("Baked environment input is missing from asset dependencies.");
  if (used.size !== atlases.size) throw new Error("Baked lighting contains an unreferenced atlas.");
  return manifest;
}

/** Each supplied value is canonical JSON; geometry/UV binary data may use SHA-256 digests as values. */
export async function fingerprintBakeInputs(inputs: Record<keyof BakeInputHashes, unknown>): Promise<BakeInputHashes> {
  const keys = Object.keys(hashFields) as Array<keyof BakeInputHashes>;
  if (Object.keys(inputs).length !== keys.length || keys.some((key) => !(key in inputs)))
    throw new Error("Every bake input category must be supplied.");
  const entries = await Promise.all(keys.map(async (key) => {
    const value = z.json().parse(inputs[key]);
    return [key, await sha256Hex(new TextEncoder().encode(stableStringify(value)))];
  }));
  return Object.fromEntries(entries) as unknown as BakeInputHashes;
}

/** A retained old output is never labelled current merely because its bytes exist. */
export function bakedLightingValidity(
  sceneGuid: string,
  currentInputs: BakeInputHashes,
  manifest: BakedLightingManifest | null,
): BakedLightingValidity {
  if (!manifest) return { status: "missing", reason: "No readable baked lighting output is assigned." };
  const current = hashesSchema.parse(currentInputs);
  const reasons: string[] = [];
  if (manifest.sceneGuid !== sceneGuid) reasons.push("Scene identity changed");
  for (const key of Object.keys(hashFields) as Array<keyof BakeInputHashes>)
    if (manifest.inputs[key] !== current[key]) reasons.push(`${key} changed`);
  return reasons.length ? { status: "stale", reasons } : { status: "valid" };
}

export interface DecodedBakedLighting {
  guid: string;
  manifest: BakedLightingManifest;
  /** Owned CPU bytes; callers must not mutate validated atlas contents. */
  atlases: ReadonlyMap<string, Uint8Array>;
}

export async function validateBakedLightingChunks(
  header: Pick<BabassetHeader, "guid" | "type" | "version" | "dependencies">,
  chunks: readonly ChunkInput[],
): Promise<DecodedBakedLighting> {
  return validateChunks(header, chunks, true);
}

async function validateChunks(
  header: Pick<BabassetHeader, "guid" | "type" | "version" | "dependencies">,
  chunks: readonly ChunkInput[],
  copy: boolean,
): Promise<DecodedBakedLighting> {
  if (header.type !== BAKED_LIGHTING_ASSET_TYPE || header.version !== 1)
    throw new Error("Unsupported baked lighting asset type or version.");
  const guid = id.parse(header.guid);
  unique(chunks.map((chunk) => chunk.id), "asset chunk");
  const document = chunks.find((chunk) => chunk.id === BAKED_LIGHTING_MANIFEST_CHUNK);
  if (!document || document.kind !== "document" || document.mime !== "application/json" || document.data.byteLength > MAX_MANIFEST_BYTES)
    throw new Error("Baked lighting manifest is missing or exceeds its size limit.");
  const manifest = parseBakedLightingManifest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(document.data)));
  if (stableStringify([...header.dependencies].sort()) !== stableStringify([...manifest.dependencies].sort()))
    throw new Error("Baked lighting header dependencies do not match the manifest.");
  if (chunks.length !== manifest.atlases.length + 1) throw new Error("Unexpected baked lighting asset chunks.");
  const atlases = new Map<string, Uint8Array>();
  for (const atlas of manifest.atlases) {
    const chunk = chunks.find((candidate) => candidate.id === atlas.chunkId);
    if (!chunk || chunk.kind !== "diffuseIrradiance" || chunk.mime !== "application/octet-stream" ||
      chunk.data.byteLength !== atlas.width * atlas.height * 16)
      throw new Error(`Missing or malformed irradiance atlas ${atlas.guid}.`);
    // Snapshot every bounded input before the first asynchronous hash operation.
    atlases.set(atlas.guid, copy ? chunk.data.slice() : chunk.data);
  }
  for (const atlas of manifest.atlases) {
    const data = atlases.get(atlas.guid)!;
    if (await sha256Hex(data) !== atlas.sha256) throw new Error(`Irradiance atlas ${atlas.guid} hash mismatch.`);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let offset = 0; offset < view.byteLength; offset += 4) {
      const value = view.getFloat32(offset, true);
      if (!Number.isFinite(value) || value < 0 || (offset % 16 === 12 && value > 1))
        throw new Error(`Irradiance atlas ${atlas.guid} contains invalid radiance or coverage.`);
    }
  }
  return { guid, manifest, atlases };
}

function ownedChunks(decoded: DecodedBakedLighting): ChunkInput[] {
  return [{ id: BAKED_LIGHTING_MANIFEST_CHUNK, kind: "document", mime: "application/json",
    data: new TextEncoder().encode(stableStringify(decoded.manifest)) },
  ...decoded.manifest.atlases.map((atlas) => ({ id: atlas.chunkId, kind: "diffuseIrradiance",
    mime: "application/octet-stream", data: decoded.atlases.get(atlas.guid)! }))];
}

export async function bakedLightingImportResult(options: {
  guid: string; name: string; manifest: BakedLightingManifest; atlases: ReadonlyMap<string, Uint8Array>;
}): Promise<ImportResult> {
  const manifest = parseBakedLightingManifest(options.manifest);
  const chunks: ChunkInput[] = [{ id: BAKED_LIGHTING_MANIFEST_CHUNK, kind: "document", mime: "application/json",
    data: new TextEncoder().encode(stableStringify(manifest)) }];
  for (const atlas of manifest.atlases) {
    const data = options.atlases.get(atlas.guid);
    if (!data) throw new Error(`Missing irradiance atlas ${atlas.guid}.`);
    chunks.push({ id: atlas.chunkId, kind: "diffuseIrradiance", mime: "application/octet-stream", data });
  }
  const result: ImportResult = { type: BAKED_LIGHTING_ASSET_TYPE, version: 1,
    guid: id.parse(options.guid), name: id.parse(options.name), dependencies: manifest.dependencies,
    payload: {}, chunks };
  const decoded = await validateBakedLightingChunks(result, chunks);
  result.chunks = ownedChunks(decoded);
  return result;
}

/** Runtime/export uses the same complete container, without a baker or external blob files. */
export async function encodeBakedLightingAsset(result: ImportResult): Promise<Uint8Array> {
  const name = id.parse(result.name);
  const decoded = await validateBakedLightingChunks(result, result.chunks);
  return encodeBabasset({ header: { guid: decoded.guid, name, type: BAKED_LIGHTING_ASSET_TYPE,
    version: 1, dependencies: decoded.manifest.dependencies, payload: {},
    mode: "bundled", engineVersion: "0.0.0" }, chunks: ownedChunks(decoded) });
}

export async function decodeBakedLightingAsset(
  bytes: Uint8Array,
  readBlob?: (sha256: string) => Promise<Uint8Array>,
): Promise<DecodedBakedLighting> {
  if (bytes.byteLength < 12) throw new Error("Truncated baked lighting container.");
  const headerLength = readU32LE(bytes, 8);
  const payloadStart = 12 + headerLength;
  if (headerLength > MAX_MANIFEST_BYTES || payloadStart > bytes.byteLength)
    throw new Error("Baked lighting header exceeds its size limit or is truncated.");
  const header = readBabassetHeader(bytes);
  for (const entry of header.chunks) {
    if (!("inline" in entry.locator)) continue;
    const { offset, length } = entry.locator.inline;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 ||
      offset + length > bytes.byteLength - payloadStart)
      throw new Error("Baked lighting chunk is outside its container.");
  }
  return readBakedLightingAssetChunks(header, async (entry) => {
    if ("inline" in entry.locator) {
      const { offset, length } = entry.locator.inline;
      return bytes.subarray(payloadStart + offset, payloadStart + offset + length);
    }
    if (!readBlob) throw new Error(`Chunk ${entry.id} requires a blob reader.`);
    return readBlob(entry.locator.blob);
  });
}

/** Validate manifest and declared atlas lengths before requesting any atlas payload. */
export async function readBakedLightingAssetChunks(
  sourceHeader: BabassetHeader,
  readChunk: (entry: ChunkEntry) => Promise<Uint8Array>,
): Promise<DecodedBakedLighting> {
  const header = structuredClone(sourceHeader);
  if (header.type !== BAKED_LIGHTING_ASSET_TYPE || header.version !== 1)
    throw new Error("Unsupported baked lighting asset type or version.");
  if (header.chunks.length < 2 || header.chunks.length > 17)
    throw new Error("Unexpected baked lighting asset chunks.");
  unique(header.chunks.map((entry) => entry.id), "asset chunk");
  const document = header.chunks.find((entry) => entry.id === BAKED_LIGHTING_MANIFEST_CHUNK);
  if (!document || document.kind !== "document" || document.mime !== "application/json")
    throw new Error("Baked lighting manifest chunk is missing or malformed.");
  for (const entry of header.chunks) {
    hash.parse(entry.sha256);
    if (entry !== document && (entry.kind !== "diffuseIrradiance" || entry.mime !== "application/octet-stream"))
      throw new Error("Unexpected baked lighting asset chunks.");
    if ("inline" in entry.locator) {
      const { offset, length } = entry.locator.inline;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 ||
        length > (entry === document ? MAX_MANIFEST_BYTES : BAKED_LIGHTING_MAX_BYTES))
        throw new Error("Baked lighting chunk exceeds its size limit or has an invalid locator.");
    } else if (entry.locator.blob !== entry.sha256) throw new Error("Baked lighting blob identity does not match its chunk hash.");
  }
  const readOwned = async (entry: ChunkEntry, maximum: number, exact?: number): Promise<Uint8Array> => {
    const data = await readChunk(entry);
    if (data.byteLength > maximum || (exact !== undefined && data.byteLength !== exact))
      throw new Error(`Baked lighting chunk ${entry.id} has an invalid byte length.`);
    return data.slice();
  };
  const documentBytes = await readOwned(document, MAX_MANIFEST_BYTES);
  if (await sha256Hex(documentBytes) !== document.sha256) throw new Error("Baked lighting manifest hash mismatch.");
  const manifest = parseBakedLightingManifest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(documentBytes)));
  if (header.chunks.length !== manifest.atlases.length + 1 ||
    stableStringify([...header.dependencies].sort()) !== stableStringify([...manifest.dependencies].sort()))
    throw new Error("Baked lighting chunks or dependencies do not match the manifest.");
  const declared = manifest.atlases.map((atlas) => {
    const entry = header.chunks.find((chunk) => chunk.id === atlas.chunkId);
    const length = atlas.width * atlas.height * 16;
    if (!entry || entry.sha256 !== atlas.sha256 ||
      ("inline" in entry.locator && entry.locator.inline.length !== length))
      throw new Error(`Irradiance atlas ${atlas.guid} metadata does not match the manifest.`);
    return { entry, length };
  });
  const chunks: ChunkInput[] = [{ ...document, data: documentBytes }];
  for (const { entry, length } of declared) chunks.push({ ...entry, data: await readOwned(entry, length, length) });
  return validateChunks(header, chunks, false);
}
