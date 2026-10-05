import { Mesh, Quaternion, Vector3 } from "@babylonjs/core";
import { SNAPSHOT_FLAG_VISIBLE } from "@babylonslate/bridge";
import { identitySerializedTransform, identityTransform } from "@babylonslate/core";
import { afterEach, expect, it } from "vitest";
import { createTestEngine } from "./create-null-engine";
import { applyAssignMesh, applyComponentTransformsCommand, applySnapshotToScene, createSnapshotSceneBinding } from "./snapshot-apply";
import type { SampledSnapshot } from "./snapshot-sync";

const handles: ReturnType<typeof createTestEngine>[] = [];
afterEach(() => { for (const handle of handles.splice(0)) { handle.scene.dispose(); handle.engine.dispose(); } });
function host() { const handle = createTestEngine(); handles.push(handle); return handle; }
function sample(): SampledSnapshot {
  return { frameId: 1, tickIndex: 1, alpha: 1, actorCount: 1,
    actors: [{ slotId: 0, flags: SNAPSHOT_FLAG_VISIBLE, ...identityTransform(), position: { x: 10, y: 1, z: 0 } }] };
}

it("composes a moving singleton component with unchanged and later actor snapshots without replacing its visual", () => {
  const { scene } = host(), binding = createSnapshotSceneBinding(), snapshot = sample();
  snapshot.actors[0]!.rotation = Quaternion.RotationAxis(Vector3.Forward(), Math.PI / 2);
  snapshot.actors[0]!.scale = { x: 2, y: 2, z: 2 };
  applyAssignMesh(scene, binding, { type: "assignMesh", slotId: 0, primaryComponentId: "mesh", meshKind: "box", meshAssetGuid: null });
  applySnapshotToScene(scene, binding, snapshot);
  const mesh = binding.meshes.get(0)!, geometry = mesh.geometry, material = mesh.material;
  const pose = identityTransform();
  pose.position.x = 2;
  pose.rotation = Quaternion.RotationAxis(Vector3.Forward(), Math.PI / 2);
  pose.scale = { x: 0.5, y: 0.75, z: 1 };
  const ancestor = identityTransform();
  ancestor.position.y = 3;
  applyComponentTransformsCommand(binding, { type: "setComponentTransforms", slotId: 0,
    parts: [{ componentId: "mesh", transform: pose, parentTransforms: [ancestor] }] });
  applySnapshotToScene(scene, binding, snapshot);
  expect(binding.meshes.get(0)).toBe(mesh);
  expect(mesh.geometry).toBe(geometry);
  expect(mesh.material).toBe(material);
  expect(mesh.getAbsolutePosition().x).toBeCloseTo(4);
  expect(mesh.getAbsolutePosition().y).toBeCloseTo(5);
  const scale = new Vector3(), rotation = new Quaternion();
  mesh.getWorldMatrix().decompose(scale, rotation);
  expect(scale.asArray()).toEqual([1, 1.5, 2]);
  expect(Math.abs(rotation.z)).toBeCloseTo(1);
  // An actor tick must continue to include the last component sample.
  snapshot.actors[0]!.position.x = 20;
  applySnapshotToScene(scene, binding, snapshot);
  expect(mesh.getAbsolutePosition().x).toBeCloseTo(14);
  expect(mesh.getAbsolutePosition().y).toBeCloseTo(5);
  expect(snapshot.actors[0]!.position.x).toBe(20);
  // A rotated component under nonuniform scale must retain the sheared basis.
  snapshot.actors[0]!.rotation = Quaternion.Identity();
  snapshot.actors[0]!.scale = { x: 2, y: 1, z: 1 };
  applyComponentTransformsCommand(binding, { type: "setComponentTransforms", slotId: 0, parts: [{ componentId: "mesh", transform: {
    ...identityTransform(), rotation: Quaternion.RotationAxis(Vector3.Forward(), Math.PI / 4),
  } }] });
  applySnapshotToScene(scene, binding, snapshot);
  const right = Vector3.TransformNormal(Vector3.Right(), mesh.getWorldMatrix());
  const up = Vector3.TransformNormal(Vector3.Up(), mesh.getWorldMatrix());
  expect(right.x).toBeCloseTo(Math.SQRT2); expect(right.y).toBeCloseTo(Math.SQRT1_2);
  expect(up.x).toBeCloseTo(-Math.SQRT2); expect(up.y).toBeCloseTo(Math.SQRT1_2);
});

it("updates visual and nonvisual ancestor poses in place while retaining nested component resources", () => {
  const { scene } = host(), binding = createSnapshotSceneBinding(), snapshot = sample();
  const ancestor = identityTransform();
  ancestor.position.y = 3;
  applyAssignMesh(scene, binding, { type: "assignMesh", slotId: 0, meshKind: "box", meshAssetGuid: null, parts: [
    { componentId: "a", meshKind: "box", ...identitySerializedTransform(), parentTransforms: [ancestor] },
    { componentId: "b", parentId: "a", meshKind: "sphere", ...identitySerializedTransform() },
  ] });
  applySnapshotToScene(scene, binding, snapshot);
  const root = binding.meshes.get(0)!, a = scene.getMeshByName("actor-0|a") as Mesh, b = scene.getMeshByName("actor-0|b") as Mesh;
  const resources = [a.geometry, a.material, b.geometry, b.material];
  const attachment = a.parent, nodes = scene.transformNodes.length;
  a.freezeWorldMatrix(); b.freezeWorldMatrix();
  for (const y of [4, 6]) {
    applyComponentTransformsCommand(binding, { type: "setComponentTransforms", slotId: 0, parts: [
      { componentId: "a", transform: { ...identityTransform(), position: { x: 4, y: 0, z: 0 } }, parentTransforms: [{ ...identityTransform(), position: { x: 0, y, z: 0 } }] },
      { componentId: "b", parentId: "a", transform: { ...identityTransform(), position: { x: 7, y: 0, z: 0 } } },
    ] });
    applySnapshotToScene(scene, binding, snapshot);
    expect(b.computeWorldMatrix(true).getTranslation().asArray()).toEqual([21, 1 + y, 0]);
    expect(a.parent).toBe(attachment);
    expect(scene.transformNodes.length).toBe(nodes);
  }
  expect(binding.meshes.get(0)).toBe(root);
  expect([a.geometry, a.material, b.geometry, b.material]).toEqual(resources);
  expect(a.isDisposed() || b.isDisposed()).toBe(false);
});
