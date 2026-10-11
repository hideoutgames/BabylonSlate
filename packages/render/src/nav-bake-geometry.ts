import { Mesh, Vector3, VertexBuffer } from "@babylonjs/core";
import {
  composeAffineTransform,
  decomposeAffineTransform,
  identitySerializedTransform,
  multiplyAffineTransforms,
  type SerializedActor,
  type SerializedScene,
  type SerializedTransform,
  type Transform,
} from "@babylonslate/core";
import {
  mergeNavBakeMeshes,
  recastMeshesFromCollider2d,
  recastWalkableQuadFromXy,
  recastWallsFromXyChains,
  staticBlockerBakeParts,
  xyBoundsFromActors,
  type NavBakeBounds,
  type NavBakeMeshPart,
  type XyChain,
} from "@babylonslate/navigation";
import {
  bakeColliderLocal,
  multiplyQuat,
  parseColliderProperties,
  quatToPlanarAngle,
} from "@babylonslate/physics";
import type { EditorSceneSync } from "./editor-scene-sync";
import { visualMeshes } from "./visual-meshes";
import { isEditorCameraModel } from "./editor-camera-model";

export type NavBakeCollectExtras = {
  tilemapChains?: readonly XyChain[];
  bakeBounds?: NavBakeBounds;
};

/**
 * Recast bake input. 3D uses MeshComponent world meshes plus static blockers.
 * 2D uses an XY walkable quad, collider/tilemap walls, and remapped blockers
 * (engineplan §14.2). Lights, cameras, and NavMesh proxies stay out.
 */
export function collectNavBakeGeometry(
  sync: Pick<EditorSceneSync, "meshForActor">,
  sceneData: SerializedScene,
  extras?: NavBakeCollectExtras,
): { positions: number[]; indices: number[] } {
  const parts: NavBakeMeshPart[] = [];
  const scratch = new Vector3();
  const mode = sceneData.viewportMode === "2d" ? "2d" : "3d";
  const bounds = extras?.bakeBounds;
  if (mode === "2d") {
    const walls: NavBakeMeshPart[] = [];
    const actorsById = new Map(sceneData.actors.map((actor) => [actor.id, actor]));
    for (const actor of sceneData.actors) {
      if (!actor.components.some((component) => component.classId === "ColliderComponent")) continue;
      const world = actorWorldPose(actor, actorsById);
      if (!world) continue;
      for (const part of collider2dParts(actor, world)) {
        if (bounds && !partIntersectsXyBounds(part, bounds)) continue;
        walls.push(part);
      }
    }
    if (extras?.tilemapChains && extras.tilemapChains.length > 0) {
      const chains = bounds
        ? extras.tilemapChains.filter((chain) =>
            xyChainIntersectsBounds(chain, bounds),
          )
        : extras.tilemapChains;
      if (chains.length > 0) walls.push(recastWallsFromXyChains(chains, 2));
    }
    // The floor reaches past every wall, not only past the actor origins.
    const xy = xyBoundsFromActors(sceneData.actors, undefined, walls);
    const clipped = bounds ? intersectXyBounds(xy, bounds) : xy;
    if (clipped) parts.push(recastWalkableQuadFromXy(clipped));
    parts.push(...walls);
  } else {
    for (const actor of sceneData.actors) {
      if (
        !actor.components.some((component) => component.classId === "MeshComponent")
      ) {
        continue;
      }
      const root = sync.meshForActor(actor.id);
      if (!root) continue;
      for (const mesh of bakeVisualMeshes(root)) {
        if (bounds && !meshAabbIntersects(mesh, bounds)) continue;
        const part = meshPart(mesh, scratch);
        if (part) parts.push(part);
      }
    }
  }
  parts.push(...staticBlockerBakeParts(sceneData.actors, mode, bounds));
  return mergeNavBakeMeshes(parts);
}

function bakeVisualMeshes(root: Mesh): Mesh[] {
  return visualMeshes(root).filter((mesh): mesh is Mesh => {
    if (!(mesh instanceof Mesh)) return false;
    const meta = mesh.metadata as { editorPickProxy?: boolean } | null;
    return !meta?.editorPickProxy && !isEditorCameraModel(mesh);
  });
}

function runtimeTransform(transform: SerializedTransform): Transform {
  const [px, py, pz] = transform.position;
  const [rx, ry, rz, rw] = transform.rotation;
  const [sx, sy, sz] = transform.scale;
  return {
    position: { x: px, y: py, z: pz },
    rotation: { x: rx, y: ry, z: rz, w: rw },
    scale: { x: sx, y: sy, z: sz },
  };
}

/** World pose through the parent chain (`local × parentWorld`), as Play composes it; null on a cycle. */
function actorWorldPose(
  actor: SerializedActor,
  actorsById: ReadonlyMap<string, SerializedActor>,
): Transform | null {
  const local = runtimeTransform(actor.transform);
  if (!actor.parentId || !actorsById.has(actor.parentId)) return local;
  const matrix = composeAffineTransform(local);
  let reference = local.rotation;
  const signs = { ...local.scale };
  const visited = new Set([actor.id]);
  for (let parentId: string | null = actor.parentId; parentId;) {
    if (visited.has(parentId)) return null;
    visited.add(parentId);
    const parent = actorsById.get(parentId);
    if (!parent) break;
    const parentLocal = runtimeTransform(parent.transform);
    multiplyAffineTransforms(matrix, composeAffineTransform(parentLocal), matrix);
    reference = multiplyQuat(parentLocal.rotation, reference);
    signs.x *= parentLocal.scale.x;
    signs.y *= parentLocal.scale.y;
    signs.z *= parentLocal.scale.z;
    parentId = parent.parentId;
  }
  const world = runtimeTransform(identitySerializedTransform());
  decomposeAffineTransform(matrix, reference, world, signs);
  return world;
}

/**
 * An actor's 2D colliders placed as the 2D physics world places them: actor ×
 * component scale baked into the shape, the component offset turned by the
 * actor's planar angle. A collider physics rejects bakes nothing.
 */
function collider2dParts(actor: SerializedActor, world: Transform): NavBakeMeshPart[] {
  const parts: NavBakeMeshPart[] = [];
  const bodyAngle = quatToPlanarAngle(world.rotation);
  const cos = Math.cos(bodyAngle);
  const sin = Math.sin(bodyAngle);
  for (const component of actor.components) {
    if (component.classId !== "ColliderComponent") continue;
    let baked: ReturnType<typeof bakeColliderLocal>;
    try {
      const { shape } = parseColliderProperties({ shape: component.properties.shape }, "2d");
      const local = runtimeTransform(component.transform ?? identitySerializedTransform());
      baked = bakeColliderLocal(shape, local, world.scale);
    } catch {
      continue;
    }
    const offset = baked.translation;
    parts.push(...recastMeshesFromCollider2d(
      {
        x: world.position.x + offset.x * cos - offset.y * sin,
        y: world.position.y + offset.x * sin + offset.y * cos,
        angle: bodyAngle + quatToPlanarAngle(baked.rotation),
      },
      baked.shape as unknown as Record<string, unknown>,
    ));
  }
  return parts;
}

/** Whether a Recast-space part's world XY extent meets the bake bounds. */
function partIntersectsXyBounds(part: NavBakeMeshPart, bounds: NavBakeBounds): boolean {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 2 < part.positions.length; i += 3) {
    // Recast (x, _, z) is world (x, z).
    const x = Number(part.positions[i]);
    const y = Number(part.positions[i + 2]);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return (
    minX <= Math.max(bounds.min.x, bounds.max.x) &&
    maxX >= Math.min(bounds.min.x, bounds.max.x) &&
    minY <= Math.max(bounds.min.y, bounds.max.y) &&
    maxY >= Math.min(bounds.min.y, bounds.max.y)
  );
}

function xyChainIntersectsBounds(
  chain: XyChain,
  bounds: NavBakeBounds,
): boolean {
  if (chain.points.length === 0) return false;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of chain.points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  const boxMinX = Math.min(bounds.min.x, bounds.max.x);
  const boxMaxX = Math.max(bounds.min.x, bounds.max.x);
  const boxMinY = Math.min(bounds.min.y, bounds.max.y);
  const boxMaxY = Math.max(bounds.min.y, bounds.max.y);
  return minX <= boxMaxX && maxX >= boxMinX && minY <= boxMaxY && maxY >= boxMinY;
}

function intersectXyBounds(
  xy: { minX: number; minY: number; maxX: number; maxY: number },
  bounds: NavBakeBounds,
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const minX = Math.max(xy.minX, Math.min(bounds.min.x, bounds.max.x));
  const minY = Math.max(xy.minY, Math.min(bounds.min.y, bounds.max.y));
  const maxX = Math.min(xy.maxX, Math.max(bounds.min.x, bounds.max.x));
  const maxY = Math.min(xy.maxY, Math.max(bounds.min.y, bounds.max.y));
  if (minX > maxX || minY > maxY) return null;
  return { minX, minY, maxX, maxY };
}

function meshAabbIntersects(
  mesh: Mesh,
  bounds: NavBakeBounds,
): boolean {
  mesh.computeWorldMatrix(true);
  mesh.refreshBoundingInfo();
  const box = mesh.getBoundingInfo().boundingBox;
  const min = box.minimumWorld;
  const max = box.maximumWorld;
  return (
    min.x <= Math.max(bounds.min.x, bounds.max.x) &&
    max.x >= Math.min(bounds.min.x, bounds.max.x) &&
    min.y <= Math.max(bounds.min.y, bounds.max.y) &&
    max.y >= Math.min(bounds.min.y, bounds.max.y) &&
    min.z <= Math.max(bounds.min.z, bounds.max.z) &&
    max.z >= Math.min(bounds.min.z, bounds.max.z)
  );
}

function meshPart(
  mesh: Mesh,
  scratch: Vector3,
): {
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
  transform: (x: number, y: number, z: number) => {
    x: number;
    y: number;
    z: number;
  };
} | null {
  mesh.computeWorldMatrix(true);
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  const indices = mesh.getIndices();
  if (!positions || !indices || positions.length < 9 || indices.length < 3) {
    return null;
  }
  const world = mesh.getWorldMatrix();
  return {
    positions,
    indices: reversedTriangles(indices),
    transform: (x, y, z) => {
      scratch.set(x, y, z);
      Vector3.TransformCoordinatesToRef(scratch, world, scratch);
      return { x: scratch.x, y: scratch.y, z: scratch.z };
    },
  };
}

/** Babylon is left-handed; Recast wants CCW triangles with +Y normals. */
function reversedTriangles(indices: ArrayLike<number>): number[] {
  const out: number[] = [];
  const count = Math.floor(indices.length / 3) * 3;
  for (let i = 0; i < count; i += 3) {
    out.push(Number(indices[i]), Number(indices[i + 2]), Number(indices[i + 1]));
  }
  return out;
}
