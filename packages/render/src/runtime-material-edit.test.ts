import { afterEach, expect, it } from "vitest";
import { InputBlock, MeshBuilder, NodeMaterial, NullEngine, Scene } from "@babylonjs/core";
import { createDefaultMaterialDocument } from "@babylonslate/shader-graph";
import { MaterialLibrary, ownedMaterialPreparation } from "./material-library";
import { applyAssignMaterial, createSnapshotSceneBinding } from "./snapshot-apply";
import { RuntimeMaterialEditOwner, type RuntimeMaterialPreparationRequest } from "./runtime-material-edit";

const disposers: (() => void)[] = [];
afterEach(() => { while (disposers.length) disposers.pop()?.(); });
async function fixture() {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const library = new MaterialLibrary();
  const binding = createSnapshotSceneBinding();
  const document = createDefaultMaterialDocument();
  document.nodes.push({ id: "roughness", type: "param.float", position: { x: 0, y: 0 }, properties: { name: "Roughness", value: [0.5] } });
  document.edges.push({ id: "roughness-output", sourceNodeId: "roughness", sourcePinId: "out", targetNodeId: "output", targetPinId: "roughness" });
  binding.resolveMaterial = (guid, options) => ["material", "replacement"].includes(guid) ? library.resolve(scene, guid, document, options) : null;
  binding.validateMaterialParameter = (_guid, name, value) => library.acceptsParameter(document, name, value);
  binding.releaseMaterialInstance = (key, guid) => library.releaseInstance(key, guid);
  const mesh = MeshBuilder.CreateBox("actor-1", {}, scene);
  const sibling = MeshBuilder.CreateBox("actor-2", {}, scene);
  binding.meshes.set(1, mesh);
  binding.primaryComponentIds.set(1, "body");
  binding.meshSorting.set(1, { actorGuid: "actor", sortingLayer: "Default", orderInLayer: 0 });
  applyAssignMaterial(scene, binding, { type: "assignMaterial", slotId: 1, componentId: "body", materialAssetGuid: "material" });
  sibling.material = mesh.material;
  await ownedMaterialPreparation(mesh.material!);
  const owner = new RuntimeMaterialEditOwner(binding, library);
  disposers.push(() => { owner.dispose(); library.dispose(); scene.dispose(); engine.dispose(); });
  const request: RuntimeMaterialPreparationRequest = { sessionGeneration: 1, requestId: 1, editToken: "session-1:1",
    slotId: 1, actorGuid: "actor", componentId: "body", materialGuid: "material", parameterName: "Roughness", parameter: { kind: "float", value: 0.9 } };
  const commit = () => owner.commit({ type: "setMaterialParameter", slotId: 1, componentId: "body", materialAssetGuid: "material",
    parameterName: "Roughness", parameter: { kind: "float", value: 0.9 }, preparedEditToken: request.editToken });
  return { scene, mesh, sibling, library, binding, owner, request, commit };
}
const roughness = (material: NodeMaterial) => (material.getBlockByName("roughness") as InputBlock).value;

it("prepares a private candidate without changing the visual, then adopts its exact native owner", async () => {
  const f = await fixture();
  const previous = f.mesh.material;
  await f.owner.prepare(f.request);
  expect(f.mesh.material).toBe(previous);
  expect(f.commit()).toEqual({ success: true });
  const applied = f.mesh.material as NodeMaterial;
  expect(applied).not.toBe(previous);
  expect(roughness(applied)).toBe(0.9);
  expect(f.sibling.material).toBe(previous);
  expect(roughness(f.sibling.material as NodeMaterial)).toBe(0.5);
  expect(f.library.materialFor(f.scene, "material", { instanceKey: "1|body" })).toBe(applied);
  f.owner.release(f.request.editToken);
  expect(f.scene.materials).toContain(applied);
  expect(f.scene.materials).toContain(previous);
});

it("rejects missing material and stale gameplay ownership without disturbing the last valid owner", async () => {
  const f = await fixture();
  const previous = f.mesh.material;
  await expect(f.owner.prepare({ ...f.request, materialGuid: "missing", parameterName: undefined, parameter: undefined })).rejects.toThrow("unavailable");
  expect(f.mesh.material).toBe(previous);
  await f.owner.prepare(f.request);
  applyAssignMaterial(f.scene, f.binding, { type: "assignMaterial", slotId: 1, componentId: "body", materialAssetGuid: "replacement" });
  const gameplay = f.mesh.material;
  expect(f.commit()).toMatchObject({ success: false, reason: expect.stringContaining("changed") });
  expect(f.mesh.material).toBe(gameplay);
  f.owner.release(f.request.editToken);
  expect(f.library.materialFor(f.scene, "material", { instanceKey: `runtime-edit:${f.request.editToken}` })).toBeNull();
});

it("rejects recycled slots and cancellation, releasing only the pending private instance", async () => {
  const f = await fixture();
  await f.owner.prepare(f.request);
  f.binding.meshSorting.set(1, { actorGuid: "another-actor", sortingLayer: "Default", orderInLayer: 0 });
  expect(f.commit().success).toBe(false);
  f.owner.cancelAll();
  expect(f.commit().success).toBe(false);
  expect(f.sibling.material).toBe(f.mesh.material);
  expect(f.library.materialFor(f.scene, "material", { instanceKey: `runtime-edit:${f.request.editToken}` })).toBeNull();
});
