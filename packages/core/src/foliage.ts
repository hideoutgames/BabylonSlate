import type { SerializedActor, SerializedTransform } from "./scene";

export const DEFAULT_FOLIAGE_CULL_DISTANCE = 120;
export const DEFAULT_FOLIAGE_FADE_RANGE = 15;
export const DEFAULT_FOLIAGE_SHADOW_DISTANCE = 45;

export interface FoliageModel {
  modelGuid: string;
  materialGuid: string | null;
  weight: number;
  minScale: number;
  maxScale: number;
  /** Distance from camera at which spatial cells stop drawing (0 = unlimited). */
  cullDistance: number;
  /** Width of the dithered fade-out band ending at cullDistance (meters). */
  fadeRange: number;
  /** Distance at which spatial cells stop casting shadows (0 = inherit cullDistance). */
  shadowDistance: number;
}
export interface FoliageGroup {
  id: string;
  name: string;
  models: FoliageModel[];
}

/** A batch's Model, Material Override and distances: the JSON part of a Foliage batch. */
export interface FoliageBatchInfo {
  modelGuid: string;
  materialGuid: string | null;
  cullDistance: number;
  fadeRange: number;
  shadowDistance: number;
}

/** Floats per foliage instance: position `x, y, z`, rotation quaternion `x, y, z, w`, scale `x, y, z`. */
export const FOLIAGE_FLOATS_PER_INSTANCE = 10;

/** A decoded batch: its info and its instances, `FOLIAGE_FLOATS_PER_INSTANCE` floats each. */
export interface FoliageBatch extends FoliageBatchInfo {
  transforms: Float32Array;
}

/** Decoded Foliage component: typed instance data, never one object per instance. */
export interface FoliageProperties {
  groupId: string;
  batches: FoliageBatch[];
}

/**
 * The JSON form stored in `SerializedComponent.properties`. Instances live in one binary `HPFG` chunk: base64 `data`
 * in editor documents (undo, journal, copy and paste), `chunkId` (`foliage:<componentId>`) in a saved `.hasset` and in
 * Play and exported games, which carry the raw chunk beside the Scene. Neither when nothing is painted.
 */
export interface SerializedFoliageProperties {
  groupId: string;
  batches: FoliageBatchInfo[];
  data?: string | null;
  chunkId?: string;
}

export const MAX_FOLIAGE_INSTANCES = 20000;
const MAX_FOLIAGE_BATCHES = 128;

/** Binary `HPFG` chunk prefix inside Scene, Prefab and Class `.hasset` files. */
export const FOLIAGE_CHUNK_PREFIX = "foliage:";

/** The `.hasset` binary chunk id of a `FoliageComponent`. */
export function foliageChunkId(componentId: string): string {
  return `${FOLIAGE_CHUNK_PREFIX}${componentId}`;
}

/** True when `chunkId` names a binary foliage instance chunk. */
export function isFoliageChunkId(chunkId: string): boolean {
  return chunkId.startsWith(FOLIAGE_CHUNK_PREFIX) && chunkId.length > FOLIAGE_CHUNK_PREFIX.length;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}
function number(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}
function guid(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function normalizeFoliageGroups(value: unknown): FoliageGroup[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  return value.slice(0, 64).flatMap((entry, index) => {
    const p = object(entry);
    const id = guid(p.id) ?? `foliage-group-${index + 1}`;
    if (ids.has(id)) return [];
    ids.add(id);
    const models = Array.isArray(p.models) ? p.models : [];
    return [{ id, name: guid(p.name) ?? "Foliage Group", models: models.slice(0, 64).flatMap((entry) => {
      const model = object(entry);
      const modelGuid = guid(model.modelGuid);
      if (!modelGuid) return [];
      const minScale = number(model.minScale, 0.8, 0.01, 100);
      return [{
        modelGuid,
        materialGuid: guid(model.materialGuid),
        weight: number(model.weight, 1, 0, 100),
        minScale,
        maxScale: number(model.maxScale, Math.max(1.2, minScale), minScale, 100),
        cullDistance: number(model.cullDistance, DEFAULT_FOLIAGE_CULL_DISTANCE, 0, 10_000),
        fadeRange: number(model.fadeRange, DEFAULT_FOLIAGE_FADE_RANGE, 0, 1_000),
        shadowDistance: number(model.shadowDistance, DEFAULT_FOLIAGE_SHADOW_DISTANCE, 0, 10_000),
      }];
    }) }];
  });
}

/* HPFG chunk: magic, u16 version, u16 batchCount, u32 instanceCount per batch, then the instances' floats. */
const HPFG_MAGIC = [0x48, 0x50, 0x46, 0x47] as const; // "HPFG"
const HPFG_VERSION = 1;
const HPFG_PREFIX_BYTES = 8;
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** Encode the batches' instances into one little-endian `HPFG` chunk, in batch order. */
export function encodeFoliageChunk(batches: ReadonlyArray<Pick<FoliageBatch, "transforms">>): Uint8Array<ArrayBuffer> {
  if (batches.length > 0xffff) throw new Error("Foliage chunk holds at most 65535 batches");
  const floats = batches.reduce((total, batch) => total + batch.transforms.length, 0);
  const header = HPFG_PREFIX_BYTES + batches.length * 4;
  const buffer = new ArrayBuffer(header + floats * 4);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  bytes.set(HPFG_MAGIC, 0);
  view.setUint16(4, HPFG_VERSION, true);
  view.setUint16(6, batches.length, true);
  let offset = header;
  for (let index = 0; index < batches.length; index++) {
    const transforms = batches[index]!.transforms;
    if (transforms.length % FOLIAGE_FLOATS_PER_INSTANCE !== 0) throw new Error("Foliage batch transforms must hold whole instances");
    view.setUint32(HPFG_PREFIX_BYTES + index * 4, transforms.length / FOLIAGE_FLOATS_PER_INSTANCE, true);
    if (LITTLE_ENDIAN) new Float32Array(buffer, offset, transforms.length).set(transforms);
    else for (let i = 0; i < transforms.length; i++) view.setFloat32(offset + i * 4, transforms[i]!, true);
    offset += transforms.byteLength;
  }
  return bytes;
}

/**
 * Decode an `HPFG` chunk into one `Float32Array` of instances per batch: views of one aligned buffer, never an object
 * per instance. Throws for a malformed chunk (magic, version, lengths) or more than `MAX_FOLIAGE_INSTANCES` instances.
 */
export function decodeFoliageChunk(bytes: Uint8Array): Float32Array[] {
  if (bytes.byteLength < HPFG_PREFIX_BYTES) throw new Error("Invalid HPFG foliage chunk: truncated header");
  for (let i = 0; i < HPFG_MAGIC.length; i++) {
    if (bytes[i] !== HPFG_MAGIC[i]) throw new Error("Invalid HPFG foliage chunk: bad magic");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(4, true);
  if (version !== HPFG_VERSION) throw new Error(`Unsupported HPFG foliage chunk version: ${version}`);
  const batchCount = view.getUint16(6, true);
  const header = HPFG_PREFIX_BYTES + batchCount * 4;
  if (bytes.byteLength < header) throw new Error("Invalid HPFG foliage chunk: truncated batch table");
  let instances = 0;
  const counts: number[] = [];
  for (let index = 0; index < batchCount; index++) {
    const count = view.getUint32(HPFG_PREFIX_BYTES + index * 4, true);
    instances += count;
    counts.push(count);
  }
  if (instances > MAX_FOLIAGE_INSTANCES) throw new Error(`Invalid HPFG foliage chunk: ${instances} instances`);
  const floats = instances * FOLIAGE_FLOATS_PER_INSTANCE;
  if (bytes.byteLength !== header + floats * 4) throw new Error("Invalid HPFG foliage chunk: length does not match its batch table");
  let all: Float32Array;
  if (LITTLE_ENDIAN && (bytes.byteOffset + header) % 4 === 0) {
    all = new Float32Array(bytes.buffer, bytes.byteOffset + header, floats);
  } else {
    all = new Float32Array(floats);
    for (let i = 0; i < floats; i++) all[i] = view.getFloat32(header + i * 4, true);
  }
  const batches: Float32Array[] = [];
  let at = 0;
  for (const count of counts) {
    const length = count * FOLIAGE_FLOATS_PER_INSTANCE;
    batches.push(all.subarray(at, at + length));
    at += length;
  }
  return batches;
}

function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length))));
  }
  return btoa(parts.join(""));
}

/** Raw `HPFG` bytes of a base64 `data` string. */
export function decodeFoliageBase64ToBytes(encoded: string): Uint8Array<ArrayBuffer> {
  const binary = atob(encoded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Base64 `HPFG` string of the batches' instances, for editor JSON. */
export function encodeFoliageBase64(batches: ReadonlyArray<Pick<FoliageBatch, "transforms">>): string {
  return bytesToBase64(encodeFoliageChunk(batches));
}

function batchInfo(value: unknown): FoliageBatchInfo | null {
  const batch = object(value);
  const modelGuid = guid(batch.modelGuid);
  if (!modelGuid) return null;
  return {
    modelGuid,
    materialGuid: guid(batch.materialGuid),
    cullDistance: number(batch.cullDistance, DEFAULT_FOLIAGE_CULL_DISTANCE, 0, 10_000),
    fadeRange: number(batch.fadeRange, DEFAULT_FOLIAGE_FADE_RANGE, 0, 1_000),
    shadowDistance: number(batch.shadowDistance, DEFAULT_FOLIAGE_SHADOW_DISTANCE, 0, 10_000),
  };
}

/** The batch infos of serialized or decoded properties, in order, without decoding any instance. */
export function foliageBatchInfos(value: unknown): FoliageBatchInfo[] {
  const batches = object(value).batches;
  if (!Array.isArray(batches)) return [];
  const infos: FoliageBatchInfo[] = [];
  for (const entry of batches.slice(0, MAX_FOLIAGE_BATCHES)) {
    const info = batchInfo(entry);
    if (info) infos.push(info);
  }
  return infos;
}

/** Instances in decoded properties. */
export function foliageInstanceCount(properties: FoliageProperties): number {
  let count = 0;
  for (const batch of properties.batches) count += batch.transforms.length / FOLIAGE_FLOATS_PER_INSTANCE;
  return count;
}

const decodedByProperties = new WeakMap<object, FoliageProperties>();
const decodedByBytes = new WeakMap<Uint8Array, Float32Array[]>();
const MAX_BASE64_CACHE = 8;
const decodedByBase64 = new Map<string, Float32Array[]>();

function decodeBytesCached(bytes: Uint8Array): Float32Array[] {
  let decoded = decodedByBytes.get(bytes);
  if (!decoded) {
    decoded = decodeFoliageChunk(bytes);
    decodedByBytes.set(bytes, decoded);
  }
  return decoded;
}

function decodeBase64Cached(encoded: string): Float32Array[] {
  const hit = decodedByBase64.get(encoded);
  if (hit) {
    decodedByBase64.delete(encoded);
    decodedByBase64.set(encoded, hit);
    return hit;
  }
  const decoded = decodeFoliageChunk(decodeFoliageBase64ToBytes(encoded));
  if (decodedByBase64.size >= MAX_BASE64_CACHE) {
    const oldest = decodedByBase64.keys().next().value;
    if (oldest !== undefined) decodedByBase64.delete(oldest);
  }
  decodedByBase64.set(encoded, decoded);
  return decoded;
}

/**
 * Decode a `FoliageComponent` into typed batches. Accepts decoded `FoliageProperties` (batches with `Float32Array`
 * transforms), raw `HPFG` bytes (Play and exported games, from the chunk named by `chunkId`), or base64 `data`
 * (editor JSON). The result is cached per properties object, so hosts replace properties rather than mutate them.
 * Instances whose chunk does not match the batch list, or is malformed, are dropped with their batches.
 */
export function parseFoliageProperties(value: unknown, binaryBytes?: Uint8Array | null): FoliageProperties {
  const memo = !binaryBytes && value !== null && typeof value === "object" ? value : null;
  const cached = memo ? decodedByProperties.get(memo) : undefined;
  if (cached) return cached;
  const p = object(value);
  const groupId = guid(p.groupId) ?? "";
  const rawBatches = Array.isArray(p.batches) ? p.batches.slice(0, MAX_FOLIAGE_BATCHES) : [];
  let transforms: readonly Float32Array[] | null = null;
  if (rawBatches.length > 0 && rawBatches.every((batch) => object(batch).transforms instanceof Float32Array)) {
    transforms = rawBatches.map((batch) => object(batch).transforms as Float32Array);
  } else {
    try {
      if (binaryBytes && binaryBytes.byteLength > 0) transforms = decodeBytesCached(binaryBytes);
      else if (typeof p.data === "string" && p.data.length > 0) transforms = decodeBase64Cached(p.data);
    } catch {
      transforms = null;
    }
    if (transforms && transforms.length !== rawBatches.length) transforms = null;
  }
  const batches: FoliageBatch[] = [];
  let remaining = MAX_FOLIAGE_INSTANCES * FOLIAGE_FLOATS_PER_INSTANCE;
  for (let index = 0; index < rawBatches.length && transforms; index++) {
    const info = batchInfo(rawBatches[index]);
    const source = transforms[index]!;
    if (!info || source.length === 0 || remaining <= 0 || source.length % FOLIAGE_FLOATS_PER_INSTANCE !== 0) continue;
    const kept = source.length <= remaining ? source : source.subarray(0, remaining);
    remaining -= kept.length;
    batches.push({ ...info, transforms: kept });
  }
  const parsed = { groupId, batches };
  if (memo) decodedByProperties.set(memo, parsed);
  return parsed;
}

/** Decoded properties as the JSON stored in a document: batch infos and base64 `data` (null when nothing is painted). */
export function serializeFoliageProperties(properties: FoliageProperties): SerializedFoliageProperties {
  const batches = properties.batches.filter((batch) => batch.transforms.length > 0);
  return {
    groupId: properties.groupId,
    batches: batches.map((batch) => ({ modelGuid: batch.modelGuid, materialGuid: batch.materialGuid, cullDistance: batch.cullDistance, fadeRange: batch.fadeRange, shadowDistance: batch.shadowDistance })),
    data: batches.length > 0 ? encodeFoliageBase64(batches) : null,
  };
}

/**
 * Normalize `FoliageComponent` JSON without decoding its instances: batch infos and either `data` or `chunkId`.
 * Decoded properties (typed transforms) are serialized.
 */
export function normalizeSerializedFoliageProperties(value: unknown): SerializedFoliageProperties {
  const p = object(value);
  const batches = Array.isArray(p.batches) ? p.batches : [];
  if (batches.length > 0 && batches.every((batch) => object(batch).transforms instanceof Float32Array)) {
    return serializeFoliageProperties(parseFoliageProperties(p));
  }
  const data = typeof p.data === "string" && p.data.length > 0 ? p.data : null;
  const chunkId = typeof p.chunkId === "string" && isFoliageChunkId(p.chunkId) ? p.chunkId : null;
  return {
    groupId: guid(p.groupId) ?? "",
    batches: foliageBatchInfos(p),
    ...(data ? { data } : chunkId ? { chunkId } : { data: null }),
  };
}

/** 32-bit FNV-1a over a string's UTF-16 code units. */
function hashString(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

/** 32-bit FNV-1a over float bit patterns. */
function hashFloats(values: Float32Array, seed: number): number {
  const words = new Uint32Array(values.buffer, values.byteOffset, values.length);
  let hash = seed;
  for (let i = 0; i < words.length; i++) {
    hash ^= words[i]!;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Identity of a component's instances for change detection: a hash of its `data` string, its `chunkId`, or a hash of
 * decoded transforms. Never serializes the instances.
 */
export function foliageInstancesFingerprint(value: unknown): string {
  const p = object(value);
  if (typeof p.data === "string" && p.data.length > 0) return `data:${p.data.length}:${hashString(p.data)}`;
  if (typeof p.chunkId === "string" && p.chunkId) return `chunk:${p.chunkId}`;
  const batches = Array.isArray(p.batches) ? p.batches : [];
  let hash = 0x811c9dc5;
  let floats = 0;
  for (const batch of batches) {
    const transforms = object(batch).transforms;
    if (!(transforms instanceof Float32Array)) continue;
    hash = hashFloats(transforms, hash);
    floats += transforms.length;
  }
  return floats > 0 ? `floats:${floats}:${hash.toString(16)}` : "none";
}

/** Models are selected by weight; zero-weight entries never paint. */
export function chooseFoliageModel(group: FoliageGroup, random: number): FoliageModel | null {
  const models = group.models.filter((entry) => entry.weight > 0);
  const sum = models.reduce((total, entry) => total + entry.weight, 0);
  let pick = Math.max(0, Math.min(1 - Number.EPSILON, random)) * sum;
  for (const model of models) { pick -= model.weight; if (pick < 0) return model; }
  return null;
}

/** Writes `transform` as one instance's floats at `offset`. */
export function writeFoliageInstance(target: Float32Array, offset: number, transform: SerializedTransform): void {
  target[offset] = transform.position[0]; target[offset + 1] = transform.position[1]; target[offset + 2] = transform.position[2];
  target[offset + 3] = transform.rotation[0]; target[offset + 4] = transform.rotation[1];
  target[offset + 5] = transform.rotation[2]; target[offset + 6] = transform.rotation[3];
  target[offset + 7] = transform.scale[0]; target[offset + 8] = transform.scale[1]; target[offset + 9] = transform.scale[2];
}

/** Instance transforms as a batch's floats (`FOLIAGE_FLOATS_PER_INSTANCE` each). */
export function packFoliageTransforms(transforms: readonly SerializedTransform[]): Float32Array {
  const packed = new Float32Array(transforms.length * FOLIAGE_FLOATS_PER_INSTANCE);
  for (let index = 0; index < transforms.length; index++) writeFoliageInstance(packed, index * FOLIAGE_FLOATS_PER_INSTANCE, transforms[index]!);
  return packed;
}

export function appendFoliageInstance(properties: FoliageProperties, model: FoliageModel, transform: SerializedTransform): FoliageProperties {
  if (foliageInstanceCount(properties) >= MAX_FOLIAGE_INSTANCES) return properties;
  const existing = properties.batches.findIndex((batch) => batch.modelGuid === model.modelGuid && batch.materialGuid === model.materialGuid);
  const cullDistance = number(model.cullDistance, DEFAULT_FOLIAGE_CULL_DISTANCE, 0, 10_000);
  const fadeRange = number(model.fadeRange, DEFAULT_FOLIAGE_FADE_RANGE, 0, 1_000);
  const shadowDistance = number(model.shadowDistance, DEFAULT_FOLIAGE_SHADOW_DISTANCE, 0, 10_000);
  const appended = (previous: Float32Array) => {
    const next = new Float32Array(previous.length + FOLIAGE_FLOATS_PER_INSTANCE);
    next.set(previous);
    writeFoliageInstance(next, previous.length, transform);
    return next;
  };
  return { ...properties, batches: existing < 0
    ? [...properties.batches, { modelGuid: model.modelGuid, materialGuid: model.materialGuid, transforms: appended(new Float32Array(0)), cullDistance, fadeRange, shadowDistance }]
    : properties.batches.map((batch, index) => index === existing ? { ...batch, transforms: appended(batch.transforms), cullDistance, fadeRange, shadowDistance } : batch) };
}

/**
 * A Foliage Group Model's edit from `previous` to `next` reaches the strokes painted with it: every batch of group
 * `groupId`'s Foliage components that holds `previous`'s Model and Material Override takes `next`'s Material Override and
 * distances, so later edits still find it. The instances (`data` or `chunkId`) are untouched. Untouched actors,
 * components and batches keep their identity; returns `actors` itself when no batch is the Model's.
 */
export function applyFoliageModelEdit(
  actors: SerializedActor[], groupId: string, previous: FoliageModel, next: FoliageModel,
): SerializedActor[] {
  let changed = false;
  const result = actors.map((actor) => {
    let actorChanged = false;
    const components = actor.components.map((component) => {
      const properties = object(component.properties);
      if (component.classId !== "FoliageComponent" || properties.groupId !== groupId || !Array.isArray(properties.batches)) return component;
      let batchChanged = false;
      const batches = properties.batches.map((batch: unknown) => {
        const entry = object(batch);
        if (entry.modelGuid !== previous.modelGuid || guid(entry.materialGuid) !== previous.materialGuid) return batch;
        batchChanged = true;
        return { ...entry, materialGuid: next.materialGuid, cullDistance: next.cullDistance, fadeRange: next.fadeRange, shadowDistance: next.shadowDistance };
      });
      if (!batchChanged) return component;
      actorChanged = true;
      return { ...component, properties: { ...properties, batches } };
    });
    if (!actorChanged) return actor;
    changed = true;
    return { ...actor, components };
  });
  return changed ? result : actors;
}
