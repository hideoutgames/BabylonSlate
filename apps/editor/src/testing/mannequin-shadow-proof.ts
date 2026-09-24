import { Matrix, Ray, Vector3, VertexBuffer, type AbstractMesh, type Scene } from "@babylonjs/core";
import { sceneShadowController } from "../../../../packages/render/src/shadow-controller";
import type { ShadowParticipation } from "../../../../packages/render/src/shadow-mesh-policy";

const names = new Set(["head", "torso", "arm-left", "arm-right", "leg-left", "leg-right"]);
const originals = new WeakMap<Scene, Map<AbstractMesh, ShadowParticipation | undefined>>();

/** Explicit test-build probe of the six real starter meshes, never a frame hook. */
export function mannequinShadowProbe(scene: Scene, modelOnly = false) {
  if (scene.meshes.length > 512) throw new Error("Mannequin scene probe limit exceeded");
  const meshes = scene.meshes.filter(mesh => names.has(mesh.name));
  if (meshes.length !== 6) throw new Error(`Expected six mannequin parts, got ${meshes.length}`);
  let saved = originals.get(scene);
  if (!saved) { saved = new Map(); originals.set(scene, saved); }
  const controller = sceneShadowController(scene);
  for (const mesh of scene.meshes) {
    if (!saved.has(mesh)) saved.set(mesh, mesh.metadata?.slateShadowParticipation);
    const original = saved.get(mesh);
    controller.setParticipation(mesh, modelOnly ? { ...original, castShadows: names.has(mesh.name) } : original ?? {});
    if (!modelOnly && !original && mesh.metadata) delete mesh.metadata.slateShadowParticipation;
  }
  return meshes.map(mesh => {
    const world = mesh.computeWorldMatrix(true);
    const normalMatrix = Matrix.Transpose(Matrix.Invert(world));
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
    const normals = mesh.getVerticesData(VertexBuffer.NormalKind)!;
    if (positions.length > 4096) throw new Error("Mannequin geometry probe limit exceeded");
    const vertices = [];
    for (let i = 0; i < positions.length; i += 3) vertices.push({
      position: Vector3.TransformCoordinates(Vector3.FromArray(positions, i), world).asArray(),
      normal: Vector3.TransformNormal(Vector3.FromArray(normals, i), normalMatrix).normalize().asArray(),
      localPosition: Array.from(positions.slice(i, i + 3)),
      localNormal: Array.from(normals.slice(i, i + 3)),
    });
    return { name: mesh.name, vertices, indices: Array.from(mesh.getIndices()!), material: mesh.material?.getClassName() };
  });
}

/** Exclude foreground editor geometry from contact tests, not shadow boundaries. */
export function mannequinShadowVisibility(scene: Scene, points: { worldPosition: number[]; region: string }[]) {
  if (points.length > 8192) throw new Error("Mannequin visibility probe limit exceeded");
  const camera = scene.activeCamera!.globalPosition;
  return points.map(point => {
    const offset = Vector3.FromArray(point.worldPosition).subtract(camera);
    const ray = new Ray(camera, offset.normalizeToNew(), offset.length() + 0.001);
    const picked = scene.pickWithRay(ray, mesh => mesh.isEnabled() && mesh.isVisible && mesh.visibility > 0 && mesh.getTotalVertices() > 0);
    return picked?.pickedMesh?.name === point.region;
  });
}
