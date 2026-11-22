/** Binary `BSLD` chunk prefix inside Scene/Prefab/Class `.hasset` files. */
export const LANDSCAPE_CHUNK_PREFIX = "landscape:";

/** Return the `.hasset` binary chunk id for a `LandscapeComponent`. */
export function landscapeChunkId(componentId: string): string {
  return `${LANDSCAPE_CHUNK_PREFIX}${componentId}`;
}

/** True when `chunkId` names a binary landscape field chunk. */
export function isLandscapeChunkId(chunkId: string): boolean {
  return chunkId.startsWith(LANDSCAPE_CHUNK_PREFIX) && chunkId.length > LANDSCAPE_CHUNK_PREFIX.length;
}

/** In-memory heightfield with four RGBA8 paint weights per vertex, in local X/Z space. */
export interface LandscapeProperties {
  width: number;
  depth: number;
  subdivisions: number;
  /** Z-major heights (`heights[iz * (subdivisions + 1) + ix]`). */
  heights: Float32Array;
  /** Z-major RGBA8 paint weights (`0..255`, 4 bytes per vertex summing to 255). */
  weights: Uint8Array;
  materialGuid: string | null;
  collisionsEnabled: boolean;
}

/** Pure JSON form stored inside `SerializedComponent.properties`. */
export interface SerializedLandscapeProperties {
  width: number;
  depth: number;
  subdivisions: number;
  /** Compact base64-encoded `BSLD` bytes in Editor JSON; omitted/null when flat or externalized to `chunkId`. */
  data?: string | null;
  /** `.hasset` binary chunk id (e.g. `"landscape:<componentId>"`) when externalized on disk or in exports. */
  chunkId?: string | null;
  materialGuid: string | null;
  collisionsEnabled: boolean;
}

/** Heightfield collider geometry passed directly to `@haptic/physics`. */
export interface LandscapeHeightField {
  kind: "heightfield";
  numXSamples: number;
  numZSamples: number;
  width: number;
  depth: number;
  heights: Float32Array;
}

export type LandscapeBrushTool = "raise" | "lower" | "smooth" | "flatten" | "paint";
export interface LandscapeBrush {
  tool: LandscapeBrushTool;
  radius: number;
  strength: number;
  falloff: number;
  height: number;
  layer: number;
}

const BSLD_MAGIC_0 = 0x42; // 'B'
const BSLD_MAGIC_1 = 0x53; // 'S'
const BSLD_MAGIC_2 = 0x4c; // 'L'
const BSLD_MAGIC_3 = 0x44; // 'D'
const BSLD_FORMAT = 1;
const BSLD_HEADER_BYTES = 16;
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

type DecodedField = {
  subdivisions: number;
  heights: Float32Array;
  weights: Uint8Array;
};

const MAX_BASE64_CACHE = 16;
const decodedByBytes = new WeakMap<Uint8Array, DecodedField | null>();
const decodedByBase64 = new Map<string, DecodedField | null>();

function finite(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

function defaultWeights(vertexCount: number): Uint8Array {
  const weights = new Uint8Array(vertexCount * 4);
  for (let i = 0; i < vertexCount; i++) weights[i * 4] = 255;
  return weights;
}

/** Quantize four non-negative float weights to RGBA8 bytes summing to exactly 255 via largest-remainder rounding. */
export function quantizeVertexWeights(
  w0: number,
  w1: number,
  w2: number,
  w3: number,
  target: Uint8Array,
  offset: number,
): void {
  const a = Number.isFinite(w0) && w0 > 0 ? w0 : 0;
  const b = Number.isFinite(w1) && w1 > 0 ? w1 : 0;
  const c = Number.isFinite(w2) && w2 > 0 ? w2 : 0;
  const d = Number.isFinite(w3) && w3 > 0 ? w3 : 0;
  const sum = a + b + c + d;
  if (sum <= 0) {
    target[offset] = 255;
    target[offset + 1] = 0;
    target[offset + 2] = 0;
    target[offset + 3] = 0;
    return;
  }
  const scale = 255 / sum;
  const r0 = a * scale, r1 = b * scale, r2 = c * scale, r3 = d * scale;
  let f0 = Math.floor(r0), f1 = Math.floor(r1), f2 = Math.floor(r2), f3 = Math.floor(r3);
  let rem = 255 - (f0 + f1 + f2 + f3);
  if (rem > 0) {
    const frac = [r0 - f0, r1 - f1, r2 - f2, r3 - f3];
    const floors = [f0, f1, f2, f3];
    while (rem > 0) {
      let best = 0;
      for (let i = 1; i < 4; i++) {
        if (frac[i]! > frac[best]!) best = i;
      }
      floors[best] = floors[best]! + 1;
      frac[best] = -1;
      rem--;
    }
    f0 = floors[0]!; f1 = floors[1]!; f2 = floors[2]!; f3 = floors[3]!;
  }
  target[offset] = f0;
  target[offset + 1] = f1;
  target[offset + 2] = f2;
  target[offset + 3] = f3;
}

/** True when every vertex is at height 0 with pure layer-0 paint `[255, 0, 0, 0]`. */
export function isFlatDefaultLandscape(
  data: Pick<LandscapeProperties, "heights" | "weights">,
): boolean {
  const { heights, weights } = data;
  for (let i = 0; i < heights.length; i++) {
    if (heights[i] !== 0) return false;
    const at = i * 4;
    if (weights[at] !== 255 || weights[at + 1] !== 0 || weights[at + 2] !== 0 || weights[at + 3] !== 0) {
      return false;
    }
  }
  return true;
}

/** Encode landscape heights (`Float32Array`) and paint weights (`Uint8Array`) into a compact `BSLD` binary chunk. */
export function encodeLandscapeChunk(
  data: Pick<LandscapeProperties, "subdivisions" | "heights" | "weights">,
): Uint8Array<ArrayBuffer> {
  const subdivisions = Math.round(finite(data.subdivisions, 64, 4, 256));
  const vertexCount = (subdivisions + 1) ** 2;
  if (data.heights.length !== vertexCount || data.weights.length !== vertexCount * 4) {
    throw new Error(`Landscape field length mismatch for subdivisions=${subdivisions}`);
  }
  const heightBytes = vertexCount * 4;
  const weightBytes = vertexCount * 4;
  const buffer = new ArrayBuffer(BSLD_HEADER_BYTES + heightBytes + weightBytes);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  bytes[0] = BSLD_MAGIC_0;
  bytes[1] = BSLD_MAGIC_1;
  bytes[2] = BSLD_MAGIC_2;
  bytes[3] = BSLD_MAGIC_3;
  view.setUint32(4, BSLD_FORMAT, true);
  view.setUint16(8, subdivisions, true);
  view.setUint16(10, 0, true);
  view.setUint32(12, 0, true);

  if (LITTLE_ENDIAN) {
    const outHeights = new Float32Array(buffer, BSLD_HEADER_BYTES, vertexCount);
    for (let i = 0; i < vertexCount; i++) {
      outHeights[i] = finite(data.heights[i], 0, -10000, 10000);
    }
  } else {
    for (let i = 0; i < vertexCount; i++) {
      view.setFloat32(BSLD_HEADER_BYTES + i * 4, finite(data.heights[i], 0, -10000, 10000), true);
    }
  }
  const outWeights = new Uint8Array(buffer, BSLD_HEADER_BYTES + heightBytes, weightBytes);
  for (let i = 0; i < vertexCount; i++) {
    const at = i * 4;
    const w0 = data.weights[at]!, w1 = data.weights[at + 1]!, w2 = data.weights[at + 2]!, w3 = data.weights[at + 3]!;
    if (w0 + w1 + w2 + w3 === 255) {
      outWeights[at] = w0;
      outWeights[at + 1] = w1;
      outWeights[at + 2] = w2;
      outWeights[at + 3] = w3;
    } else {
      quantizeVertexWeights(w0, w1, w2, w3, outWeights, at);
    }
  }
  return bytes;
}

/**
 * Decode a `BSLD` binary chunk into typed `Float32Array` heights and `Uint8Array` RGBA8 paint weights; null when the
 * bytes are not a well-formed chunk (truncated, wrong magic, format, subdivisions or length). Never throws, so one
 * damaged chunk cannot stop a Scene from opening, saving or playing.
 */
export function decodeLandscapeChunk(bytes: Uint8Array): DecodedField | null {
  if (bytes.byteLength < BSLD_HEADER_BYTES) return null;
  if (
    bytes[0] !== BSLD_MAGIC_0 ||
    bytes[1] !== BSLD_MAGIC_1 ||
    bytes[2] !== BSLD_MAGIC_2 ||
    bytes[3] !== BSLD_MAGIC_3
  ) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) !== BSLD_FORMAT) return null;
  const subdivisions = view.getUint16(8, true);
  if (subdivisions < 4 || subdivisions > 256) return null;
  const vertexCount = (subdivisions + 1) ** 2;
  const heightBytes = vertexCount * 4;
  if (bytes.byteLength !== BSLD_HEADER_BYTES + heightBytes + vertexCount * 4) return null;
  const heights = new Float32Array(vertexCount);
  if (LITTLE_ENDIAN && (bytes.byteOffset + BSLD_HEADER_BYTES) % 4 === 0) {
    const src = new Float32Array(bytes.buffer, bytes.byteOffset + BSLD_HEADER_BYTES, vertexCount);
    for (let i = 0; i < vertexCount; i++) heights[i] = finite(src[i], 0, -10000, 10000);
  } else {
    for (let i = 0; i < vertexCount; i++) {
      heights[i] = finite(view.getFloat32(BSLD_HEADER_BYTES + i * 4, true), 0, -10000, 10000);
    }
  }
  const weights = new Uint8Array(vertexCount * 4);
  const weightOffset = BSLD_HEADER_BYTES + heightBytes;
  for (let i = 0; i < vertexCount; i++) {
    const at = i * 4;
    const w0 = bytes[weightOffset + at]!;
    const w1 = bytes[weightOffset + at + 1]!;
    const w2 = bytes[weightOffset + at + 2]!;
    const w3 = bytes[weightOffset + at + 3]!;
    if (w0 + w1 + w2 + w3 === 255) {
      weights[at] = w0;
      weights[at + 1] = w1;
      weights[at + 2] = w2;
      weights[at + 3] = w3;
    } else {
      quantizeVertexWeights(w0, w1, w2, w3, weights, at);
    }
  }
  return { subdivisions, heights, weights };
}

function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length))));
  }
  return btoa(parts.join(""));
}

function base64ToBytes(encoded: string): Uint8Array<ArrayBuffer> | null {
  let binary: string;
  try {
    binary = atob(encoded);
  } catch {
    return null;
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Encode landscape field data as a compact base64 `BSLD` string for JSON-only editor undo/journal snapshots. */
export function encodeLandscapeBase64(
  data: Pick<LandscapeProperties, "subdivisions" | "heights" | "weights">,
): string {
  return bytesToBase64(encodeLandscapeChunk(data));
}

/** Decode a base64 `BSLD` string into raw binary `BSLD` bytes; null when it is not base64. */
export function decodeLandscapeBase64ToBytes(encoded: string): Uint8Array<ArrayBuffer> | null {
  return base64ToBytes(encoded);
}

function cachedDecodeBytes(bytes: Uint8Array): DecodedField | null {
  if (decodedByBytes.has(bytes)) return decodedByBytes.get(bytes)!;
  const decoded = decodeLandscapeChunk(bytes);
  decodedByBytes.set(bytes, decoded);
  return decoded;
}

function cachedDecodeBase64(encoded: string): DecodedField | null {
  if (decodedByBase64.has(encoded)) {
    const hit = decodedByBase64.get(encoded)!;
    decodedByBase64.delete(encoded);
    decodedByBase64.set(encoded, hit);
    return hit;
  }
  const bytes = base64ToBytes(encoded);
  const decoded = bytes ? decodeLandscapeChunk(bytes) : null;
  if (decodedByBase64.size >= MAX_BASE64_CACHE) {
    const oldest = decodedByBase64.keys().next().value;
    if (oldest !== undefined) decodedByBase64.delete(oldest);
  }
  decodedByBase64.set(encoded, decoded);
  return decoded;
}

/**
 * A `LandscapeComponent`'s heightfield from the field data it names: raw binary `BSLD` bytes (Play/Player, matched to
 * the component's `chunkId`), already-parsed typed arrays, or base64 `data` (Editor JSON, LRU-cached). A component
 * naming no field data is the flat default terrain. Null when the field data it names cannot be read: bytes or base64
 * that are not a well-formed chunk, a chunk for other subdivisions, or a `chunkId` whose bytes were not supplied.
 */
export function decodeLandscapeField(
  value: unknown,
  binaryBytes?: Uint8Array | null,
): LandscapeProperties | null {
  const p = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const subdivisions = Math.round(finite(p.subdivisions, 64, 4, 256));
  const width = finite(p.width, 64, 1, 4096);
  const depth = finite(p.depth, 64, 1, 4096);
  const materialGuid = typeof p.materialGuid === "string" && p.materialGuid ? p.materialGuid : null;
  const collisionsEnabled = p.collisionsEnabled === true;
  const count = (subdivisions + 1) ** 2;
  const field = (heights: Float32Array, weights: Uint8Array): LandscapeProperties =>
    ({ width, depth, subdivisions, heights, weights, materialGuid, collisionsEnabled });

  if (binaryBytes && binaryBytes.byteLength > 0) {
    const decoded = cachedDecodeBytes(binaryBytes);
    return decoded?.subdivisions === subdivisions ? field(decoded.heights, decoded.weights) : null;
  }

  const rawWeights = p.weights;
  const ownWeights = rawWeights instanceof Uint8Array && rawWeights.length === count * 4 ? rawWeights : null;
  if (p.heights instanceof Float32Array && p.heights.length === count) {
    return field(p.heights, ownWeights ?? defaultWeights(count));
  }
  if (typeof p.data === "string" && p.data.length > 0) {
    const decoded = cachedDecodeBase64(p.data);
    return decoded?.subdivisions === subdivisions ? field(decoded.heights, decoded.weights) : null;
  }
  if (typeof p.chunkId === "string" && isLandscapeChunkId(p.chunkId)) return null;
  return field(new Float32Array(count), ownWeights ?? defaultWeights(count));
}

/**
 * `decodeLandscapeField`, with flat terrain in place of field data that cannot be read. Callers that must tell the
 * user about unreadable terrain use `decodeLandscapeField` (Editor open, runtime hydration).
 */
export function parseLandscapeProperties(
  value: unknown,
  binaryBytes?: Uint8Array | null,
): LandscapeProperties {
  const decoded = decodeLandscapeField(value, binaryBytes);
  if (decoded) return decoded;
  const p = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return decodeLandscapeField({
    width: p.width, depth: p.depth, subdivisions: p.subdivisions, materialGuid: p.materialGuid,
    collisionsEnabled: p.collisionsEnabled,
  })!;
}

/** Convert in-memory `LandscapeProperties` into pure JSON `SerializedLandscapeProperties`. */
export function serializeLandscapeProperties(
  data: LandscapeProperties,
): SerializedLandscapeProperties {
  const flat = isFlatDefaultLandscape(data);
  return {
    width: finite(data.width, 64, 1, 4096),
    depth: finite(data.depth, 64, 1, 4096),
    subdivisions: Math.round(finite(data.subdivisions, 64, 4, 256)),
    data: flat ? null : encodeLandscapeBase64(data),
    materialGuid: data.materialGuid || null,
    collisionsEnabled: data.collisionsEnabled === true,
  };
}

/**
 * Normalize `LandscapeComponent` JSON metadata in O(1) without decoding or copying the binary field payload.
 * If passed in-memory typed-array `LandscapeProperties`, encodes it into pure JSON automatically.
 */
export function normalizeSerializedLandscapeProperties(
  value: unknown,
): SerializedLandscapeProperties {
  const p = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  if (p.heights instanceof Float32Array) {
    return serializeLandscapeProperties(parseLandscapeProperties(p));
  }
  const data = typeof p.data === "string" && p.data.length > 0 ? p.data : null;
  const chunkId = typeof p.chunkId === "string" && isLandscapeChunkId(p.chunkId) ? p.chunkId : null;
  return {
    width: finite(p.width, 64, 1, 4096),
    depth: finite(p.depth, 64, 1, 4096),
    subdivisions: Math.round(finite(p.subdivisions, 64, 4, 256)),
    ...(data ? { data } : chunkId ? { chunkId } : { data: null }),
    materialGuid: typeof p.materialGuid === "string" && p.materialGuid ? p.materialGuid : null,
    collisionsEnabled: p.collisionsEnabled === true,
  };
}

/** Native heightfield descriptor shared by runtime physics and editor Drop queries (zero triangle expansion). */
export function landscapeHeightField(
  value: unknown,
  binaryBytes?: Uint8Array | null,
): LandscapeHeightField | null {
  if (!value || typeof value !== "object" || (value as Record<string, unknown>).collisionsEnabled !== true) {
    return null;
  }
  const data = parseLandscapeProperties(value, binaryBytes);
  const side = data.subdivisions + 1;
  return {
    kind: "heightfield",
    numXSamples: side,
    numZSamples: side,
    width: data.width,
    depth: data.depth,
    heights: data.heights,
  };
}

/** Inclusive vertex index bounds (`ix`, `iz`) of the samples a stroke changed. */
export interface LandscapeRegion {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

/** The vertices a dab changes, computed from the untouched heightfield. */
interface SculptPatch {
  indices: number[];
  heights: number[];
  weights: number[];
  region: LandscapeRegion;
}

/** `null` for a dab that cannot apply (non-finite or non-positive brush). */
function sculptPatch(
  terrain: LandscapeProperties,
  floatWeights: Float32Array | null,
  x: number,
  z: number,
  brush: LandscapeBrush,
): SculptPatch | null {
  if (![x, z, brush.radius, brush.strength].every(Number.isFinite) || brush.radius <= 0 || brush.strength <= 0) {
    return null;
  }
  const { width, depth, subdivisions, heights } = terrain;
  const side = subdivisions + 1;
  const stepX = width / subdivisions;
  const stepZ = depth / subdivisions;
  const minX = Math.max(0, Math.ceil((x - brush.radius + width / 2) / stepX));
  const maxX = Math.min(side - 1, Math.floor((x + brush.radius + width / 2) / stepX));
  const minZ = Math.max(0, Math.ceil((z - brush.radius + depth / 2) / stepZ));
  const maxZ = Math.min(side - 1, Math.floor((z + brush.radius + depth / 2) / stepZ));
  const falloff = finite(brush.falloff, 0.5, 0.001, 1);
  const patch: SculptPatch = { indices: [], heights: [], weights: [], region: { x0: minX, z0: minZ, x1: maxX, z1: maxZ } };
  for (let iz = minZ; iz <= maxZ; iz++) {
    for (let ix = minX; ix <= maxX; ix++) {
      const distance = Math.hypot(ix * stepX - width / 2 - x, iz * stepZ - depth / 2 - z);
      if (distance >= brush.radius) continue;
      const t = Math.min(1, (1 - distance / brush.radius) / falloff);
      const amount = brush.strength * t * t * (3 - 2 * t);
      const index = iz * side + ix;
      const current = heights[index]!;
      patch.indices.push(index);
      if (brush.tool === "paint") {
        const layer = Math.round(finite(brush.layer, 0, 0, 3));
        const blend = Math.min(1, amount);
        const at = index * 4;
        for (let l = 0; l < 4; l++) {
          const prev = floatWeights ? floatWeights[at + l]! : terrain.weights[at + l]! / 255;
          patch.weights.push(prev * (1 - blend) + (l === layer ? blend : 0));
        }
      } else if (brush.tool === "smooth") {
        let sum = 0;
        let count = 0;
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = ix + dx;
            const nz = iz + dz;
            if (nx >= 0 && nx < side && nz >= 0 && nz < side) {
              sum += heights[nz * side + nx]!;
              count++;
            }
          }
        }
        patch.heights.push(current + (sum / count - current) * Math.min(1, amount));
      } else if (brush.tool === "flatten") {
        patch.heights.push(current + (finite(brush.height, 0, -10000, 10000) - current) * Math.min(1, amount));
      } else {
        patch.heights.push(
          Math.max(-10000, Math.min(10000, current + (brush.tool === "lower" ? -amount : amount))),
        );
      }
    }
  }
  return patch;
}

/**
 * One drag's dabs applied in place to owned `Float32Array` heights and `Uint8Array` weights.
 * `liveProperties()` exposes the working buffers directly for zero-copy viewport preview updates, and
 * `takeDirtyRegion()` names the samples changed since the last preview, so only the chunks over them re-upload.
 * Paint keeps the stroke's weights unrounded (`floatWeights`): every dab blends from them, and the RGBA8 bytes are
 * rounded from them (summing to 255), so a low-strength stroke accumulates as the float maths does instead of
 * stalling on byte rounding. `toSerializedProperties()` encodes `BSLD` once on pointer-up for Undo/Redo.
 */
export class LandscapeSculptSession {
  private readonly terrain: LandscapeProperties;
  /** The stroke's unrounded paint weights, created by its first paint dab. */
  private floatWeights: Float32Array | null = null;
  private dirtyRegion: LandscapeRegion | null = null;
  private dirty = false;

  constructor(properties: unknown) {
    const parsed = parseLandscapeProperties(properties);
    this.terrain = {
      ...parsed,
      heights: parsed.heights.slice(),
      weights: parsed.weights.slice(),
    };
  }

  /** Whether any dab mutated the terrain during this session. */
  get hasChanges(): boolean {
    return this.dirty;
  }

  /** Applies one dab at local `(x, z)` in the landscape's own units; dabs that cannot apply are ignored. */
  dab(x: number, z: number, brush: LandscapeBrush): void {
    const paint = brush.tool === "paint";
    const { heights, weights } = this.terrain;
    if (paint && !this.floatWeights) {
      const floats = new Float32Array(weights.length);
      for (let i = 0; i < weights.length; i++) floats[i] = weights[i]! / 255;
      this.floatWeights = floats;
    }
    const patch = sculptPatch(this.terrain, this.floatWeights, x, z, brush);
    if (!patch?.indices.length) return;
    this.dirty = true;
    const floats = this.floatWeights;
    for (let n = 0; n < patch.indices.length; n++) {
      const index = patch.indices[n]!;
      if (paint && floats) {
        const at = index * 4;
        for (let l = 0; l < 4; l++) floats[at + l] = patch.weights[n * 4 + l]!;
        quantizeVertexWeights(floats[at]!, floats[at + 1]!, floats[at + 2]!, floats[at + 3]!, weights, at);
      } else {
        heights[index] = patch.heights[n]!;
      }
    }
    const region = this.dirtyRegion;
    this.dirtyRegion = region
      ? {
        x0: Math.min(region.x0, patch.region.x0),
        z0: Math.min(region.z0, patch.region.z0),
        x1: Math.max(region.x1, patch.region.x1),
        z1: Math.max(region.z1, patch.region.z1),
      }
      : patch.region;
  }

  /** Live typed-array view for zero-copy viewport mesh preview updates during a drag. */
  liveProperties(): LandscapeProperties {
    return this.terrain;
  }

  /** The samples dabs changed since the last call (inclusive vertex bounds), or null when none did. */
  takeDirtyRegion(): LandscapeRegion | null {
    const region = this.dirtyRegion;
    this.dirtyRegion = null;
    return region;
  }

  /** Pure JSON serialized form encoded once at stroke commit time for Undo/Redo. */
  toSerializedProperties(): SerializedLandscapeProperties {
    return serializeLandscapeProperties(this.terrain);
  }
}

/** Resample a heightfield when its resolution changes, preserving the authored shape and paint weights. */
export function resizeLandscape(terrain: LandscapeProperties, subdivisions: number): LandscapeProperties {
  const nextSub = Math.round(finite(subdivisions, 64, 4, 256));
  const oldSide = terrain.subdivisions + 1;
  const side = nextSub + 1;
  const heights = new Float32Array(side * side);
  const weights = new Uint8Array(side * side * 4);
  for (let z = 0; z < side; z++) {
    for (let x = 0; x < side; x++) {
      const sx = (x / nextSub) * terrain.subdivisions;
      const sz = (z / nextSub) * terrain.subdivisions;
      const x0 = Math.floor(sx);
      const z0 = Math.floor(sz);
      const x1 = Math.min(x0 + 1, oldSide - 1);
      const z1 = Math.min(z0 + 1, oldSide - 1);
      const tx = sx - x0;
      const tz = sz - z0;
      const i00 = z0 * oldSide + x0;
      const i10 = z0 * oldSide + x1;
      const i01 = z1 * oldSide + x0;
      const i11 = z1 * oldSide + x1;
      const w00 = (1 - tx) * (1 - tz);
      const w10 = tx * (1 - tz);
      const w01 = (1 - tx) * tz;
      const w11 = tx * tz;
      const dst = z * side + x;
      heights[dst] =
        terrain.heights[i00]! * w00 +
        terrain.heights[i10]! * w10 +
        terrain.heights[i01]! * w01 +
        terrain.heights[i11]! * w11;
      const s0 =
        terrain.weights[i00 * 4]! * w00 +
        terrain.weights[i10 * 4]! * w10 +
        terrain.weights[i01 * 4]! * w01 +
        terrain.weights[i11 * 4]! * w11;
      const s1 =
        terrain.weights[i00 * 4 + 1]! * w00 +
        terrain.weights[i10 * 4 + 1]! * w10 +
        terrain.weights[i01 * 4 + 1]! * w01 +
        terrain.weights[i11 * 4 + 1]! * w11;
      const s2 =
        terrain.weights[i00 * 4 + 2]! * w00 +
        terrain.weights[i10 * 4 + 2]! * w10 +
        terrain.weights[i01 * 4 + 2]! * w01 +
        terrain.weights[i11 * 4 + 2]! * w11;
      const s3 =
        terrain.weights[i00 * 4 + 3]! * w00 +
        terrain.weights[i10 * 4 + 3]! * w10 +
        terrain.weights[i01 * 4 + 3]! * w01 +
        terrain.weights[i11 * 4 + 3]! * w11;
      quantizeVertexWeights(s0, s1, s2, s3, weights, dst * 4);
    }
  }
  return {
    ...terrain,
    subdivisions: nextSub,
    heights,
    weights,
  };
}
