import { MeshBuilder, Quaternion, Scene, Vector3 } from "@babylonjs/core";
import type { Mesh } from "@babylonjs/core";
import type { SerializedActor, SerializedScene } from "@babylonslate/core";

/** Editor meshes are named so picking can map a hit back to an actor id. */
export const EDITOR_ACTOR_MESH_PREFIX = "editorActor:";

export function editorMeshName(actorId: string): string {
  return `${EDITOR_ACTOR_MESH_PREFIX}${actorId}`;
}

export function actorIdFromMeshName(meshName: string): string | null {
  return meshName.startsWith(EDITOR_ACTOR_MESH_PREFIX)
    ? meshName.slice(EDITOR_ACTOR_MESH_PREFIX.length)
    : null;
}

export function clearSceneMeshes(scene: Scene): void {
  scene.meshes.slice().forEach((mesh) => {
    if (mesh.name !== "__root__") {
      mesh.dispose();
    }
  });
}

/** Build the Babylon mesh for an actor's first renderable component. */
export function createActorMesh(scene: Scene, actor: SerializedActor): Mesh {
  const meshComponent = actor.components.find(
    (component) => component.classId === "MeshComponent",
  );
  const meshKind =
    typeof meshComponent?.properties.meshKind === "string"
      ? meshComponent.properties.meshKind
      : null;
  const name = editorMeshName(actor.id);

  switch (meshKind) {
    case "sphere":
      return MeshBuilder.CreateSphere(name, { diameter: 1.5 }, scene);
    case "cylinder":
      return MeshBuilder.CreateCylinder(name, { height: 1.5, diameter: 1 }, scene);
    case "plane":
    case "quad":
      return MeshBuilder.CreatePlane(name, { size: 1.5 }, scene);
    case "ground":
      return MeshBuilder.CreateGround(name, { width: 10, height: 10 }, scene);
    case "box":
      return MeshBuilder.CreateBox(name, { size: 1.5 }, scene);
    default:
      // Actors without a renderable component still need a pickable proxy so
      // they can be selected and transformed in the viewport.
      return MeshBuilder.CreateBox(name, { size: 0.25 }, scene);
  }
}

export function applyActorTransform(mesh: Mesh, actor: SerializedActor): void {
  const [px, py, pz] = actor.transform.position;
  const [rx, ry, rz, rw] = actor.transform.rotation;
  const [sx, sy, sz] = actor.transform.scale;
  mesh.position.set(px, py, pz);
  if (!mesh.rotationQuaternion) {
    mesh.rotationQuaternion = new Quaternion(rx, ry, rz, rw);
  } else {
    mesh.rotationQuaternion.set(rx, ry, rz, rw);
  }
  mesh.scaling.set(sx, sy, sz);
  mesh.isVisible = actor.visible;
  mesh.isPickable = !actor.locked;
}

/** Full rebuild of the editor scene; `EditorSceneSync` does incremental work. */
export function applySceneToBabylonScene(
  scene: Scene,
  sceneData: SerializedScene,
): void {
  clearSceneMeshes(scene);

  const meshes = new Map<string, Mesh>();
  for (const actor of sceneData.actors) {
    const mesh = createActorMesh(scene, actor);
    applyActorTransform(mesh, actor);
    meshes.set(actor.id, mesh);
  }

  for (const actor of sceneData.actors) {
    if (!actor.parentId) continue;
    const mesh = meshes.get(actor.id);
    const parent = meshes.get(actor.parentId);
    if (mesh && parent) {
      mesh.parent = parent;
    }
  }
}

export function countSceneMeshes(scene: Scene): number {
  return scene.meshes.filter((mesh) => mesh.name !== "__root__").length;
}

export function toVector3(value: [number, number, number]): Vector3 {
  return new Vector3(value[0], value[1], value[2]);
}
