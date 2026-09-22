import { installAssetBytes } from "@babylonslate/assets";
import { Mesh, NullEngine, Scene, StandardMaterial, VertexBuffer } from "@babylonjs/core";
import { encodeGlbJsonBin, splitGlbJsonBin } from "@babylonslate/assets";
import { parseText2DProperties } from "@babylonslate/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { beginSlotModelAnimLoad, createModelActorRoot, glbContainerLoadCount } from "./glb-anim";
import * as modelContainer from "./model-container";
import { encodeTriangleGlb } from "./model-mesh";
import { applyAssignMesh, createSnapshotSceneBinding, retirePlaySlot } from "./snapshot-apply";
import { createText2DMesh } from "./text2d-mesh";
import * as bitmap from "./text2d-bitmap";
import { visualMeshes } from "./visual-meshes";

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

  it("does not let an old rejection evict or block a newer successful generation", async () => {
    const { scene } = host();
    const binding = createSnapshotSceneBinding();
    const root = createModelActorRoot(scene, "model");
    const first = installAssetBytes(encodeTriangleGlb());
    const second = new Blob([await first.arrayBuffer()]);
    const late = Promise.withResolvers<never>();
    const entered = Promise.withResolvers<void>();
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
      text: "A <u>B</u>", size: 24, renderer: "bitmap",
    }, undefined, { rich: true }).dispose();
    cycle();
    const warmed = { materials: scene.materials.length, meshes: scene.meshes.length, geometries: scene.geometries.length, textures: scene.textures.length };
    for (let index = 0; index < 200; index += 1) cycle();
    expect({ materials: scene.materials.length, meshes: scene.meshes.length, geometries: scene.geometries.length, textures: scene.textures.length }).toEqual(warmed);
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
});
