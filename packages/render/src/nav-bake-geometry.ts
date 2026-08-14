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
  if (mode === "2d") {
    parts.push(recastWalkableQuadFromXy(xyBoundsFromActors(sceneData.actors)));
    for (const actor of sceneData.actors) {
      const position = {
        x: actor.transform.position[0],
        y: actor.transform.position[1],
      };
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
      const part = meshPart(mesh, scratch);
      if (part) parts.push(part);
    }
  }
  parts.push(...staticBlockerBakeParts(sceneData.actors, mode));
  return mergeNavBakeMeshes(parts);
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
    indices,
    transform: (x, y, z) => {
      scratch.set(x, y, z);
      Vector3.TransformCoordinatesToRef(scratch, world, scratch);
      return { x: scratch.x, y: scratch.y, z: scratch.z };
    },
  };
}
