import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { Scene } from "@babylonjs/core/scene";
import { convexHullEdges } from "@haptic/assets";
import type { ColliderShape } from "@haptic/physics";
import { setUnlitMaterial, type UnlitMaterialKey } from "./unlit-material";
import { RENDERING_GROUP } from "./sorting";

const COLLIDER_DASH_SIZE = 0.12;
const COLLIDER_GAP_SIZE = 0.08;
const COLLIDER_DASH_THICKNESS = 0.018;
export const COLLIDER_COLOR = new Color3(0.85, 0.9, 0.4);
/** Solid dashes from both sides; editor helpers draw without fog. */
const COLLIDER_MATERIAL: UnlitMaterialKey = { textured: false, backFaceCulling: false, fog: false, role: "helper" };

export function isColliderVisualMesh(mesh: Pick<Mesh, "metadata">): boolean {
  return Boolean(
    (mesh.metadata as { editorColliderVisual?: boolean } | null)
      ?.editorColliderVisual,
  );
}

export function isColliderVisualTree(mesh: { parent?: unknown } | Mesh): boolean {
  let node: unknown = mesh;
  while (node) {
    if (node instanceof Mesh && isColliderVisualMesh(node)) return true;
    node = (node as { parent?: unknown }).parent ?? null;
  }
  return false;
}

/** Unit box local corners (24 vertices, matching Babylon CreateBoxVertexData FRONTSIDE). */
const UNIT_BOX_POS = [
  // +Z face
  0.5, -0.5, 0.5, -0.5, -0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, 0.5,
  // -Z face
  0.5, 0.5, -0.5, -0.5, 0.5, -0.5, -0.5, -0.5, -0.5, 0.5, -0.5, -0.5,
  // +X face
  0.5, 0.5, -0.5, 0.5, -0.5, -0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5,
  // -X face
  -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5, -0.5, -0.5, -0.5, 0.5, -0.5,
  // +Y face
  -0.5, 0.5, 0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5,
  // -Y face
  0.5, -0.5, 0.5, 0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5, 0.5,
] as const;

const UNIT_BOX_NORM = [
  0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
  0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1,
  1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0,
  -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0,
  0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0,
  0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0,
] as const;

const UNIT_BOX_UV = [
  1, 1, 0, 1, 0, 0, 1, 0,
  1, 1, 0, 1, 0, 0, 1, 0,
  1, 1, 0, 1, 0, 0, 1, 0,
  1, 1, 0, 1, 0, 0, 1, 0,
  1, 1, 0, 1, 0, 0, 1, 0,
  1, 1, 0, 1, 0, 0, 1, 0,
] as const;

const UNIT_BOX_INDICES = [
  0, 1, 2, 0, 2, 3,
  4, 5, 6, 4, 6, 7,
  8, 9, 10, 8, 10, 11,
  12, 13, 14, 12, 14, 15,
  16, 17, 18, 16, 18, 19,
  20, 21, 22, 20, 22, 23,
] as const;

const COLLIDER_DASH_PERIOD = COLLIDER_DASH_SIZE + COLLIDER_GAP_SIZE;

function countEdgeDashes(length: number): number {
  if (length < 1e-5) return 0;
  let count = 0;
  for (let offset = 0; offset < length - 1e-5; offset += COLLIDER_DASH_PERIOD) {
    const dashLen = Math.min(COLLIDER_DASH_SIZE, length - offset);
    if (dashLen < COLLIDER_DASH_THICKNESS) break;
    count += 1;
  }
  return count;
}

function buildDashedEdgesVertexData(edges: Array<[Vector3, Vector3]>): VertexData | null {
  let totalDashes = 0;
  for (let i = 0; i < edges.length; i++) {
    const [from, to] = edges[i]!;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    totalDashes += countEdgeDashes(Math.hypot(dx, dy, dz));
  }
  if (totalDashes === 0) return null;

  const totalVerts = totalDashes * 24;
  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const uvs = new Float32Array(totalVerts * 2);
  const indices = totalVerts > 0xffff ? new Uint32Array(totalDashes * 36) : new Uint16Array(totalDashes * 36);

  let vertBase = 0;
  let posOffset = 0;
  let uvOffset = 0;
  let idxOffset = 0;

  for (let i = 0; i < edges.length; i++) {
    const [from, to] = edges[i]!;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const length = Math.hypot(dx, dy, dz);
    if (length < 1e-5) continue;

    // Orthonormal basis aligned with edge direction as +X (matching quaternionAlignX).
    const invLen = 1 / length;
    const xx = dx * invLen;
    const xy = dy * invLen;
    const xz = dz * invLen;
    // up = (0, 1, 0) unless |dot(x, up)| > 0.999, else (0, 0, 1).
    let zx: number;
    let zy: number;
    let zz: number;
    if (Math.abs(xy) > 0.999) {
      // cross(x, (0, 0, 1)) = (xy, -xx, 0)
      zx = xy;
      zy = -xx;
      zz = 0;
    } else {
      // cross(x, (0, 1, 0)) = (-xz, 0, xx)
      zx = -xz;
      zy = 0;
      zz = xx;
    }
    const zInv = 1 / Math.hypot(zx, zy, zz);
    zx *= zInv;
    zy *= zInv;
    zz *= zInv;
    // y = normalize(cross(z, x))
    let yx = zy * xz - zz * xy;
    let yy = zz * xx - zx * xz;
    let yz = zx * xy - zy * xx;
    const yInv = 1 / Math.hypot(yx, yy, yz);
    yx *= yInv;
    yy *= yInv;
    yz *= yInv;

    const tyx = yx * COLLIDER_DASH_THICKNESS;
    const tyy = yy * COLLIDER_DASH_THICKNESS;
    const tyz = yz * COLLIDER_DASH_THICKNESS;
    const tzx = zx * COLLIDER_DASH_THICKNESS;
    const tzy = zy * COLLIDER_DASH_THICKNESS;
    const tzz = zz * COLLIDER_DASH_THICKNESS;

    for (let offset = 0; offset < length - 1e-5; offset += COLLIDER_DASH_PERIOD) {
      const dashLen = Math.min(COLLIDER_DASH_SIZE, length - offset);
      if (dashLen < COLLIDER_DASH_THICKNESS) break;
      const dist = offset + dashLen * 0.5;
      const mx = from.x + xx * dist;
      const my = from.y + xy * dist;
      const mz = from.z + xz * dist;
      const dxx = xx * dashLen;
      const dxy = xy * dashLen;
      const dxz = xz * dashLen;

      for (let v = 0; v < 24; v++) {
        const p3 = v * 3;
        const lx = UNIT_BOX_POS[p3]!;
        const ly = UNIT_BOX_POS[p3 + 1]!;
        const lz = UNIT_BOX_POS[p3 + 2]!;
        positions[posOffset] = mx + lx * dxx + ly * tyx + lz * tzx;
        positions[posOffset + 1] = my + lx * dxy + ly * tyy + lz * tzy;
        positions[posOffset + 2] = mz + lx * dxz + ly * tyz + lz * tzz;

        const nx = UNIT_BOX_NORM[p3]!;
        const ny = UNIT_BOX_NORM[p3 + 1]!;
        const nz = UNIT_BOX_NORM[p3 + 2]!;
        normals[posOffset] = nx * xx + ny * yx + nz * zx;
        normals[posOffset + 1] = nx * xy + ny * yy + nz * zy;
        normals[posOffset + 2] = nx * xz + ny * yz + nz * zz;
        posOffset += 3;

        const u2 = v * 2;
        uvs[uvOffset] = UNIT_BOX_UV[u2]!;
        uvs[uvOffset + 1] = UNIT_BOX_UV[u2 + 1]!;
        uvOffset += 2;
      }

      for (let k = 0; k < 36; k++) {
        indices[idxOffset++] = vertBase + UNIT_BOX_INDICES[k]!;
      }
      vertBase += 24;
    }
  }

  const data = new VertexData();
  data.positions = positions;
  data.normals = normals;
  data.uvs = uvs;
  data.indices = indices;
  return data;
}

export function createDashedEdgesMesh(
  scene: Scene,
  name: string,
  edges: Array<[Vector3, Vector3]>,
  color: Color3 = COLLIDER_COLOR,
  options?: { pickable?: boolean },
): Mesh {
  const root = new Mesh(name, scene);
  root.metadata = { ...(root.metadata ?? {}), editorColliderVisual: true };
  root.isPickable = options?.pickable === true;
  root.renderingGroupId = RENDERING_GROUP.world;
  const merged = buildDashedEdgesVertexData(edges);
  if (!merged) return root;
  // Every dash box shares one mesh and draw call. The `:dash:` name is what
  // editor collider display toggles.
  const dash = new Mesh(`${name}:dash:0`, scene);
  merged.applyToMesh(dash);
  dash.parent = root;
  // Mark the actual renderable segments, not an entire subtree: authored
  // component meshes can also be parented beneath a collider visual root.
  dash.metadata = { ...dash.metadata, editorColliderVisual: true };
  setUnlitMaterial(dash, COLLIDER_MATERIAL, {
    texture: null, color: [color.r, color.g, color.b], alpha: 1, cutoff: 0, blend: false, textureAlpha: false, twoSided: false,
  });
  dash.isPickable = options?.pickable === true;
  dash.renderingGroupId = RENDERING_GROUP.world;
  return root;
}

export function createColliderVisualMesh(
  scene: Scene,
  name: string,
  shape: ColliderShape,
  color: Color3 = COLLIDER_COLOR,
  options?: { pickable?: boolean },
): Mesh {
  return createDashedEdgesMesh(scene, name, shapeEdges(shape), color, options);
}

function shapeEdges(shape: ColliderShape): Array<[Vector3, Vector3]> {
  switch (shape.kind) {
    case "box":
      return boxEdges(shape.halfExtents.x, shape.halfExtents.y, shape.halfExtents.z);
    case "box2d":
      return boxEdges(shape.halfExtents.x, shape.halfExtents.y, 0);
    case "sphere":
      return sphereEdges(shape.radius);
    case "circle":
      return ringEdges(shape.radius, "z");
    case "capsule":
      return capsuleEdges(shape.radius, shape.halfHeight, true);
    case "capsule2d":
      return capsuleEdges(shape.radius, shape.halfHeight, false);
    case "cylinder":
      return cylinderEdges(shape.radius, shape.height);
    case "polygon":
    case "chain":
      return polylineEdges(
        shape.points.map((point) => new Vector3(point.x, point.y, 0)),
        shape.kind === "chain" ? shape.loop === true : true,
      );
    case "convex":
      return hullEdges(shape.points);
    case "mesh":
      return hullEdges(
        Array.from({ length: shape.positions.length / 3 }, (_, i) => ({
          x: shape.positions[i * 3]!,
          y: shape.positions[i * 3 + 1]!,
          z: shape.positions[i * 3 + 2]!,
        })),
      );
    default:
      return boxEdges(0.5, 0.5, 0.5);
  }
}

export function cylinderEdges(
  radius: number,
  height: number,
): Array<[Vector3, Vector3]> {
  const hy = height / 2;
  const top = ringEdges(radius, "y").map(
    ([a, b]): [Vector3, Vector3] => [
      a.add(new Vector3(0, hy, 0)),
      b.add(new Vector3(0, hy, 0)),
    ],
  );
  const bottom = ringEdges(radius, "y").map(
    ([a, b]): [Vector3, Vector3] => [
      a.add(new Vector3(0, -hy, 0)),
      b.add(new Vector3(0, -hy, 0)),
    ],
  );
  const edges: Array<[Vector3, Vector3]> = [...top, ...bottom];
  for (let i = 0; i < 4; i++) {
    const theta = (i / 4) * Math.PI * 2;
    const x = Math.cos(theta) * radius;
    const z = Math.sin(theta) * radius;
    edges.push([new Vector3(x, -hy, z), new Vector3(x, hy, z)]);
  }
  return edges;
}

function boxEdges(hx: number, hy: number, hz: number): Array<[Vector3, Vector3]> {
  const p = (x: number, y: number, z: number) => new Vector3(x, y, z);
  const corners = [
    p(-hx, -hy, -hz),
    p(hx, -hy, -hz),
    p(hx, hy, -hz),
    p(-hx, hy, -hz),
    p(-hx, -hy, hz),
    p(hx, -hy, hz),
    p(hx, hy, hz),
    p(-hx, hy, hz),
  ];
  const pairs: Array<[number, number]> = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
    [4, 5],
    [5, 6],
    [6, 7],
    [7, 4],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ];
  if (hz === 0) {
    return [
      [corners[0]!, corners[1]!],
      [corners[1]!, corners[2]!],
      [corners[2]!, corners[3]!],
      [corners[3]!, corners[0]!],
    ];
  }
  return pairs.map(([a, b]) => [corners[a]!, corners[b]!]);
}

function sphereEdges(radius: number): Array<[Vector3, Vector3]> {
  return [
    ...ringEdges(radius, "x"),
    ...ringEdges(radius, "y"),
    ...ringEdges(radius, "z"),
  ];
}

function ringEdges(
  radius: number,
  axis: "x" | "y" | "z",
  segments = 24,
): Array<[Vector3, Vector3]> {
  const points: Vector3[] = [];
  for (let i = 0; i < segments; i++) {
    const theta = (i / segments) * Math.PI * 2;
    const c = Math.cos(theta) * radius;
    const s = Math.sin(theta) * radius;
    if (axis === "x") points.push(new Vector3(0, c, s));
    else if (axis === "y") points.push(new Vector3(c, 0, s));
    else points.push(new Vector3(c, s, 0));
  }
  return polylineEdges(points, true);
}

function capsuleEdges(
  radius: number,
  halfHeight: number,
  threeD: boolean,
): Array<[Vector3, Vector3]> {
  const edges: Array<[Vector3, Vector3]> = [];
  const top = ringEdges(radius, "y").map(
    ([a, b]): [Vector3, Vector3] => [
      a.add(new Vector3(0, halfHeight, 0)),
      b.add(new Vector3(0, halfHeight, 0)),
    ],
  );
  const bottom = ringEdges(radius, "y").map(
    ([a, b]): [Vector3, Vector3] => [
      a.add(new Vector3(0, -halfHeight, 0)),
      b.add(new Vector3(0, -halfHeight, 0)),
    ],
  );
  edges.push(...top, ...bottom);
  const meridians = threeD ? 4 : 2;
  for (let i = 0; i < meridians; i++) {
    const theta = (i / meridians) * Math.PI * 2;
    const x = Math.cos(theta) * radius;
    const z = threeD ? Math.sin(theta) * radius : 0;
    if (!threeD && i === 1) {
      edges.push([
        new Vector3(-radius, -halfHeight, 0),
        new Vector3(-radius, halfHeight, 0),
      ]);
      continue;
    }
    edges.push([
      new Vector3(x, -halfHeight, z),
      new Vector3(x, halfHeight, z),
    ]);
  }
  const caps = [
    ...arcEdges(radius, halfHeight, 1),
    ...arcEdges(radius, -halfHeight, -1),
  ];
  edges.push(...caps);
  if (threeD) {
    edges.push(...caps.map(([a, b]): [Vector3, Vector3] => [
      new Vector3(0, a.y, a.x),
      new Vector3(0, b.y, b.x),
    ]));
  }
  return edges;
}

function arcEdges(
  radius: number,
  y: number,
  sign: number,
  segments = 8,
): Array<[Vector3, Vector3]> {
  const points: Vector3[] = [];
  for (let i = 0; i <= segments; i++) {
    const theta = (i / segments) * Math.PI;
    points.push(
      new Vector3(
        Math.cos(theta) * radius,
        y + Math.sin(theta) * radius * sign,
        0,
      ),
    );
  }
  return polylineEdges(points, false);
}

function polylineEdges(
  points: readonly Vector3[],
  loop: boolean,
): Array<[Vector3, Vector3]> {
  const edges: Array<[Vector3, Vector3]> = [];
  for (let i = 0; i + 1 < points.length; i++) {
    edges.push([points[i]!, points[i + 1]!]);
  }
  if (loop && points.length > 2) {
    edges.push([points[points.length - 1]!, points[0]!]);
  }
  return edges;
}

function hullEdges(
  points: readonly { x: number; y: number; z?: number }[],
): Array<[Vector3, Vector3]> {
  const edges = convexHullEdges(
    points.map((point) => ({ x: point.x, y: point.y, z: point.z ?? 0 })),
  );
  if (edges.length === 0) return aabbEdges(points);
  return edges.map(([from, to]) => [
    new Vector3(from.x, from.y, from.z),
    new Vector3(to.x, to.y, to.z),
  ]);
}

function aabbEdges(
  points: readonly { x: number; y: number; z?: number }[],
): Array<[Vector3, Vector3]> {
  if (points.length === 0) return boxEdges(0.5, 0.5, 0.5);
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    minZ = Math.min(minZ, point.z ?? 0);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
    maxZ = Math.max(maxZ, point.z ?? 0);
  }
  const hx = Math.max(0.01, (maxX - minX) / 2);
  const hy = Math.max(0.01, (maxY - minY) / 2);
  const hz = Math.max(0.01, (maxZ - minZ) / 2);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;
  return boxEdges(hx, hy, hz).map(
    ([from, to]): [Vector3, Vector3] => [
      from.add(new Vector3(cx, cy, cz)),
      to.add(new Vector3(cx, cy, cz)),
    ],
  );
}
