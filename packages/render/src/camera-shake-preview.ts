import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import { CameraShakeView, type CameraShakeViewOffset } from "./camera-shake-view";
import { installEngineDefaultMaterial } from "./default-material";
import { installPreviewEnvironment } from "./preview-environment";
import { createPreviewLighting } from "./preview-lighting";
import { SceneRenderCoordinator } from "./scene-render-coordinator";

/** A Camera Shake editor's preview: a small set seen through a camera the shake moves. */
export interface CameraShakePreviewScene {
  scene: Scene;
  camera: UniversalCamera;
  renderer: SceneRenderCoordinator;
  /** The whole set, one mesh, so the presenter waits for one draw. */
  mesh: Mesh;
  /** The shake offset the next frames draw with; null draws the set still. */
  setOffset(offset: CameraShakeViewOffset | null): void;
  dispose(): void;
  /** Disposes, then resolves once the renderer's native resources are released and the Scene is disposed. */
  whenReleased(): Promise<void>;
}

/** Pillars around the view at increasing distance, so near and far parts move apart as the camera shakes. */
const PILLARS: ReadonlyArray<readonly [x: number, z: number, height: number]> = [
  [-3, 2, 2.4], [3, 2, 2.4], [-3, 6, 3], [3, 6, 3], [-3, 10, 3.6], [3, 10, 3.6], [0, 14, 4.2],
];
const CRATES: ReadonlyArray<readonly [x: number, z: number, size: number]> = [
  [0, 3, 0.8], [-1.2, 5, 0.6], [1.4, 8, 1],
];

/**
 * Builds the preview set from runtime primitives in code: a ground quad, seven pillars and three crates, merged
 * into one mesh (about 130 triangles, one draw, nothing stored on disk), lit by the preview lights on the engine
 * default Material, under the engine default sky as other asset previews are. The camera stands where a player
 * would, looking down the corridor.
 */
export function createCameraShakePreviewScene(engine: AbstractEngine): CameraShakePreviewScene {
  const scene = new Scene(engine);
  scene.skipPointerMovePicking = true;
  // The camera renders into `outputRenderTarget`, so this clears the preview RTT, not the shared framebuffer.
  scene.autoClear = true;
  installEngineDefaultMaterial(scene);

  const camera = new UniversalCamera("cameraShakePreviewCamera", new Vector3(0, 1.6, -4), scene);
  camera.inputs.clear();
  camera.minZ = 0.05;
  camera.maxZ = 100;
  camera.setTarget(new Vector3(0, 1.2, 8));

  createPreviewLighting(scene);
  const renderer = new SceneRenderCoordinator(scene, { waterPlanarReflections: false });
  installPreviewEnvironment(scene);

  const parts: Mesh[] = [MeshBuilder.CreateGround("cameraShakePreviewGround", { width: 14, height: 26 }, scene)];
  parts[0]!.position.z = 7;
  for (const [x, z, height] of PILLARS) {
    const pillar = MeshBuilder.CreateBox("cameraShakePreviewPillar", { width: 0.5, depth: 0.5, height }, scene);
    pillar.position.set(x, height / 2, z);
    parts.push(pillar);
  }
  for (const [x, z, size] of CRATES) {
    const crate = MeshBuilder.CreateBox("cameraShakePreviewCrate", { size }, scene);
    crate.position.set(x, size / 2, z);
    crate.rotation.y = x * 0.4;
    parts.push(crate);
  }
  const mesh = Mesh.MergeMeshes(parts, true, false) ?? parts[0]!;
  mesh.name = "cameraShakePreviewSet";
  mesh.freezeWorldMatrix();

  const shake = new CameraShakeView(scene, () => camera);

  let released: Promise<void> | null = null;
  const release = () => {
    released ??= renderer.whenReleased().then(() => {
      if (!scene.isDisposed) scene.dispose();
    });
    return released;
  };
  const host: CameraShakePreviewScene = {
    scene,
    camera,
    renderer,
    mesh,
    setOffset: (offset) => shake.set(offset),
    dispose: () => {
      shake.dispose();
      void release().catch((error: unknown) => {
        console.warn(`[render] Camera Shake preview scene is quarantined until actual release: ${String(error)}`);
      });
    },
    whenReleased: () => {
      host.dispose();
      return release();
    },
  };
  return host;
}
