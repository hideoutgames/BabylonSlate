import { encodeGlbJsonBin, splitGlbJsonBin } from "./importers/glb-parse";
import type { CollisionTriangleMesh } from "@haptic/core";
import type { HullVec3 } from "./convex-hull";
import {
  formatImportCount,
  GLTF_MAX_NODE_DEPTH,
  GLTF_MAX_PRIMITIVE_INDICES,
  GLTF_MAX_PRIMITIVE_VERTICES,
  ImportLimitError,
  importLimitError,
} from "./import-limits";

const textDecoder = new TextDecoder();

const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
const BYTE = 5120;
const UNSIGNED_BYTE = 5121;
const SHORT = 5122;

type Mat4 = Float64Array;

function identityMat(): Mat4 {
  return new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

/** Column-major 4×4 product `a × b`, as glTF composes a node under its parent. */
export function multiplyMat(a: Mat4, b: Mat4): Mat4 {
  const out = new Float64Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        a[row]! * b[col * 4]! +
        a[4 + row]! * b[col * 4 + 1]! +
        a[8 + row]! * b[col * 4 + 2]! +
        a[12 + row]! * b[col * 4 + 3]!;
    }
  }
  return out;
}

function translationMat(x: number, y: number, z: number): Mat4 {
  const m = identityMat();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

function scaleMat(x: number, y: number, z: number): Mat4 {
  const m = identityMat();
  m[0] = x;
  m[5] = y;
  m[10] = z;
  return m;
}

function quatMat(x: number, y: number, z: number, w: number): Mat4 {
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;
  const m = identityMat();
  m[0] = 1 - 2 * (yy + zz);
  m[1] = 2 * (xy + wz);
  m[2] = 2 * (xz - wy);
  m[4] = 2 * (xy - wz);
  m[5] = 1 - 2 * (xx + zz);
  m[6] = 2 * (yz + wx);
  m[8] = 2 * (xz + wy);
  m[9] = 2 * (yz - wx);
  m[10] = 1 - 2 * (xx + yy);
  return m;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function nodeMatrix(node: Record<string, unknown>): Mat4 {
  if (Array.isArray(node.matrix) && node.matrix.length >= 16) {
    const m = new Float64Array(16);
    for (let i = 0; i < 16; i++) m[i] = Number(node.matrix[i]) || 0;
    return m;
  }
  const t = Array.isArray(node.translation) ? node.translation : [0, 0, 0];
  const r = Array.isArray(node.rotation) ? node.rotation : [0, 0, 0, 1];
  const s = Array.isArray(node.scale) ? node.scale : [1, 1, 1];
  // A scale of 0 is authored (it hides a node), not a missing value.
  const scale = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 1;
  return multiplyMat(
    translationMat(Number(t[0]) || 0, Number(t[1]) || 0, Number(t[2]) || 0),
    multiplyMat(
      quatMat(
        Number(r[0]) || 0,
        Number(r[1]) || 0,
        Number(r[2]) || 0,
        typeof r[3] === "number" ? r[3] : 1,
      ),
      scaleMat(scale(s[0]), scale(s[1]), scale(s[2])),
    ),
  );
}

/** A node scaled to nothing on every axis draws nothing, and neither do its children. */
function isCollapsedNode(node: Record<string, unknown>): boolean {
  return Array.isArray(node.scale) && node.scale.length >= 3 &&
    node.scale.slice(0, 3).every((value) => value === 0);
}

function componentBytes(componentType: number): number {
  switch (componentType) {
    case BYTE:
    case UNSIGNED_BYTE:
      return 1;
    case SHORT:
    case UNSIGNED_SHORT:
      return 2;
    case UNSIGNED_INT:
    case FLOAT:
      return 4;
    default:
      return 0;
  }
}

function readComponent(
  view: DataView,
  offset: number,
  componentType: number,
): number {
  switch (componentType) {
    case BYTE:
      return view.getInt8(offset);
    case UNSIGNED_BYTE:
      return view.getUint8(offset);
    case SHORT:
      return view.getInt16(offset, true);
    case UNSIGNED_SHORT:
      return view.getUint16(offset, true);
    case UNSIGNED_INT:
      return view.getUint32(offset, true);
    case FLOAT:
    default:
      return view.getFloat32(offset, true);
  }
}

/** A `normalized` accessor's integer component as glTF reads it; signed types clamp at -1. */
function normalizeComponent(value: number, componentType: number): number {
  switch (componentType) {
    case BYTE: return Math.max(value / 127, -1);
    case UNSIGNED_BYTE: return value / 255;
    case SHORT: return Math.max(value / 32767, -1);
    case UNSIGNED_SHORT: return value / 65535;
    default: return value;
  }
}

/** Geometry that cannot be read: compressed with a codec the reader does not decode, or malformed. */
export class GltfGeometryUnreadableError extends Error {
  override readonly name = "GltfGeometryUnreadableError";
}

const DRACO = "KHR_draco_mesh_compression";
const MESHOPT = "EXT_meshopt_compression";
const DRACO_UNREADABLE =
  "its geometry is Draco-compressed (KHR_draco_mesh_compression), which collision cooking cannot decode; export the model without mesh compression and import it again";
const MESHOPT_UNREADABLE =
  "its geometry is meshopt-compressed (EXT_meshopt_compression), which collision cooking cannot decode; export the model without mesh compression and import it again";
const MALFORMED_GEOMETRY = "its geometry is malformed: an accessor reads outside its buffer";

/** Malformed geometry, saying what is wrong. */
function malformed(detail: string): GltfGeometryUnreadableError {
  return new GltfGeometryUnreadableError(`its geometry is malformed: ${detail}`);
}

/** A non-negative safe integer from an optional glTF field, or `fallback` when absent; anything else is malformed. */
function gltfIndexField(value: unknown, fallback: number, describe: () => string): number {
  if (value === undefined) return fallback;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  throw malformed(`${describe()} must be a whole number of at least 0, not ${String(value)}`);
}

/**
 * `count` elements of `components` values from a buffer view, tightly packed or (`strided`) `byteStride` apart.
 * Everything that sizes the loop is checked first: offsets are whole and non-negative, a stride is whole and at
 * least one element long, and the last element ends inside the view and the view inside the BIN. So a malformed
 * file fails at once instead of reading past its data or looping over a count its bytes do not hold.
 */
function readElements(
  json: Record<string, unknown>,
  bin: Uint8Array,
  viewIndex: number,
  byteOffset: unknown,
  count: number,
  components: number,
  componentType: number,
  strided: boolean,
): number[] {
  const bufferViews = Array.isArray(json.bufferViews) ? json.bufferViews : [];
  const view = bufferViews[viewIndex];
  const size = componentBytes(componentType);
  if (!view || typeof view !== "object" || size === 0) throw new GltfGeometryUnreadableError(MALFORMED_GEOMETRY);
  const record = view as Record<string, unknown>;
  // Only buffer 0, the GLB's binary chunk, holds data. A meshopt view names its fallback buffer, which holds none.
  if ((record.buffer ?? 0) !== 0) {
    throw new GltfGeometryUnreadableError(asRecord(record.extensions)[MESHOPT] ? MESHOPT_UNREADABLE : MALFORMED_GEOMETRY);
  }
  const viewLabel = `glTF buffer view ${viewIndex}`;
  const viewOffset = gltfIndexField(record.byteOffset, 0, () => `${viewLabel}'s byteOffset`);
  const viewLength = gltfIndexField(record.byteLength, 0, () => `${viewLabel}'s byteLength`);
  if (viewOffset + viewLength > bin.byteLength) {
    throw malformed(
      `${viewLabel} ends at byte ${formatImportCount(viewOffset + viewLength)}, past the end of the ${formatImportCount(bin.byteLength)}-byte binary buffer`,
    );
  }
  const offset = gltfIndexField(byteOffset, 0, () => "an accessor's byteOffset");
  const elementBytes = size * components;
  // No stride (or 0) packs elements tightly; a stride shorter than an element would overlap them.
  const declaredStride = strided ? record.byteStride : undefined;
  const stride = declaredStride === undefined || declaredStride === 0 ? elementBytes : declaredStride;
  if (typeof stride !== "number" || !Number.isSafeInteger(stride) || stride < elementBytes) {
    throw malformed(`${viewLabel}'s byteStride must be a whole number of at least ${elementBytes} bytes, not ${String(declaredStride)}`);
  }
  // Checked once, before the loop: the last element ends inside the view.
  if (count > 0 && offset + (count - 1) * stride + elementBytes > viewLength) {
    throw malformed(`an accessor reads ${formatImportCount(count)} elements, which run past the end of ${viewLabel}`);
  }
  const start = viewOffset + offset;
  const data = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const out = new Array<number>(count * components);
  for (let i = 0, at = 0; i < count; i++) {
    const element = start + i * stride;
    for (let c = 0; c < components; c++) out[at++] = readComponent(data, element + c * size, componentType);
  }
  return out;
}

/**
 * An accessor's values, `components` per element, as glTF defines them: `byteStride` honoured, sparse substitutions
 * applied, zeros without a buffer view, and `normalized` integer components mapped to [0, 1] or [-1, 1]
 * (KHR_mesh_quantization). Throws `GltfGeometryUnreadableError` for compressed or malformed data (`readElements`),
 * and `ImportLimitError` for a count or sparse count above `maxCount`, before anything is read or allocated.
 */
export function accessorValues(
  json: Record<string, unknown>,
  bin: Uint8Array,
  accessorIndex: number,
  components: number,
  maxCount: number = GLTF_MAX_PRIMITIVE_INDICES,
): number[] {
  const accessors = Array.isArray(json.accessors) ? json.accessors : [];
  const accessor = asRecord(accessors[accessorIndex]);
  const label = `glTF accessor ${accessorIndex}`;
  const count = gltfIndexField(accessor.count, 0, () => `${label}'s count`);
  const sparse = asRecord(accessor.sparse);
  const sparseCount = gltfIndexField(sparse.count, 0, () => `${label}'s sparse count`);
  // Before the zeros of a view-less accessor or any read are allocated.
  for (const [what, value] of [["element count", count], ["sparse element count", sparseCount]] as const) {
    if (value > maxCount) {
      throw importLimitError(
        `The ${what} of ${label}`,
        formatImportCount(value),
        formatImportCount(maxCount),
        "Split the mesh into smaller parts before importing.",
      );
    }
  }
  const componentType = typeof accessor.componentType === "number" ? accessor.componentType : FLOAT;
  const values = typeof accessor.bufferView === "number"
    ? readElements(json, bin, accessor.bufferView, accessor.byteOffset, count, components, componentType, true)
    : new Array<number>(count * components).fill(0);
  if (sparseCount > 0) {
    const targetsAt = asRecord(sparse.indices);
    const valuesAt = asRecord(sparse.values);
    if (typeof targetsAt.bufferView !== "number" || typeof valuesAt.bufferView !== "number") {
      throw new GltfGeometryUnreadableError(MALFORMED_GEOMETRY);
    }
    const targets = readElements(json, bin, targetsAt.bufferView, targetsAt.byteOffset, sparseCount, 1,
      typeof targetsAt.componentType === "number" ? targetsAt.componentType : UNSIGNED_INT, false);
    const replacements = readElements(json, bin, valuesAt.bufferView, valuesAt.byteOffset, sparseCount,
      components, componentType, false);
    for (let i = 0; i < sparseCount; i++) {
      const target = targets[i]!;
      if (target >= count) throw new GltfGeometryUnreadableError(MALFORMED_GEOMETRY);
      for (let c = 0; c < components; c++) values[target * components + c] = replacements[i * components + c]!;
    }
  }
  if (accessor.normalized === true) {
    for (let i = 0; i < values.length; i++) values[i] = normalizeComponent(values[i]!, componentType);
  }
  return values;
}

const TRIANGLES = 4;
const TRIANGLE_STRIP = 5;
const TRIANGLE_FAN = 6;

/** A Draco primitive's accessors have no buffer view unless the file also ships them uncompressed. */
function assertNotDracoOnly(json: Record<string, unknown>, primitive: Record<string, unknown>, accessorIndex: unknown): void {
  if (!asRecord(primitive.extensions)[DRACO] || typeof accessorIndex !== "number") return;
  const accessors = Array.isArray(json.accessors) ? json.accessors : [];
  const accessor = asRecord(accessors[accessorIndex]);
  if (typeof accessor.bufferView !== "number" && !accessor.sparse) throw new GltfGeometryUnreadableError(DRACO_UNREADABLE);
}

/** Appends one primitive's baked xyz triples and re-based triangle-list indices; points and lines add nothing. */
function appendPrimitive(
  json: Record<string, unknown>,
  bin: Uint8Array,
  primitive: Record<string, unknown>,
  world: Mat4,
  scale: number,
  positions: number[],
  indices: number[],
): void {
  const mode = typeof primitive.mode === "number" ? primitive.mode : TRIANGLES;
  if (mode !== TRIANGLES && mode !== TRIANGLE_STRIP && mode !== TRIANGLE_FAN) return;
  const attributes = asRecord(primitive.attributes);
  const positionIndex =
    typeof attributes.POSITION === "number" ? attributes.POSITION : -1;
  if (positionIndex < 0) return;
  assertNotDracoOnly(json, primitive, positionIndex);
  assertNotDracoOnly(json, primitive, primitive.indices);
  const raw = accessorValues(json, bin, positionIndex, 3, GLTF_MAX_PRIMITIVE_VERTICES);
  const base = positions.length / 3;
  let count = 0;
  for (let i = 0; i + 2 < raw.length; i += 3, count++) {
    const x = raw[i]!, y = raw[i + 1]!, z = raw[i + 2]!;
    positions.push(
      (world[0]! * x + world[4]! * y + world[8]! * z + world[12]!) * scale,
      (world[1]! * x + world[5]! * y + world[9]! * z + world[13]!) * scale,
      (world[2]! * x + world[6]! * y + world[10]! * z + world[14]!) * scale,
    );
  }
  const order = typeof primitive.indices === "number"
    ? accessorValues(json, bin, primitive.indices, 1, GLTF_MAX_PRIMITIVE_INDICES)
    : Array.from({ length: count }, (_, i) => i);
  if (mode === TRIANGLES) {
    for (let i = 0; i + 2 < order.length; i += 3) indices.push(base + order[i]!, base + order[i + 1]!, base + order[i + 2]!);
  } else if (mode === TRIANGLE_STRIP) {
    // Strip triangle i is (i, i + 1 + i % 2, i + 2 - i % 2), so every triangle keeps the strip's winding.
    for (let i = 0; i + 2 < order.length; i++) {
      indices.push(base + order[i]!, base + order[i + 1 + (i % 2)]!, base + order[i + 2 - (i % 2)]!);
    }
  } else {
    for (let i = 0; i + 2 < order.length; i++) indices.push(base + order[i + 1]!, base + order[i + 2]!, base + order[0]!);
  }
}

function collectFromNode(
  json: Record<string, unknown>,
  bin: Uint8Array,
  nodeIndex: number,
  parent: Mat4,
  scale: number,
  positions: number[],
  indices: number[],
  seen: Set<number>,
  depth: number,
): void {
  // A node reached twice (through a cycle, or from two parents) is collected once.
  if (seen.has(nodeIndex)) return;
  seen.add(nodeIndex);
  if (depth > GLTF_MAX_NODE_DEPTH) throw gltfNodeDepthError();
  const nodes = Array.isArray(json.nodes) ? json.nodes : [];
  const meshes = Array.isArray(json.meshes) ? json.meshes : [];
  const node = asRecord(nodes[nodeIndex]);
  if (isCollapsedNode(node)) return;
  const world = multiplyMat(parent, nodeMatrix(node));
  if (typeof node.mesh === "number") {
    const mesh = asRecord(meshes[node.mesh]);
    const primitives = Array.isArray(mesh.primitives) ? mesh.primitives : [];
    for (const primitive of primitives) {
      appendPrimitive(json, bin, asRecord(primitive), world, scale, positions, indices);
    }
  }
  const children = Array.isArray(node.children) ? node.children : [];
  for (const child of children) {
    if (typeof child === "number") {
      collectFromNode(json, bin, child, world, scale, positions, indices, seen, depth + 1);
    }
  }
}

/** The node hierarchy is deeper than {@link GLTF_MAX_NODE_DEPTH}. */
export function gltfNodeDepthError(): ImportLimitError {
  return new ImportLimitError(
    `The model's node hierarchy is more than ${GLTF_MAX_NODE_DEPTH} levels deep; the import limit is ${GLTF_MAX_NODE_DEPTH}. Flatten the hierarchy before importing.`,
  );
}

function parseGltfJsonBin(
  bytes: Uint8Array,
): { json: Record<string, unknown>; bin: Uint8Array } | null {
  const split = splitGlbJsonBin(bytes);
  if (split) return split;
  try {
    const json = JSON.parse(textDecoder.decode(bytes)) as Record<
      string,
      unknown
    >;
    return { json, bin: new Uint8Array(0) };
  } catch {
    return null;
  }
}

export function extractGltfPositions(
  bytes: Uint8Array,
  importScale = 1,
): HullVec3[] {
  const positions = readGltfTriangles(bytes, importScale)?.positions;
  if (!positions) return [];
  return Array.from({ length: positions.length / 3 }, (_, i) => ({
    x: positions[i * 3]!,
    y: positions[i * 3 + 1]!,
    z: positions[i * 3 + 2]!,
  }));
}

/**
 * Rest-pose triangles with node transforms and Import Scale baked, packed for transfer; `mesh` is null when the model
 * has no triangles or its geometry cannot be read, and `problem` then says why for the latter.
 */
export function readGltfCollisionMesh(
  bytes: Uint8Array,
  importScale = 1,
): { mesh: CollisionTriangleMesh | null; problem: string | null } {
  const { triangles, problem } = collectGltfTriangles(bytes, importScale);
  return { mesh: triangles ? packGltfTriangles(triangles) : null, problem };
}

/** {@link readGltfTriangles}'s result packed as {@link readGltfCollisionMesh} returns its mesh. */
export function packGltfTriangles(triangles: GltfTriangles): CollisionTriangleMesh {
  const { positions, indices } = triangles;
  const vertexCount = positions.length / 3;
  // Malformed out-of-range indices keep a Uint32 slot so collider validation still rejects them.
  const fits = vertexCount <= 0x10000 && indices.every((index) => index < 0x10000);
  return {
    positions: Float32Array.from(positions),
    indices: fits ? Uint16Array.from(indices) : Uint32Array.from(indices),
  };
}

/** `readGltfCollisionMesh` without the reason. */
export function extractGltfCollisionMesh(
  bytes: Uint8Array,
  importScale = 1,
): CollisionTriangleMesh | null {
  return readGltfCollisionMesh(bytes, importScale).mesh;
}

/** Rest-pose triangles: xyz per vertex and three indices per triangle. */
export interface GltfTriangles {
  positions: number[];
  indices: number[];
}

/**
 * A glTF or GLB file's rest-pose triangles with node transforms and Import Scale baked, or null when it has none or
 * its geometry cannot be read (compressed or malformed). Parse once and share the result when both a collider and
 * an occluder are cooked from it.
 */
export function readGltfTriangles(
  bytes: Uint8Array,
  importScale: number,
): GltfTriangles | null {
  return collectGltfTriangles(bytes, importScale).triangles;
}

/**
 * Every triangle of the default scene, or none with the reason when any of its geometry cannot be read: part of a
 * model would collide wrongly, so a compressed or malformed model yields nothing. Import limits (vertex and index
 * caps, node depth) are not caught: they fail the import by name.
 */
function collectGltfTriangles(
  bytes: Uint8Array,
  importScale: number,
): { triangles: GltfTriangles | null; problem: string | null } {
  const parsed = parseGltfJsonBin(bytes);
  if (!parsed) return { triangles: null, problem: null };
  const { json, bin } = parsed;
  const required: unknown[] = Array.isArray(json.extensionsRequired) ? json.extensionsRequired : [];
  if (required.includes(DRACO)) return { triangles: null, problem: DRACO_UNREADABLE };
  if (required.includes(MESHOPT)) return { triangles: null, problem: MESHOPT_UNREADABLE };
  try {
    return { triangles: collectSceneTriangles(json, bin, importScale), problem: null };
  } catch (error) {
    if (error instanceof GltfGeometryUnreadableError) return { triangles: null, problem: error.message };
    throw error;
  }
}

function collectSceneTriangles(
  json: Record<string, unknown>,
  bin: Uint8Array,
  importScale: number,
): { positions: number[]; indices: number[] } | null {
  const scale =
    typeof importScale === "number" && Number.isFinite(importScale) && importScale > 0
      ? importScale
      : 1;
  const positions: number[] = [];
  const indices: number[] = [];
  const seen = new Set<number>();
  const scenes = Array.isArray(json.scenes) ? json.scenes : [];
  const sceneIndex = typeof json.scene === "number" ? json.scene : 0;
  const scene = asRecord(scenes[sceneIndex] ?? scenes[0]);
  const roots = Array.isArray(scene.nodes) ? scene.nodes : [];
  if (roots.length > 0) {
    for (const root of roots) {
      if (typeof root === "number") {
        collectFromNode(json, bin, root, identityMat(), scale, positions, indices, seen, 1);
      }
    }
  } else {
    const nodes = Array.isArray(json.nodes) ? json.nodes : [];
    for (let i = 0; i < nodes.length; i++) {
      collectFromNode(json, bin, i, identityMat(), scale, positions, indices, seen, 1);
    }
  }
  return positions.length === 0 ? null : { positions, indices };
}

/** Unit cube GLB (size 1, centered) for importer / hull tests. */
export function buildBoxGlbFixture(size = 1): Uint8Array {
  const h = size / 2;
  const positions = new Float32Array([
    -h, -h, -h, h, -h, -h, h, h, -h, -h, h, -h, -h, -h, h, h, -h, h, h, h, h, -h,
    h, h,
  ]);
  const indices = new Uint16Array([
    0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 3, 2, 6, 3, 6, 7, 0, 3,
    7, 0, 7, 4, 1, 5, 6, 1, 6, 2,
  ]);
  const bin = new Uint8Array(positions.byteLength + indices.byteLength);
  bin.set(new Uint8Array(positions.buffer), 0);
  bin.set(new Uint8Array(indices.buffer), positions.byteLength);
  const json = {
    asset: { version: "2.0", generator: "haptic-test" },
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
      {
        buffer: 0,
        byteOffset: positions.byteLength,
        byteLength: indices.byteLength,
      },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: FLOAT,
        count: 8,
        type: "VEC3",
        min: [-h, -h, -h],
        max: [h, h, h],
      },
      {
        bufferView: 1,
        componentType: UNSIGNED_SHORT,
        count: indices.length,
        type: "SCALAR",
      },
    ],
    meshes: [
      {
        primitives: [{ attributes: { POSITION: 0 }, indices: 1 }],
      },
    ],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
  return encodeGlbJsonBin(json, bin);
}
