/** Synthetic GLB fixtures for NullEngine tests and test-mode proofs; kept out of the render barrel. */
import { encodeGlbJsonBin } from "@babylonslate/assets";

const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;

/** Volume tetrahedron whose mesh node is translated. */
export function encodeTranslatedTetrahedronGlb(
  translation: [number, number, number],
): Uint8Array {
  const positions = new Float32Array([0, 0, 0, 0.5, 0, 0, 0, 0.5, 0, 0, 0, 0.5]);
  const indices = new Uint16Array([0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3]);
  const bin = new Uint8Array(positions.byteLength + indices.byteLength);
  bin.set(new Uint8Array(positions.buffer), 0);
  bin.set(new Uint8Array(indices.buffer), positions.byteLength);
  return encodeGlbJsonBin(
    {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0, translation }],
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

/** Minimal one-triangle GLB for NullEngine tests (3 vertices, no indices). */
export function encodeTriangleGlb(): Uint8Array {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  return encodeGlbJsonBin(
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
  return encodeGlbJsonBin(
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
  return encodeGlbJsonBin(
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
): Uint8Array<ArrayBuffer> {
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
  return encodeGlbJsonBin(
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

/**
 * Indexed UV sphere with normals and a UV seam, dense enough for automatic
 * LOD (2 × rings × segments triangles).
 */
export function encodeUvSphereGlb(rings = 32, segments = 64): Uint8Array {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  for (let ring = 0; ring <= rings; ring++) {
    const theta = (ring / rings) * Math.PI;
    for (let segment = 0; segment <= segments; segment++) {
      const phi = (segment / segments) * Math.PI * 2;
      const x = Math.sin(theta) * Math.cos(phi);
      const y = Math.cos(theta);
      const z = Math.sin(theta) * Math.sin(phi);
      positions.push(x, y, z);
      normals.push(x, y, z);
      uvs.push(segment / segments, ring / rings);
    }
  }
  const indices: number[] = [];
  const row = segments + 1;
  for (let ring = 0; ring < rings; ring++) {
    for (let segment = 0; segment < segments; segment++) {
      const a = ring * row + segment;
      const b = a + row;
      indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const views = [
    new Float32Array(positions),
    new Float32Array(normals),
    new Float32Array(uvs),
    new Uint16Array(indices),
  ];
  const bin = new Uint8Array(views.reduce((total, view) => total + Math.ceil(view.byteLength / 4) * 4, 0));
  const bufferViews: Record<string, unknown>[] = [];
  let offset = 0;
  for (const view of views) {
    bin.set(new Uint8Array(view.buffer), offset);
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: view.byteLength });
    offset += Math.ceil(view.byteLength / 4) * 4;
  }
  const count = positions.length / 3;
  return encodeGlbJsonBin(
    {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3 }] }],
      accessors: [
        { bufferView: 0, componentType: FLOAT, count, type: "VEC3", min: [-1, -1, -1], max: [1, 1, 1] },
        { bufferView: 1, componentType: FLOAT, count, type: "VEC3" },
        { bufferView: 2, componentType: FLOAT, count, type: "VEC2" },
        { bufferView: 3, componentType: UNSIGNED_SHORT, count: indices.length, type: "SCALAR" },
      ],
      bufferViews,
      buffers: [{ byteLength: bin.byteLength }],
    },
    bin,
  );
}
