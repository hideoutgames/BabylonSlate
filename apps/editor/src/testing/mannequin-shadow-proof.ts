import { Color3, Matrix, PBRMaterial, Vector3, VertexBuffer, type Material, type Scene } from "@babylonjs/core";
import { sceneShadowController } from "../../../../packages/render/src/shadow-controller";

const names = new Set(["head", "torso", "arm-left", "arm-right", "leg-left", "leg-right"]);
const originals = new WeakMap<Scene, Map<string, Material | null>>();

/** Explicit test-build probe of the six real starter meshes, never a frame hook. */
export async function mannequinShadowProbe(scene: Scene, neutral: boolean, modelOnly = false) {
  const meshes = scene.meshes.filter(mesh => names.has(mesh.name));
  if (meshes.length !== 6) throw new Error(`Expected six mannequin parts, got ${meshes.length}`);
  let saved = originals.get(scene);
  if (!saved) { saved = new Map(meshes.map(mesh => [mesh.id, mesh.material])); originals.set(scene, saved); }
  let material = scene.getMaterialByName("mannequin-shadow-neutral") as PBRMaterial | null;
  if (neutral && !material) {
    material = new PBRMaterial("mannequin-shadow-neutral", scene);
    material.albedoColor = new Color3(0.6, 0.6, 0.6);
    material.metallic = 0;
    material.roughness = 1;
  }
  for (const mesh of scene.meshes) {
    sceneShadowController(scene).setParticipation(mesh, { castShadows: names.has(mesh.name) || !modelOnly });
  }
  const result = meshes.map(mesh => {
    const source = mesh.material;
    const effect = mesh.subMeshes[0]?.effect;
    mesh.material = neutral ? material : saved!.get(mesh.id)!;
    const world = mesh.computeWorldMatrix(true);
    const normalMatrix = Matrix.Transpose(Matrix.Invert(world));
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
    const normals = mesh.getVerticesData(VertexBuffer.NormalKind)!;
    if (positions.length > 4096) throw new Error("Mannequin geometry probe limit exceeded");
    const vertices = [];
    for (let i = 0; i < positions.length; i += 3) vertices.push({
      position: Vector3.TransformCoordinates(Vector3.FromArray(positions, i), world).asArray(),
      normal: Vector3.TransformNormal(Vector3.FromArray(normals, i), normalMatrix).normalize().asArray(),
    });
    return { name: mesh.name, vertices, indices: Array.from(mesh.getIndices()!), material: source?.getClassName(), defines: effect?.defines, fragment: effect?.fragmentSourceCode };
  });
  if (neutral) await Promise.all(meshes.map(mesh => material!.forceCompilationAsync(mesh)));
  return result;
}
