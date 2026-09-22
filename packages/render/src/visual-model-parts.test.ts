import { installAssetBytes } from "@babylonslate/assets";
import { NullEngine, Scene, StandardMaterial } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeParentedAnimatedTriangleGlb } from "./model-mesh";
import * as modelContainer from "./model-container";
import { applyAssignMesh, applyAssignMaterial, applySetMaterialParameter, createSnapshotSceneBinding, disposeSnapshotBinding, retirePlaySlot, type AssignMeshCommand } from "./snapshot-apply";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const engines: NullEngine[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const engine of engines.splice(0)) engine.dispose(); });
function fixture() {
  const engine = new NullEngine(); engines.push(engine);
  const scene = new Scene(engine);
  const binding = createSnapshotSceneBinding();
  binding.modelSources = new Map(["old", "first", "second", "next-first", "next-second"].map((name) =>
    [name, installAssetBytes(encodeParentedAnimatedTriangleGlb(name))]));
  return { scene, binding };
}
function parts(first = "first", second = "second"): AssignMeshCommand {
  return { type: "assignMesh", slotId: 1, meshKind: "box", meshAssetGuid: null,
    parts: [first, second].map((guid, index) => ({ componentId: `part-${index}`, parentId: null,
      meshKind: "box", meshAssetGuid: guid, position: [index * 2, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
    })),
  };
}
function ownedMaterial(f: ReturnType<typeof fixture>) {
  const material = new StandardMaterial("retained-private-material", f.scene);
  f.binding.componentMaterialGuids.set("1|removed", "authored");
  f.binding.materialParameters.set("1|removed", { materialAssetGuid: "authored", values: new Map() });
  f.binding.resolveMaterial = () => material;
  const release = vi.fn(() => material.dispose(false, false));
  f.binding.releaseMaterialInstance = release;
  return { material, release };
}
async function initialModel(f: ReturnType<typeof fixture>) {
  applyAssignMesh(f.scene, f.binding, { type: "assignMesh", slotId: 1, meshKind: "box", meshAssetGuid: "old", primaryComponentId: "removed" });
  await f.binding.slotAnimLoads!.get(1);
  return f.binding.meshes.get(1)!;
}

describe("Play multipart model publication", () => {
  it.each([false, true])("publishes both prepared model parts and animation lookups together (replacement=%s)", async (replacement) => {
    const f = fixture();
    const retained = replacement ? ownedMaterial(f) : undefined;
    if (replacement) await initialModel(f);
    const previous = f.binding.meshes.get(1);
    const previousGroups = f.binding.slotAnimationGroups?.get(1);
    const entered = deferred<void>();
    const ready = deferred<void>();
    const nativeLoad = modelContainer.loadModelContainer;
    vi.spyOn(modelContainer, "loadModelContainer").mockImplementation(async (...args) => {
      if (args[2] === "second.glb") { entered.resolve(); await ready.promise; }
      return nativeLoad(...args);
    });
    try {
      applyAssignMesh(f.scene, f.binding, parts());
      const load = f.binding.slotAnimLoads!.get(1)!;
      const placeholder = f.binding.meshes.get(1)!;
      await entered.promise;
      expect(f.binding.meshes.get(1)).toBe(previous ?? placeholder);
      expect(f.binding.slotAnimationGroups?.get(1)).toBe(previousGroups);
      expect(placeholder.isDisposed()).toBe(false);
      if (retained) { expect(retained.release).not.toHaveBeenCalled(); expect(f.scene.materials).toContain(retained.material); }
      ready.resolve(); await load;
      const winner = f.binding.meshes.get(1)!;
      expect(winner).not.toBe(placeholder);
      expect(placeholder.isDisposed()).toBe(true);
      if (retained) { expect(retained.release).toHaveBeenCalledOnce(); expect(f.scene.materials).not.toContain(retained.material); }
      expect(winner.getChildMeshes().filter((mesh) => mesh.getTotalVertices() === 3)).toHaveLength(2);
      expect(f.binding.slotAnimationGroups!.get(1)!.map((group) => group.name).sort()).toEqual(["first", "second"]);
      retirePlaySlot(f.binding, 1);
      expect(f.binding.slotAnimationGroups?.get(1)).toBeUndefined();
    } finally { disposeSnapshotBinding(f.binding); f.scene.dispose(); }
  });

  it.each([false, true])("keeps the prior hierarchy after a failed part and releases its owner only on retirement (retry=%s)", async (retry) => {
    const f = fixture();
    const retained = ownedMaterial(f);
    const previous = await initialModel(f);
    const previousGroups = f.binding.slotAnimationGroups!.get(1);
    const entered = deferred<void>();
    const failure = deferred<void>();
    const nativeLoad = modelContainer.loadModelContainer;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const loader = vi.spyOn(modelContainer, "loadModelContainer").mockImplementation(async (...args) => {
      if (args[2] === "second.glb") { entered.resolve(); await failure.promise; }
      return nativeLoad(...args);
    });
    try {
      applyAssignMesh(f.scene, f.binding, parts());
      const load = f.binding.slotAnimLoads!.get(1)!;
      const candidate = f.scene.meshes.find((mesh) => mesh !== previous && mesh.name === "actor-1")!;
      await entered.promise;
      failure.reject(new Error("Controlled second-part decode failure"));
      await expect(load).rejects.toThrow("second-part decode failure");
      expect(f.binding.meshes.get(1)).toBe(previous);
      expect(previous.isDisposed()).toBe(false);
      expect(f.binding.slotAnimationGroups!.get(1)).toBe(previousGroups);
      expect(candidate.isDisposed()).toBe(true);
      expect(retained.release).not.toHaveBeenCalled();
      expect(f.scene.materials).toContain(retained.material);
      if (retry) {
        loader.mockRestore();
        applyAssignMesh(f.scene, f.binding, parts());
        await f.binding.slotAnimLoads!.get(1);
        expect(f.binding.meshes.get(1)).not.toBe(previous);
        expect(previous.isDisposed()).toBe(true);
      } else disposeSnapshotBinding(f.binding);
      expect(retained.release).toHaveBeenCalledOnce();
      expect(f.scene.materials).not.toContain(retained.material);
    } finally { disposeSnapshotBinding(f.binding); f.scene.dispose(); }
  });

  it.each(["late", "third", "old-material"])("restarts material preparation and retires exact private owners across A/B/%s", async (finalGuid) => {
    const f = fixture();
    const materials = new Map(["old-material", "late", "third"].map((guid) => [guid, new StandardMaterial(guid, f.scene)]));
    const oldMaterial = materials.get("old-material")!;
    const material = materials.get(finalGuid)!;
    const privateOwners = new Set<string>();
    const releases = new Map<string, number>();
    f.binding.materialAssetGuids.set(1, "old-material");
    f.binding.materialParameters.set("1|", { materialAssetGuid: "old-material", values: new Map() });
    f.binding.resolveMaterial = (guid, options) => {
      if (options?.instanceKey) privateOwners.add(guid);
      return materials.get(guid) ?? null;
    };
    f.binding.releaseMaterialInstance = (_key, guid) => {
      for (const owner of [...privateOwners]) {
        if (guid && owner !== guid) continue;
        privateOwners.delete(owner);
        releases.set(owner, (releases.get(owner) ?? 0) + 1);
        materials.get(owner)!.dispose(false, false);
      }
    };
    const previous = await initialModel(f);
    const modelEntered = deferred<void>();
    const modelReady = deferred<void>();
    const materialEntered = deferred<void>();
    const materialReady = deferred<void>();
    vi.spyOn(material, "forceCompilationAsync").mockImplementation(() => {
      materialEntered.resolve();
      return materialReady.promise;
    });
    const nativeLoad = modelContainer.loadModelContainer;
    vi.spyOn(modelContainer, "loadModelContainer").mockImplementation(async (...args) => {
      if (args[2] === "second.glb") { modelEntered.resolve(); await modelReady.promise; }
      return nativeLoad(...args);
    });
    try {
      applyAssignMesh(f.scene, f.binding, parts());
      const obsolete = [f.binding.slotAnimLoads!.get(1)!];
      await modelEntered.promise;
      const assignPrivate = (guid: string) => {
        applyAssignMaterial(f.scene, f.binding, { type: "assignMaterial", slotId: 1, materialAssetGuid: guid });
        obsolete.push(f.binding.slotAnimLoads!.get(1)!);
        applySetMaterialParameter(f.binding, { type: "setMaterialParameter", slotId: 1,
          materialAssetGuid: guid, parameterName: "amount", parameter: { kind: "float", value: 0.5 } });
      };
      assignPrivate("late");
      if (finalGuid !== "late") { obsolete.push(f.binding.slotAnimLoads!.get(1)!); assignPrivate(finalGuid); }
      const latest = f.binding.slotAnimLoads!.get(1)!;
      expect(latest).not.toBe(obsolete[0]);
      modelReady.resolve();
      await materialEntered.promise;
      expect(f.binding.meshes.get(1)).toBe(previous);
      expect(previous.isDisposed()).toBe(false);
      expect(releases.get("old-material") ?? 0).toBe(0);
      expect(f.scene.materials).toContain(oldMaterial);
      if (finalGuid !== "late") expect(releases.get("late")).toBe(1);
      expect([...privateOwners].sort()).toEqual([...new Set(["old-material", finalGuid])].sort());
      for (const mesh of previous.getChildMeshes().filter((mesh) => mesh.getTotalVertices() === 3)) expect(mesh.material).toBe(oldMaterial);
      materialReady.resolve();
      await latest; await Promise.all(obsolete);
      const winner = f.binding.meshes.get(1)!;
      expect(winner).not.toBe(previous);
      expect(releases.get("old-material") ?? 0).toBe(finalGuid === "old-material" ? 0 : 1);
      expect(f.scene.materials).toContain(material);
      const triangles = winner.getChildMeshes().filter((mesh) => mesh.getTotalVertices() === 3);
      expect(triangles).toHaveLength(2);
      for (const mesh of triangles) expect(mesh.material).toBe(material);
      retirePlaySlot(f.binding, 1);
      expect(privateOwners.size).toBe(0);
      for (const count of releases.values()) expect(count).toBe(1);
    } finally { disposeSnapshotBinding(f.binding); f.scene.dispose(); }
  });

  it("makes superseded multipart completion inert and retires pending models on owner removal", async () => {
    const f = fixture();
    await initialModel(f);
    const entered = deferred<void>();
    const ready = deferred<void>();
    const nativeLoad = modelContainer.loadModelContainer;
    vi.spyOn(modelContainer, "loadModelContainer").mockImplementation(async (...args) => {
      if (args[2] === "second.glb") { entered.resolve(); await ready.promise; }
      return nativeLoad(...args);
    });
    try {
      applyAssignMesh(f.scene, f.binding, parts());
      const obsolete = f.binding.slotAnimLoads!.get(1)!;
      await entered.promise;
      applyAssignMesh(f.scene, f.binding, parts("next-first", "next-second"));
      await f.binding.slotAnimLoads!.get(1);
      const winner = f.binding.meshes.get(1)!;
      const winningGroups = f.binding.slotAnimationGroups!.get(1)!;
      ready.resolve(); await obsolete;
      expect(f.binding.meshes.get(1)).toBe(winner);
      expect(f.binding.slotAnimationGroups!.get(1)).toBe(winningGroups);
      expect(winningGroups.map((group) => group.name).sort()).toEqual(["next-first", "next-second"]);
      applyAssignMesh(f.scene, f.binding, parts());
      const pending = f.binding.slotAnimLoads!.get(1)!;
      retirePlaySlot(f.binding, 1);
      await pending;
      expect(f.binding.meshes.has(1)).toBe(false);
      expect(f.binding.slotAnimationGroups?.has(1)).toBe(false);
      expect(f.scene.meshes).toHaveLength(0);
    } finally { disposeSnapshotBinding(f.binding); f.scene.dispose(); }
  });
});
