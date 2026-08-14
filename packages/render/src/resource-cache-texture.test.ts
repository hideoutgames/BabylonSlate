import { describe, expect, it, vi } from "vitest";
import { NullEngine, Texture } from "@babylonjs/core";
import { ResourceCache } from "./resource-cache";
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

  it("rebuilds when sampling flags change (cache key includes flags)", () => {
    const engine = new NullEngine();
    const cache = new ResourceCache({ byteCeiling: 8 * 1024 * 1024 });
    const bytes = new Uint8Array([9, 9, 9]);
    const a = cache.getTexture("tex", engine, bytes, { noMipmap: false });
    const b = cache.getTexture("tex", engine, bytes, { noMipmap: true });
    expect(a).not.toBe(b);
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
