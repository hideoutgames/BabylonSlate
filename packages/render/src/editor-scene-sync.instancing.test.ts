import { afterEach, describe, expect, it } from "vitest";
import { InstancedMesh, Mesh, StandardMaterial, type Scene } from "@babylonjs/core";
import { createActor, createDefaultScene, createMeshComponent, type SerializedActor, type SerializedScene } from "@haptic/core";
import { createTestEngine } from "./create-null-engine";
import { EditorSceneSync } from "./editor-scene-sync";
import { sceneInstancePool, setSceneInstancing } from "./instance-pool";
import { collectNavBakeGeometry } from "./nav-bake-geometry";
import { pooledLeafOf } from "./pooled-visuals";
import { isEditorStaticMesh } from "./reflection-probes";

const handles: Array<ReturnType<typeof createTestEngine>> = [];
afterEach(() => { for (const { engine } of handles.splice(0)) engine.dispose(); });

/** An editor Scene whose primitives draw through its instance pool, resolving the Materials `library` builds. */
function pooledEditor(library: (scene: Scene) => Record<string, StandardMaterial> = () => ({})) {
  const handle = createTestEngine();
  handles.push(handle);
  handle.engine.getCaps().instancedArrays = true;
  setSceneInstancing(handle.scene, true);
  const materials = library(handle.scene);
  const sync = new EditorSceneSync(handle.scene, undefined, { resolveMaterial: (guid) => materials[guid] ?? null });
  return { sync, materials, pool: sceneInstancePool(handle.scene) };
}

const sceneWith = (actors: SerializedActor[]): SerializedScene => ({ ...createDefaultScene(), actors });

function crate(id: string, materialGuid?: string, x = 0): SerializedActor {
  const mesh = createMeshComponent(`${id}-mesh`, "box");
  if (materialGuid) mesh.properties.materialGuid = materialGuid;
  const actor = createActor(id, id, { components: [mesh] });
  actor.transform.position = [x, 0, 0];
  return actor;
}

/** The leaf an actor's primitive draws through. */
function leafOf(sync: EditorSceneSync, actorId: string): InstancedMesh {
  const leaf = pooledLeafOf(sync.meshForActor(actorId)!);
  if (!leaf) throw new Error(`${actorId} is not pooled`);
  return leaf;
}

describe("editor primitives drawn through the instance pool", () => {
  it("draws crates that share a Material in one group, and a tap on a crate's batch names its actor", () => {
    const { sync, pool } = pooledEditor();
    sync.apply(sceneWith([crate("a"), crate("b", undefined, 2), crate("c", undefined, 4)]));
    const leaves = ["a", "b", "c"].map((id) => leafOf(sync, id));
    expect(new Set(leaves.map((leaf) => leaf.sourceMesh)).size).toBe(1);
    expect(pool.diagnostics()).toMatchObject({ groups: 1, pooled: 3 });
    expect(leaves.map((leaf) => sync.actorForMesh(leaf.name))).toEqual(["a", "b", "c"]);
    expect(sync.visualMeshesForActor("b")).toEqual([leaves[1]]);
  });

  it("pools each primitive part of a multi-component actor, and a tap on any part names the actor", () => {
    const { sync, pool } = pooledEditor();
    const actor = createActor("pair", "Pair", { components: [createMeshComponent("left", "box"), createMeshComponent("right", "sphere")] });
    sync.apply(sceneWith([actor]));
    const drawn = sync.visualMeshesForActor("pair");
    expect(drawn.map((mesh) => mesh instanceof InstancedMesh)).toEqual([true, true]);
    expect(drawn.map((mesh) => sync.actorForMesh(mesh.name))).toEqual(["pair", "pair"]);
    expect(pool.diagnostics()).toMatchObject({ groups: 2, pooled: 2 });
    sync.apply(sceneWith([{ ...actor, visible: false }]));
    expect(drawn.map((mesh) => mesh.isVisible)).toEqual([false, false]);
  });

  it("hides and locks what draws: the crate's leaf", () => {
    const { sync } = pooledEditor();
    const actor = crate("a");
    sync.apply(sceneWith([actor]));
    expect([leafOf(sync, "a").isVisible, leafOf(sync, "a").isPickable]).toEqual([true, true]);
    sync.apply(sceneWith([{ ...actor, visible: false }]));
    expect(leafOf(sync, "a").isVisible).toBe(false);
    sync.apply(sceneWith([{ ...actor, visible: true, locked: true }]));
    expect([leafOf(sync, "a").isVisible, leafOf(sync, "a").isPickable]).toEqual([true, false]);
  });

  it("moves a crate to the group of its assigned Material and back when the assignment clears", () => {
    const { sync, pool, materials } = pooledEditor((scene) => ({ rock: new StandardMaterial("rock", scene) }));
    sync.apply(sceneWith([crate("a"), crate("b", "rock", 2)]));
    const [plain, rocky] = [leafOf(sync, "a"), leafOf(sync, "b")];
    expect(rocky.material).toBe(materials.rock);
    expect(rocky.sourceMesh).not.toBe(plain.sourceMesh);
    sync.apply(sceneWith([crate("a"), crate("b", undefined, 2)]));
    expect(leafOf(sync, "b")).toBe(rocky);
    expect(rocky.sourceMesh).toBe(plain.sourceMesh);
    expect(pool.diagnostics().pooled).toBe(2);
  });

  it("gives a crate with a Material no group draws a mesh of its own, which the construction Material restores", () => {
    const { sync, materials: { glass } } = pooledEditor((scene) => {
      const glass = new StandardMaterial("glass", scene);
      glass.alpha = 0.5;
      return { glass };
    });
    sync.apply(sceneWith([crate("a", "glass")]));
    const root = sync.meshForActor("a")!;
    expect(pooledLeafOf(root)).toBeUndefined();
    const own = root.getChildMeshes().find((mesh): mesh is Mesh => mesh instanceof Mesh && mesh.getTotalVertices() > 0)!;
    expect(own.material).toBe(glass);
    expect(sync.actorForMesh(own.name)).toBe("a");
    sync.apply(sceneWith([crate("a")]));
    expect(own.material).not.toBe(glass);
  });

  it("lets a reflection probe capture a static crate through its leaf", () => {
    const { sync } = pooledEditor();
    sync.apply(sceneWith([crate("wall"), crate("mover", undefined, 2)]));
    const statics = new Set(["wall"]);
    expect([isEditorStaticMesh(leafOf(sync, "wall"), statics), isEditorStaticMesh(leafOf(sync, "mover"), statics)]).toEqual([true, false]);
  });

  it("bakes a pooled crate's triangles into the nav mesh", () => {
    const { sync } = pooledEditor();
    const data = sceneWith([crate("a")]);
    sync.apply(data);
    const pooled = collectNavBakeGeometry(sync, data);
    const unpooled = (() => {
      const handle = createTestEngine();
      handles.push(handle);
      const plain = new EditorSceneSync(handle.scene);
      plain.apply(data);
      return collectNavBakeGeometry(plain, data);
    })();
    expect(pooled.indices.length).toBeGreaterThan(0);
    expect(pooled).toEqual(unpooled);
  });
});
