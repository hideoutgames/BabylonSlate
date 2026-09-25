import { expect, it, vi } from "vitest";
import { Matrix, MeshBuilder, NodeMaterial, NullEngine, RenderTargetTexture, Scene, Texture, type Effect } from "@babylonjs/core";
import { installAssetBytes } from "@babylonslate/assets";
import { createDefaultMaterialDocument, lowerMaterialDocument } from "@babylonslate/shader-graph";
import { compileMaterialPlan } from "./material-compiler";
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

it("binds the scene anisotropy variant through a compiled graph's image source", async () => {
  const engine = new NullEngine();
  engine.getCaps().maxAnisotropy = 8;
  const scene = new Scene(engine);
  scene.setTransformMatrix(Matrix.Identity(), Matrix.Identity());
  const cache = new ResourceCache();
  const lease = cache.acquireTexture("albedo", engine, installAssetBytes(new Uint8Array([1, 2, 3])));
  const source = lease.resource as Texture;
  const doc = createDefaultMaterialDocument();
  doc.nodes.push({ id: "sample", type: "texture.sample", position: { x: 0, y: 0 }, properties: { textureGuid: "albedo" } });
  doc.edges.push({ id: "sample-emission", sourceNodeId: "sample", sourcePinId: "rgb", targetNodeId: "output", targetPinId: "emissive" });
  const lowered = lowerMaterialDocument(doc, { functions: {} });
  if (!lowered.ok) throw new Error("Material did not lower");
  const compiled = compileMaterialPlan(lowered.plan, { scene, name: "sampled", resolveTexture: () => source });
  if (!compiled.ok) throw new Error("Material did not compile");
  try {
    const mesh = MeshBuilder.CreateBox("box", {}, scene);
    mesh.material = compiled.material;
    await compiled.material.forceCompilationAsync(mesh);
    const block = compiled.material.attachedBlocks.find((candidate) => candidate instanceof QualityTextureBlock)!;
    expect(block.hasImageSource).toBe(true);
    sceneRenderingSettings(scene).textureAnisotropy = 8;
    const subMesh = mesh.subMeshes[0]!;
    expect(compiled.material.isReadyForSubMesh(mesh, subMesh)).toBe(true);
    const setTexture = vi.spyOn(subMesh.effect!, "setTexture");
    compiled.material.bindForSubMesh(mesh.computeWorldMatrix(true), mesh, subMesh);
    const bound = setTexture.mock.calls.filter(([name]) => name === block.samplerName).at(-1)?.[1];
    expect(bound).not.toBe(source);
    expect(bound?.anisotropicFilteringLevel).toBe(8);
    expect(bound?.getInternalTexture()).toBe(source.getInternalTexture());
    expect(source.anisotropicFilteringLevel).toBe(4);
  } finally { compiled.dispose(); lease.release(); cache.dispose(); scene.dispose(); engine.dispose(); }
});

it("keeps sampling the source without retrying every frame when a variant cannot be acquired", () => {
  const engine = new NullEngine();
  engine.getCaps().maxAnisotropy = 8;
  const scene = new Scene(engine);
  const cache = new ResourceCache();
  const lease = cache.acquireTexture("shared", engine, installAssetBytes(new Uint8Array([1, 2, 3])));
  const source = lease.resource as Texture;
  const block = new QualityTextureBlock("sample");
  block.texture = source;
  const material = new NodeMaterial("receiver", scene);
  const effect = { setTexture: vi.fn(), setFloat: vi.fn(), setMatrix: vi.fn() } as unknown as Effect;
  const acquire = vi.spyOn(cache, "acquireTexture").mockImplementation(() => { throw new Error("Texture replacement exceeds the live texture byte budget"); });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    sceneRenderingSettings(scene).textureAnisotropy = 2;
    for (let frame = 0; frame < 3; frame++) expect(() => block.bind(effect, material)).not.toThrow();
    expect(acquire).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    expect(block.texture).toBe(source);
    expect(source.anisotropicFilteringLevel).toBe(4);
  } finally { warn.mockRestore(); acquire.mockRestore(); block.dispose(); lease.release(); cache.dispose(); scene.dispose(); engine.dispose(); }
});
