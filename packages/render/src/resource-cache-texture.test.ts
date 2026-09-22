import { afterEach, describe, expect, it, vi } from "vitest";
import { NullEngine, PBRMaterial, Texture } from "@babylonjs/core";
import {
  bindResourceCacheToHandle,
  acquireMaterialTexture,
  ResourceCache,
  resourceCacheForEngine,
  releaseResourceCacheForEngine,
} from "./resource-cache";
import { isDisposedGpuTexture } from "./gpu-resource-live";
import { accountedTextureBytes } from "./texture-bytes";
import { pickAtCanvas } from "./picking";
import { Scene } from "@babylonjs/core/scene";

// NullEngine reports a configurable synthetic upload size and has no cube IO.
// Keep native wrappers/refcounts while admitting small valid upload stand-ins.
function textureEngine() {
  const engine = new NullEngine({ renderWidth: 64, renderHeight: 64, textureSize: 16,
    deterministicLockstep: false, lockstepMaxSteps: 4 });
  vi.spyOn(engine, "createCubeTexture").mockImplementation((url, _scene, _files, noMipmap) => {
    const internal = engine.createTexture(url, noMipmap ?? false, false, null);
    internal.isCube = true;
    return internal;
  });
  return engine;
}
afterEach(() => vi.restoreAllMocks());

describe("resource cache getTexture", () => {
  it("keeps exact source URL generations leased independently of GPU wrappers", () => {
    const cache = new ResourceCache();
    const owner = bindResourceCacheToHandle(cache);
    const old = owner.cache.acquireBlobUrl("same-guid", new Uint8Array([1, 2, 3]));
    const next = owner.cache.acquireBlobUrl("same-guid", new Uint8Array([1, 2, 4]));
    expect(old.key).not.toBe(next.key);
    cache.flushUnreferenced();
    expect(cache.resourceStats()).toMatchObject({ generations: 2, leases: 2 });
    for (let i = 0; i < 10_000; i++) expect(old.resource).toBeTruthy();
    next.release(); next.release();
    cache.flushUnreferenced();
    expect(cache.resourceStats()).toMatchObject({ generations: 1, leases: 1 });
    owner.releaseHandleRetains();
    expect(cache.resourceStats()).toEqual({ generations: 0, leases: 0, wrappers: 0, pending: 0 });
  });
  it("honors the largest live view budget regardless of update order", () => {
    const cache = new ResourceCache({ byteCeiling: 100 });
    const high = {};
    const low = {};
    cache.setClientBudget(high, 1000);
    cache.setClientBudget(low, 100);
    cache.account("resident", 500);
    cache.releaseAccounting("resident");
    cache.setClientBudget(low, 200);
    expect(cache.accountedBytes()).toBe(500);
    cache.setClientBudget(high, null);
    expect(cache.accountedBytes()).toBe(0);
    cache.dispose();
  });
  it("keeps concurrent texture representations alive until their own views release them", () => {
    const engine = textureEngine();
    const cache = new ResourceCache();
    const sceneView = bindResourceCacheToHandle(cache);
    const materialView = bindResourceCacheToHandle(cache);
    const original = new Uint8Array([1, 2, 3]);
    const reduced = new Uint8Array([1, 2, 4]);
    const firstLease = sceneView.cache.acquireTexture("shared", engine, reduced);
    const first = firstLease.resource;
    const secondLease = materialView.cache.acquireTexture("shared", engine, original);
    const second = secondLease.resource;
    const disposeFirst = vi.spyOn(first, "dispose");
    const disposeSecond = vi.spyOn(second, "dispose");
    const readLease = cache.acquireTexture("shared", engine, reduced);
    expect(readLease.resource).toBe(first);
    readLease.release();
    materialView.releaseHandleRetains();
    expect(disposeSecond).toHaveBeenCalledOnce();
    expect(disposeFirst).not.toHaveBeenCalled();
    const rereadLease = cache.acquireTexture("shared", engine, reduced);
    expect(rereadLease.resource).toBe(first);
    rereadLease.release();
    sceneView.releaseHandleRetains();
    expect(disposeFirst).toHaveBeenCalledOnce();
    cache.dispose();
    engine.dispose();
  });
  it("reuses one Texture for the same guid + sampling key", () => {
    const engine = textureEngine();
    const cache = new ResourceCache({ byteCeiling: 8 * 1024 * 1024 });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const aLease = cache.acquireTexture("tex", engine, bytes, {
      samplingMode: Texture.TRILINEAR_SAMPLINGMODE,
    });
    const a = aLease.resource;
    const bLease = cache.acquireTexture("tex", engine, bytes, {
      samplingMode: Texture.TRILINEAR_SAMPLINGMODE,
    });
    const b = bLease.resource;
    expect(a).toBe(b);
    aLease.release();
    bLease.release();
    cache.flushUnreferenced();
    expect(cache.accountedBytes()).toBe(0);
    cache.dispose();
    engine.dispose();
  });

  it("rebuilds after releaseGpuTextures keeps the blob URL", () => {
    const engine = textureEngine();
    const cache = new ResourceCache({ byteCeiling: 8 * 1024 * 1024 });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const firstLease = cache.acquireTexture("tex", engine, bytes);
    const first = firstLease.resource;
    cache.releaseGpuTextures();
    const secondLease = cache.acquireTexture("tex", engine, bytes);
    const second = secondLease.resource;
    expect(second).not.toBe(first);
    expect(second.getInternalTexture()).not.toBeNull();
    cache.dispose();
    engine.dispose();
  });

  it("rebuilds a material texture after the cached instance was disposed", () => {
    const engine = textureEngine();
    const cache = new ResourceCache({ byteCeiling: 8 * 1024 * 1024 });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const firstLease = acquireMaterialTexture(cache, "tex", engine, bytes);
    const first = firstLease?.resource ?? null;
    expect(first).not.toBeNull();
    first!.dispose();
    const secondLease = acquireMaterialTexture(cache, "tex", engine, bytes);
    const second = secondLease?.resource ?? null;
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(second!.getInternalTexture()).not.toBeNull();
    cache.dispose();
    engine.dispose();
  });

  it("returns a distinct no-mip wrapper without disposing the mipped Texture", () => {
    const engine = textureEngine();
    const cache = new ResourceCache({ byteCeiling: 8 * 1024 * 1024 });
    const bytes = new Uint8Array([9, 9, 9]);
    const aLease = cache.acquireTexture("tex", engine, bytes, { noMipmap: false });
    const a = aLease.resource;
    const bLease = cache.acquireTexture("tex", engine, bytes, { noMipmap: true });
    const b = bLease.resource;
    expect(b).not.toBe(a);
    expect(isDisposedGpuTexture(a)).toBe(false);
    expect(a.getInternalTexture()).not.toBeNull();
    expect((b as Texture).getInternalTexture()).not.toBeNull();
    const nomipUrl = (b as Texture).url ?? "";
    expect(nomipUrl.startsWith("blob:")).toBe(true);
    expect(nomipUrl).not.toContain("#nomip");
    expect(nomipUrl).not.toContain("#ninv");
    expect(nomipUrl).not.toBe((a as Texture).url);
    const againLease = cache.acquireTexture("tex", engine, bytes, { noMipmap: true });
    const again = againLease.resource;
    expect(again).toBe(b);
    cache.dispose();
    engine.dispose();
  });

  it("revokes extra object URLs when the cache entry is disposed", () => {
    const revoked: string[] = [];
    const original = URL.revokeObjectURL.bind(URL);
    const spy = vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => {
      revoked.push(String(url));
      original(url);
    });
    const engine = textureEngine();
    const cache = new ResourceCache({ byteCeiling: 8 * 1024 * 1024 });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const aLease = cache.acquireTexture("tex", engine, bytes);
    const a = aLease.resource;
    const bLease = cache.acquireTexture("tex", engine, bytes, {
      noMipmap: true,
    });
    const b = bLease.resource as Texture;
    const extra = (b.url ?? "").split("#")[0] ?? "";
    expect(extra.startsWith("blob:")).toBe(true);
    expect(extra).not.toBe(((a as Texture).url ?? "").split("#")[0]);
    cache.dispose();
    expect(revoked).toContain(extra);
    spy.mockRestore();
    engine.dispose();
  });

  it("revokes extra object URLs when flushUnreferenced evicts", () => {
    const revoked: string[] = [];
    const original = URL.revokeObjectURL.bind(URL);
    const spy = vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => {
      revoked.push(String(url));
      original(url);
    });
    const engine = textureEngine();
    const cache = new ResourceCache({ byteCeiling: 8 * 1024 * 1024 });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const aLease = cache.acquireTexture("tex", engine, bytes);
    const a = aLease.resource;
    const bLease = cache.acquireTexture("tex", engine, bytes, {
      noMipmap: true,
    });
    const b = bLease.resource as Texture;
    const extra = (b.url ?? "").split("#")[0] ?? "";
    aLease.release();
    bLease.release();
    cache.flushUnreferenced();
    expect(revoked).toContain(extra);
    expect(revoked).toContain(((a as Texture).url ?? "").split("#")[0]);
    spy.mockRestore();
    engine.dispose();
  });

  it("keeps glTF invertY false on a distinct wrapper from sprite albedo", () => {
    const engine = textureEngine();
    const cache = new ResourceCache({ byteCeiling: 8 * 1024 * 1024 });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const spriteLease = cache.acquireTexture("shared", engine, bytes, {
      noMipmap: true,
      samplingMode: Texture.NEAREST_SAMPLINGMODE,
    });
    const sprite = spriteLease.resource;
    const materialLease = acquireMaterialTexture(cache, "shared", engine, bytes);
    const material = materialLease?.resource ?? null;
    expect(sprite).toBeInstanceOf(Texture);
    expect((sprite as Texture).invertY).toBe(true);
    const spriteUrl = (sprite as Texture).url ?? "";
    expect(spriteUrl.startsWith("blob:")).toBe(true);
    expect(spriteUrl).not.toContain("#nomip");
    expect(spriteUrl).not.toContain("#ninv");
    expect(material).not.toBeNull();
    expect(material).not.toBe(sprite);
    expect(material!.invertY).toBe(false);
    expect(material!.url ?? "").not.toContain("#ninv");
    expect(material!.url ?? "").not.toContain("#nomip");
    expect(isDisposedGpuTexture(sprite)).toBe(false);
    cache.dispose();
    engine.dispose();
  });

  it("tells Babylon to use the KTX2 loader for packed ktx2 bytes", () => {
    const ktx2 = new Uint8Array([
      0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
      1, 2, 3, 4,
    ]);
    const engine = textureEngine();
    const cache = new ResourceCache({ byteCeiling: 8 * 1024 * 1024 });
    const textureLease = cache.acquireTexture("tex", engine, ktx2);
    const texture = textureLease.resource;
    const loaderHints = texture as unknown as {
      mimeType?: string;
      _mimeType?: string;
      _forcedExtension?: string;
    };
    expect(loaderHints.mimeType ?? loaderHints._mimeType).toBe("image/ktx2");
    expect(loaderHints._forcedExtension).toBe(".ktx2");
    expect(texture.name || texture.url).toMatch(/#\.ktx2$/);
    cache.dispose();
    engine.dispose();
  });

  it("loads a no-mip KTX2 wrapper from a second blob URL with only #.ktx2", () => {
    const ktx2 = new Uint8Array([
      0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
      1, 2, 3, 4,
    ]);
    const engine = textureEngine();
    const cache = new ResourceCache({ byteCeiling: 8 * 1024 * 1024 });
    const mippedLease = cache.acquireTexture("tex", engine, ktx2);
    const mipped = mippedLease.resource;
    const pixelArtLease = cache.acquireTexture("tex", engine, ktx2, {
      noMipmap: true,
      samplingMode: Texture.NEAREST_SAMPLINGMODE,
    });
    const pixelArt = pixelArtLease.resource as Texture;
    expect(pixelArt).not.toBe(mipped);
    const pixelArtUrl = pixelArt.url ?? "";
    expect(pixelArtUrl).toMatch(/#\.ktx2$/);
    expect(pixelArtUrl).not.toContain("#nomip");
    expect(pixelArtUrl.split("#")[0]).not.toBe((mipped.url ?? "").split("#")[0]);
    expect(isDisposedGpuTexture(mipped)).toBe(false);
    cache.dispose();
    engine.dispose();
  });

  it("builds a cube texture when isCube is set", () => {
    const engine = textureEngine();
    const cache = new ResourceCache({ byteCeiling: 8 * 1024 * 1024 });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const cubeLease = cache.acquireTexture("env", engine, bytes, { isCube: true });
    const cube = cubeLease.resource;
    expect(cube.isCube).toBe(true);
    cache.dispose();
    engine.dispose();
  });

  it("builds a six-face cube in px py pz nx ny nz order", () => {
    const engine = textureEngine();
    const scene = new Scene(engine);
    const cache = new ResourceCache({ byteCeiling: 8 * 1024 * 1024 });
    const files = [
      "blob:px",
      "blob:py",
      "blob:pz",
      "blob:nx",
      "blob:ny",
      "blob:nz",
    ];
    const cubeLease = cache.acquireCubeTextureFromImages("sky-faces", scene, files);
    const cube = cubeLease.resource;
    expect(cube.isCube).toBe(true);
    expect(cube._files).toEqual(files);
    const againLease = cache.acquireCubeTextureFromImages("sky-faces", scene, files);
    const again = againLease.resource;
    expect(again).toBe(cube);
    const nearestLease = cache.acquireCubeTextureFromImages(
      "sky-faces",
      scene,
      files,
      true,
    );
    const nearest = nearestLease.resource;
    expect(nearest).not.toBe(cube);
    expect(isDisposedGpuTexture(cube)).toBe(false);
    cache.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("keeps a six-face cube off the scene so Play scene dispose cannot leak it", () => {
    const engine = textureEngine();
    const scene = new Scene(engine);
    const cache = new ResourceCache({ byteCeiling: 8 * 1024 * 1024 });
    const files = [
      "blob:px",
      "blob:py",
      "blob:pz",
      "blob:nx",
      "blob:ny",
      "blob:nz",
    ];
    const cubeLease = cache.acquireCubeTextureFromImages("sky-faces", scene, files);
    const cube = cubeLease.resource;
    expect(scene.textures.includes(cube)).toBe(false);
    expect(cube.getInternalTexture()).not.toBeNull();
    scene.dispose();
    expect(cube.getInternalTexture()).not.toBeNull();
    cache.dispose();
    expect(cube.getInternalTexture()).toBeNull();
    engine.dispose();
  });

  it("keeps a leased cube during unreferenced eviction", () => {
    const engine = textureEngine();
    const scene = new Scene(engine);
    const cache = new ResourceCache({ byteCeiling: 8 * 1024 * 1024 });
    const files = [
      "blob:px",
      "blob:py",
      "blob:pz",
      "blob:nx",
      "blob:ny",
      "blob:nz",
    ];
    const cubeLease = cache.acquireCubeTextureFromImages("engine-default-skybox", scene, files);
    const cube = cubeLease.resource;
    cache.flushUnreferenced();
    expect(isDisposedGpuTexture(cube)).toBe(false);
    expect(cube.getInternalTexture()).not.toBeNull();
    cache.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("does not dispose a cache cube when a Play PBR skybox material is disposed", () => {
    const engine = textureEngine();
    const playScene = new Scene(engine);
    const cache = new ResourceCache({ byteCeiling: 8 * 1024 * 1024 });
    const files = [
      "blob:px",
      "blob:py",
      "blob:pz",
      "blob:nx",
      "blob:ny",
      "blob:nz",
    ];
    const cubeLease = cache.acquireCubeTextureFromImages("engine-default-skybox", playScene, files);
    const cube = cubeLease.resource;
    const material = new PBRMaterial("play-skybox", playScene);
    material.reflectionTexture = cube;
    playScene.dispose();
    expect(isDisposedGpuTexture(cube)).toBe(false);
    expect(cube.getInternalTexture()).not.toBeNull();
    cache.dispose();
    engine.dispose();
  });

  it("logs eviction reason when flushing unreferenced", () => {
    const reasons: Array<{ id: string; reason: string }> = [];
    const cache = new ResourceCache({
      byteCeiling: 50,
      onEvict: (id, reason) => reasons.push({ id, reason }),
    });
    cache.account("gone", 80);
    cache.releaseAccounting("gone");
    cache.flushUnreferenced();
    expect(reasons.some((r) => r.id === "gone" && r.reason === "flush")).toBe(
      true,
    );
    cache.dispose();
  });

  it("trims unreferenced entries toward 80% of the ceiling", () => {
    const cache = new ResourceCache({ byteCeiling: 1000 });
    cache.account("old", 600);
    cache.releaseAccounting("old");
    cache.account("kept", 600);
    cache.releaseAccounting("kept");
    expect(cache.accountedBytes()).toBeLessThanOrEqual(800);
    expect(cache.accountedBytes()).toBe(600);
    cache.dispose();
  });
});

describe("Play texture cache invariant with getTexture", () => {
  it("Play open/close cycle does not grow accounted bytes after flush", () => {
    const engine = textureEngine();
    const before = engine.getLoadedTexturesCache().length;
    const cache = new ResourceCache({ byteCeiling: 8 * 1024 * 1024 });
    const bytes = new Uint8Array(32 * 32 * 4);
    // Editor retain
    const editorLease = cache.acquireTexture("shared", engine, bytes);
    cache.account("shared", accountedTextureBytes(32, 32, "rgba8", true));
    // Play retain (same guid + sampling → same Texture)
    const playLease = cache.acquireTexture("shared", engine, bytes);
    // Play release
    playLease.release();
    // Editor still holds one ref — flush must keep entry
    cache.flushUnreferenced();
    expect(cache.accountedBytes()).toBeGreaterThan(0);
    // Editor release + flush
    editorLease.release();
    cache.flushUnreferenced();
    expect(cache.accountedBytes()).toBe(0);
    expect(engine.getLoadedTexturesCache().length).toBeLessThanOrEqual(before + 1);
    cache.dispose();
    engine.dispose();
  });
});

describe("explicit tap picking", () => {
  it("returns null when nothing is hit", () => {
    const engine = textureEngine();
    const scene = new Scene(engine);
    expect(pickAtCanvas(scene, 0, 0)).toBeNull();
    scene.dispose();
    engine.dispose();
  });

  it("walks parents to resolve tilemap chunk hits to actor-N slotId", () => {
    const engine = textureEngine();
    const scene = new Scene(engine);
    const root = { name: "actor-7", parent: null };
    const chunk = { name: "actor-7:layer:0:0", parent: root };
    vi.spyOn(scene, "pick").mockReturnValue({
      hit: true,
      pickedMesh: chunk,
    } as never);

    const hit = pickAtCanvas(scene, 12, 34);
    expect(hit).toMatchObject({ meshName: "actor-7", slotId: 7 });
    expect(scene.pick).toHaveBeenCalledWith(12, 34, undefined, false);

    scene.dispose();
    engine.dispose();
  });

  it("returns the mesh name with null slotId when no actor-* ancestor exists", () => {
    const engine = textureEngine();
    const scene = new Scene(engine);
    const mesh = { name: "gizmo-ring", parent: null };
    vi.spyOn(scene, "pick").mockReturnValue({
      hit: true,
      pickedMesh: mesh,
    } as never);

    expect(pickAtCanvas(scene, 1, 2)).toMatchObject({
      meshName: "gizmo-ring",
      slotId: null,
    });

    scene.dispose();
    engine.dispose();
  });
});

describe("resourceCacheForEngine", () => {
  it("returns the same ResourceCache for one Engine and a distinct cache per Engine", () => {
    const engineA = textureEngine();
    const engineB = textureEngine();
    const first = resourceCacheForEngine(engineA);
    const second = resourceCacheForEngine(engineA);
    const other = resourceCacheForEngine(engineB);
    expect(first).toBe(second);
    expect(other).not.toBe(first);
    releaseResourceCacheForEngine(engineA);
    releaseResourceCacheForEngine(engineB);
    engineA.dispose();
    engineB.dispose();
  });

  it("returns a new ResourceCache after releaseResourceCacheForEngine", () => {
    const engine = textureEngine();
    const first = resourceCacheForEngine(engine);
    releaseResourceCacheForEngine(engine);
    const second = resourceCacheForEngine(engine);
    expect(second).not.toBe(first);
    releaseResourceCacheForEngine(engine);
    engine.dispose();
  });
});

describe("encode queue pause reasons (editor helper contract)", () => {
  it("documents reason-set semantics via local mirror", () => {
    // Mirror of apps/editor encode-queue-pause — keeps render package free of editor imports.
    const reasons = new Set<string>();
    const paused = () => reasons.size > 0;
    reasons.add("visibility");
    reasons.add("play");
    expect(paused()).toBe(true);
    reasons.delete("play");
    expect(paused()).toBe(true);
    reasons.delete("visibility");
    expect(paused()).toBe(false);
    vi.clearAllMocks();
  });
});

describe("bindResourceCacheToHandle", () => {
  it.each(["enabled-first", "disabled-first"])("keeps a sibling's disabled budget policy regardless of update order (%s)", (order) => {
    const inner = new ResourceCache({ byteCeiling: 100 });
    const capped = bindResourceCacheToHandle(inner);
    const uncapped = bindResourceCacheToHandle(inner);
    const clients = order === "enabled-first" ? [capped, uncapped] : [uncapped, capped];
    for (const client of clients) {
      client.cache.setByteCeiling(100);
      client.cache.setBudgetEnabled(client === capped);
    }
    inner.account("resident", 500);
    inner.releaseAccounting("resident");
    capped.cache.setBudgetEnabled(true);
    expect(inner.accountedBytes()).toBe(500);
    uncapped.releaseHandleRetains();
    inner.account("after-detach", 500);
    inner.releaseAccounting("after-detach");
    inner.evictToCeiling();
    expect(inner.accountedBytes()).toBe(0);
    capped.releaseHandleRetains();
    inner.dispose();
  });

  it.each([true, false])("restores the cache's baseline enabled=%s after the last explicit view policy detaches", (enabled) => {
    const inner = new ResourceCache({ byteCeiling: 100, budgetEnabled: enabled });
    const bound = bindResourceCacheToHandle(inner);
    bound.cache.setByteCeiling(100);
    bound.cache.setBudgetEnabled(!enabled);
    inner.account("while-attached", 500);
    inner.releaseAccounting("while-attached");
    inner.evictToCeiling();
    expect(inner.accountedBytes()).toBe(enabled ? 500 : 0);
    bound.releaseHandleRetains();
    inner.account("after-detach", 500);
    inner.releaseAccounting("after-detach");
    inner.evictToCeiling();
    expect(inner.accountedBytes()).toBe(enabled ? 0 : 500);
    inner.dispose();
  });

  it("releases this handle's retains then flushes unreferenced GPU wrappers", () => {
    const engine = textureEngine();
    const inner = new ResourceCache({ byteCeiling: 8 * 1024 * 1024 });
    const bound = bindResourceCacheToHandle(inner);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const textureLease = bound.cache.acquireTexture("tex-scene", engine, bytes);
    const texture = textureLease.resource;
    bound.releaseHandleRetains();
    expect(isDisposedGpuTexture(texture)).toBe(true);
    inner.dispose();
    engine.dispose();
  });

  it("keeps textures still retained by another handle", () => {
    const engine = textureEngine();
    const inner = new ResourceCache({ byteCeiling: 8 * 1024 * 1024 });
    const editor = bindResourceCacheToHandle(inner);
    const play = bindResourceCacheToHandle(inner);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const textureLease = editor.cache.acquireTexture("tex-shared", engine, bytes);
    const texture = textureLease.resource;
    play.cache.acquireTexture("tex-shared", engine, bytes).resource;
    play.releaseHandleRetains();
    expect(isDisposedGpuTexture(texture)).toBe(false);
    editor.releaseHandleRetains();
    expect(isDisposedGpuTexture(texture)).toBe(true);
    inner.dispose();
    engine.dispose();
  });
});
