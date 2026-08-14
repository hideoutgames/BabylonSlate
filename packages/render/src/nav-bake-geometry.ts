import { Vector3, VertexBuffer, type Mesh } from "@babylonjs/core";
import type { SerializedScene } from "@babylonslate/core";
import { mergeNavBakeMeshes } from "@babylonslate/navigation";
import type { EditorSceneSync } from "./editor-scene-sync";

/**
 * Main-thread Recast input: MeshComponent actors only. Lights, cameras, and
 * NavMesh proxies stay out of the bake (engineplan §14.2).
 */
export function collectNavBakeGeometry(
  sync: Pick<EditorSceneSync, "meshForActor">,
  sceneData: SerializedScene,
): { positions: number[]; indices: number[] } {
  const parts: Array<{
    positions: ArrayLike<number>;
    indices: ArrayLike<number>;
    transform: (x: number, y: number, z: number) => {
      x: number;
      y: number;
      z: number;
    };
  }> = [];
  const scratch = new Vector3();
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
