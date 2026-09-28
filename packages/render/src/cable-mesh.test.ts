import { Mesh, Ray, StandardMaterial, TransformNode, Vector3, VertexBuffer } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createActor, createDefaultScene, identitySerializedTransform, parseCableProperties } from "@babylonslate/core";
import { SNAPSHOT_FLAG_VISIBLE } from "@babylonslate/bridge";
import { applyCableFrame, createCableMesh, sampleCableFrame } from "./cable-mesh";
import { applyMaterialBounds } from "./material-bounds";
import { createTestEngine } from "./create-null-engine";
import { applySceneToBabylonScene, clearSceneMeshes, editorComponentMeshName } from "./scene-loader";
import { EditorSceneSync } from "./editor-scene-sync";
import { applyAssignMesh, applySnapshotToScene, createSnapshotSceneBinding, retirePlaySlot } from "./snapshot-apply";

function packet(id: number, points: number[], anchors = [-1, -1, 0, 0, 0, 0, 0, 0]): Float32Array {
  return new Float32Array([id, points.length / 3, ...anchors, ...points]);
}

describe("cable rendering", () => {
  const handles: ReturnType<typeof createTestEngine>[] = [];
  function setup() { const handle = createTestEngine(); handles.push(handle); return handle; }
  afterEach(() => { for (const handle of handles.splice(0)) { handle.scene.dispose(); handle.engine.dispose(); } });

  it("keeps tube buffers and topology while updating world geometry, normals, bounds and picking under a scaled parent", () => {
    const { scene } = setup();
    const mesh = createCableMesh(scene, "cable", { numSegments: 2, numSides: 4, cableWidth: 0.4, tileMaterial: 3 }, 7);
    const parent = new TransformNode("parent", scene);
    parent.position.set(10, 20, 30);
    parent.scaling.set(2, 3, 4);
    mesh.parent = parent;
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
    const normals = mesh.getVerticesData(VertexBuffer.NormalKind)!;
    const indices = mesh.getIndices();
    const uvs = mesh.getVerticesData(VertexBuffer.UVKind);
    const vertexBuffer = mesh.getVertexBuffer(VertexBuffer.PositionKind);
    const bounds = mesh.getBoundingInfo();
    applyCableFrame(scene, packet(7, [10, 20, 30, 12, 20, 30, 14, 20, 30]), 1);
    scene.onBeforeRenderObservable.notifyObservers(scene);
    expect(Vector3.TransformCoordinates(Vector3.FromArray(positions), mesh.getWorldMatrix()).asArray()).toEqual([10, expect.closeTo(20.2, 5), 30]);
    expect(mesh.getBoundingInfo().boundingBox.minimumWorld.asArray()).toEqual([10, expect.closeTo(19.8, 5), expect.closeTo(29.8, 5)]);
    expect(mesh.getBoundingInfo().boundingBox.maximumWorld.asArray()).toEqual([14, expect.closeTo(20.2, 5), expect.closeTo(30.2, 5)]);
    expect(scene.pickWithRay(new Ray(new Vector3(12, 20, 35), new Vector3(0, 0, -1)))?.pickedMesh).toBe(mesh);
    // The worker frame arrives before the actor snapshot. Reproject the same
    // world points after its parent moves instead of applying that motion twice.
    parent.position.x += 100;
    scene.onBeforeRenderObservable.notifyObservers(scene);
    expect(Vector3.TransformCoordinates(Vector3.FromArray(positions), mesh.getWorldMatrix()).asArray()).toEqual([expect.closeTo(10, 5), expect.closeTo(20.2, 5), 30]);
    applyCableFrame(scene, packet(7, [10, 24, 30, 12, 24, 30, 14, 24, 30]), 2);
    scene.onBeforeRenderObservable.notifyObservers(scene);
    expect(mesh.getBoundingInfo().boundingBox.minimumWorld.y).toBeCloseTo(23.8, 5);
    expect(mesh.getVerticesData(VertexBuffer.PositionKind)).toBe(positions);
    expect(mesh.getVerticesData(VertexBuffer.NormalKind)).toBe(normals);
    expect(mesh.getVertexBuffer(VertexBuffer.PositionKind)).toBe(vertexBuffer);
    expect(mesh.getIndices()).toBe(indices);
    expect(mesh.getVerticesData(VertexBuffer.UVKind)).toBe(uvs);
    expect(uvs?.[uvs.length - 1]).toBe(3);
    expect(mesh.getBoundingInfo()).toBe(bounds);
    const displaced = new StandardMaterial("displaced", scene);
    displaced.metadata = { boundsPadding: 0.5 };
    mesh.material = displaced;
    applyMaterialBounds(mesh);
    expect(mesh.getBoundingInfo()).toBe(bounds);
    expect(bounds.boundingBox.minimumWorld.y).toBeCloseTo(22.3, 5);
    applyCableFrame(scene, packet(7, [10, 26, 30, 12, 26, 30, 14, 26, 30]), 3);
    scene.onBeforeRenderObservable.notifyObservers(scene);
    expect(bounds.boundingBox.minimumWorld.y).toBeCloseTo(24.3, 5);
    mesh.material = null;
    applyMaterialBounds(mesh);
    expect(bounds.boundingBox.minimumWorld.y).toBeCloseTo(25.8, 5);
  });

  it("keeps collapsed and vertical cables finite and rejects incomplete or non-finite frames", () => {
    const { scene } = setup();
    const mesh = createCableMesh(scene, "cable", { numSegments: 2 }, 1);
    let frameId = 0;
    for (const points of [[0, 0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 2, 0, 0, 4, 0]]) {
      applyCableFrame(scene, packet(1, points), ++frameId);
      scene.onBeforeRenderObservable.notifyObservers(scene);
      expect(Array.from(mesh.getVerticesData(VertexBuffer.PositionKind)!).every(Number.isFinite)).toBe(true);
      const normals = mesh.getVerticesData(VertexBuffer.NormalKind)!;
      for (let i = 0; i < normals.length; i += 3) expect(Math.hypot(normals[i]!, normals[i + 1]!, normals[i + 2]!)).toBeCloseTo(1, 5);
    }
    const before = Array.from(mesh.getVerticesData(VertexBuffer.PositionKind)!);
    applyCableFrame(scene, packet(1, [0, NaN, 0, 0, 2, 0, 0, 4, 0]), 3);
    applyCableFrame(scene, new Float32Array([1, 3, -1, -1, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 4);
    scene.onBeforeRenderObservable.notifyObservers(scene);
    expect(Array.from(mesh.getVerticesData(VertexBuffer.PositionKind)!)).toEqual(before);
  });

  it("loads authored cables, resolves attached preview endpoints, and refreshes targets without rebuilding geometry", () => {
    const { scene } = setup();
    const material = new StandardMaterial("surface", scene);
    const actor = createActor("rope", "Rope", { components: [{ id: "cable", classId: "CableComponent", properties: { numSegments: 2, numSides: 4, cableWidth: 0.4, cableLength: 8, targetActorId: "target", endPosition: [0, 0, 0], materialGuid: "surface" } }] });
    actor.transform.position = [2, 0, 0];
    const target = createActor("target", "Target", { components: [] });
    target.transform.position = [10, 0, 0];
    const document = { ...createDefaultScene(), actors: [actor, target] };
    applySceneToBabylonScene(scene, document, { resolveMaterial: () => material });
    const loaded = scene.getMeshByName(editorComponentMeshName("rope", "cable"))!;
    expect(loaded.material).toBe(material);
    expect(loaded.getBoundingInfo().boundingBox.maximumWorld.x).toBeCloseTo(10);
    expect(scene.getMeshByName(editorComponentMeshName("rope", "billboard"))).toBeNull();
    clearSceneMeshes(scene);
    const sync = new EditorSceneSync(scene, undefined, { resolveMaterial: () => material });
    sync.apply(document);
    const mesh = scene.getMeshByName(editorComponentMeshName("rope", "cable"))!;
    const geometry = (mesh as Mesh).geometry;
    target.transform.position = [14, 0, 0];
    sync.apply({ ...document, actors: [actor, target] });
    expect(scene.getMeshByName(mesh.name)).toBe(mesh);
    expect((mesh as Mesh).geometry).toBe(geometry);
    expect(mesh.getBoundingInfo().boundingBox.maximumWorld.x).toBeCloseTo(14);
    actor.components[0]!.properties.numSegments = 4;
    sync.apply({ ...document, actors: [actor, target] });
    expect(scene.getMeshByName(mesh.name)?.getTotalVertices()).toBe(25);
    sync.dispose();
  });

  it("builds Play cable parts and retires simulation bindings when an actor despawns", () => {
    const { scene } = setup();
    const binding = createSnapshotSceneBinding();
    const cable = { ...parseCableProperties({ numSegments: 2, numSides: 4, cableWidth: 0.4 }), simulationId: 4 };
    applyAssignMesh(scene, binding, { type: "assignMesh", slotId: 8, meshKind: "cable", meshAssetGuid: null, parts: [{ componentId: "wire", meshKind: "cable", meshAssetGuid: null, ...identitySerializedTransform(), cable }] });
    applyCableFrame(scene, packet(4, [3, 4, 0, 4, 4, 0, 5, 4, 0]), 1);
    applySnapshotToScene(scene, binding, { frameId: 1, tickIndex: 1, alpha: 1, actorCount: 1, actors: [{ slotId: 8, flags: SNAPSHOT_FLAG_VISIBLE, position: { x: 3, y: 4, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } }] });
    scene.onBeforeRenderObservable.notifyObservers(scene);
    const mesh = scene.getMeshByName("actor-8|wire")!;
    expect(mesh.getBoundingInfo().boundingBox.maximumWorld.x).toBeCloseTo(5);
    expect(mesh.isVisible).toBe(true);
    const retiredData = Array.from(mesh.getVerticesData(VertexBuffer.PositionKind)!);
    const retainedPositions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
    retirePlaySlot(binding, 8);
    expect(mesh.isDisposed()).toBe(true);
    applyCableFrame(scene, packet(4, [30, 40, 0, 40, 40, 0, 50, 40, 0]), 2);
    scene.onBeforeRenderObservable.notifyObservers(scene);
    expect(Array.from(retainedPositions)).toEqual(retiredData);
    expect(scene.getMeshByName("actor-8|wire")).toBeNull();
  });

  it("resolves same-actor targets and keeps cable offsets through non-visual component ancestors", () => {
    const { scene } = setup();
    const actor = createActor("rig", "Rig", { components: [
      { id: "mount", classId: "SceneComponent", transform: { ...identitySerializedTransform(), position: [3, 0, 0] }, properties: {} },
      { id: "target-instance", sourceId: "target", classId: "SceneComponent", transform: { ...identitySerializedTransform(), position: [8, 0, 0] }, properties: {} },
      { id: "cable", classId: "CableComponent", parentId: "mount", transform: { ...identitySerializedTransform(), position: [1, 0, 0] }, properties: { targetComponentId: "target", endPosition: [1, 0, 0], cableLength: 5, cableWidth: 0.4, numSegments: 2, numSides: 4 } },
    ] });
    actor.transform.position = [10, 0, 0];
    applySceneToBabylonScene(scene, { ...createDefaultScene(), actors: [actor] });
    const mesh = scene.getMeshByName(editorComponentMeshName("rig", "cable"))!;
    expect(mesh.getBoundingInfo().boundingBox.minimumWorld.x).toBeCloseTo(14);
    expect(mesh.getBoundingInfo().boundingBox.maximumWorld.x).toBeCloseTo(19);
    actor.transform.scale = [2, 3, 4];
    actor.components[2]!.properties.cableLength = 10;
    applySceneToBabylonScene(scene, { ...createDefaultScene(), actors: [actor] });
    const scaled = scene.getMeshByName(editorComponentMeshName("rig", "cable"))!;
    expect(scaled.getBoundingInfo().boundingBox.minimumWorld.x).toBeCloseTo(18);
    expect(scaled.getBoundingInfo().boundingBox.maximumWorld.x).toBeCloseTo(28);
    expect(scaled.getBoundingInfo().boundingBox.maximumWorld.y).toBeCloseTo(0.2);
    expect(scaled.getBoundingInfo().boundingBox.minimumWorld.y).toBeCloseTo(-0.2);
  });

  it("coalesces pending packets and samples the actor frame pair across skipped and sleeping frames", () => {
    const { scene } = setup();
    const mesh = createCableMesh(scene, "cable", { numSegments: 2, numSides: 4, cableWidth: 0.4 }, 1);
    const upload = vi.spyOn(mesh, "updateVerticesData");
    applyCableFrame(scene, packet(1, [0, 0, 0, 1, 0, 0, 2, 0, 0]), 1);
    applyCableFrame(scene, packet(1, [0, 4, 0, 1, 4, 0, 2, 4, 0]), 4);
    applyCableFrame(scene, packet(1, [0, 8, 0, 1, 8, 0, 2, 8, 0]), 8);
    expect(upload).not.toHaveBeenCalled();
    sampleCableFrame(scene, 4, 1, 0.25);
    scene.onBeforeRenderObservable.notifyObservers(scene);
    expect(mesh.getBoundingInfo().boundingBox.minimumWorld.y).toBeCloseTo(0.8);
    expect(upload.mock.calls.filter(([kind]) => kind === VertexBuffer.PositionKind)).toHaveLength(1);
    scene.onBeforeRenderObservable.notifyObservers(scene);
    expect(upload.mock.calls.filter(([kind]) => kind === VertexBuffer.PositionKind)).toHaveLength(1);
    // No packet at frame 6: sleeping particles retain their last frame-4 pose.
    sampleCableFrame(scene, 8, 6, 0.5);
    scene.onBeforeRenderObservable.notifyObservers(scene);
    expect(mesh.getBoundingInfo().boundingBox.minimumWorld.y).toBeCloseTo(5.8);
    // Future packets wrapping the bounded history cannot evict this pinned pair.
    for (let frame = 9; frame < 30; frame++) applyCableFrame(scene, packet(1, [0, frame, 0, 1, frame, 0, 2, frame, 0]), frame);
    sampleCableFrame(scene, 8, 6, 0.75);
    scene.onBeforeRenderObservable.notifyObservers(scene);
    expect(mesh.getBoundingInfo().boundingBox.minimumWorld.y).toBeCloseTo(6.8);
    sampleCableFrame(scene, 31, 30, 0.3);
    scene.onBeforeRenderObservable.notifyObservers(scene);
    expect(mesh.getBoundingInfo().boundingBox.minimumWorld.y).toBeCloseTo(28.8);
    const sleepingUploads = upload.mock.calls.length;
    sampleCableFrame(scene, 32, 31, 0.7);
    scene.onBeforeRenderObservable.notifyObservers(scene);
    expect(upload.mock.calls).toHaveLength(sleepingUploads);
    upload.mockRestore();
  });

  it("pins attached endpoints to sampled actor poses when the retained particle history has advanced", () => {
    const { scene } = setup();
    const start = new Mesh("start", scene), end = new Mesh("end", scene);
    start.position.set(10, 5, 0); end.position.set(16, 5, 0);
    const mesh = createCableMesh(scene, "cable", { numSegments: 2, numSides: 4, cableWidth: 0.4 }, 1, (slot) => slot === 3 ? start : end);
    applyCableFrame(scene, packet(1, [100, 50, 0, 101, 50, 0, 102, 50, 0], [3, 4, 1, 0, 0, -1, 0, 0]), 30);
    sampleCableFrame(scene, 2, 1, 0.5);
    scene.onBeforeRenderObservable.notifyObservers(scene);
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
    // Opposite ring vertices average to the particle, independent of its tangent.
    expect((positions[0]! + positions[6]!) / 2).toBeCloseTo(11);
    expect((positions[1]! + positions[7]!) / 2).toBeCloseTo(5);
    expect((positions[30]! + positions[36]!) / 2).toBeCloseTo(15);
    expect((positions[31]! + positions[37]!) / 2).toBeCloseTo(5);
  });
});
