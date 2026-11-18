import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { MultiMaterial } from "@babylonjs/core/Materials/multiMaterial";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { SubMesh } from "@babylonjs/core/Meshes/subMesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { SubMesh as SubMeshType } from "@babylonjs/core/Meshes/subMesh";
import { ObjectRenderer } from "@babylonjs/core/Rendering/objectRenderer";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, describe, expect, it } from "vitest";
import { attachLeanPreparation, leanPreparationDiagnostics, SELF_CHECK_STRIDE, verifyLeanPreparation } from "./lean-render-preparation";
import { noteRenderChange } from "./render-change-journal";

type Internals = {
  _prepareRenderingManager(passIndex?: number): AbstractMesh[] | null;
  _defaultRenderListPrepared: boolean;
  _renderPassIds: number[];
  renderingManager: { _renderingGroups: Array<Record<string, { length: number; data: SubMeshType[] }> | undefined> };
  _activeMeshes: { length: number; data: AbstractMesh[] };
};
type Queue = "_opaqueSubMeshes" | "_alphaTestSubMeshes" | "_transparentSubMeshes" | "_depthOnlySubMeshes";

const engines: NullEngine[] = [];
afterEach(() => {
  verifyLeanPreparation(false);
  while (engines.length) engines.pop()!.dispose();
});

function world() {
  const engine = new NullEngine();
  engines.push(engine);
  const scene = new Scene(engine);
  const camera = new FreeCamera("camera", new Vector3(0, 0, -10), scene);
  scene.activeCamera = camera;
  const renderer = new ObjectRenderer("objects", scene);
  attachLeanPreparation(renderer, "objects");
  const internals = renderer as unknown as Internals;
  const list: AbstractMesh[] = [];
  renderer.renderList = list;
  // As the frame graph's object task sets it.
  renderer.forceLayerMaskCheck = true;
  const box = (name: string) => {
    const mesh = MeshBuilder.CreateBox(name, { size: 1 }, scene);
    mesh.material = new StandardMaterial(`${name} material`, scene);
    list.push(mesh);
    return mesh;
  };
  /** One frame of the pass: what the frame graph's object task does around the preparation. */
  const prepare = () => {
    engine.beginFrame();
    scene.incrementRenderId();
    (scene as unknown as { _frameId: number })._frameId++;
    engine.currentRenderPassId = internals._renderPassIds[0]!;
    internals._defaultRenderListPrepared = false;
    internals._prepareRenderingManager(0);
    // Drawing a mesh clears its intermediate activation (`Mesh.render`).
    for (const mesh of scene.meshes) (mesh as unknown as { _internalAbstractMeshDataInfo: { _isActiveIntermediate: boolean } })._internalAbstractMeshDataInfo._isActiveIntermediate = false;
    engine.endFrame();
  };
  const name = (subMesh: SubMeshType) => {
    const owner = subMesh.getMesh();
    return owner.subMeshes.length > 1 ? `${owner.name}#${owner.subMeshes.indexOf(subMesh)}` : owner.name;
  };
  /** Each rendering group's queue, as the names of the meshes its sub-meshes belong to. */
  const queue = (which: Queue, group = 0) => {
    const array = internals.renderingManager._renderingGroups[group]?.[which];
    return array ? array.data.slice(0, array.length).map(name) : [];
  };
  const opaque = (group = 0) => queue("_opaqueSubMeshes", group);
  const transparent = (group = 0) => queue("_transparentSubMeshes", group);
  const active = () => internals._activeMeshes.data.slice(0, internals._activeMeshes.length).map((mesh) => mesh.name);
  const work = () => leanPreparationDiagnostics(scene)!;
  return { engine, scene, camera, renderer, list, box, prepare, queue, opaque, transparent, active, work };
}

/** The instances `source` registered for `renderId` in the current render pass. */
function registered(source: Mesh, renderId: number): number {
  const storage = (source as unknown as { _getInstanceDataStorage(): { visibleInstances: Record<number, unknown[]> | null } })._getInstanceDataStorage();
  return storage.visibleInstances?.[renderId]?.length ?? 0;
}

describe("lean render preparation", () => {
  it("queues what Babylon's preparation queues, keeping the answers between frames", () => {
    const w = world();
    w.box("a");
    const b = w.box("b");
    (b.material as StandardMaterial).alpha = 0.5;
    w.prepare();
    w.prepare();
    expect(w.opaque()).toEqual(["a"]);
    expect(w.transparent()).toEqual(["b"]);
    expect(w.active()).toEqual(["a", "b"]);
    // The second frame made no entry afresh.
    expect(w.work().refreshes).toBe(2);
    expect(w.work().passes).toBe(2);
  });

  type World = ReturnType<typeof world>;
  it.each([
    ["isVisible", (mesh: Mesh) => { mesh.isVisible = false; }],
    ["setEnabled", (mesh: Mesh) => { mesh.setEnabled(false); }],
    ["an ancestor's setEnabled", (mesh: Mesh, w: World) => {
      const parent = new TransformNode("parent", mesh.getScene());
      mesh.parent = parent;
      w.prepare();
      parent.setEnabled(false);
    }],
    ["an ancestor's isVisible, inherited", (mesh: Mesh, w: World) => {
      const parent = MeshBuilder.CreateBox("parent", { size: 1 }, mesh.getScene());
      mesh.parent = parent;
      mesh.inheritVisibility = true;
      w.prepare();
      parent.isVisible = false;
    }],
    ["inheritVisibility under a hidden parent", (mesh: Mesh, w: World) => {
      const parent = MeshBuilder.CreateBox("parent", { size: 1 }, mesh.getScene());
      parent.isVisible = false;
      mesh.parent = parent;
      w.prepare();
      mesh.inheritVisibility = true;
    }],
    ["layerMask", (mesh: Mesh) => { mesh.layerMask = 0x10000000; }],
  ] as Array<[string, (mesh: Mesh, w: World) => void]>)("stops queueing a mesh after its %s change", (_label, change) => {
    const w = world();
    w.box("a");
    const b = w.box("b");
    w.prepare();
    expect(w.opaque()).toEqual(["a", "b"]);
    change(b, w);
    w.prepare();
    expect(w.opaque()).toEqual(["a"]);
    expect(w.work().heals).toBe(0);
  });

  it("queues a mesh again when it shows again, and follows the camera's layer mask each pass", () => {
    const w = world();
    const a = w.box("a");
    a.isVisible = false;
    w.prepare();
    expect(w.opaque()).toEqual([]);
    a.isVisible = true;
    w.prepare();
    expect(w.opaque()).toEqual(["a"]);
    w.camera.layerMask = 0x10000000;
    w.prepare();
    expect(w.opaque()).toEqual([]);
    expect(w.work().heals).toBe(0);
  });

  it("moves a mesh between queues on a Material swap, a render-pass Material, visibility and vertex alpha", () => {
    const w = world();
    const a = w.box("a");
    const blended = new StandardMaterial("blended", w.scene);
    blended.alpha = 0.5;
    w.prepare();
    a.material = blended;
    w.prepare();
    expect(w.transparent()).toEqual(["a"]);
    a.material = new StandardMaterial("solid", w.scene);
    w.prepare();
    expect(w.opaque()).toEqual(["a"]);
    a.setMaterialForRenderPass(w.renderer.renderPassId, blended);
    w.prepare();
    expect(w.transparent()).toEqual(["a"]);
    a.setMaterialForRenderPass(w.renderer.renderPassId, undefined);
    w.prepare();
    expect(w.opaque()).toEqual(["a"]);
    a.visibility = 0.5;
    w.prepare();
    expect(w.transparent()).toEqual(["a"]);
    a.visibility = 1;
    w.prepare();
    expect(w.opaque()).toEqual(["a"]);
    a.hasVertexAlpha = true;
    w.prepare();
    expect(w.transparent()).toEqual(["a"]);
    expect(w.work().heals).toBe(0);
  });

  it("reads each Material's queue every pass: an alpha or transparency change needs no journal entry", () => {
    const w = world();
    const a = w.box("a");
    w.prepare();
    (a.material as StandardMaterial).alpha = 0.5;
    w.prepare();
    expect(w.transparent()).toEqual(["a"]);
    a.material!.transparencyMode = 1; // Alpha test.
    w.prepare();
    expect(w.queue("_alphaTestSubMeshes")).toEqual(["a"]);
    a.material!.needDepthPrePass = true;
    w.prepare();
    expect(w.queue("_depthOnlySubMeshes")).toEqual(["a"]);
  });

  it("asks a Material that replaces needAlphaBlendingForMesh per sub-mesh", () => {
    const w = world();
    const a = w.box("a");
    let blend = false;
    a.material!.needAlphaBlendingForMesh = () => blend;
    w.prepare();
    expect(w.opaque()).toEqual(["a"]);
    blend = true;
    w.prepare();
    expect(w.transparent()).toEqual(["a"]);
  });

  it("moves a mesh to its new rendering group", () => {
    const w = world();
    const a = w.box("a");
    w.prepare();
    a.renderingGroupId = 2;
    w.prepare();
    expect(w.opaque(0)).toEqual([]);
    expect(w.opaque(2)).toEqual(["a"]);
    expect(w.work().heals).toBe(0);
  });

  it("follows sub-mesh changes and MultiMaterial slots, which no journal entry names", () => {
    const w = world();
    const a = w.box("a");
    const red = new StandardMaterial("red", w.scene);
    const glass = new StandardMaterial("glass", w.scene);
    glass.alpha = 0.5;
    const multi = new MultiMaterial("multi", w.scene);
    multi.subMaterials = [red, red];
    a.material = multi;
    w.prepare();
    expect(w.opaque()).toEqual(["a"]);
    new SubMesh(1, 0, a.getTotalVertices(), 0, 6, a);
    w.prepare();
    expect(w.opaque()).toEqual(["a#0", "a#1"]);
    multi.subMaterials[1] = glass;
    w.prepare();
    expect(w.opaque()).toEqual(["a#0"]);
    expect(w.transparent()).toEqual(["a#1"]);
  });

  it("draws an instance through its source, whether or not the source is listed", () => {
    const w = world();
    const source = w.box("source");
    const one = source.createInstance("one");
    const two = source.createInstance("two");
    w.list.push(one, two);
    w.prepare();
    expect(w.opaque()).toEqual(["source"]);
    expect(registered(source, w.scene.getRenderId())).toBe(2);
    w.list.splice(0, 1);
    w.prepare();
    expect(w.opaque()).toEqual(["source"]);
    expect(w.active()).toEqual(["one", "two"]);
    expect(registered(source, w.scene.getRenderId())).toBe(2);
    // A source's Material and rendering group reach its instances' entries.
    const glass = new StandardMaterial("glass", w.scene);
    glass.alpha = 0.5;
    source.material = glass;
    w.prepare();
    expect(w.transparent()).toEqual(["source"]);
    source.renderingGroupId = 1;
    w.prepare();
    expect(w.transparent(1)).toEqual(["source"]);
    expect(w.work().heals).toBe(0);
  });

  it("selects LOD per frame once a mesh has levels, and keeps it fixed once they are removed", () => {
    const w = world();
    const a = w.box("a");
    const far = MeshBuilder.CreateBox("a far", { size: 1 }, w.scene);
    far.material = a.material;
    w.prepare();
    expect(w.opaque()).toEqual(["a"]);
    a.addLODLevel(5, far);
    w.prepare();
    expect(w.opaque()).toEqual(["a far"]);
    expect(w.work().liveMeshes).toBe(1);
    a.removeLODLevel(far);
    w.prepare();
    expect(w.opaque()).toEqual(["a"]);
    expect(w.work().liveMeshes).toBe(1);
  });

  it("hands every mesh to Babylon's path once the Scene's LOD selector is replaced", () => {
    const w = world();
    const a = w.box("a");
    const stand = w.box("stand-in");
    w.list.length = 1;
    w.prepare();
    w.scene.customLODSelector = (mesh) => (mesh === a ? stand : mesh);
    w.prepare();
    expect(w.opaque()).toEqual(["stand-in"]);
    expect(w.work().liveMeshes).toBe(1);
  });

  it("queues a mesh new to the list, and asks an unready mesh again each frame", () => {
    const w = world();
    w.box("a");
    w.prepare();
    const b = MeshBuilder.CreateBox("b", { size: 1 }, w.scene);
    b.material = new StandardMaterial("b material", w.scene);
    w.list.push(b);
    (b as unknown as { _setReady(state: boolean): void })._setReady(false);
    w.prepare();
    expect(w.opaque()).toEqual(["a"]);
    (b as unknown as { _setReady(state: boolean): void })._setReady(true);
    w.prepare();
    expect(w.opaque()).toEqual(["a", "b"]);
    b.delayLoadState = 2;
    w.prepare();
    expect(w.opaque()).toEqual(["a"]);
  });

  it("makes every entry afresh after a journal overflow", () => {
    const w = world();
    const a = w.box("a");
    w.prepare();
    // A write no hook hears, then more changes than the journal keeps for an unread reader.
    (a as unknown as { _nodeDataStorage: { _isVisible: boolean } })._nodeDataStorage._isVisible = false;
    for (let index = 0; index <= 1 << 16; index++) noteRenderChange(new TransformNode(`n${index}`, w.scene));
    w.prepare();
    expect(w.opaque()).toEqual([]);
    expect(w.work().overflows).toBe(1);
  });

  it("heals a kept answer that went stale unheard, and counts the field", () => {
    const w = world();
    const a = w.box("a");
    w.prepare();
    (a as unknown as { _nodeDataStorage: { _isVisible: boolean } })._nodeDataStorage._isVisible = false;
    for (let frame = 0; frame < SELF_CHECK_STRIDE; frame++) w.prepare();
    expect(w.opaque()).toEqual([]);
    expect(w.work().heals).toBe(1);
    expect(w.work().healedFields).toEqual(["enabledOrVisible"]);
  });

  describe("verifier", () => {
    it("finds the lean queues equal to Babylon's, which draw, without registering instances twice", () => {
      const w = world();
      verifyLeanPreparation(true);
      const source = w.box("source");
      const glass = w.box("glass");
      (glass.material as StandardMaterial).alpha = 0.5;
      const one = source.createInstance("one");
      const lone = w.box("lone");
      const only = lone.createInstance("only");
      w.list.splice(w.list.indexOf(lone), 1);
      w.list.push(one, only);
      const far = MeshBuilder.CreateBox("far", { size: 1 }, w.scene);
      const lod = w.box("lod");
      lod.addLODLevel(1, far);
      for (let frame = 0; frame < 3; frame++) w.prepare();
      expect(w.opaque()).toEqual(["source", "far", "lone"]);
      expect(w.transparent()).toEqual(["glass"]);
      expect(registered(source, w.scene.getRenderId())).toBe(1);
      expect(registered(lone, w.scene.getRenderId())).toBe(1);
      const work = w.work();
      expect(work.verifiedPasses).toBe(3);
      expect(work.mismatches).toBe(0);
      expect(work.babylonQueued).toBe(12);
      expect(work.leanQueued).toBe(12);
    });

    it("reports a lean queue that differs, while Babylon's draws", () => {
      const w = world();
      w.box("a");
      const b = w.box("b");
      w.prepare();
      verifyLeanPreparation(true);
      (b as unknown as { _nodeDataStorage: { _isVisible: boolean } })._nodeDataStorage._isVisible = false;
      w.prepare();
      expect(w.opaque()).toEqual(["a"]);
      const work = w.work();
      expect(work.mismatches).toBe(1);
      expect(work.mismatchExamples[0]).toBe('objects group 0 opaqueSubMeshes[1] of 1/2: Babylon none, lean "b" sub-mesh 0');
    });
  });
});

