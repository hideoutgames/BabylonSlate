import {
  Color3,
  Matrix,
  Mesh,
  MeshBuilder,
  Quaternion,
  Scene,
  StandardMaterial,
  Vector3,
} from "@babylonjs/core";
import type { ColliderShape } from "@babylonslate/physics";
import { RENDERING_GROUP } from "./sorting";

export const COLLIDER_DASH_SIZE = 0.12;
export const COLLIDER_GAP_SIZE = 0.08;
export const COLLIDER_DASH_THICKNESS = 0.018;
const COLLIDER_COLOR = new Color3(0.85, 0.9, 0.4);
const materialsByScene = new WeakMap<Scene, StandardMaterial>();

export function isColliderVisualMesh(mesh: Mesh): boolean {
  return Boolean(
    (mesh.metadata as { editorColliderVisual?: boolean } | null)
      ?.editorColliderVisual,
  );
}

export function createColliderVisualMesh(
  scene: Scene,
  name: string,
  shape: ColliderShape,
): Mesh {
  const root = new Mesh(name, scene);
  root.metadata = { ...(root.metadata ?? {}), editorColliderVisual: true };
  root.isPickable = false;
  root.overlay = false;
  root.renderingGroupId = RENDERING_GROUP.world;
  const material = colliderMaterial(scene);
  for (const [from, to] of shapeEdges(shape)) {
    addDashedEdge(root, scene, material, from, to);
  }
  return root;
}

function colliderMaterial(scene: Scene): StandardMaterial {
  const existing = materialsByScene.get(scene);
  if (existing) return existing;
  const material = new StandardMaterial("colliderDash", scene);
  material.disableLighting = true;
  material.disableDepthWrite = false;
  material.backFaceCulling = false;
  material.emissiveColor = COLLIDER_COLOR.clone();
  material.diffuseColor = Color3.Black();
  material.specularColor = Color3.Black();
  material.alpha = 1;
  materialsByScene.set(scene, material);
  return material;
}

function addDashedEdge(
  parent: Mesh,
  scene: Scene,
  material: StandardMaterial,
  from: Vector3,
  to: Vector3,
): void {
  const delta = to.subtract(from);
  const length = delta.length();
  if (length < 1e-5) return;
  const unit = delta.scale(1 / length);
  const rotation = quaternionAlignX(unit);
  const period = COLLIDER_DASH_SIZE + COLLIDER_GAP_SIZE;
  let offset = 0;
  let index = 0;
  while (offset < length - 1e-5) {
    const dashLen = Math.min(COLLIDER_DASH_SIZE, length - offset);
    if (dashLen < COLLIDER_DASH_THICKNESS) break;
    const mid = from.add(unit.scale(offset + dashLen / 2));
    const dash = MeshBuilder.CreateBox(
      `${parent.name}:dash:${parent.getChildren().length}:${index}`,
      {
        width: dashLen,
        height: COLLIDER_DASH_THICKNESS,
        depth: COLLIDER_DASH_THICKNESS,
      },
      scene,
    );
    dash.parent = parent;
    dash.position.copyFrom(mid);
    dash.rotationQuaternion = rotation.clone();
    dash.material = material;
    dash.isPickable = false;
    dash.overlay = false;
    dash.renderingGroupId = RENDERING_GROUP.world;
    offset += period;
    index += 1;
  }
}

function quaternionAlignX(direction: Vector3): Quaternion {
  const x = direction.clone().normalize();
  let up = Vector3.Up();
  if (Math.abs(Vector3.Dot(x, up)) > 0.999) up = Vector3.Forward();
  const z = Vector3.Cross(x, up).normalize();
  const y = Vector3.Cross(z, x).normalize();
  return Quaternion.FromRotationMatrix(
    Matrix.FromXYZAxesToRef(x, y, z, new Matrix()),
  );
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
    case "polygon":
    case "chain":
      return polylineEdges(
        shape.points.map((point) => new Vector3(point.x, point.y, 0)),
        shape.kind === "chain" ? shape.loop === true : true,
      );
    case "convex":
      return aabbEdges(shape.points);
    case "mesh":
      return aabbEdges(shape.vertices);
    default:
      return boxEdges(0.5, 0.5, 0.5);
  }
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
  if (!threeD) {
    edges.push(
      ...arcEdges(radius, halfHeight, 1),
      ...arcEdges(radius, -halfHeight, -1),
    );
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
