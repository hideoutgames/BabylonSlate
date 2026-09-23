import { expect, it, vi } from "vitest";
import { NodeMaterial, NullEngine, RenderTargetTexture, Scene, Texture, type Effect } from "@babylonjs/core";
import { installAssetBytes } from "@babylonslate/assets";
import { ResourceCache } from "./resource-cache";
import { sceneRenderingSettings } from "./render-settings";
import { QualityTextureBlock } from "./texture-quality";

it("retains renderer-owned sampling when a graph binds a render target", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const target = new RenderTargetTexture("rendered input", 16, scene);
  target.anisotropicFilteringLevel = 1;
  const block = new QualityTextureBlock("input");
  block.texture = target;
  const material = new NodeMaterial("receiver", scene);
  const effect = { setTexture: vi.fn(), setFloat: vi.fn(), setMatrix: vi.fn() } as unknown as Effect;
  try {
    sceneRenderingSettings(scene).textureAnisotropy = 8;
    block.bind(effect, material);
    expect(block.texture).toBe(target);
    expect(target.anisotropicFilteringLevel).toBe(1);
    sceneRenderingSettings(scene).textureAnisotropy = 2;
    block.bind(effect, material);
    expect(target.anisotropicFilteringLevel).toBe(1);
  } finally { block.dispose(); scene.dispose(); engine.dispose(); }
});

it("isolates scene sampler quality without duplicating uploads or reacquiring steady bindings", () => {
  const engine = new NullEngine();
  engine.getCaps().maxAnisotropy = 8;
  const cache = new ResourceCache();
  const first = new Scene(engine);
  const second = new Scene(engine);
  const bytes = installAssetBytes(new Uint8Array([1, 2, 3]));
  const lease = cache.acquireTexture("shared", engine, bytes);
  const source = lease.resource as Texture;
  const a = new QualityTextureBlock("first");
  const b = new QualityTextureBlock("second");
  a.texture = b.texture = source;
  const materialA = new NodeMaterial("first", first);
  const materialB = new NodeMaterial("second", second);
  sceneRenderingSettings(first).textureAnisotropy = 1;
  sceneRenderingSettings(second).textureAnisotropy = 8;
  const effect = { setTexture: vi.fn(), setFloat: vi.fn(), setMatrix: vi.fn() } as unknown as Effect;
  try {
    a.bind(effect, materialA);
    b.bind(effect, materialB);
    expect(a.texture?.anisotropicFilteringLevel).toBe(1);
    expect(b.texture?.anisotropicFilteringLevel).toBe(8);
    expect(source.anisotropicFilteringLevel).toBe(4);
    expect(a.texture).not.toBe(b.texture);
    expect(a.texture?.getInternalTexture()).toBe(source.getInternalTexture());
    expect(b.texture?.getInternalTexture()).toBe(source.getInternalTexture());
    const acquire = vi.spyOn(cache, "acquireTexture");
    for (let i = 0; i < 1000; i++) { a.bind(effect, materialA); b.bind(effect, materialB); }
    expect(acquire).not.toHaveBeenCalled();
    a.dispose();
    expect(b.texture?.getInternalTexture()).not.toBeNull();
    b.dispose();
    lease.release();
    cache.flushUnreferenced();
    expect(cache.resourceStats().leases).toBe(0);
  } finally {
    a.dispose(); b.dispose(); lease.release(); cache.dispose(); first.dispose(); second.dispose(); engine.dispose();
  }
});
