import { afterEach, describe, expect, it } from "vitest";
import { createTestEngine } from "./create-null-engine";
import { createParticlePreviewScene } from "./particle-preview";

describe("createParticlePreviewScene", () => {
  const handles: Array<{ engine: { dispose: () => void } }> = [];

  afterEach(() => {
    while (handles.length > 0) {
      handles.pop()?.engine.dispose();
    }
  });

  it("builds a disposable Scene on the shared Engine with a hidden mesh", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const host = createParticlePreviewScene(handle.engine);
    expect(host.scene).toBeTruthy();
    expect(host.camera).toBeTruthy();
    expect(host.mesh.isVisible).toBe(false);
    host.dispose();
  });
});
