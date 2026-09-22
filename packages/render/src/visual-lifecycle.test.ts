import { Mesh, NullEngine, Scene, StandardMaterial, VertexBuffer } from "@babylonjs/core";
import { encodeGlbJsonBin, splitGlbJsonBin } from "@babylonslate/assets";
import { afterEach, describe, expect, it, vi } from "vitest";
import { beginSlotModelAnimLoad, createModelActorRoot } from "./glb-anim";
import { encodeTriangleGlb } from "./model-mesh";
import { createSnapshotSceneBinding, retirePlaySlot } from "./snapshot-apply";
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
    await beginSlotModelAnimLoad(scene, binding, 0, "model", firstBytes, oldRoot);
    const oldMesh = visualMeshes(oldRoot)[0]!;
    expect(oldMesh).toBeInstanceOf(Mesh);
    const oldGeometry = (oldMesh as Mesh).geometry;
    await beginSlotModelAnimLoad(scene, binding, 1, "model", secondBytes, nextRoot);
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
    const bytes = encodeTriangleGlb();
    const borrowed = new StandardMaterial("library-owned", scene);
    const cycle = async () => {
      const root = createModelActorRoot(scene, "model");
      binding.meshes.set(0, root);
      await beginSlotModelAnimLoad(scene, binding, 0, "model", bytes, root);
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
});
