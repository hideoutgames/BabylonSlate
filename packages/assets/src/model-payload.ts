import { concatBytes, readU32LE, writeU32LE } from "./bytes";

export interface ModelMaterialSlot {
  index: number;
  name: string;
  materialGuid: string | null;
}

/** Importer fallback when Engine Settings are not passed. Not used for missing payload fields. */
export const DEFAULT_MODEL_IMPORT_SCALE = 1;

export interface ModelPayload {
  materialSlots: ModelMaterialSlot[];
  clipNames: string[];
  skeletonGuid: string | null;
  /**
   * Uniform multiplier applied under the actor root at load.
   * Missing / invalid values normalize to 1 so legacy assets keep authored size.
   */
  importScale: number;
}

export function normalizeModelImportScale(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 1;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function slotName(value: unknown, index: number): string {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : `Slot ${index + 1}`;
}

function slotGuid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const guid = value.trim();
  return guid.length > 0 ? guid : null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
}

function nullableGuid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const guid = value.trim();
  return guid.length > 0 ? guid : null;
}

/** Drop importer count fields; coerce slot guids; keep filled legacy guids. */
export function normalizeModelPayload(value: unknown): ModelPayload {
  const record = asRecord(value);
  const rawSlots = Array.isArray(record.materialSlots)
    ? record.materialSlots
    : [];
  const materialSlots: ModelMaterialSlot[] = rawSlots.map((entry, index) => {
    const slot = asRecord(entry);
    const slotIndex =
      typeof slot.index === "number" && Number.isFinite(slot.index)
        ? slot.index
        : index;
    return {
      index: slotIndex,
      name: slotName(slot.name, slotIndex),
      materialGuid: slotGuid(slot.materialGuid),
    };
  });
  return {
    materialSlots,
    clipNames: stringList(record.clipNames),
    skeletonGuid: nullableGuid(record.skeletonGuid),
    importScale: normalizeModelImportScale(record.importScale),
  };
}

export function remapModelPayloadGuids(
  assetType: string,
  payload: Record<string, unknown>,
  remap: ReadonlyMap<string, string>,
): Record<string, unknown> {
  if (assetType !== "Model") return payload;
  const model = normalizeModelPayload(payload);
  return {
    ...model,
    materialSlots: model.materialSlots.map((slot) => ({
      ...slot,
      materialGuid: slot.materialGuid
        ? (remap.get(slot.materialGuid) ?? slot.materialGuid)
        : null,
    })),
    skeletonGuid: model.skeletonGuid
      ? (remap.get(model.skeletonGuid) ?? model.skeletonGuid)
      : null,
  };
}

/** Slot Material guids for Show References, remap, and export. */
export function modelMaterialGuids(payload: unknown): string[] {
  const guids = new Set<string>();
  for (const slot of normalizeModelPayload(payload).materialSlots) {
    if (slot.materialGuid) guids.add(slot.materialGuid);
  }
  return [...guids].sort();
}

/** Skeleton + slot Material guids on a Model header. */
export function modelAssetGuids(payload: unknown): string[] {
  const model = normalizeModelPayload(payload);
  const guids = new Set<string>(modelMaterialGuids(model));
  if (model.skeletonGuid) guids.add(model.skeletonGuid);
  return [...guids].sort();
}

/** Packed Texture proof required before replacing embedded GLB rasters with a 1×1 stub. */
export type PackedTextureSlimProof = {
  packedTextureGuids: ReadonlySet<string>;
  texturesByMaterialGuid: ReadonlyMap<string, readonly string[]>;
  /**
   * Slot Material guids that compiled in this Scene. Omit or leave empty to
   * keep authored GLB rasters — packed bytes alone must not slim.
   */
  compiledMaterialGuids?: ReadonlySet<string>;
};

/**
 * Slim only when every slot has a Material guid, that Material compiled, and
 * every texture it samples is present in packed Texture bytes. Bound slots
 * alone must not slim — Preview Build otherwise leaves construction mats on
 * a red stub.
 */
export function shouldSlimModelEmbeddedTextures(
  payload: unknown,
  packed?: PackedTextureSlimProof | null,
): boolean {
  const slots = normalizeModelPayload(payload).materialSlots;
  if (
    slots.length === 0 ||
    !slots.every(
      (slot) =>
        typeof slot.materialGuid === "string" && slot.materialGuid.length > 0,
    )
  ) {
    return false;
  }
  if (!packed) return false;
  if (!packed.compiledMaterialGuids) return false;
  for (const slot of slots) {
    const materialGuid = slot.materialGuid;
    if (!materialGuid) return false;
    if (!packed.compiledMaterialGuids.has(materialGuid)) return false;
    const textures = packed.texturesByMaterialGuid.get(materialGuid);
    if (!textures) return false;
    for (const guid of textures) {
      if (!packed.packedTextureGuids.has(guid)) return false;
    }
  }
  return true;
}

const PACKED_MODEL_MAGIC = new Uint8Array([0x42, 0x53, 0x4d, 0x4f]); // BSMO
const packedEncoder = new TextEncoder();
const packedDecoder = new TextDecoder();

/** Pack Model JSON payload with GLB source so export can ship both. */
export function encodePackedModelAsset(
  payload: ModelPayload | Record<string, unknown>,
  source: Uint8Array,
): Uint8Array {
  const json = packedEncoder.encode(JSON.stringify(normalizeModelPayload(payload)));
  return concatBytes([
    PACKED_MODEL_MAGIC,
    writeU32LE(json.byteLength),
    json,
    source,
  ]);
}

function packedModelJsonRange(
  bytes: Uint8Array,
): { jsonStart: number; jsonEnd: number } | null {
  if (bytes.byteLength < 8) return null;
  for (let i = 0; i < PACKED_MODEL_MAGIC.length; i++) {
    if (bytes[i] !== PACKED_MODEL_MAGIC[i]) return null;
  }
  const jsonLen = readU32LE(bytes, 4);
  const jsonStart = 8;
  const jsonEnd = jsonStart + jsonLen;
  if (jsonLen < 0 || jsonEnd > bytes.byteLength) return null;
  return { jsonStart, jsonEnd };
}

/** JSON payload from a BSMO envelope without copying GLB bytes. */
export function peekPackedModelPayload(bytes: Uint8Array): ModelPayload | null {
  const range = packedModelJsonRange(bytes);
  if (!range) return null;
  try {
    return normalizeModelPayload(
      JSON.parse(packedDecoder.decode(bytes.subarray(range.jsonStart, range.jsonEnd))),
    );
  } catch {
    return null;
  }
}

/** Unwrap a packed Model envelope; raw GLB returns null. */
export function decodePackedModelAsset(
  bytes: Uint8Array,
): { payload: ModelPayload; source: Uint8Array } | null {
  const payload = peekPackedModelPayload(bytes);
  if (!payload) return null;
  const range = packedModelJsonRange(bytes);
  if (!range) return null;
  return { payload, source: bytes.subarray(range.jsonEnd) };
}

/** Packed Model source plus payload; raw GLB uses a default payload. */
export function extractPackedModelAsset(bytes: Uint8Array): {
  payload: ModelPayload;
  source: Uint8Array;
} {
  return decodePackedModelAsset(bytes) ?? {
    payload: normalizeModelPayload({}),
    source: bytes,
  };
}
