import { afterEach, describe, expect, it } from "vitest";
import { InstancedMesh, Mesh, StandardMaterial } from "@babylonjs/core";
import { createTestEngine } from "./create-null-engine";
import { encodeUvHierarchyGlb } from "./glb-test-fixtures";
import { sceneInstancePool, setSceneInstancing } from "./instance-pool";
import { loadModelContainer, modelMaterialIndexOf } from "./model-container";
import { applyModelMaterialSlots } from "./model-preview";
import { poolModelLeaves } from "./pooled-model-leaves";

const handles: Array<ReturnType<typeof createTestEngine>> = [];
afterEach(() => { for (const { engine } of handles.splice(0)) engine.dispose(); });

/** A pooling Scene's template container of a two-part model, each part naming its own glTF material. */
async function modelScene(pooling = true) {
  const handle = createTestEngine();
  handles.push(handle);
  handle.engine.getCaps().instancedArrays = true;
  setSceneInstancing(handle.scene, pooling);
  const container = await loadModelContainer(handle.scene, encodeUvHierarchyGlb({ separateMaterials: true }), "two-parts.glb");
  const holds: string[] = [];
  /** An instance of the model under its own root, as Play's model load builds one. */
  const instance = (name: string) => {
    const root = new Mesh(name, handle.scene);
    for (const node of container.instantiateModelsToScene((source) => source, false, { doNotInstantiate: true }).rootNodes) node.parent = root;
    return root;
  };
  const retain = () => { holds.push("held"); return () => { holds.push("released"); }; };
  return { scene: handle.scene, container, instance, retain, holds, pool: sceneInstancePool(handle.scene) };
}

const part = (root: Mesh, name: string) => root.getChildMeshes().find((mesh) => mesh.name === name)!;

describe("poolModelLeaves", () => {
  it("draws the same part of two instances in one group, in place, keeping each part's Material slot", async () => {
    const { instance, container, retain, pool, holds } = await modelScene();
    const [left, right] = [instance("left"), instance("right")];
    const before = { parent: part(left, "part-a").parent, position: part(left, "part-a").position.asArray(), slot: modelMaterialIndexOf(part(left, "part-a")) };
    const members = [...poolModelLeaves(left, container, { retain }), ...poolModelLeaves(right, container, { retain })];
    expect(members.map((member) => member.name)).toEqual(["part-a", "part-b", "part-a", "part-b"]);
    const a = part(left, "part-a");
    expect(a).toBeInstanceOf(InstancedMesh);
    expect({ parent: a.parent, position: a.position.asArray(), slot: modelMaterialIndexOf(a) }).toEqual(before);
    expect((a as InstancedMesh).sourceMesh).toBe((part(right, "part-a") as InstancedMesh).sourceMesh);
    // One group per part, each holding the container.
    expect(pool.diagnostics()).toMatchObject({ groups: 2, pooled: 4 });
    expect(holds).toEqual(["held", "held"]);
    for (const root of [left, right]) root.dispose();
    expect(holds.filter((hold) => hold === "released")).toHaveLength(2);
  });

  it("moves a pooled part to the group of the Material its slot assigns", async () => {
    const { scene, instance, container, retain, pool } = await modelScene();
    const [left, right] = [instance("left"), instance("right")];
    poolModelLeaves(left, container, { retain });
    poolModelLeaves(right, container, { retain });
    const stone = new StandardMaterial("stone", scene);
    applyModelMaterialSlots(left, [{ index: 0, name: "MatA", materialGuid: "stone" }], () => stone);
    const [leftA, rightA] = [part(left, "part-a") as InstancedMesh, part(right, "part-a") as InstancedMesh];
    expect([leftA.material, rightA.material]).toEqual([stone, null]);
    expect(leftA.sourceMesh).not.toBe(rightA.sourceMesh);
    expect(pool.diagnostics()).toMatchObject({ groups: 3, pooled: 4 });
  });

  it("gives a part a mesh of its own, in place, for a Material no group draws", async () => {
    const { scene, instance, container, retain } = await modelScene();
    const root = instance("model");
    poolModelLeaves(root, container, { retain });
    const glass = new StandardMaterial("glass", scene);
    glass.alpha = 0.5;
    applyModelMaterialSlots(root, [{ index: 0, name: "MatA", materialGuid: "glass" }], () => glass);
    const own = part(root, "part-a");
    expect(own).toBeInstanceOf(Mesh);
    expect([own.material, modelMaterialIndexOf(own), own.getTotalVertices()]).toEqual([glass, 0, 3]);
  });

  it("leaves a model alone where the Scene does not pool", async () => {
    const { instance, container, retain } = await modelScene(false);
    const root = instance("model");
    expect(poolModelLeaves(root, container, { retain })).toEqual([]);
    expect(part(root, "part-a")).toBeInstanceOf(Mesh);
  });
});
