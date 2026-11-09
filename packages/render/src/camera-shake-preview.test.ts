import { describe, expect, it } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { createCameraShakePreviewScene } from "./camera-shake-preview";
import { PREVIEW_SKYBOX_MESH_NAME } from "./preview-environment";
import { isSkyboxMesh } from "./skybox";
import { mockCubeTextureIO } from "./texture-test-fixtures";

describe("Camera Shake preview scene", () => {
  it("builds its set as one small mesh under the default sky and shakes its camera only while a frame draws", async () => {
    const engine = new NullEngine();
    mockCubeTextureIO(engine);
    const host = createCameraShakePreviewScene(engine);
    try {
      const sky = host.scene.getMeshByName(PREVIEW_SKYBOX_MESH_NAME);
      expect(sky && isSkyboxMesh(sky)).toBe(true);
      const meshes = host.scene.meshes.filter((mesh) => mesh !== sky && mesh.getTotalVertices() > 0);
      expect(meshes).toEqual([host.mesh]);
      expect(host.mesh.getTotalIndices() / 3).toBeLessThanOrEqual(150);
      const rest = host.camera.position.clone();
      // The camera looks straight down the set, so its right axis is world X.
      host.setOffset({ x: 0.25, y: 0, z: 0, pitch: 0, yaw: 0, roll: 0, fov: 0 });
      host.scene.onBeforeRenderObservable.notifyObservers(host.scene);
      expect(host.camera.position.x).toBeCloseTo(rest.x + 0.25, 6);
      host.scene.onAfterRenderObservable.notifyObservers(host.scene);
      expect(host.camera.position.asArray()).toEqual(rest.asArray());
    } finally {
      await host.whenReleased();
      engine.dispose();
    }
    expect(host.scene.isDisposed).toBe(true);
  });
});
