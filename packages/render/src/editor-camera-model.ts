import { Geometry, Mesh, VertexData, type Scene } from "@babylonjs/core";
import geometryData from "./editor-camera-geometry.json";
import { applyEditorBillboardPass } from "./editor-billboard";
import { setUnlitMaterial, type UnlitBinding, type UnlitMaterialKey } from "./unlit-material";

/** Its vertex colours, front faces only; editor helpers draw without fog. */
const CAMERA_MODEL_MATERIAL: UnlitMaterialKey = { textured: false, backFaceCulling: true, fog: false, role: "helper" };
const CAMERA_MODEL_BINDING: UnlitBinding = {
  texture: null, color: [1, 1, 1], alpha: 1, cutoff: 0, blend: false, textureAlpha: false, twoSided: false,
};

/** Outside Babylon's default camera mask; only the editor navigation camera opts in. */
export const EDITOR_CAMERA_MODEL_LAYER = 0x10000000;
export const EDITOR_CAMERA_MODEL_KIND = "editor-camera-model";

type CameraResources = {
  geometry: Geometry;
  users: number;
};
const resourcesByScene = new WeakMap<Scene, CameraResources>();

export function isEditorCameraModel(mesh: { metadata?: unknown }): boolean {
  return (mesh.metadata as { editorCameraModel?: boolean } | null)?.editorCameraModel === true;
}

/** Blender-authored solid camera, baked with its lens facing local +Z. */
export function createEditorCameraModel(scene: Scene, name: string): Mesh {
  let resources = resourcesByScene.get(scene);
  if (!resources) {
    const vertices = new VertexData();
    vertices.positions = geometryData.positions.map((value) => value / 10000);
    vertices.indices = geometryData.indices;
    vertices.colors = [];
    for (let i = 0; i < geometryData.colors.length; i += 3) {
      vertices.colors.push(
        geometryData.colors[i]! / 255,
        geometryData.colors[i + 1]! / 255,
        geometryData.colors[i + 2]! / 255,
        1,
      );
    }
    resources = {
      geometry: new Geometry("editorCameraGeometry", scene, vertices, false),
      users: 0,
    };
    resourcesByScene.set(scene, resources);
  }
  const mesh = new Mesh(name, scene);
  resources.geometry.applyToMesh(mesh);
  setUnlitMaterial(mesh, CAMERA_MODEL_MATERIAL, CAMERA_MODEL_BINDING);
  mesh.hasVertexAlpha = false;
  mesh.metadata = { editorCameraModel: true };
  mesh.layerMask = EDITOR_CAMERA_MODEL_LAYER;
  applyEditorBillboardPass(mesh);
  resources.users++;
  const shared = resources;
  mesh.onDisposeObservable.addOnce(() => {
    if (--shared.users !== 0) return;
    shared.geometry.dispose();
    resourcesByScene.delete(scene);
  });
  return mesh;
}
