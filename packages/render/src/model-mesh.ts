import { Mesh, Scene, VertexData } from "@babylonjs/core";

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;

function readU32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

function pad4(length: number): number {
  return (4 - (length % 4)) % 4;
}

function splitGlb(bytes: Uint8Array): {
  json: Record<string, unknown>;
  bin: Uint8Array | null;
} | null {
  if (bytes.byteLength < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (readU32(view, 0) !== GLB_MAGIC) return null;
  if (readU32(view, 4) !== 2) return null;
  let offset = 12;
  let json: Record<string, unknown> | null = null;
  let bin: Uint8Array | null = null;
  while (offset + 8 <= bytes.byteLength) {
    const chunkLength = readU32(view, offset);
    const chunkType = readU32(view, offset + 4);
    offset += 8;
    if (offset + chunkLength > bytes.byteLength) break;
    const chunk = bytes.subarray(offset, offset + chunkLength);
    offset += chunkLength + pad4(chunkLength);
    if (chunkType === CHUNK_JSON) {
      try {
        json = JSON.parse(new TextDecoder().decode(chunk)) as Record<
          string,
          unknown
        >;
      } catch {
        return null;
      }
    } else if (chunkType === CHUNK_BIN) {
      bin = chunk;
    }
  }
  return json ? { json, bin } : null;
}

/** Named glTF animation clips in a GLB, if the file is readable. */
export function glbClipNames(bytes: Uint8Array): string[] {
  const glb = splitGlb(bytes);
  if (!glb) return [];
  const animations = Array.isArray(glb.json.animations) ? glb.json.animations : [];
  return animations.map((row, index) => {
    const name = (row as { name?: unknown }).name;
    return typeof name === "string" && name.length > 0 ? name : `animation${index}`;
  });
}

function accessorFloats(
  json: Record<string, unknown>,
  bin: Uint8Array,
  accessorIndex: number,
): Float32Array | null {
  const accessors = Array.isArray(json.accessors) ? json.accessors : [];
  const bufferViews = Array.isArray(json.bufferViews) ? json.bufferViews : [];
  const accessor = accessors[accessorIndex] as Record<string, unknown> | undefined;
  if (!accessor) return null;
  const componentType = Number(accessor.componentType);
  const count = Number(accessor.count);
  const type = accessor.type;
  if (componentType !== FLOAT || type !== "VEC3" || !Number.isFinite(count)) {
    return null;
  }
  const viewIndex = Number(accessor.bufferView);
  const view = bufferViews[viewIndex] as Record<string, unknown> | undefined;
  if (!view) return null;
  const byteOffset =
    Number(view.byteOffset ?? 0) + Number(accessor.byteOffset ?? 0);
  const byteLength = count * 12;
  if (byteOffset + byteLength > bin.byteLength) return null;
  const copy = new Float32Array(count * 3);
  const data = new DataView(bin.buffer, bin.byteOffset + byteOffset, byteLength);
  for (let i = 0; i < copy.length; i++) {
    copy[i] = data.getFloat32(i * 4, true);
  }
  return copy;
}

function accessorIndices(
  json: Record<string, unknown>,
  bin: Uint8Array,
  accessorIndex: number,
): number[] | null {
  const accessors = Array.isArray(json.accessors) ? json.accessors : [];
  const bufferViews = Array.isArray(json.bufferViews) ? json.bufferViews : [];
  const accessor = accessors[accessorIndex] as Record<string, unknown> | undefined;
  if (!accessor) return null;
  const componentType = Number(accessor.componentType);
  const count = Number(accessor.count);
  const viewIndex = Number(accessor.bufferView);
  const view = bufferViews[viewIndex] as Record<string, unknown> | undefined;
  if (!view || !Number.isFinite(count)) return null;
  const byteOffset =
    Number(view.byteOffset ?? 0) + Number(accessor.byteOffset ?? 0);
  const stride = componentType === UNSIGNED_INT ? 4 : 2;
  if (byteOffset + count * stride > bin.byteLength) return null;
  const viewBuf = new DataView(bin.buffer, bin.byteOffset + byteOffset);
  const indices: number[] = [];
  for (let i = 0; i < count; i++) {
    indices.push(
      componentType === UNSIGNED_INT
        ? viewBuf.getUint32(i * 4, true)
        : componentType === UNSIGNED_SHORT
          ? viewBuf.getUint16(i * 2, true)
          : viewBuf.getUint8(i),
    );
  }
  return indices;
}

/** Build a Babylon mesh from the first GLB primitive, or null when unreadable. */
export function createMeshFromModelBytes(
  scene: Scene,
  name: string,
  bytes: Uint8Array,
): Mesh | null {
  const glb = splitGlb(bytes);
  if (!glb?.bin) return null;
  const meshes = Array.isArray(glb.json.meshes) ? glb.json.meshes : [];
  const meshJson = meshes[0] as Record<string, unknown> | undefined;
  const primitives = Array.isArray(meshJson?.primitives)
    ? meshJson.primitives
    : [];
  const primitive = primitives[0] as Record<string, unknown> | undefined;
  const attributes = (primitive?.attributes ?? {}) as Record<string, unknown>;
  if (typeof attributes.POSITION !== "number") return null;
  const positions = accessorFloats(glb.json, glb.bin, attributes.POSITION);
  if (!positions || positions.length < 9) return null;
  const vertexData = new VertexData();
  vertexData.positions = Array.from(positions);
  if (typeof primitive?.indices === "number") {
    const indices = accessorIndices(glb.json, glb.bin, primitive.indices);
    if (indices) vertexData.indices = indices;
  } else {
    const count = positions.length / 3;
    vertexData.indices = Array.from({ length: count }, (_, i) => i);
  }
  const mesh = new Mesh(name, scene);
  vertexData.applyToMesh(mesh, true);
  return mesh;
}

/** True when bytes are a GLB or glTF JSON document. OBJ/STL return false. */
export function isGltfModelBytes(
  bytes: Uint8Array | null | undefined,
): boolean {
  if (!bytes || bytes.byteLength < 4) return false;
  if (splitGlb(bytes)) return true;
  try {
    const json = JSON.parse(new TextDecoder().decode(bytes)) as {
      asset?: unknown;
    };
    return Boolean(json && typeof json === "object" && json.asset);
  } catch {
    return false;
  }
}

export function gltfLoaderExtension(bytes: Uint8Array): ".glb" | ".gltf" {
  return splitGlb(bytes) ? ".glb" : ".gltf";
}

function encodeGlb(json: unknown, bin: Uint8Array): Uint8Array {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = pad4(jsonBytes.length);
  const jsonChunkLen = jsonBytes.length + jsonPad;
  const binPad = pad4(bin.byteLength);
  const binChunkLen = bin.byteLength + binPad;
  const total = 12 + 8 + jsonChunkLen + 8 + binChunkLen;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonChunkLen, true);
  view.setUint32(16, CHUNK_JSON, true);
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonChunkLen);
  const binHeader = 20 + jsonChunkLen;
  view.setUint32(binHeader, binChunkLen, true);
  view.setUint32(binHeader + 4, CHUNK_BIN, true);
  out.set(bin, binHeader + 8);
  return out;
}

/** Minimal one-triangle GLB for NullEngine tests (3 vertices, no indices). */
export function encodeTriangleGlb(): Uint8Array {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  return encodeGlb(
    {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [
        {
          bufferView: 0,
          componentType: FLOAT,
          count: 3,
          type: "VEC3",
          min: [0, 0, 0],
          max: [1, 1, 0],
        },
      ],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
      buffers: [{ byteLength: 36 }],
    },
    new Uint8Array(positions.buffer),
  );
}

/** Triangle GLB with a named translation clip for AnimationGroup tests. */
export function encodeAnimatedTriangleGlb(clipName = "Idle"): Uint8Array {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const times = new Float32Array([0, 1]);
  const translations = new Float32Array([0, 0, 0, 0, 1, 0]);
  const bin = new Uint8Array(68);
  bin.set(new Uint8Array(positions.buffer), 0);
  bin.set(new Uint8Array(times.buffer), 36);
  bin.set(new Uint8Array(translations.buffer), 44);
  return encodeGlb(
    {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [
        {
          bufferView: 0,
          componentType: FLOAT,
          count: 3,
          type: "VEC3",
          min: [0, 0, 0],
          max: [1, 1, 0],
        },
        {
          bufferView: 1,
          componentType: FLOAT,
          count: 2,
          type: "SCALAR",
          min: [0],
          max: [1],
        },
        {
          bufferView: 2,
          componentType: FLOAT,
          count: 2,
          type: "VEC3",
        },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 36 },
        { buffer: 0, byteOffset: 36, byteLength: 8 },
        { buffer: 0, byteOffset: 44, byteLength: 24 },
      ],
      buffers: [{ byteLength: 68 }],
      animations: [
        {
          name: clipName,
          channels: [{ sampler: 0, target: { node: 0, path: "translation" } }],
          samplers: [{ input: 1, output: 2, interpolation: "LINEAR" }],
        },
      ],
    },
    bin,
  );
}

/** Parent transform + child triangle so adopt cannot promote a lone mesh. */
export function encodeParentedAnimatedTriangleGlb(clipName = "Idle"): Uint8Array {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const times = new Float32Array([0, 1]);
  const translations = new Float32Array([0, 0, 0, 0, 1, 0]);
  const bin = new Uint8Array(68);
  bin.set(new Uint8Array(positions.buffer), 0);
  bin.set(new Uint8Array(times.buffer), 36);
  bin.set(new Uint8Array(translations.buffer), 44);
  return encodeGlb(
    {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ children: [1] }, { mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [
        {
          bufferView: 0,
          componentType: FLOAT,
          count: 3,
          type: "VEC3",
          min: [0, 0, 0],
          max: [1, 1, 0],
        },
        {
          bufferView: 1,
          componentType: FLOAT,
          count: 2,
          type: "SCALAR",
          min: [0],
          max: [1],
        },
        {
          bufferView: 2,
          componentType: FLOAT,
          count: 2,
          type: "VEC3",
        },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 36 },
        { buffer: 0, byteOffset: 36, byteLength: 8 },
        { buffer: 0, byteOffset: 44, byteLength: 24 },
      ],
      buffers: [{ byteLength: 68 }],
      animations: [
        {
          name: clipName,
          channels: [{ sampler: 0, target: { node: 1, path: "translation" } }],
          samplers: [{ input: 1, output: 2, interpolation: "LINEAR" }],
        },
      ],
    },
    bin,
  );
}
