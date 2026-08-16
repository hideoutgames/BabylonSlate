import {
  ArcRotateCamera,
  Color4,
  HemisphericLight,
  MeshBuilder,
  Scene,
  Vector3,
  type Engine,
  type Mesh,
  type NodeMaterial,
  type PostProcess,
} from "@babylonjs/core";
import type { MaterialPreviewMesh } from "@babylonslate/shader-graph";
import { createMeshFromModelBytes } from "./model-mesh";

export const MATERIAL_PREVIEW_MESH_NAME = "materialPreviewMesh";

/** Keep orbit/pinch pivoted on the mesh, including custom Models that are off-origin. */
export function aimPreviewCameraAtMesh(
  camera: ArcRotateCamera,
  mesh: Mesh,
): void {
  mesh.computeWorldMatrix(true);
  const bounds = mesh.getBoundingInfo();
  camera.setTarget(bounds.boundingBox.centerWorld.clone());
}

/**
 * Build the preview primitive for a Material document.
 *
 * Cone is a cylinder with a zero top diameter, and Plane is the 2D quad so a
 * sprite-style material can be judged flat-on.
 */
export function createMaterialPreviewMesh(
  scene: Scene,
  kind: MaterialPreviewMesh,
  customMeshBytes?: Uint8Array | null,
): Mesh {
  const name = MATERIAL_PREVIEW_MESH_NAME;
  switch (kind) {
    case "cube":
      return MeshBuilder.CreateBox(name, { size: 1.4 }, scene);
    case "cylinder":
      return MeshBuilder.CreateCylinder(
        name,
        { height: 1.8, diameter: 1.2 },
        scene,
      );
    case "cone":
      return MeshBuilder.CreateCylinder(
        name,
        { height: 1.8, diameterTop: 0, diameterBottom: 1.4 },
        scene,
      );
    case "plane":
      return MeshBuilder.CreatePlane(name, { size: 1.8 }, scene);
    case "custom": {
      if (customMeshBytes && customMeshBytes.byteLength > 0) {
        const loaded = createMeshFromModelBytes(scene, name, customMeshBytes);
        if (loaded) return loaded;
      }
      // Fall back to the sphere so an unresolved pick still previews.
      return MeshBuilder.CreateSphere(name, { diameter: 1.6 }, scene);
    }
    case "sphere":
    default:
      return MeshBuilder.CreateSphere(
        name,
        { diameter: 1.6, segments: 32 },
        scene,
      );
  }
}

export interface MaterialPreviewScene {
  scene: Scene;
  camera: ArcRotateCamera;
  /** Current preview mesh; replaced when the primitive choice changes. */
  mesh: Mesh;
  setMesh: (
    kind: MaterialPreviewMesh,
    customMeshBytes?: Uint8Array | null,
  ) => Mesh;
  applyMaterial: (material: NodeMaterial | null) => void;
  applyPostProcess: (material: NodeMaterial | null) => void;
  dispose: () => void;
}

/**
 * A disposable Scene on the shared app Engine.
 *
 * The editor keeps one Engine for its lifetime, so a Material tab adds a Scene
 * and a view rather than a second WebGL context.
 */
export function createMaterialPreviewScene(
  engine: Engine,
  options: {
    mesh?: MaterialPreviewMesh;
    customMeshBytes?: Uint8Array | null;
  } = {},
): MaterialPreviewScene {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.05, 0.05, 0.07, 1);
  scene.skipPointerMovePicking = true;

  const camera = new ArcRotateCamera(
    "materialPreviewCamera",
    -Math.PI / 3,
    Math.PI / 2.6,
    4,
    Vector3.Zero(),
    scene,
  );
  camera.lowerRadiusLimit = 1.6;
  camera.upperRadiusLimit = 12;
  camera.wheelDeltaPercentage = 0.02;
  camera.panningSensibility = 0;
  camera.pinchPrecision = 24;
  camera.pinchDeltaPercentage = 0.02;
  camera.useNaturalPinchZoom = true;

  const key = new HemisphericLight(
    "materialPreviewLight",
    new Vector3(0.4, 1, 0.6),
    scene,
  );
  key.intensity = 1.1;
  const fill = new HemisphericLight(
    "materialPreviewFill",
    new Vector3(-0.6, -0.4, -0.8),
    scene,
  );
  fill.intensity = 0.35;

  let mesh = createMaterialPreviewMesh(
    scene,
    options.mesh ?? "sphere",
    options.customMeshBytes,
  );
  aimPreviewCameraAtMesh(camera, mesh);
  let postProcess: PostProcess | null = null;

  const disposePostProcess = () => {
    if (!postProcess) return;
    postProcess.dispose(camera);
    postProcess = null;
  };

  const host: MaterialPreviewScene = {
    scene,
    camera,
    get mesh() {
      return mesh;
    },
    setMesh: (kind, customMeshBytes) => {
      const material = mesh.material;
      mesh.dispose();
      mesh = createMaterialPreviewMesh(scene, kind, customMeshBytes);
      mesh.material = material;
      aimPreviewCameraAtMesh(camera, mesh);
      return mesh;
    },
    applyMaterial: (material) => {
      mesh.material = material;
    },
    applyPostProcess: (material) => {
      disposePostProcess();
      if (!material) return;
      postProcess = material.createPostProcess(camera) ?? null;
    },
    dispose: () => {
      disposePostProcess();
      scene.dispose();
    },
  };
  return host;
}
