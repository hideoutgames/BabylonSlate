import { MeshBuilder, Scene, Vector3 } from "@babylonjs/core";
import type { SerializedScene } from "@babylonslate/shared";

export function clearSceneMeshes(scene: Scene): void {
  scene.meshes.slice().forEach((mesh) => {
    if (mesh.name !== "__root__") {
      mesh.dispose();
    }
  });
}

export function applySceneToBabylonScene(
  scene: Scene,
  sceneData: SerializedScene,
): void {
  clearSceneMeshes(scene);

  for (const meshDef of sceneData.meshes) {
    if (meshDef.type === "box") {
      const box = MeshBuilder.CreateBox(meshDef.id, { size: 1.5 }, scene);
      box.position = new Vector3(...meshDef.position);
    }
  }
}

export function countSceneMeshes(scene: Scene): number {
  return scene.meshes.filter((mesh) => mesh.name !== "__root__").length;
}
