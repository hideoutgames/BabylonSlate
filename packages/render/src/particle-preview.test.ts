import { afterEach, describe, expect, it } from "vitest";
import { createDefaultMaterialDocument } from "@babylonslate/shader-graph";
import { createTestEngine } from "./create-null-engine";
import {
  createParticleMaterialResolver,
  createParticlePreviewScene,
} from "./particle-preview";

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

  it("compiles a particle-domain material for Preview createEffectForParticles", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const host = createParticlePreviewScene(handle.engine);
    const resolver = createParticleMaterialResolver({
      scene: host.scene,
      documents: new Map([
        ["mat-1", createDefaultMaterialDocument("Sparks", "particle")],
      ]),
    });
    const material = resolver.resolve("mat-1");
    expect(material).toBeTruthy();
    expect(material?.mode).toBe(2);
    expect(resolver.resolve("missing")).toBeNull();
    resolver.dispose();
    host.dispose();
  });
});
