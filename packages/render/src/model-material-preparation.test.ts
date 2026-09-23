import { FreeCamera, Mesh, NullEngine, RawTexture, Scene, StandardMaterial, TextureBlock, Vector3 } from "@babylonjs/core";
import { installAssetBytes } from "@babylonslate/assets";
import { createDefaultMaterialDocument } from "@babylonslate/shader-graph";
import { afterEach, describe, expect, it, vi } from "vitest";
import { beginSlotModelAnimLoad, createModelActorRoot, invalidateSlotAnimLoad } from "./glb-anim";
import { MaterialLibrary } from "./material-library";
import { encodeUvHierarchyGlb } from "./model-mesh";
import { createSnapshotSceneBinding } from "./snapshot-apply";
import { visualMeshes } from "./visual-meshes";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const disposers: Array<() => void> = [];
afterEach(() => {
  while (disposers.length) disposers.pop()?.();
  vi.restoreAllMocks();
});

function textureDocument(guid: string) {
  const doc = createDefaultMaterialDocument();
  doc.nodes.push(
    { id: "texture", type: "param.texture", position: { x: 0, y: 0 }, properties: { name: "Albedo", textureGuid: guid } },
    { id: "uv", type: "input.uv", position: { x: 0, y: 0 }, properties: {} },
    { id: "sample", type: "texture.sample", position: { x: 0, y: 0 }, properties: {} },
  );
  doc.edges = doc.edges.filter((edge) => edge.id !== "e-color-output");
  doc.edges.push(
    { id: "texture-sample", sourceNodeId: "texture", sourcePinId: "out", targetNodeId: "sample", targetPinId: "texture" },
    { id: "uv-sample", sourceNodeId: "uv", sourcePinId: "uv", targetNodeId: "sample", targetPinId: "uv" },
    { id: "sample-output", sourceNodeId: "sample", sourcePinId: "rgb", targetNodeId: "output", targetPinId: "baseColor" },
  );
  return doc;
}

async function host() {
  const engine = new NullEngine();
  disposers.push(() => engine.dispose());
  const scene = new Scene(engine);
  new FreeCamera("camera", new Vector3(0, 0, -3), scene);
  const binding = createSnapshotSceneBinding();
  const root = createModelActorRoot(scene, "model");
  const bytes = encodeUvHierarchyGlb({ separateMaterials: true });
  await beginSlotModelAnimLoad(scene, binding, 0, "model", installAssetBytes(bytes), root);
  const previous = visualMeshes(root);
  const next = new Blob([bytes]);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  return { scene, binding, root, previous, next };
}

function delayedTextures(scene: Scene) {
  const admission = deferred<void>();
  void admission.promise.catch(() => {});
  const working = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, scene);
  const pending = RawTexture.CreateRGBATexture(new Uint8Array([255, 0, 0, 255]), 1, 1, scene);
  working.getInternalTexture()!.isReady = true;
  pending.getInternalTexture()!.isReady = true;
  const released = vi.fn();
  const library = new MaterialLibrary({
    acquireTexture: (guid) => {
      let live = true;
      return { resource: guid === "pending" ? pending : working, key: guid,
        ready: guid === "pending" ? admission.promise : Promise.resolve(),
        release: () => { if (live) { live = false; released(guid); } },
      };
    },
    textureIdentity: (guid) => guid,
  });
  disposers.push(() => { library.dispose(); working.dispose(); pending.dispose(); });
  return { library, admission, working, pending, released };
}

describe("staged model material admission", () => {
  it("keeps a valid GLB predecessor when a native-ready assigned texture fails lease admission", async () => {
    const f = await host();
    const textures = delayedTextures(f.scene);
    expect(textures.pending.isReady()).toBe(true);
    const entered = deferred<void>();
    const load = beginSlotModelAnimLoad(f.scene, f.binding, 0, "model", f.next, f.root, undefined, undefined, (staging) => {
      const material = textures.library.resolve(f.scene, "material", textureDocument("pending"));
      for (const mesh of visualMeshes(staging)) mesh.material = material;
      entered.resolve();
    });
    await entered.promise;
    expect(visualMeshes(f.root)).toEqual(f.previous);
    textures.admission.reject(new Error("texture byte budget rejected replacement"));
    await expect(load).rejects.toThrow("texture byte budget");
    expect(visualMeshes(f.root)).toEqual(f.previous);
    for (const mesh of f.previous) expect(mesh.isDisposed()).toBe(false);
    expect(textures.released).toHaveBeenCalledExactlyOnceWith("pending");
  });

  it("waits for the requested graph generation even when resolve returns its working predecessor", async () => {
    const f = await host();
    const textures = delayedTextures(f.scene);
    const first = textures.library.acquire(f.scene, "material", textureDocument("working"));
    if (!first.ok) throw new Error("Initial graph did not compile");
    await first.ready;
    const entered = deferred<void>();
    const load = beginSlotModelAnimLoad(f.scene, f.binding, 0, "model", f.next, f.root, undefined, undefined, (staging) => {
      const material = textures.library.resolve(f.scene, "material", textureDocument("pending"));
      expect(material).toBe(first.material);
      for (const mesh of visualMeshes(staging)) mesh.material = material;
      entered.resolve();
    });
    await entered.promise;
    textures.admission.reject(new Error("requested graph texture rejected"));
    await expect(load).rejects.toThrow("requested graph texture");
    expect(visualMeshes(f.root)).toEqual(f.previous);
    expect(f.scene.materials).toContain(first.material);
  });

  it("includes authored texture parameters after the base material has prepared", async () => {
    const f = await host();
    const textures = delayedTextures(f.scene);
    const doc = textureDocument("working");
    const first = textures.library.acquire(f.scene, "material", doc, { instanceKey: "actor" });
    if (!first.ok) throw new Error("Initial graph did not compile");
    await first.ready;
    const entered = deferred<void>();
    const load = beginSlotModelAnimLoad(f.scene, f.binding, 0, "model", f.next, f.root, undefined, undefined, (staging) => {
      const material = textures.library.resolve(f.scene, "material", doc, {
        instanceKey: "actor", parameters: new Map([["Albedo", { kind: "texture", textureAssetGuid: "pending" }]]),
      });
      for (const mesh of visualMeshes(staging)) mesh.material = material;
      entered.resolve();
    });
    await entered.promise;
    expect(visualMeshes(f.root)).toEqual(f.previous);
    textures.admission.reject(new Error("authored parameter admission rejected"));
    await expect(load).rejects.toThrow("authored parameter admission");
    expect(visualMeshes(f.root)).toEqual(f.previous);
    expect((first.material.getBlockByName("sample") as TextureBlock).texture).toBe(textures.working);
    expect(textures.released).toHaveBeenCalledWith("pending");
  });

  it("coalesces the same pending authored parameter while the model waits", async () => {
    const f = await host();
    const textures = delayedTextures(f.scene);
    const doc = textureDocument("working");
    const first = textures.library.acquire(f.scene, "material", doc, { instanceKey: "actor" });
    if (!first.ok) throw new Error("Initial graph did not compile");
    await first.ready;
    const entered = deferred<void>();
    const parameters = new Map([["Albedo", { kind: "texture" as const, textureAssetGuid: "pending" }]]);
    const load = beginSlotModelAnimLoad(f.scene, f.binding, 0, "model", f.next, f.root, undefined, undefined, (staging) => {
      const material = textures.library.resolve(f.scene, "material", doc, { instanceKey: "actor", parameters });
      for (const mesh of visualMeshes(staging)) mesh.material = material;
      entered.resolve();
    });
    await entered.promise;
    textures.library.resolve(f.scene, "material", doc, { instanceKey: "actor", parameters });
    textures.admission.resolve();
    await load;
    expect(visualMeshes(f.root)).not.toEqual(f.previous);
    expect((first.material.getBlockByName("sample") as TextureBlock).texture).toBe(textures.pending);
    expect(textures.released).not.toHaveBeenCalledWith("pending");
  });

  it("retains the predecessor material when a replacement graph cannot compile its mesh variant", async () => {
    const f = await host();
    const textures = delayedTextures(f.scene);
    const first = textures.library.acquire(f.scene, "material", textureDocument("working"));
    if (!first.ok) throw new Error("Initial graph did not compile");
    await first.ready;
    for (const mesh of f.previous) mesh.material = first.material;
    const load = beginSlotModelAnimLoad(f.scene, f.binding, 0, "model", f.next, f.root, undefined, undefined, (staging) => {
      const document = textureDocument("other-ready-source");
      const next = textures.library.acquire(f.scene, "material", document);
      if (!next.ok) throw new Error("Replacement graph did not compile");
      vi.spyOn(next.material, "forceCompilationAsync").mockRejectedValue(new Error("replacement mesh variant failed"));
      const assigned = textures.library.resolve(f.scene, "material", document);
      expect(assigned).toBe(first.material);
      for (const mesh of visualMeshes(staging)) mesh.material = assigned;
    });
    await expect(load).rejects.toThrow("replacement mesh variant failed");
    expect(visualMeshes(f.root)).toEqual(f.previous);
    for (const mesh of f.previous) expect(mesh.material).toBe(first.material);
    expect(f.scene.materials).toContain(first.material);
  });

  it("preserves the old model and borrowed material on native prewarm failure, then retries", async () => {
    const f = await host();
    const material = new StandardMaterial("borrowed", f.scene);
    const warm = vi.spyOn(material, "forceCompilationAsync").mockRejectedValueOnce(new Error("native variant failed"));
    const assign = (staging: Mesh) => {
      for (const mesh of visualMeshes(staging)) mesh.material = material;
    };
    await expect(beginSlotModelAnimLoad(f.scene, f.binding, 0, "model", f.next, f.root, undefined, undefined, assign)).rejects.toThrow("native variant failed");
    expect(visualMeshes(f.root)).toEqual(f.previous);
    expect(f.scene.materials).toContain(material);
    warm.mockRestore();
    await beginSlotModelAnimLoad(f.scene, f.binding, 0, "model", f.next, f.root, undefined, undefined, assign);
    for (const mesh of f.previous) expect(mesh.isDisposed()).toBe(true);
    expect(visualMeshes(f.root).every((mesh) => mesh.material === material)).toBe(true);
  });

  it("cancels a pending material generation without waiting for late admission", async () => {
    const f = await host();
    const textures = delayedTextures(f.scene);
    const entered = deferred<void>();
    const load = beginSlotModelAnimLoad(f.scene, f.binding, 0, "model", f.next, f.root, undefined, undefined, (staging) => {
      const material = textures.library.resolve(f.scene, "material", textureDocument("pending"));
      for (const mesh of visualMeshes(staging)) mesh.material = material;
      entered.resolve();
    });
    await entered.promise;
    invalidateSlotAnimLoad(f.binding, 0);
    await load;
    expect(visualMeshes(f.root)).toEqual(f.previous);
    textures.admission.resolve();
    await Promise.resolve();
    expect(visualMeshes(f.root)).toEqual(f.previous);
    expect(f.binding.slotAnimLoads?.has(0)).toBe(false);
  });
});
