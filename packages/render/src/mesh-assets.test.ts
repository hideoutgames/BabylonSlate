import { describe, expect, it } from "vitest";
import {
  Material,
  MeshBuilder,
  NullEngine,
  Scene,
  StandardMaterial,
} from "@babylonjs/core";
import { applyAlbedoTexture, meshAssetFingerprint } from "./mesh-assets";
import { getMaterialTexture, ResourceCache } from "./resource-cache";
import { isDisposedGpuTexture } from "./gpu-resource-live";

describe("meshAssetFingerprint", () => {
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

describe("applyAlbedoTexture", () => {
  it("does not dispose a live material Texture when overlay sampling flags differ", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const cache = new ResourceCache({ byteCeiling: 8 * 1024 * 1024 });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const albedo = getMaterialTexture(cache, "tex-1", engine, bytes);
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
    expect(overlay.diffuseTexture).toBe(albedo);
    expect(overlay.transparencyMode).toBe(Material.MATERIAL_ALPHATEST);
    cache.dispose();
    scene.dispose();
    engine.dispose();
  });
});
