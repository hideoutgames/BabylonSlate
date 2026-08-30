import { describe, expect, it, vi } from "vitest";
import { NullEngine, PBRMaterial, Texture } from "@babylonjs/core";
import {
  bindResourceCacheToHandle,
  getMaterialTexture,
  ResourceCache,
  resourceCacheForEngine,
  releaseResourceCacheForEngine,
} from "./resource-cache";
import { isDisposedGpuTexture } from "./gpu-resource-live";
import { accountedTextureBytes } from "./texture-bytes";
import { pickAtCanvas } from "./picking";
import { Scene } from "@babylonjs/core/scene";

describe("resource cache getTexture", () => {
  it("reuses one Texture for the same guid + sampling key", () => {
    const engine = new NullEngine();
    const cache = new ResourceCache({ byteCeiling: 8 * 1024 * 1024 });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const a = cache.getTexture("tex", engine, bytes, {
      samplingMode: Texture.TRILINEAR_SAMPLINGMODE,
    });
    const b = cache.getTexture("tex", engine, bytes, {
      samplingMode: Texture.TRILINEAR_SAMPLINGMODE,
    });
    expect(a).toBe(b);
    cache.release("tex");
    cache.release("tex");
    cache.flushUnreferenced();
    expect(cache.accountedBytes()).toBe(0);
    cache.dispose();
    engine.dispose();
  });

  it("rebuilds after releaseGpuTextures keeps the blob URL", () => {
    const engine = new NullEngine();
    const cache = new ResourceCache({ byteCeiling: 8 * 1024 * 1024 });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const first = cache.getTexture("tex", engine, bytes);
    cache.releaseGpuTextures();
    const second = cache.getTexture("tex", engine, bytes);
    expect(second).not.toBe(first);
    expect(second.getInternalTexture()).not.toBeNull();
    cache.dispose();
    engine.dispose();
  });

  it("rebuilds a material texture after the cached instance was disposed", () => {
    const engine = new NullEngine();
    const cache = new ResourceCache({ byteCeiling: 8 * 1024 * 1024 });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const first = getMaterialTexture(cache, "tex", engine, bytes);
    expect(first).not.toBeNull();
    first!.dispose();
    const second = getMaterialTexture(cache, "tex", engine, bytes);
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(second!.getInternalTexture()).not.toBeNull();
    cache.dispose();
    engine.dispose();
  });

  it("returns a distinct no-mip wrapper without disposing the mipped Texture", () => {
    const engine = new NullEngine();
    const cache = new ResourceCache({ byteCeiling: 8 * 1024 * 1024 });
    const bytes = new Uint8Array([9, 9, 9]);
    const a = cache.getTexture("tex", engine, bytes, { noMipmap: false });
    const b = cache.getTexture("tex", engine, bytes, { noMipmap: true });
    expect(b).not.toBe(a);
    expect(isDisposedGpuTexture(a)).toBe(false);
    expect((b as Texture).url).toContain("#nomip");
    expect(((b as Texture).url.split("#")[1] ?? "")).not.toContain(":");
    const again = cache.getTexture("tex", engine, bytes, { noMipmap: true });
    expect(again).toBe(b);
    cache.dispose();
    engine.dispose();
  });

  it("keeps glTF invertY false on a distinct wrapper from sprite albedo", () => {
    const engine = new NullEngine();
    const cache = new ResourceCache({ byteCeiling: 8 * 1024 * 1024 });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const sprite = cache.getTexture("shared", engine, bytes, {
      noMipmap: true,
      samplingMode: Texture.NEAREST_SAMPLINGMODE,
    });
    const material = getMaterialTexture(cache, "shared", engine, bytes);
    expect(sprite).toBeInstanceOf(Texture);
    expect((sprite as Texture).invertY).toBe(true);
    expect((sprite as Texture).url).toContain("#nomip");
    expect(((sprite as Texture).url.split("#")[1] ?? "")).not.toContain(":");
    expect(material).not.toBeNull();
    expect(material).not.toBe(sprite);
    expect(material!.invertY).toBe(false);
    expect(material!.url).toContain("#ninv");
    expect(isDisposedGpuTexture(sprite)).toBe(false);
    cache.dispose();
    engine.dispose();
  });

  it("tells Babylon to use the KTX2 loader for packed ktx2 bytes", () => {
    const ktx2 = new Uint8Array([
      0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x32, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
      1, 2, 3, 4,
    ]);
    const engine = new NullEngine();
    const cache = new ResourceCache({ byteCeiling: 8 * 1024 * 1024 });
    const texture = cache.getTexture("tex", engine, ktx2);
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

  it("loads a no-mip KTX2 wrapper from a #nomip.ktx2 fragment", () => {
    const ktx2 = new Uint8Array([
      0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x32, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
      1, 2, 3, 4,
    ]);
    const engine = new NullEngine();
    const cache = new ResourceCache({ byteCeiling: 8 * 1024 * 1024 });
    const mipped = cache.getTexture("tex", engine, ktx2);
    const pixelArt = cache.getTexture("tex", engine, ktx2, {
      noMipmap: true,
      samplingMode: Texture.NEAREST_SAMPLINGMODE,
    });
    expect(pixelArt).not.toBe(mipped);
    expect(pixelArt.url).toContain("#nomip.ktx2");
    expect((pixelArt.url.split("#")[1] ?? "")).not.toContain(":");
    expect(isDisposedGpuTexture(mipped)).toBe(false);
    cache.dispose();
    engine.dispose();
  });

  it("builds a cube texture when isCube is set", () => {
    const engine = new NullEngine();
    const cache = new ResourceCache({ byteCeiling: 8 * 1024 * 1024 });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const cube = cache.getTexture("env", engine, bytes, { isCube: true });
    expect(cube.isCube).toBe(true);
    cache.dispose();
    engine.dispose();
  });

  it("builds a six-face cube in px py pz nx ny nz order", () => {
    const engine = new NullEngine();
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
    const cube = cache.getCubeTextureFromImages("sky-faces", scene, files);
    expect(cube.isCube).toBe(true);
    expect(cube._files).toEqual(files);
    const again = cache.getCubeTextureFromImages("sky-faces", scene, files);
    expect(again).toBe(cube);
    const nearest = cache.getCubeTextureFromImages(
      "sky-faces",
      scene,
      files,
      true,
    );
    expect(nearest).toBe(cube);
    expect(isDisposedGpuTexture(cube)).toBe(false);
    cache.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("keeps a six-face cube off the scene so Play scene dispose cannot leak it", () => {
    const engine = new NullEngine();
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
    const cube = cache.getCubeTextureFromImages("sky-faces", scene, files);
    expect(scene.textures.includes(cube)).toBe(false);
    expect(cube.getInternalTexture()).not.toBeNull();
    scene.dispose();
    expect(cube.getInternalTexture()).not.toBeNull();
    cache.dispose();
    expect(cube.getInternalTexture()).toBeNull();
    engine.dispose();
  });

  it("keeps a live cube when another client pins unrelated textureBytes", () => {
    const engine = new NullEngine();
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
    const cube = cache.getCubeTextureFromImages("engine-default-skybox", scene, files);
    cache.setClientTextures("viewport", ["tex-albedo"]);
    cache.setClientTextures("play", ["tex-albedo"]);
    cache.flushUnreferenced();
    expect(isDisposedGpuTexture(cube)).toBe(false);
    expect(cube.getInternalTexture()).not.toBeNull();
    cache.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("does not dispose a cache cube when a Play PBR skybox material is disposed", () => {
    const engine = new NullEngine();
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
    const cube = cache.getCubeTextureFromImages("engine-default-skybox", playScene, files);
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
    cache.release("gone");
    cache.flushUnreferenced();
    expect(reasons.some((r) => r.id === "gone" && r.reason === "flush")).toBe(
      true,
    );
    cache.dispose();
  });

  it("trims unreferenced entries toward 80% of the ceiling", () => {
    const cache = new ResourceCache({ byteCeiling: 1000 });
    cache.account("old", 600);
    cache.release("old");
    cache.account("kept", 600);
    cache.release("kept");
    expect(cache.accountedBytes()).toBeLessThanOrEqual(800);
    expect(cache.accountedBytes()).toBe(600);
    cache.dispose();
  });
});

describe("Play texture cache invariant with getTexture", () => {
  it("Play open/close cycle does not grow accounted bytes after flush", () => {
    const engine = new NullEngine();
    const before = engine.getLoadedTexturesCache().length;
    const cache = new ResourceCache({ byteCeiling: 8 * 1024 * 1024 });
    const bytes = new Uint8Array(32 * 32 * 4);
    // Editor retain
    cache.getTexture("shared", engine, bytes);
    cache.account("shared", accountedTextureBytes(32, 32, "rgba8", true));
    // Play retain (same guid + sampling → same Texture)
    cache.getTexture("shared", engine, bytes);
    // Play release
    cache.release("shared");
    // Editor still holds one ref — flush must keep entry
    cache.flushUnreferenced();
    expect(cache.accountedBytes()).toBeGreaterThan(0);
    // Editor release + flush
    cache.release("shared");
    cache.flushUnreferenced();
    expect(cache.accountedBytes()).toBe(0);
    expect(engine.getLoadedTexturesCache().length).toBeLessThanOrEqual(before + 1);
    cache.dispose();
    engine.dispose();
  });
});

describe("explicit tap picking", () => {
  it("returns null when nothing is hit", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    expect(pickAtCanvas(scene, 0, 0)).toBeNull();
    scene.dispose();
    engine.dispose();
  });

  it("walks parents to resolve tilemap chunk hits to actor-N slotId", () => {
    const engine = new NullEngine();
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
    const engine = new NullEngine();
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
    const engineA = new NullEngine();
    const engineB = new NullEngine();
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
    const engine = new NullEngine();
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
  it("releases this handle's retains then flushes unreferenced GPU wrappers", () => {
    const engine = new NullEngine();
    const inner = new ResourceCache({ byteCeiling: 8 * 1024 * 1024 });
    const bound = bindResourceCacheToHandle(inner);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const texture = bound.cache.getTexture("tex-scene", engine, bytes);
    bound.releaseHandleRetains();
    expect(isDisposedGpuTexture(texture)).toBe(true);
    inner.dispose();
    engine.dispose();
  });

  it("keeps textures still retained by another handle", () => {
    const engine = new NullEngine();
    const inner = new ResourceCache({ byteCeiling: 8 * 1024 * 1024 });
    const editor = bindResourceCacheToHandle(inner);
    const play = bindResourceCacheToHandle(inner);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const texture = editor.cache.getTexture("tex-shared", engine, bytes);
    play.cache.getTexture("tex-shared", engine, bytes);
    play.releaseHandleRetains();
    expect(isDisposedGpuTexture(texture)).toBe(false);
    editor.releaseHandleRetains();
    expect(isDisposedGpuTexture(texture)).toBe(true);
    inner.dispose();
    engine.dispose();
  });
});
