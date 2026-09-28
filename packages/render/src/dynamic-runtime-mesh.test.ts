import { Mesh, Ray, StandardMaterial, Vector3, VertexBuffer } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DynamicRuntimeMeshGeometry, identitySerializedTransform } from "@babylonslate/core";
import { createTestEngine } from "./create-null-engine";
import { applyDynamicRuntimeMeshUpdate, createDynamicRuntimeMesh, flushDynamicRuntimeMeshes } from "./dynamic-runtime-mesh";
import { applyAssignMaterial, applyAssignMesh, createSnapshotSceneBinding, retirePlaySlot } from "./snapshot-apply";

describe("dynamic runtime mesh rendering", () => {
  const handles: ReturnType<typeof createTestEngine>[] = [];
  function setup() { const handle = createTestEngine(); handles.push(handle); return handle; }
  afterEach(() => { vi.restoreAllMocks(); for (const handle of handles.splice(0)) { handle.scene.dispose(); handle.engine.dispose(); } });

  it("coalesces partial GPU uploads, retains buffers, and updates bounds and cached picking", () => {
    const { engine, scene } = setup();
    const data = new DynamicRuntimeMeshGeometry();
    data.setGeometry([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]);
    const mesh = createDynamicRuntimeMesh(scene, "mesh", { meshId: 1, update: data.takeUpdate() });
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
    const positionBuffer = mesh.getVertexBuffer(VertexBuffer.PositionKind)!;
    const indices = mesh.getIndices();
    const ray = new Ray(new Vector3(0.2, 0.2, 5), new Vector3(0, 0, -1));
    expect(scene.pickWithRay(ray)?.pickedPoint?.z).toBeCloseTo(0);
    const upload = vi.spyOn(engine, "updateDynamicVertexBuffer");
    const indexUpload = vi.spyOn(engine, "updateDynamicIndexBuffer");
    data.updateVertices(1, [2, 0, 2]);
    applyDynamicRuntimeMeshUpdate(scene, 1, data.takeUpdate());
    data.updateVertices(2, [0, 2, 2]);
    applyDynamicRuntimeMeshUpdate(scene, 1, data.takeUpdate());
    expect(upload).not.toHaveBeenCalled();
    flushDynamicRuntimeMeshes(scene);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]?.slice(2)).toEqual([12, 24]);
    expect(indexUpload).not.toHaveBeenCalled();
    expect(mesh.getVertexBuffer(VertexBuffer.PositionKind)).toBe(positionBuffer);
    expect(mesh.getVerticesData(VertexBuffer.PositionKind)).toBe(positions);
    expect(mesh.getIndices()).toBe(indices);
    expect(mesh.getBoundingInfo().boundingBox.maximum.asArray()).toEqual([2, 2, 2]);
    expect(scene.pickWithRay(ray)?.pickedPoint?.z).toBeCloseTo(0.4);
    flushDynamicRuntimeMeshes(scene);
    expect(upload).toHaveBeenCalledTimes(1);
    data.setGeometry([0, 0, 1, 1, 0, 1, 0, 1, 1], [0, 2, 1]);
    applyDynamicRuntimeMeshUpdate(scene, 1, data.takeUpdate()); flushDynamicRuntimeMeshes(scene);
    expect(mesh.getVertexBuffer(VertexBuffer.PositionKind)).toBe(positionBuffer);
    expect(mesh.getIndices()).toBe(indices);
    expect([...indices!]).toEqual([0, 2, 1]);
    expect(scene.pickWithRay(ray)?.pickedPoint?.z).toBeCloseTo(1);
  });

  it("keeps component materials and attachment transforms through clear, replacement, and slot retirement", () => {
    const { scene } = setup();
    const binding = createSnapshotSceneBinding();
    const material = new StandardMaterial("shared", scene);
    binding.resolveMaterial = () => material;
    const data = new DynamicRuntimeMeshGeometry();
    applyAssignMesh(scene, binding, { type: "assignMesh", slotId: 4, meshKind: "dynamicRuntimeMesh", meshAssetGuid: null,
      parts: [{ componentId: "surface", meshKind: "dynamicRuntimeMesh", ...identitySerializedTransform(),
        parentTransforms: [{ position: { x: 5, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 2, y: 1, z: 1 } }],
        dynamicMesh: { meshId: 2, update: data.takeUpdate(true) } }] });
    const mesh = scene.getMeshByName("actor-4|surface") as Mesh;
    expect(mesh).toBeInstanceOf(Mesh); expect(mesh.getTotalVertices()).toBe(0);
    applyAssignMaterial(scene, binding, { type: "assignMaterial", slotId: 4, componentId: "surface", materialAssetGuid: "material" });
    data.setGeometry([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]);
    applyDynamicRuntimeMeshUpdate(scene, 2, data.takeUpdate()); flushDynamicRuntimeMeshes(scene);
    mesh.computeWorldMatrix(true);
    expect(mesh.material).toBe(material);
    expect(mesh.getBoundingInfo().boundingBox.maximumWorld.x).toBe(7);
    data.clear(); applyDynamicRuntimeMeshUpdate(scene, 2, data.takeUpdate()); flushDynamicRuntimeMeshes(scene);
    expect(mesh.geometry).toBeNull(); expect(mesh.material).toBe(material);
    data.setGeometry([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]);
    applyDynamicRuntimeMeshUpdate(scene, 2, data.takeUpdate()); flushDynamicRuntimeMeshes(scene);
    expect(mesh.getTotalVertices()).toBe(3);
    mesh.isVisible = false;
    data.updateVertices(0, [0, 0, 2]);
    applyDynamicRuntimeMeshUpdate(scene, 2, data.takeUpdate()); flushDynamicRuntimeMeshes(scene);
    expect(mesh.isVisible).toBe(false);
    retirePlaySlot(binding, 4);
    expect(mesh.isDisposed()).toBe(true); expect(scene.materials).toContain(material);
    data.updateVertices(0, [100, 0, 0]);
    applyDynamicRuntimeMeshUpdate(scene, 2, data.takeUpdate()); flushDynamicRuntimeMeshes(scene);
    expect(scene.getMeshByName("actor-4|surface")).toBeNull();
  });
});
