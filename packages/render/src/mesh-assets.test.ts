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
import { createDefaultSpriteAnimationPayload, createDefaultSpritePayload } from "@babylonslate/assets";
import { createSpriteQuad } from "./sprite-quad";
import { applyAssignMaterial, createSnapshotSceneBinding } from "./snapshot-apply";
import { applyAnimStateToScene, sceneAnimHostFromBinding } from "./anim-apply";
import { constructionMaterialOf } from "./visual-meshes";

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
  function spriteFixture() {
    const engine = new NullEngine({ renderWidth: 64, renderHeight: 64, textureSize: 4,
      deterministicLockstep: false, lockstepMaxSteps: 1 });
    const scene = new Scene(engine);
    const cache = new ResourceCache();
    const sprite = createDefaultSpritePayload();
    sprite.textureGuid = "atlas";
    const mesh = createSpriteQuad(scene, "actor-1", sprite.frames[0]!);
    const assets = { resourceCache: cache, textureBytes: installTextureBytes(new Map([
      ["atlas", new Uint8Array([1, 2, 3])], ["next", new Uint8Array([1, 2, 4])],
    ]))! };
    const acquire = vi.spyOn(cache, "acquireTexture");
    applyAlbedoTexture(mesh, scene, "atlas", assets);
    const auto = mesh.material as StandardMaterial;
    const authored = new StandardMaterial("authored", scene);
    const binding = createSnapshotSceneBinding();
    binding.meshes.set(1, mesh);
    binding.meshAssetGuids.set(1, "sprite");
    binding.resolveMaterial = () => authored;
    const assign = (materialAssetGuid: string | null) => applyAssignMaterial(scene, binding, {
      type: "assignMaterial", slotId: 1, materialAssetGuid,
    });
    return { engine, scene, cache, sprite, mesh, assets, acquire, auto, authored, binding, assign,
      dispose: () => { scene.dispose(); cache.dispose(); engine.dispose(); } };
  }

  it("restores a static sprite's owned material immediately after clearing an authored assignment", () => {
    const f = spriteFixture();
    try {
      const construction = constructionMaterialOf(f.mesh);
      const texture = f.auto.diffuseTexture;
      const bounds = f.mesh.getBoundingInfo();
      f.authored.metadata = { boundsPadding: 2 };
      f.assign("authored");
      applyAlbedoTexture(f.mesh, f.scene, "atlas", f.assets);
      expect(f.mesh.material).toBe(f.authored);
      expect(f.scene.materials).toContain(construction);
      expect(f.cache.resourceStats().leases).toBe(1);
      f.assign(null);
      expect(f.mesh.material).toBe(f.auto);
      expect(f.mesh.getBoundingInfo()).toBe(bounds);
      expect(f.auto.diffuseTexture).toBe(texture);
      expect(f.acquire).toHaveBeenCalledOnce();
      f.mesh.dispose();
      expect(f.scene.materials).not.toContain(f.auto);
      expect(f.scene.materials).toContain(f.authored);
      expect(f.cache.resourceStats().leases).toBe(0);
    } finally { f.dispose(); }
  });

  it("resumes the latest animation texture after clearing an authored sprite material", async () => {
    const f = spriteFixture();
    try {
      const animation = createDefaultSpriteAnimationPayload();
      animation.frames[0]!.textureGuid = "next";
      const host = sceneAnimHostFromBinding(f.binding, {
        animationGroups: [], spritePayloads: new Map([["sprite", f.sprite]]),
        spriteAnimations: new Map([["animation", animation]]),
        applyTexture: (mesh, guid) => applyAlbedoTexture(mesh, mesh.getScene(), guid, f.assets),
      });
      const command = { type: "animState" as const, slotId: 1, stateId: "idle", normalisedTime: 0,
        blendWeights: { idle: 1 }, clipName: "Idle", clipKind: "sprite" as const, clipAssetGuid: "animation" };
      f.assign("authored");
      applyAnimStateToScene(host, command);
      expect(f.mesh.material).toBe(f.authored);
      expect(f.acquire).toHaveBeenCalledOnce();
      f.assign(null);
      applyAnimStateToScene(host, command);
      expect(f.acquire).toHaveBeenCalledTimes(2);
      const next = f.acquire.mock.results[1]!.value as ReturnType<ResourceCache["acquireTexture"]>;
      next.resource.getInternalTexture()!.isReady = true;
      next.resource.onLoadObservable.notifyObservers(next.resource as never);
      await next.ready;
      expect(f.mesh.material).toBe(f.auto);
      expect(f.auto.diffuseTexture).toBe(next.resource);
      expect(f.cache.resourceStats().leases).toBe(1);
      for (let i = 0; i < 100; i++) applyAnimStateToScene(host, command);
      expect(f.acquire).toHaveBeenCalledTimes(2);
      expect(f.scene.materials).toContain(f.authored);
    } finally { f.dispose(); }
  });

  it("does not let a pending sprite upload replace a newer authored material assignment", async () => {
    const f = spriteFixture();
    const nativeCreate = f.engine.createTexture.bind(f.engine);
    const create = vi.spyOn(f.engine, "createTexture").mockImplementation((...args) => {
      args[5] = null;
      const texture = nativeCreate(...args);
      texture.isReady = false;
      return texture;
    });
    try {
      applyAlbedoTexture(f.mesh, f.scene, "next", f.assets);
      const next = f.acquire.mock.results[1]!.value as ReturnType<ResourceCache["acquireTexture"]>;
      const previous = f.auto.diffuseTexture;
      f.assign("authored");
      expect(f.auto.diffuseTexture).toBe(previous);
      next.resource.getInternalTexture()!.isReady = true;
      next.resource.onLoadObservable.notifyObservers(next.resource as never);
      await next.ready;
      expect(f.mesh.material).toBe(f.authored);
      expect(f.auto.diffuseTexture).toBe(next.resource);
      f.assign(null);
      expect(f.mesh.material).toBe(f.auto);
      expect(f.auto.diffuseTexture).toBe(next.resource);
      expect(f.cache.resourceStats().leases).toBe(1);
    } finally { create.mockRestore(); f.dispose(); }
  });

  it("keeps the previous texture after upload failure and ignores an obsolete completion", async () => {
    const engine = new NullEngine(); const scene = new Scene(engine); const cache = new ResourceCache();
    const mesh = MeshBuilder.CreatePlane("sprite", {}, scene);
    const sources = installTextureBytes(new Map([
      ["first", new Uint8Array([1, 2, 3])], ["failed", new Uint8Array([1, 2, 4])], ["winner", new Uint8Array([1, 2, 5])],
    ]))!;
    const assets = { resourceCache: cache, textureBytes: sources };
    applyAlbedoTexture(mesh, scene, "first", assets);
    const material = mesh.material as StandardMaterial;
    const working = material.diffuseTexture;
    const nativeCreate = engine.createTexture.bind(engine);
    const failures: Array<NonNullable<Parameters<typeof engine.createTexture>[6]>> = [];
    const create = vi.spyOn(engine, "createTexture").mockImplementation((...args) => {
      failures.push(args[6]!); args[5] = null;
      const texture = nativeCreate(...args); texture.isReady = false; return texture;
    });
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      applyAlbedoTexture(mesh, scene, "failed", assets);
      expect(material.diffuseTexture).toBe(working);
      failures[0]!("controlled failure", undefined);
      await Promise.resolve();
      expect(material.diffuseTexture).toBe(working);
      expect(report).toHaveBeenCalledOnce();
      applyAlbedoTexture(mesh, scene, "winner", assets);
      const winner = cache.acquireTexture("winner", engine, sources.get("winner")!, { noMipmap: true, samplingMode: Texture.NEAREST_SAMPLINGMODE, anisotropicFilteringLevel: 1, hasAlpha: true });
      winner.resource.getInternalTexture()!.isReady = true;
      winner.resource.onLoadObservable.notifyObservers(winner.resource as never);
      await winner.ready;
      expect(material.diffuseTexture).toBe(winner.resource);
      failures[0]!("obsolete failure", undefined);
      await Promise.resolve();
      expect(material.diffuseTexture).toBe(winner.resource);
      expect(mesh.material).toBe(material);
      winner.release();
    } finally { create.mockRestore(); report.mockRestore(); scene.dispose(); cache.dispose(); engine.dispose(); }
  });
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
    // NullEngine reserves unknown-format 512x512 uploads as RGBA float.
    const cache = new ResourceCache({ byteCeiling: 16 * 1024 * 1024 });
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
