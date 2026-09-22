import { installAssetBytes } from "@babylonslate/assets";
import { Animation, AnimationGroup, FreeCamera, Mesh, NullEngine, PBRMaterial, RawTexture, Scene, StandardMaterial, Vector3, VertexBuffer } from "@babylonjs/core";
import { encodeGlbJsonBin, splitGlbJsonBin } from "@babylonslate/assets";
import { createActor, createDefaultScene, createMeshComponent, parseText2DProperties } from "@babylonslate/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { beginSlotModelAnimLoad, createModelActorRoot, glbContainerLoadCount } from "./glb-anim";
import * as modelContainer from "./model-container";
import { encodeTriangleGlb, encodeUvHierarchyGlb } from "./model-mesh";
import { applyAssignMesh, createSnapshotSceneBinding, retirePlaySlot } from "./snapshot-apply";
import { createText2DMesh } from "./text2d-mesh";
import * as bitmap from "./text2d-bitmap";
import { visualMeshes } from "./visual-meshes";
import { EditorSceneSync } from "./editor-scene-sync";
import { createText3DMesh } from "./text3d-mesh";
import { createOverlayTextureQuad } from "./overlay-texture-quad";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const engines: NullEngine[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const engine of engines.splice(0)) engine.dispose();
});

function host() {
  const engine = new NullEngine();
  engines.push(engine);
  return { engine, scene: new Scene(engine) };
}

describe("visual generation ownership", () => {
  it("replaces valid same-length GLB content without invalidating an older live instance", async () => {
    const { scene } = host();
    const firstBytes = encodeTriangleGlb();
    const split = splitGlbJsonBin(firstBytes)!;
    const secondBin = split.bin.slice();
    // Numeric triangle fixture: widen vertex 1, retaining the valid GLB layout.
    new DataView(secondBin.buffer, secondBin.byteOffset, secondBin.byteLength).setFloat32(12, 2, true);
    const json = structuredClone(split.json);
    (json.accessors as Array<{ max: number[] }>)[0]!.max[0] = 2;
    const secondBytes = encodeGlbJsonBin(json, secondBin);
    expect(secondBytes.byteLength).toBe(firstBytes.byteLength);
    const binding = createSnapshotSceneBinding();
    const oldRoot = createModelActorRoot(scene, "old");
    const nextRoot = createModelActorRoot(scene, "next");
    await beginSlotModelAnimLoad(scene, binding, 0, "model", installAssetBytes(firstBytes), oldRoot);
    const oldMesh = visualMeshes(oldRoot)[0]!;
    expect(oldMesh).toBeInstanceOf(Mesh);
    const oldGeometry = (oldMesh as Mesh).geometry;
    await beginSlotModelAnimLoad(scene, binding, 1, "model", installAssetBytes(secondBytes), nextRoot);
    expect(visualMeshes(nextRoot)[0]!.getVerticesData(VertexBuffer.PositionKind)![3]).toBe(2);
    expect(oldMesh.isDisposed()).toBe(false);
    expect((oldMesh as Mesh).geometry).toBe(oldGeometry);
    expect(oldMesh.getVerticesData(VertexBuffer.PositionKind)![3]).toBe(1);
    nextRoot.dispose();
    expect(oldMesh.getVerticesData(VertexBuffer.PositionKind)![3]).toBe(1);
  });

  it("retires original model clone materials after a borrowed material overrides them", async () => {
    const { scene } = host();
    const binding = createSnapshotSceneBinding();
    const source = installAssetBytes(encodeTriangleGlb());
    const borrowed = new StandardMaterial("library-owned", scene);
    const cycle = async () => {
      const root = createModelActorRoot(scene, "model");
      binding.meshes.set(0, root);
      await beginSlotModelAnimLoad(scene, binding, 0, "model", source, root);
      for (const mesh of visualMeshes(root)) mesh.material = borrowed;
      retirePlaySlot(binding, 0);
    };
    await cycle();
    const warmed = scene.materials.length;
    for (let index = 0; index < 200; index += 1) await cycle();
    expect(scene.materials).toContain(borrowed);
    expect(scene.materials).toHaveLength(warmed);
    expect(scene.meshes).toHaveLength(0);
    expect(binding.slotAnimationGroups?.size ?? 0).toBe(0);
  });

  it("stages editor model replacement and preserves the working hierarchy on failure", async () => {
    const { scene } = host();
    const sync = new EditorSceneSync(scene);
    sync.setMeshAssets({ modelSources: new Map([["model", installAssetBytes(encodeTriangleGlb())]]) });
    const component = createMeshComponent("mesh", "box");
    const document = { ...createDefaultScene(), actors: [
      createActor("actor", "Actor", { parentId: "parent", components: [component] }),
      createActor("parent", "Parent"),
      createActor("child", "Child", { parentId: "actor" }),
    ] };
    sync.apply(document);
    const previous = sync.meshForActor("actor")!;
    const parent = sync.meshForActor("parent")!;
    const child = sync.meshForActor("child")!;
    let reject!: (error: Error) => void;
    vi.spyOn(modelContainer, "loadModelContainer").mockImplementationOnce(() => new Promise((_, no) => { reject = no; }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const next = structuredClone(document);
    next.actors[0]!.components[0]!.properties.assetGuid = "model";
    sync.apply(next);
    expect(sync.meshForActor("actor")).toBe(previous);
    expect(previous.isDisposed()).toBe(false);
    expect(previous.parent).toBe(parent);
    expect(child.parent).toBe(previous);
    await vi.waitFor(() => expect(reject).toBeDefined());
    reject(new Error("injected editor load failure"));
    await expect(sync.whenEditorModelsReady()).rejects.toThrow("injected");
    expect(sync.meshForActor("actor")).toBe(previous);
    expect(previous.isDisposed()).toBe(false);
    expect(child.parent).toBe(previous);
    sync.apply(next);
    await sync.whenEditorModelsReady();
    expect(sync.meshForActor("actor")).not.toBe(previous);
    expect(previous.isDisposed()).toBe(true);
    const adopted = sync.meshForActor("actor")!;
    expect(adopted.parent).toBe(parent);
    expect(child.parent).toBe(adopted);
    expect(child.isDisposed()).toBe(false);
    expect(visualMeshes(adopted).some((mesh) => mesh.getTotalVertices() === 3)).toBe(true);
    sync.dispose();
  });

  it("keeps the previous instance on preparation failure and retries that source identity", async () => {
    const { scene } = host();
    const binding = createSnapshotSceneBinding();
    const root = createModelActorRoot(scene, "model");
    const source = installAssetBytes(encodeTriangleGlb());
    await beginSlotModelAnimLoad(scene, binding, 0, "model", source, root);
    const previous = visualMeshes(root)[0]!;
    const next = new Blob([await source.arrayBuffer()], { type: source.type });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const prepare = vi.fn().mockRejectedValueOnce(new Error("injected material preparation failure")).mockResolvedValue(undefined);
    await expect(beginSlotModelAnimLoad(scene, binding, 0, "model", next, root, undefined, undefined, prepare)).rejects.toThrow("injected");
    expect(visualMeshes(root)[0]).toBe(previous);
    expect(previous.isDisposed()).toBe(false);
    await beginSlotModelAnimLoad(scene, binding, 0, "model", next, root, undefined, undefined, prepare);
    expect(visualMeshes(root)[0]).not.toBe(previous);
    expect(previous.isDisposed()).toBe(true);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("bounds native resources and scene observers across 200 source-generation replacements", async () => {
    const { scene } = host();
    const binding = createSnapshotSceneBinding();
    const root = createModelActorRoot(scene, "model");
    const buffer = await installAssetBytes(encodeTriangleGlb()).arrayBuffer();
    const replace = () => beginSlotModelAnimLoad(scene, binding, 0, "model", new Blob([buffer]), root);
    const counts = () => ({
      materials: scene.materials.length, meshes: scene.meshes.length,
      geometries: scene.geometries.length, textures: scene.textures.length,
      transforms: scene.transformNodes.length, observers: scene.onDisposeObservable.observers.length,
    });
    await replace();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const warmed = counts();
    for (let index = 0; index < 200; index += 1) await replace();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(counts()).toEqual(warmed);
    expect(visualMeshes(root)).toHaveLength(1);
  }, 60_000);

  it("keeps a shared source texture animation on every independent material clone", async () => {
    const { scene } = host();
    new FreeCamera("camera", new Vector3(0, 0, -3), scene);
    const original = modelContainer.loadModelContainer;
    let shared!: RawTexture;
    vi.spyOn(modelContainer, "loadModelContainer").mockImplementationOnce(async (...args) => {
      const container = await original(...args);
      shared = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, scene);
      container.textures.push(shared);
      for (const material of container.materials) if (material instanceof PBRMaterial) material.albedoTexture = shared;
      const group = new AnimationGroup("Texture", scene);
      const animation = new Animation("offset", "uOffset", 60, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CYCLE);
      animation.setKeys([{ frame: 0, value: 0 }, { frame: 60, value: 1 }]);
      group.addTargetedAnimation(animation, shared);
      container.animationGroups.push(group);
      scene.removeAnimationGroup(group);
      return container;
    });
    const root = createModelActorRoot(scene, "model");
    const binding = createSnapshotSceneBinding();
    await beginSlotModelAnimLoad(scene, binding, 0, "model", installAssetBytes(encodeUvHierarchyGlb({ separateMaterials: true })), root);
    const textures = visualMeshes(root).map((mesh) => (mesh.material as PBRMaterial).albedoTexture!);
    expect(textures).toHaveLength(2);
    expect(textures[0]).not.toBe(textures[1]);
    const group = binding.slotAnimationGroups!.get(0)![0]!;
    group.goToFrame(30);
    group.setWeightForAllAnimatables?.(1);
    scene.render();
    for (const texture of textures) expect((texture as RawTexture).uOffset).toBeCloseTo(0.5);
    expect(shared.uOffset).toBe(0);
  });

  it("preserves a usable Play primitive when model replacement loading fails", async () => {
    const { scene } = host();
    const binding = createSnapshotSceneBinding();
    applyAssignMesh(scene, binding, { type: "assignMesh", slotId: 0, meshKind: "box", meshAssetGuid: null });
    const previous = binding.meshes.get(0)!;
    binding.modelSources = new Map([["broken", installAssetBytes(encodeTriangleGlb())]]);
    vi.spyOn(modelContainer, "loadModelContainer").mockRejectedValueOnce(new Error("injected loader failure"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    applyAssignMesh(scene, binding, { type: "assignMesh", slotId: 0, meshKind: "box", meshAssetGuid: "broken" });
    await expect(binding.slotAnimLoads!.get(0)).rejects.toThrow("injected");
    expect(binding.meshes.get(0)).toBe(previous);
    expect(previous.isDisposed()).toBe(false);
    expect(scene.meshes).toEqual([previous]);
  });

  it("does not let an old rejection evict or block a newer successful generation", async () => {
    const { scene } = host();
    const binding = createSnapshotSceneBinding();
    const root = createModelActorRoot(scene, "model");
    const first = installAssetBytes(encodeTriangleGlb());
    const second = new Blob([await first.arrayBuffer()]);
    const late = deferred<never>();
    const entered = deferred<void>();
    vi.spyOn(modelContainer, "loadModelContainer").mockImplementationOnce(() => { entered.resolve(); return late.promise; });
    const stale = beginSlotModelAnimLoad(scene, binding, 0, "model", first, root);
    await entered.promise;
    await beginSlotModelAnimLoad(scene, binding, 0, "model", second, root);
    const winner = visualMeshes(root)[0]!;
    late.reject(new Error("old load rejected"));
    await stale;
    await beginSlotModelAnimLoad(scene, binding, 1, "model", second, createModelActorRoot(scene, "another"));
    expect(glbContainerLoadCount(scene)).toBe(2);
    expect(visualMeshes(root)[0]).toBe(winner);
    expect(winner.isDisposed()).toBe(false);
  });

  it("retires generated text construction materials in a persistent scene", () => {
    const { scene } = host();
    const cycle = () => createText2DMesh(scene, "text", {
      text: "[wave=2]A [u]B[/u]", size: 24, renderer: "bitmap",
    }, undefined, { rich: true }).dispose();
    cycle();
    const warmed = { materials: scene.materials.length, meshes: scene.meshes.length, geometries: scene.geometries.length, textures: scene.textures.length };
    for (let index = 0; index < 200; index += 1) cycle();
    expect({ materials: scene.materials.length, meshes: scene.meshes.length, geometries: scene.geometries.length, textures: scene.textures.length }).toEqual(warmed);
  });

  it.each(["3D text", "overlay texture"])("retires %s construction materials after an authored override", (kind) => {
    const { scene } = host();
    const borrowed = new StandardMaterial("authored", scene);
    const cycle = () => {
      const mesh = kind === "3D text" ? createText3DMesh(scene, "text", { text: "T" }) : createOverlayTextureQuad(scene, "overlay", null);
      mesh.material = borrowed;
      mesh.dispose();
    };
    cycle();
    const warmed = { materials: scene.materials.length, meshes: scene.meshes.length, geometries: scene.geometries.length };
    for (let index = 0; index < 100; index++) cycle();
    expect({ materials: scene.materials.length, meshes: scene.meshes.length, geometries: scene.geometries.length }).toEqual(warmed);
    expect(scene.materials).toContain(borrowed);
  });

  it("rejects an oversized glyph before rasterizing or attaching a partial text tree", () => {
    const { scene, engine } = host();
    const caps = engine.getCaps();
    vi.spyOn(engine, "getCaps").mockReturnValue({ ...caps, maxTextureSize: 64 });
    const rasterize = vi.spyOn(bitmap, "rasterizeBitmapGlyph");
    expect(() => createText2DMesh(scene, "oversized", { text: "A", size: 256, renderer: "bitmap" })).toThrow(/allocation|limit/i);
    expect(rasterize).not.toHaveBeenCalled();
    expect(scene.meshes).toHaveLength(0);
    expect(scene.materials).toHaveLength(0);
    expect(scene.textures).toHaveLength(0);
  });

  it("keeps the current Play text when a replacement exceeds allocation limits", () => {
    const { scene, engine } = host();
    const binding = createSnapshotSceneBinding();
    const caps = engine.getCaps();
    vi.spyOn(engine, "getCaps").mockReturnValue({ ...caps, maxTextureSize: 64 });
    applyAssignMesh(scene, binding, { type: "assignMesh", slotId: 0, meshKind: "2dtext", meshAssetGuid: null, text2d: parseText2DProperties({ text: "A", size: 16 }) });
    const previous = binding.meshes.get(0)!;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rasterize = vi.spyOn(bitmap, "rasterizeBitmapGlyph");
    for (let repeat = 0; repeat < 100; repeat += 1) {
      applyAssignMesh(scene, binding, { type: "assignMesh", slotId: 0, meshKind: "2dtext", meshAssetGuid: null, text2d: parseText2DProperties({ text: "A", size: 256 }) });
    }
    expect(binding.meshes.get(0)).toBe(previous);
    expect(previous.isDisposed()).toBe(false);
    expect(previous.getChildMeshes()).toHaveLength(1);
    expect(rasterize).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    applyAssignMesh(scene, binding, { type: "assignMesh", slotId: 0, meshKind: "2dtext", meshAssetGuid: null, text2d: parseText2DProperties({ text: "B", size: 16 }) });
    expect(binding.meshes.get(0)).not.toBe(previous);
    expect(previous.isDisposed()).toBe(true);
  });

  it("includes already staged siblings in a multipart text replacement budget", () => {
    const { scene } = host();
    const binding = createSnapshotSceneBinding();
    const text2d = parseText2DProperties({ text: "A", size: 16, renderer: "bitmap" });
    applyAssignMesh(scene, binding, { type: "assignMesh", slotId: 0, meshKind: "2dtext", meshAssetGuid: null, text2d });
    const previous = binding.meshes.get(0)!;
    const warmed = { materials: scene.materials.length, textures: scene.textures.length, meshes: scene.meshes.length };
    const plan = bitmap.planBitmapGlyphAtlas;
    let budget: number | undefined;
    vi.spyOn(bitmap, "planBitmapGlyphAtlas").mockImplementation((cells, limits) => {
      const result = plan(cells, { ...limits!, maxWorkingBytes: budget ?? limits!.maxWorkingBytes });
      budget ??= result?.workingBytes;
      return result;
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const rasterize = vi.spyOn(bitmap, "rasterizeBitmapGlyph");
    applyAssignMesh(scene, binding, {
      type: "assignMesh", slotId: 0, meshKind: "2dtext", meshAssetGuid: null, text2d,
      parts: ["first", "second"].map((componentId) => ({
        componentId, meshKind: "2dtext", meshAssetGuid: null, text2d, parentId: null,
        position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
      })),
    });
    expect(binding.meshes.get(0)).toBe(previous);
    expect(previous.isDisposed()).toBe(false);
    expect(rasterize).toHaveBeenCalledTimes(1);
    expect({ materials: scene.materials.length, textures: scene.textures.length, meshes: scene.meshes.length }).toEqual(warmed);
  });
});
