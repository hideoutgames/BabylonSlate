import { Camera } from "@babylonjs/core/Cameras/camera";
import { afterEach, describe, expect, it } from "vitest";
import { createTestEngine } from "./test-support/test-engine";
import { createWorldLayerCamera } from "./world-layer-camera";

const engines: Array<{ dispose(): void }> = [];
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); });

function layerCamera() {
  const { engine, scene } = createTestEngine();
  engines.push(engine);
  return createWorldLayerCamera(scene);
}

describe("createWorldLayerCamera", () => {
  it("starts orthographic on the origin, 500 units in front of the XY plane, framing 16 × 9", () => {
    const { camera } = layerCamera();
    expect(camera.mode).toBe(Camera.ORTHOGRAPHIC_CAMERA);
    expect(camera.position.asArray()).toEqual([0, 0, -500]);
    expect([camera.minZ, camera.maxZ]).toEqual([0.1, 1000]);
    expect([camera.orthoLeft, camera.orthoRight, camera.orthoBottom, camera.orthoTop]).toEqual([-8, 8, -4.5, 4.5]);
  });

  it("frames Layer Camera Width × Height widened to the buffer's aspect, divided by zoom, at its location and roll", () => {
    const layer = layerCamera();
    layer.set({ x: 4, y: -2, rotation: 90, zoom: 2 }, { width: 16, height: 9 });
    // A 2:1 buffer widens the 16 × 9 view to 18 × 9; zoom 2 halves it.
    layer.fit(2);
    const { camera } = layer;
    expect(camera.position.asArray()).toEqual([4, -2, -500]);
    expect(camera.rotation.z).toBeCloseTo(Math.PI / 2);
    expect([camera.orthoLeft, camera.orthoRight, camera.orthoBottom, camera.orthoTop]).toEqual([-4.5, 4.5, -2.25, 2.25]);
    // A taller buffer heightens the view instead: 16 × 16 at 1:1.
    layer.fit(1);
    expect([camera.orthoLeft, camera.orthoRight, camera.orthoBottom, camera.orthoTop]).toEqual([-4, 4, -4, 4]);
  });

  it("shows more world, not a larger one, for a pixelated buffer extended past its design size", () => {
    const layer = layerCamera();
    layer.fit(16 / 9, 1.5);
    expect(layer.camera.orthoTop).toBeCloseTo(4.5 * 1.5);
    expect(layer.camera.orthoRight).toBeCloseTo(8 * 1.5);
    layer.fit(16 / 9, 1);
    expect(layer.camera.orthoTop).toBeCloseTo(4.5);
  });
});
