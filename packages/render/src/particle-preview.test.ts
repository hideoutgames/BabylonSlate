import { afterEach, describe, expect, it } from "vitest";
import { createDefaultMaterialDocument } from "@babylonslate/shader-graph";
import { createTestEngine } from "./create-null-engine";
import {
  createParticleMaterialResolver,
  createParticlePreviewScene,
} from "./particle-preview";
import { isSkyboxMesh } from "./skybox";

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
    expect(host.scene.meshes.some((mesh) => isSkyboxMesh(mesh))).toBe(false);
    host.dispose();
  });

  it("adds an unpickable default skybox when skybox is on", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const host = createParticlePreviewScene(handle.engine, { skybox: true });
    const skybox = host.scene.meshes.find((mesh) => isSkyboxMesh(mesh));
    expect(skybox).toBeTruthy();
    expect(skybox!.infiniteDistance).toBe(false);
    expect(skybox!.isPickable).toBe(false);
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
