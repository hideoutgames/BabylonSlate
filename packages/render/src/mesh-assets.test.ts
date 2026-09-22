import { describe, expect, it, vi } from "vitest";
import {
  Material,
  MeshBuilder,
  NullEngine,
  Scene,
  StandardMaterial,
  Texture,
} from "@babylonjs/core";
import { applyAlbedoTexture, installTextureBytes, meshAssetFingerprint, modelSlotFingerprint } from "./mesh-assets";
import { acquireMaterialTexture, ResourceCache } from "./resource-cache";
import { isDisposedGpuTexture } from "./gpu-resource-live";

describe("meshAssetFingerprint", () => {
  it("detects same-size texture replacements while retaining equal-content snapshot keys", () => {
    const original = meshAssetFingerprint({ textureBytes: new Map([["texture", new Uint8Array([1, 2, 3, 4, 5])]]) });
    expect(meshAssetFingerprint({ textureBytes: new Map([["texture", new Uint8Array([1, 2, 3, 4, 5])]]) })).toBe(original);
    expect(meshAssetFingerprint({ textureBytes: new Map([["texture", new Uint8Array([1, 9, 3, 4, 5])]]) })).not.toBe(original);
  });
  it("includes compiled CSS stack values so a fallback change rebuilds 2D text", () => {
    expect(meshAssetFingerprint({ fontCssStack: "A, sans-serif" })).not.toBe(
      meshAssetFingerprint({ fontCssStack: "B, sans-serif" }),
    );
    expect(
      meshAssetFingerprint({
        fontCssStackByGuid: new Map([["g", '"Display", sans-serif']]),
      }),
    ).not.toBe(
      meshAssetFingerprint({
        fontCssStackByGuid: new Map([["g", '"Other", sans-serif']]),
      }),
    );
  });
});

describe("modelSlotFingerprint", () => {
  it("changes when Model simple colliders change", () => {
    const base = {
      materialSlots: [] as { index: number; name: string; materialGuid: string | null }[],
      clipNames: [] as string[],
      skeletonGuid: null,
      importScale: 1,
      simpleColliders: [],
    };
    const empty = modelSlotFingerprint(new Map([["model-1", { ...base, simpleColliders: [] }]]));
    const withHull = modelSlotFingerprint(
      new Map([
        [
          "model-1",
          {
            ...base,
            simpleColliders: [
              {
                id: "hull",
                name: "Generated Collision",
                kind: "generated",
                position: [0, 0, 0],
                rotation: [0, 0, 0, 1],
                scale: [1, 1, 1],
                points: [{ x: 1, y: 0, z: 0 }],
              },
            ],
          },
        ],
      ]),
    );
    expect(withHull).not.toBe(empty);
  });
});

describe("applyAlbedoTexture", () => {
  it("reapplies equal installed content without acquiring and clears its exact binding", () => {
    const engine = new NullEngine(); const scene = new Scene(engine); const cache = new ResourceCache();
    const mesh = MeshBuilder.CreatePlane("sprite", {}, scene);
    const acquire = vi.spyOn(cache, "acquireTexture");
    const bytes = new Uint8Array([1, 2, 3, 4]);
    applyAlbedoTexture(mesh, scene, "atlas", { resourceCache: cache, textureBytes: installTextureBytes(new Map([["atlas", bytes]])) });
    applyAlbedoTexture(mesh, scene, "atlas", { resourceCache: cache, textureBytes: installTextureBytes(new Map([["atlas", bytes.slice()]])) });
    expect(acquire).toHaveBeenCalledOnce();
    applyAlbedoTexture(mesh, scene, null, { resourceCache: cache });
    expect((mesh.material as StandardMaterial).diffuseTexture).toBeNull();
    expect(cache.resourceStats().leases).toBe(0);
    scene.dispose(); cache.dispose(); engine.dispose();
  });
  it("keeps the material and binding stable across 10,000 repeated sprite selections", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const cache = new ResourceCache();
    const mesh = MeshBuilder.CreatePlane("sprite", {}, scene);
    const assets = { resourceCache: cache, textureBytes: installTextureBytes(new Map([["atlas", new Uint8Array([1, 2, 3, 4])]])) };
    applyAlbedoTexture(mesh, scene, "atlas", assets);
    const material = mesh.material;
    for (let i = 0; i < 10_000; i++) applyAlbedoTexture(mesh, scene, "atlas", assets);
    expect(mesh.material).toBe(material);
    scene.dispose();
    cache.flushUnreferenced();
    expect(isDisposedGpuTexture((material as StandardMaterial).diffuseTexture!)).toBe(true);
    cache.dispose();
    engine.dispose();
  });
  it("does not dispose a live material Texture when overlay sampling flags differ", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const cache = new ResourceCache({ byteCeiling: 8 * 1024 * 1024 });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const albedoLease = acquireMaterialTexture(cache, "tex-1", engine, bytes);
    const albedo = albedoLease?.resource ?? null;
    expect(albedo).not.toBeNull();
    const mesh = MeshBuilder.CreatePlane("overlay", { size: 1 }, scene);
    applyAlbedoTexture(mesh, scene, "tex-1", {
      resourceCache: cache,
      textureBytes: new Map([["tex-1", bytes]]),
    });
    expect(isDisposedGpuTexture(albedo!)).toBe(false);
    expect(albedo!.invertY).toBe(false);
    expect(albedo!.hasAlpha).toBe(false);
    const overlay = mesh.material as StandardMaterial;
    expect(overlay.diffuseTexture).not.toBe(albedo);
    expect((overlay.diffuseTexture as Texture | null)?.invertY).toBe(true);
    // Explicit alpha test runs after alpha composition in StandardMaterial;
    // without hasAlpha the diffuse alpha is never included in that composition.
    expect(overlay.getAlphaTestTexture()?.hasAlpha).toBe(true);
    expect(overlay.useAlphaFromDiffuseTexture).toBe(true);
    expect(overlay.transparencyMode).toBe(Material.MATERIAL_ALPHATEST);
    cache.dispose();
    scene.dispose();
    engine.dispose();
  });
});
