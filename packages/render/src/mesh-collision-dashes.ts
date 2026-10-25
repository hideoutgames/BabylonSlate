/**
 * Dashed outlines of the collision shapes a MeshComponent's Collision setting resolves to, parented to its editor mesh.
 * `scene-loader.ts` re-exports the public names.
 */
import { Mesh, Quaternion } from "@babylonjs/core";
import type { SerializedComponent } from "@haptic/core";
import { extractGltfCollisionMesh, parseMeshCollisionMode, resolveMeshCollisions } from "@haptic/assets";
import type { ColliderShape } from "@haptic/physics";
import { createColliderVisualMesh } from "./collider-visual";
import type { MeshAssetContext } from "./mesh-assets";
import { stringProp } from "./scene-visual-classify";

export function attachMeshCollisionDashes(
  mesh: Mesh,
  component: SerializedComponent,
  assets?: MeshAssetContext,
): void {
  if (assets?.drawMeshCollision === false) return;
  if (parseMeshCollisionMode(component.properties.collisionMode) === "none") {
    return;
  }
  const assetGuid = stringProp(component.properties.assetGuid);
  const modelPayload = assetGuid
    ? assets?.modelPayloads?.get(assetGuid)
    : undefined;
  let complexMesh: ReturnType<typeof extractGltfCollisionMesh> | undefined;
  if (
    parseMeshCollisionMode(component.properties.collisionMode) === "complex" &&
    assetGuid
  ) {
    const bytes = assets?.modelBytes?.get(assetGuid);
    if (bytes) {
      complexMesh = extractGltfCollisionMesh(
        bytes,
        modelPayload?.importScale ?? 1,
      );
    }
  }
  const collisions = resolveMeshCollisions(component.properties, {
    modelPayload,
    complexMesh,
  });
  const scene = mesh.getScene();
  for (const collision of collisions) {
    const visual = createColliderVisualMesh(
      scene,
      `${mesh.name}:mesh-collider:${collision.shapeId}`,
      collision.shape as ColliderShape,
    );
    visual.metadata = {
      ...(typeof visual.metadata === "object" && visual.metadata
        ? visual.metadata
        : {}),
      meshCollisionDash: true,
    };
    visual.parent = mesh;
    visual.position.set(
      collision.position[0],
      collision.position[1],
      collision.position[2],
    );
    visual.rotationQuaternion = new Quaternion(
      collision.rotation[0],
      collision.rotation[1],
      collision.rotation[2],
      collision.rotation[3],
    );
    visual.scaling.set(
      collision.scale[0],
      collision.scale[1],
      collision.scale[2],
    );
  }
}

function disposeMeshCollisionDashes(mesh: Mesh): void {
  for (const child of [...mesh.getChildren()]) {
    if (
      child instanceof Mesh &&
      (child.metadata as { meshCollisionDash?: boolean } | null)
        ?.meshCollisionDash
    ) {
      child.dispose();
    }
  }
}

export function syncMeshCollisionDashes(
  mesh: Mesh,
  component: SerializedComponent,
  assets?: MeshAssetContext,
): void {
  disposeMeshCollisionDashes(mesh);
  attachMeshCollisionDashes(mesh, component, assets);
}
