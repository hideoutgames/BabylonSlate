import { Matrix, Mesh, Quaternion, Scene, Vector3, VertexData } from "@babylonjs/core";

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

function asTuple3(
  value: unknown,
  fallback: [number, number, number],
): [number, number, number] {
  if (!Array.isArray(value) || value.length < 3) return fallback;
  const [x, y, z] = value;
  return [
    typeof x === "number" ? x : fallback[0],
    typeof y === "number" ? y : fallback[1],
    typeof z === "number" ? z : fallback[2],
  ];
}

function asTuple4(
  value: unknown,
  fallback: [number, number, number, number],
): [number, number, number, number] {
  if (!Array.isArray(value) || value.length < 4) return fallback;
  const [x, y, z, w] = value;
  return [
    typeof x === "number" ? x : fallback[0],
    typeof y === "number" ? y : fallback[1],
    typeof z === "number" ? z : fallback[2],
    typeof w === "number" ? w : fallback[3],
  ];
}

function nodeLocalMatrix(node: Record<string, unknown>): Matrix {
  if (Array.isArray(node.matrix) && node.matrix.length >= 16) {
    const values = node.matrix.map((entry) =>
      typeof entry === "number" ? entry : 0,
    );
    return Matrix.FromArray(values);
  }
  const translation = asTuple3(node.translation, [0, 0, 0]);
  const rotation = asTuple4(node.rotation, [0, 0, 0, 1]);
  const scale = asTuple3(node.scale, [1, 1, 1]);
  return Matrix.Compose(
    new Vector3(scale[0], scale[1], scale[2]),
    new Quaternion(rotation[0], rotation[1], rotation[2], rotation[3]),
    new Vector3(translation[0], translation[1], translation[2]),
  );
}

/** World matrix of the first node that references `meshIndex`, or identity. */
function meshNodeWorldMatrix(
  json: Record<string, unknown>,
  meshIndex: number,
): Matrix {
  const nodes = Array.isArray(json.nodes) ? json.nodes : [];
  const scenes = Array.isArray(json.scenes) ? json.scenes : [];
  const sceneIndex = typeof json.scene === "number" ? json.scene : 0;
  const scene = scenes[sceneIndex] as { nodes?: unknown } | undefined;
  const roots = Array.isArray(scene?.nodes)
    ? scene.nodes
    : nodes.map((_, index) => index);
  let found: Matrix | null = null;
  const visit = (index: unknown, parent: Matrix) => {
    if (found || typeof index !== "number" || index < 0 || index >= nodes.length) {
      return;
    }
    const node = nodes[index] as Record<string, unknown> | undefined;
    if (!node) return;
    const world = nodeLocalMatrix(node).multiply(parent);
    if (node.mesh === meshIndex) {
      found = world;
      return;
    }
    const children = Array.isArray(node.children) ? node.children : [];
    for (const child of children) visit(child, world);
  };
  const identity = Matrix.Identity();
  for (const root of roots) visit(root, identity);
  return found ?? identity;
}

function bakePositions(
  positions: Float32Array,
  world: Matrix,
): Float32Array {
  if (world.isIdentity()) return positions;
  const baked = new Float32Array(positions.length);
  const point = new Vector3();
  for (let i = 0; i < positions.length; i += 3) {
    point.set(positions[i]!, positions[i + 1]!, positions[i + 2]!);
    Vector3.TransformCoordinatesToRef(point, world, point);
    baked[i] = point.x;
    baked[i + 1] = point.y;
    baked[i + 2] = point.z;
  }
  return baked;
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
  const baked = bakePositions(positions, meshNodeWorldMatrix(glb.json, 0));
  const vertexData = new VertexData();
  vertexData.positions = Array.from(baked);
  if (typeof primitive?.indices === "number") {
    const indices = accessorIndices(glb.json, glb.bin, primitive.indices);
    if (indices) vertexData.indices = indices;
  } else {
    const count = baked.length / 3;
    vertexData.indices = Array.from({ length: count }, (_, i) => i);
  }
  const mesh = new Mesh(name, scene);
  vertexData.applyToMesh(mesh, true);
  mesh.refreshBoundingInfo();
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

/** Volume tetrahedron whose first mesh node (and optional parent) is translated. */
export function encodeTranslatedTetrahedronGlb(
  translation: [number, number, number],
  parentTranslation?: [number, number, number],
): Uint8Array {
  const positions = new Float32Array([0, 0, 0, 0.5, 0, 0, 0, 0.5, 0, 0, 0, 0.5]);
  const indices = new Uint16Array([0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3]);
  const bin = new Uint8Array(positions.byteLength + indices.byteLength);
  bin.set(new Uint8Array(positions.buffer), 0);
  bin.set(new Uint8Array(indices.buffer), positions.byteLength);
  const nodes = parentTranslation
    ? [
        { children: [1], translation: parentTranslation },
        { mesh: 0, translation },
      ]
    : [{ mesh: 0, translation }];
  return encodeGlb(
    {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes,
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
      accessors: [
        {
          bufferView: 0,
          componentType: FLOAT,
          count: 4,
          type: "VEC3",
          min: [0, 0, 0],
          max: [0.5, 0.5, 0.5],
        },
        {
          bufferView: 1,
          componentType: UNSIGNED_SHORT,
          count: 12,
          type: "SCALAR",
        },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
        {
          buffer: 0,
          byteOffset: positions.byteLength,
          byteLength: indices.byteLength,
        },
      ],
      buffers: [{ byteLength: bin.byteLength }],
    },
    bin,
  );
}

/** Triangle at x=1 whose node is rotated 90° about Y (glTF right-hand). */
export function encodeYRotatedTriangleGlb(): Uint8Array {
  const positions = new Float32Array([1, 0, 0, 1.2, 0, 0, 1, 0.2, 0]);
  const half = Math.SQRT1_2;
  return encodeGlb(
    {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0, rotation: [0, half, 0, half] }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [
        {
          bufferView: 0,
          componentType: FLOAT,
          count: 3,
          type: "VEC3",
          min: [1, 0, 0],
          max: [1.2, 0.2, 0],
        },
      ],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
      buffers: [{ byteLength: 36 }],
    },
    new Uint8Array(positions.buffer),
  );
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
      nodes: [{ name: "root", children: [1] }, { name: "part", mesh: 0 }],
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

export type UvHierarchyGlbOptions = {
  /** Each part uses its own glTF material (slots 0 and 1) instead of sharing slot 0. */
  separateMaterials?: boolean;
  /** Named translation clip on `part-b` (rest → +Y). */
  clipName?: string;
  /**
   * List the MatB mesh before MatA so `getChildMeshes()` visit order is not
   * glTF material order. Slot mapping must use `/materials/N`, not walk order.
   */
  laterMaterialFirst?: boolean;
};

/**
 * Two UV'd triangle meshes for adopt / slot / preview tests. Not a product
 * fixture — any glTF with multiple primitives should behave the same.
 */
export function encodeUvHierarchyGlb(
  options: UvHierarchyGlbOptions = {},
): Uint8Array {
  const positionsA = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const positionsB = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const uvs = new Float32Array([0, 0, 1, 0, 0, 1]);
  const times = new Float32Array([0, 1]);
  const translations = new Float32Array([0, 0, 0, 0, 1, 0]);
  const clip = typeof options.clipName === "string";
  const bin = new Uint8Array(clip ? 152 : 120);
  let offset = 0;
  const write = (data: Float32Array) => {
    bin.set(new Uint8Array(data.buffer), offset);
    offset += data.byteLength;
  };
  write(positionsA);
  write(uvs);
  write(positionsB);
  write(uvs);
  if (clip) {
    write(times);
    write(translations);
  }
  const materialB = options.separateMaterials ? 1 : 0;
  const laterFirst = Boolean(options.laterMaterialFirst);
  const meshA = {
    name: "part-a",
    primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }],
  };
  const meshB = {
    name: "part-b",
    primitives: [
      {
        attributes: { POSITION: 2, TEXCOORD_0: 3 },
        material: materialB,
      },
    ],
  };
  const nodeA = { name: "part-a", mesh: laterFirst ? 1 : 0 };
  const nodeB = {
    name: "part-b",
    mesh: laterFirst ? 0 : 1,
    translation: [2, 0, 0] as [number, number, number],
  };
  const partBNode = laterFirst ? 0 : 1;
  return encodeGlb(
    {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0, 1] }],
      nodes: laterFirst ? [nodeB, nodeA] : [nodeA, nodeB],
      meshes: laterFirst ? [meshB, meshA] : [meshA, meshB],
      materials: [
        {
          name: "MatA",
          pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] },
        },
        {
          name: "MatB",
          pbrMetallicRoughness: { baseColorFactor: [0, 1, 0, 1] },
        },
      ],
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
          count: 3,
          type: "VEC2",
          min: [0, 0],
          max: [1, 1],
        },
        {
          bufferView: 2,
          componentType: FLOAT,
          count: 3,
          type: "VEC3",
          min: [0, 0, 0],
          max: [1, 1, 0],
        },
        {
          bufferView: 3,
          componentType: FLOAT,
          count: 3,
          type: "VEC2",
          min: [0, 0],
          max: [1, 1],
        },
        ...(clip
          ? [
              {
                bufferView: 4,
                componentType: FLOAT,
                count: 2,
                type: "SCALAR",
                min: [0],
                max: [1],
              },
              {
                bufferView: 5,
                componentType: FLOAT,
                count: 2,
                type: "VEC3",
              },
            ]
          : []),
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 36 },
        { buffer: 0, byteOffset: 36, byteLength: 24 },
        { buffer: 0, byteOffset: 60, byteLength: 36 },
        { buffer: 0, byteOffset: 96, byteLength: 24 },
        ...(clip
          ? [
              { buffer: 0, byteOffset: 120, byteLength: 8 },
              { buffer: 0, byteOffset: 128, byteLength: 24 },
            ]
          : []),
      ],
      buffers: [{ byteLength: bin.byteLength }],
      ...(clip
        ? {
            animations: [
              {
                name: options.clipName,
                channels: [
                  { sampler: 0, target: { node: partBNode, path: "translation" } },
                ],
                samplers: [{ input: 4, output: 5, interpolation: "LINEAR" }],
              },
            ],
          }
        : {}),
    },
    bin,
  );
}
