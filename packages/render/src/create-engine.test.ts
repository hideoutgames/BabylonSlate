import { describe, expect, it, afterEach } from "vitest";
import { createTestEngine } from "./create-null-engine";
import { setupDefaultViewport } from "./create-engine";

describe("create-engine", () => {
  const handles: Array<{ engine: { dispose: () => void }; scene: { dispose: () => void } }> =
    [];

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

  it("setupDefaultViewport adds an active camera and hemispheric light", () => {
    const { scene } = createHandle();
    setupDefaultViewport(scene);

    expect(scene.activeCamera).not.toBeNull();
    expect(scene.getCameraByName("camera")).not.toBeNull();
    expect(scene.getLightByName("light")).not.toBeNull();
  });
});
