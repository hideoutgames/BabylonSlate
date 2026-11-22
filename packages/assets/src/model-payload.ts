import type { ModelOccluder } from "./occluder-bake";
import { normalizeSkeletonSockets, type SkeletonSocket } from "./skeleton-payload";
import { concatBytes } from "./bytes";
import {
  normalizeModelSimpleColliders,
  type ModelSimpleCollider,
} from "./simple-collision";

export interface ModelMaterialSlot {
  index: number;
  name: string;
  materialGuid: string | null;
}

/** Importer fallback when Engine Settings are not passed. Not used for missing payload fields. */
export const DEFAULT_MODEL_IMPORT_SCALE = 1;

export interface ModelPayload {
  materialSlots: ModelMaterialSlot[];
  skeletonGuid: string | null;
  /**
   * Uniform multiplier applied under the actor root at load.
   * Missing / invalid values normalize to 1 so legacy assets keep authored size.
   */
  importScale: number;
  /** Authored / generated simple collision volumes in model local space. */
  simpleColliders: ModelSimpleCollider[];
  /**
   * Generate simplified levels of detail when the model loads. Missing values
   * normalize to true so existing models gain automatic LOD.
   */
  autoLod: boolean;
  /** The occluder baked at import (`occluder-bake.ts`); null for a model with none, a skinned one, or one imported before. */
  occluder?: ModelOccluder | null;
  /**
   * Its Skeleton's sockets, copied in by Play and exports as they gather a game's content (`withSkeletonSockets`), so
   * the renderer resolves a socket name on the Model. A Model asset never authors them; the Skeleton does.
   */
  sockets?: SkeletonSocket[];
}

/** The Model with its Skeleton's sockets (none when the Skeleton has none), as Play and exports ship it. */
export function withSkeletonSockets(model: ModelPayload, skeletonSockets: readonly SkeletonSocket[] | undefined): ModelPayload {
  if (!skeletonSockets || skeletonSockets.length === 0) {
    if (!model.sockets) return model;
    const { sockets: _dropped, ...rest } = model;
    void _dropped;
    return rest;
  }
  return { ...model, sockets: skeletonSockets.map((socket) => ({ ...socket })) };
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
    skeletonGuid: nullableGuid(record.skeletonGuid),
    importScale: normalizeModelImportScale(record.importScale),
    simpleColliders: normalizeModelSimpleColliders(record.simpleColliders),
    autoLod: record.autoLod !== false,
    occluder: normalizeModelOccluder(record.occluder),
    ...(Array.isArray(record.sockets) && record.sockets.length > 0 ? { sockets: normalizeSkeletonSockets(record.sockets) } : {}),
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

/**
 * The Model's `.hasset` header payload: every field but its Simple Collision
 * shapes (convex hulls hold many points), which stay in the document chunk;
 * `simpleColliderCount` says how many there are. Readers that need the shapes
 * load the document.
 */
export function modelHeaderSummary(payload: unknown): Record<string, unknown> {
  const { simpleColliders, ...rest } = normalizeModelPayload(payload);
  return { ...rest, simpleColliderCount: simpleColliders.length };
}

/** Simple Collision shapes a Model header summary counts, or the shapes of a full payload. */
export function modelSimpleColliderCount(payload: unknown): number {
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  if (typeof record.simpleColliderCount === "number") return record.simpleColliderCount;
  return normalizeModelPayload(payload).simpleColliders.length;
}

/** Skeleton + slot Material guids on a Model header. */
export function modelAssetGuids(payload: unknown): string[] {
  const model = normalizeModelPayload(payload);
  const guids = new Set<string>(modelMaterialGuids(model));
  if (model.skeletonGuid) guids.add(model.skeletonGuid);
  return [...guids].sort();
}

/**
 * Packed Model envelope: magic `HPMO`, `u16 version`, `u16 flags` (none
 * defined, must be 0), `u32 jsonLength`, the payload JSON, then the GLB to the
 * end. All integers little-endian.
 */
const PACKED_MODEL_MAGIC = new Uint8Array([0x48, 0x50, 0x4d, 0x4f]); // HPMO
const PACKED_MODEL_VERSION = 1;
const PACKED_MODEL_PREFIX_BYTES = 12;
const packedEncoder = new TextEncoder();
const packedDecoder = new TextDecoder();

/** Pack Model JSON payload with GLB source so export can ship both. */
export function encodePackedModelAsset(
  payload: ModelPayload | Record<string, unknown>,
  source: Uint8Array,
): Uint8Array {
  const json = packedEncoder.encode(JSON.stringify(normalizeModelPayload(payload)));
  const prefix = new Uint8Array(PACKED_MODEL_PREFIX_BYTES);
  const view = new DataView(prefix.buffer);
  prefix.set(PACKED_MODEL_MAGIC, 0);
  view.setUint16(4, PACKED_MODEL_VERSION, true);
  view.setUint16(6, 0, true);
  view.setUint32(8, json.byteLength, true);
  return concatBytes([prefix, json, source]);
}

/** End of the JSON, null for bytes that are not an envelope (raw GLB); throws for a malformed envelope. */
function packedModelJsonEnd(bytes: Uint8Array): number | null {
  if (bytes.byteLength < PACKED_MODEL_MAGIC.length) return null;
  for (let i = 0; i < PACKED_MODEL_MAGIC.length; i++) {
    if (bytes[i] !== PACKED_MODEL_MAGIC[i]) return null;
  }
  if (bytes.byteLength < PACKED_MODEL_PREFIX_BYTES) throw new Error("Invalid HPMO model envelope: truncated header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(4, true);
  if (version !== PACKED_MODEL_VERSION) throw new Error(`Unsupported HPMO model envelope version: ${version}`);
  if (view.getUint16(6, true) !== 0) throw new Error("Invalid HPMO model envelope: unknown flags");
  const jsonEnd = PACKED_MODEL_PREFIX_BYTES + view.getUint32(8, true);
  if (jsonEnd > bytes.byteLength) throw new Error("Invalid HPMO model envelope: truncated payload");
  return jsonEnd;
}

/** JSON payload from an HPMO envelope without copying GLB bytes; null for a raw GLB. */
export function peekPackedModelPayload(bytes: Uint8Array): ModelPayload | null {
  const jsonEnd = packedModelJsonEnd(bytes);
  if (jsonEnd === null) return null;
  return normalizeModelPayload(JSON.parse(packedDecoder.decode(bytes.subarray(PACKED_MODEL_PREFIX_BYTES, jsonEnd))));
}

/** Unwrap a packed Model envelope; raw GLB returns null. Throws for a malformed envelope. */
export function decodePackedModelAsset(
  bytes: Uint8Array,
): { payload: ModelPayload; source: Uint8Array } | null {
  const jsonEnd = packedModelJsonEnd(bytes);
  if (jsonEnd === null) return null;
  const payload = normalizeModelPayload(JSON.parse(packedDecoder.decode(bytes.subarray(PACKED_MODEL_PREFIX_BYTES, jsonEnd))));
  return { payload, source: bytes.subarray(jsonEnd) };
}

function normalizeModelOccluder(value: unknown): ModelOccluder | null {
  const record = asRecord(value);
  const vector = (entry: unknown) =>
    Array.isArray(entry) && entry.length === 3 && entry.every((item) => typeof item === "number" && Number.isFinite(item))
      ? entry as [number, number, number]
      : null;
  const min = vector(record.min), max = vector(record.max), boundsMin = vector(record.boundsMin), boundsMax = vector(record.boundsMax);
  if (!min || !max || !boundsMin || !boundsMax) return null;
  if ([0, 1, 2].some((axis) => !(min[axis]! < max[axis]!) || min[axis]! < boundsMin[axis]! || max[axis]! > boundsMax[axis]!)) return null;
  return { min: [...min], max: [...max], boundsMin: [...boundsMin], boundsMax: [...boundsMax] };
}
