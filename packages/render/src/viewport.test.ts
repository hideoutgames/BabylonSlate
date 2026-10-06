import { describe, expect, it, afterEach } from "vitest";
import { createTestEngine } from "./create-null-engine";
import { isEngineDefaultMaterial } from "./default-material";
import { setupDefaultViewport } from "./viewport";
import { DEFAULT_CAMERA_RADIUS } from "./editor-camera";

describe("viewport", () => {
  const handles: Array<{
    engine: { dispose: () => void };
    scene: { dispose: () => void };
  }> = [];

  afterEach(() => {
    while (handles.length > 0) {
      const handle = handles.pop();
      handle?.scene.dispose();
      handle?.engine.dispose();
    }
  });

  function createHandle() {
    const handle = createTestEngine();
    handles.push(handle);
    return handle;
  }

  it("adds an active camera without a default hemispheric light", () => {
    const { scene } = createHandle();
    setupDefaultViewport(scene);

    expect(scene.activeCamera).not.toBeNull();
    expect(scene.getCameraByName("camera")).not.toBeNull();
    expect(scene.getLightByName("light")).toBeNull();
    expect(scene.lights).toHaveLength(0);
    expect(isEngineDefaultMaterial(scene.defaultMaterial)).toBe(true);
  });

  it("frames the origin from the default radius", () => {
    const { scene } = createHandle();
    setupDefaultViewport(scene);

    const camera = scene.getCameraByName("camera");
    expect(camera!.position.length()).toBeCloseTo(DEFAULT_CAMERA_RADIUS, 1);
  });
});
