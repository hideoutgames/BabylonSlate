import { afterEach, describe, expect, it, vi } from "vitest";
import { InstancedMesh, Logger, Mesh, NullEngine, Scene, StandardMaterial, type Material } from "@babylonjs/core";
import { sceneInstancePool, setSceneInstancing } from "./instance-pool";
import { actorMeshName } from "./picking";
import { onPooledLeafEjected, pooledLeafOf } from "./pooled-visuals";
import { sceneShadowController } from "./shadow-controller";
import * as snapshots from "./snapshot-apply";

const disposers: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (disposers.length) disposers.pop()!();
});

/** A Play binding whose Materials resolve to one StandardMaterial per guid and instance key, on a Scene with instancing. */
function setup({ instancing = true } = {}) {
  const engine = new NullEngine();
  engine.getCaps().instancedArrays = true;
  const scene = new Scene(engine);
  disposers.push(() => { scene.dispose(); engine.dispose(); });
  setSceneInstancing(scene, instancing);
  const binding = snapshots.createSnapshotSceneBinding();
  const materials = new Map<string, Material>();
  binding.resolveMaterial = (guid, options) => {
    const key = `${guid}|${options?.instanceKey ?? ""}`;
    let material = materials.get(key);
    if (!material) {
      const standard = new StandardMaterial(key, options?.scene ?? scene);
      if (guid === "glass") standard.alpha = 0.5;
      materials.set(key, (material = standard));
    }
    return material;
  };
  binding.validateMaterialParameter = () => true;
  const box = (slotId: number, extra: Partial<Parameters<typeof snapshots.applyAssignMesh>[2]> = {}) => {
    snapshots.applyAssignMesh(scene, binding, { type: "assignMesh", slotId, meshKind: "box", meshAssetGuid: null, ...extra });
    return binding.meshes.get(slotId)!;
  };
  const assign = (slotId: number, materialAssetGuid: string) =>
    snapshots.applyAssignMaterial(scene, binding, { type: "assignMaterial", slotId, materialAssetGuid });
  return { scene, binding, box, assign, materials };
}

describe("a Play primitive drawn through the instance pool", () => {
  it("is drawn by its own mesh while instancing is off", () => {
    const { box } = setup({ instancing: false });
    const root = box(1);
    expect([root.getTotalVertices() > 0, pooledLeafOf(root)]).toEqual([true, undefined]);
  });

  it("keeps the slot root as a mesh without geometry, drawn by a pool member under it that picks as the actor", () => {
    const { scene, box } = setup();
    const [first, second] = [box(1), box(2)];
    const leaf = pooledLeafOf(first)!;
    expect({
      root: first.getTotalVertices(), leaf: leaf instanceof InstancedMesh, parent: leaf.parent === first, name: leaf.name,
      picked: actorMeshName(leaf), shared: leaf.sourceMesh === pooledLeafOf(second)!.sourceMesh,
    }).toEqual({ root: 0, leaf: true, parent: true, name: "actor-1:drawn", picked: "actor-1", shared: true });
    expect(sceneInstancePool(scene).diagnostics()).toMatchObject({ groups: 1, pooled: 2 });
  });

  it("moves to the group of the Material assigned to it, and of a private instance a parameter write makes", () => {
    const { box, assign, binding } = setup();
    const [first, second] = [box(1), box(2)];
    assign(1, "stone");
    const stone = pooledLeafOf(first)!;
    expect(stone.material?.name).toBe("stone|");
    expect(stone.sourceMesh).not.toBe(pooledLeafOf(second)!.sourceMesh);
    assign(2, "stone");
    expect(pooledLeafOf(second)!.sourceMesh).toBe(stone.sourceMesh);
    snapshots.applySetMaterialParameter(binding, {
      type: "setMaterialParameter", slotId: 1, materialAssetGuid: "stone", parameterName: "Roughness", parameter: { kind: "float", value: 0.2 },
    });
    expect(pooledLeafOf(first)!.material?.name).toBe("stone|1|");
    expect(pooledLeafOf(first)!.sourceMesh).not.toBe(pooledLeafOf(second)!.sourceMesh);
    // The same node all along.
    expect(pooledLeafOf(first)).toBe(stone);
  });

  it("leaves the pool for a blended Material, drawing a mesh of its own in the leaf's place", () => {
    const { scene, box, assign } = setup();
    const root = box(1);
    const ejected: string[] = [];
    onPooledLeafEjected(scene, (mesh) => ejected.push(mesh.name));
    assign(1, "glass");
    const drawn = root.getChildMeshes().find((mesh) => mesh.name === "actor-1:drawn")!;
    expect({
      leaf: pooledLeafOf(root), own: drawn instanceof Mesh, vertices: drawn.getTotalVertices() > 0, material: drawn.material?.name, ejected,
      pooled: sceneInstancePool(scene).diagnostics().pooled,
    }).toEqual({ leaf: undefined, own: true, vertices: true, material: "glass|", ejected: ["actor-1"], pooled: 0 });
  });

  it("draws in the world rendering group and receives shadows as its participation says, through its group", () => {
    const { scene, box } = setup();
    const warn = vi.spyOn(Logger, "Warn");
    const root = box(1);
    const shadows = sceneShadowController(scene);
    shadows.setParticipation(root, { receiveShadows: false });
    shadows.sync();
    const leaf = pooledLeafOf(root)!;
    expect([leaf.renderingGroupId, leaf.receiveShadows, root.renderingGroupId]).toEqual([root.renderingGroupId, false, root.renderingGroupId]);
    shadows.setParticipation(root, { receiveShadows: true });
    shadows.sync();
    expect(leaf.receiveShadows).toBe(true);
    // Babylon warns when an instance's own setters are written.
    expect(warn).not.toHaveBeenCalled();
  });

  it("stays unpooled when the slot binds a deformer", () => {
    const { box, binding } = setup();
    binding.deformers.set(1, { actorId: "a", revision: 1, bindings: [] });
    expect(pooledLeafOf(box(1))).toBeUndefined();
    expect(pooledLeafOf(box(2))).toBeDefined();
  });

  it("sorts by an explicit layer or order in a group of its own, its leaf carrying the root's order", () => {
    const { scene, box } = setup();
    const plain = pooledLeafOf(box(1))!;
    const ordered = pooledLeafOf(box(2, { orderInLayer: 2 }))!;
    const sameOrder = pooledLeafOf(box(3, { orderInLayer: 2 }))!;
    const root = scene.getMeshByName("actor-2")!;
    expect({
      ownGroup: ordered.sourceMesh !== plain.sourceMesh, alphaIndex: ordered.alphaIndex === root.alphaIndex,
      sortingGroup: (ordered.metadata as { sortingGroupId?: string }).sortingGroupId === (root.metadata as { sortingGroupId?: string }).sortingGroupId,
      renderingGroup: ordered.renderingGroupId === root.renderingGroupId,
      // A sorting group is per actor, so even the same order sorts apart.
      apart: sameOrder.sourceMesh !== ordered.sourceMesh,
    }).toEqual({ ownGroup: true, alphaIndex: true, sortingGroup: true, renderingGroup: true, apart: true });
  });

  it("leaves its group when the slot's visual is disposed", () => {
    const { scene, box } = setup();
    const root = box(1);
    root.dispose();
    expect(sceneInstancePool(scene).diagnostics()).toMatchObject({ groups: 0, pooled: 0 });
  });
});
