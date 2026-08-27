import { encodeGlbJsonBin, splitGlbJsonBin } from "./importers/glb-parse";
import type { HullVec3 } from "./convex-hull";

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

function multiplyMat(a: Mat4, b: Mat4): Mat4 {
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

function transformPoint(m: Mat4, p: HullVec3): HullVec3 {
  return {
    x: m[0]! * p.x + m[4]! * p.y + m[8]! * p.z + m[12]!,
    y: m[1]! * p.x + m[5]! * p.y + m[9]! * p.z + m[13]!,
    z: m[2]! * p.x + m[6]! * p.y + m[10]! * p.z + m[14]!,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nodeMatrix(node: Record<string, unknown>): Mat4 {
  if (Array.isArray(node.matrix) && node.matrix.length >= 16) {
    const m = new Float64Array(16);
    for (let i = 0; i < 16; i++) m[i] = Number(node.matrix[i]) || 0;
    return m;
  }
  const t = Array.isArray(node.translation) ? node.translation : [0, 0, 0];
  const r = Array.isArray(node.rotation) ? node.rotation : [0, 0, 0, 1];
  const s = Array.isArray(node.scale) ? node.scale : [1, 1, 1];
  return multiplyMat(
    translationMat(Number(t[0]) || 0, Number(t[1]) || 0, Number(t[2]) || 0),
    multiplyMat(
      quatMat(
        Number(r[0]) || 0,
        Number(r[1]) || 0,
        Number(r[2]) || 0,
        typeof r[3] === "number" ? r[3] : 1,
      ),
      scaleMat(Number(s[0]) || 1, Number(s[1]) || 1, Number(s[2]) || 1),
    ),
  );
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
      return 4;
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

function accessorValues(
  json: Record<string, unknown>,
  bin: Uint8Array,
  accessorIndex: number,
  components: number,
): number[] {
  const accessors = Array.isArray(json.accessors) ? json.accessors : [];
  const bufferViews = Array.isArray(json.bufferViews) ? json.bufferViews : [];
  const accessor = asRecord(accessors[accessorIndex]);
  const count = typeof accessor.count === "number" ? accessor.count : 0;
  const componentType =
    typeof accessor.componentType === "number" ? accessor.componentType : FLOAT;
  const viewIndex =
    typeof accessor.bufferView === "number" ? accessor.bufferView : -1;
  const view = asRecord(bufferViews[viewIndex]);
  const viewOffset = Number(view.byteOffset ?? 0);
  const accessorOffset = Number(accessor.byteOffset ?? 0);
  const stride =
    typeof view.byteStride === "number" && view.byteStride > 0
      ? view.byteStride
      : componentBytes(componentType) * components;
  const start = viewOffset + accessorOffset;
  const data = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const offset = start + i * stride;
    for (let c = 0; c < components; c++) {
      out.push(
        readComponent(data, offset + c * componentBytes(componentType), componentType),
      );
    }
  }
  return out;
}

function primitivePositions(
  json: Record<string, unknown>,
  bin: Uint8Array,
  primitive: Record<string, unknown>,
  world: Mat4,
  scale: number,
): { vertices: HullVec3[]; indices: number[] } {
  const attributes = asRecord(primitive.attributes);
  const positionIndex =
    typeof attributes.POSITION === "number" ? attributes.POSITION : -1;
  if (positionIndex < 0) return { vertices: [], indices: [] };
  const raw = accessorValues(json, bin, positionIndex, 3);
  const vertices: HullVec3[] = [];
  for (let i = 0; i + 2 < raw.length; i += 3) {
    const local = { x: raw[i]!, y: raw[i + 1]!, z: raw[i + 2]! };
    const worldPoint = transformPoint(world, local);
    vertices.push({
      x: worldPoint.x * scale,
      y: worldPoint.y * scale,
      z: worldPoint.z * scale,
    });
  }
  const indices: number[] = [];
  if (typeof primitive.indices === "number") {
    const values = accessorValues(json, bin, primitive.indices, 1);
    for (const value of values) indices.push(value);
  } else {
    for (let i = 0; i < vertices.length; i++) indices.push(i);
  }
  return { vertices, indices };
}

function collectFromNode(
  json: Record<string, unknown>,
  bin: Uint8Array,
  nodeIndex: number,
  parent: Mat4,
  scale: number,
  vertices: HullVec3[],
  indices: number[],
  seen: Set<number>,
): void {
  if (seen.has(nodeIndex)) return;
  seen.add(nodeIndex);
  const nodes = Array.isArray(json.nodes) ? json.nodes : [];
  const meshes = Array.isArray(json.meshes) ? json.meshes : [];
  const node = asRecord(nodes[nodeIndex]);
  const world = multiplyMat(parent, nodeMatrix(node));
  if (typeof node.mesh === "number") {
    const mesh = asRecord(meshes[node.mesh]);
    const primitives = Array.isArray(mesh.primitives) ? mesh.primitives : [];
    for (const primitive of primitives) {
      const extracted = primitivePositions(
        json,
        bin,
        asRecord(primitive),
        world,
        scale,
      );
      const base = vertices.length;
      vertices.push(...extracted.vertices);
      for (const index of extracted.indices) indices.push(base + index);
    }
  }
  const children = Array.isArray(node.children) ? node.children : [];
  for (const child of children) {
    if (typeof child === "number") {
      collectFromNode(json, bin, child, world, scale, vertices, indices, seen);
    }
  }
}

function parseGltfJsonBin(
  bytes: Uint8Array,
): { json: Record<string, unknown>; bin: Uint8Array } | null {
  const split = splitGlbJsonBin(bytes);
  if (split) return split;
  try {
    const json = JSON.parse(new TextDecoder().decode(bytes)) as Record<
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
  return extractGltfCollisionMesh(bytes, importScale)?.vertices ?? [];
}

export function extractGltfCollisionMesh(
  bytes: Uint8Array,
  importScale = 1,
): { vertices: HullVec3[]; indices: number[] } | null {
  const parsed = parseGltfJsonBin(bytes);
  if (!parsed) return null;
  const { json, bin } = parsed;
  const scale =
    typeof importScale === "number" && Number.isFinite(importScale) && importScale > 0
      ? importScale
      : 1;
  const vertices: HullVec3[] = [];
  const indices: number[] = [];
  const seen = new Set<number>();
  const scenes = Array.isArray(json.scenes) ? json.scenes : [];
  const sceneIndex = typeof json.scene === "number" ? json.scene : 0;
  const scene = asRecord(scenes[sceneIndex] ?? scenes[0]);
  const roots = Array.isArray(scene.nodes) ? scene.nodes : [];
  if (roots.length > 0) {
    for (const root of roots) {
      if (typeof root === "number") {
        collectFromNode(json, bin, root, identityMat(), scale, vertices, indices, seen);
      }
    }
  } else {
    const nodes = Array.isArray(json.nodes) ? json.nodes : [];
    for (let i = 0; i < nodes.length; i++) {
      collectFromNode(json, bin, i, identityMat(), scale, vertices, indices, seen);
    }
  }
  if (vertices.length === 0) return null;
  return { vertices, indices };
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
    asset: { version: "2.0", generator: "babylonslate-test" },
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
