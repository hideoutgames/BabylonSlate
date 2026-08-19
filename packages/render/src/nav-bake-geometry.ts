import { Vector3, VertexBuffer, type Mesh } from "@babylonjs/core";
import type { SerializedScene } from "@babylonslate/core";
import {
  mergeNavBakeMeshes,
  recastMeshesFromCollider2d,
  recastWalkableQuadFromXy,
  recastWallsFromXyChains,
  staticBlockerBakeParts,
  xyBoundsFromActors,
  type NavBakeMeshPart,
  type XyChain,
} from "@babylonslate/navigation";
import type { EditorSceneSync } from "./editor-scene-sync";

export type NavBakeCollectExtras = {
  tilemapChains?: readonly XyChain[];
  bakeBounds?: {
    min: { x: number; y: number; z: number };
    max: { x: number; y: number; z: number };
  };
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
    const xy = xyBoundsFromActors(sceneData.actors);
    const clipped = bounds ? intersectXyBounds(xy, bounds) : xy;
    if (clipped) parts.push(recastWalkableQuadFromXy(clipped));
    for (const actor of sceneData.actors) {
      const position = {
        x: actor.transform.position[0],
        y: actor.transform.position[1],
      };
      if (bounds && !pointInXyBounds(position, bounds)) continue;
      for (const component of actor.components) {
        if (component.classId !== "ColliderComponent") continue;
        const shape =
          component.properties.shape &&
          typeof component.properties.shape === "object"
            ? (component.properties.shape as Record<string, unknown>)
            : undefined;
        parts.push(...recastMeshesFromCollider2d(position, shape));
      }
    }
    if (extras?.tilemapChains && extras.tilemapChains.length > 0) {
      parts.push(recastWallsFromXyChains(extras.tilemapChains, 2));
    }
  } else {
    for (const actor of sceneData.actors) {
      if (
        !actor.components.some((component) => component.classId === "MeshComponent")
      ) {
        continue;
      }
      const mesh = sync.meshForActor(actor.id);
      if (!mesh) continue;
      if (bounds && !meshAabbIntersects(mesh, bounds)) continue;
      const part = meshPart(mesh, scratch);
      if (part) parts.push(part);
    }
  }
  parts.push(...staticBlockerBakeParts(sceneData.actors, mode));
  return mergeNavBakeMeshes(parts);
}

function pointInXyBounds(
  point: { x: number; y: number },
  bounds: NonNullable<NavBakeCollectExtras["bakeBounds"]>,
): boolean {
  const minX = Math.min(bounds.min.x, bounds.max.x);
  const maxX = Math.max(bounds.min.x, bounds.max.x);
  const minY = Math.min(bounds.min.y, bounds.max.y);
  const maxY = Math.max(bounds.min.y, bounds.max.y);
  return point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY;
}

function intersectXyBounds(
  xy: { minX: number; minY: number; maxX: number; maxY: number },
  bounds: NonNullable<NavBakeCollectExtras["bakeBounds"]>,
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
  bounds: NonNullable<NavBakeCollectExtras["bakeBounds"]>,
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
