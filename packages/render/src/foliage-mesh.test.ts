import { afterEach, expect, it } from "vitest";
import { Mesh, StandardMaterial, Vector3 } from "@babylonjs/core";
import { createActor, createDefaultScene, identitySerializedTransform } from "@babylonslate/core";
import { installAssetBytes, normalizeModelPayload } from "@babylonslate/assets";
import { EditorSceneSync } from "./editor-scene-sync";
import { createTestEngine } from "./create-null-engine";
import { encodeTriangleGlb } from "./model-mesh";
import { createFoliageMesh, foliagePreparation } from "./foliage-mesh";
import { glbContainerLoadCount } from "./glb-anim";
const disposers: Array<() => void> = [];
afterEach(() => { while (disposers.length) disposers.pop()!(); });

it("shares model geometry across strokes and batches transforms with a Material override", async () => {
  const { engine, scene } = createTestEngine();
  disposers.push(() => { scene.dispose(); engine.dispose(); });
  const material = new StandardMaterial("leaves", scene);
  const assets = { modelSources: new Map([["tree", installAssetBytes(encodeTriangleGlb(), "model/gltf-binary")]]), resolveMaterial: () => material };
  const data = { groupId: "forest", batches: [{ modelGuid: "tree", materialGuid: "leaf-material", transforms: [identitySerializedTransform(), { ...identitySerializedTransform(), position: [4, 0, 0] }] }] };
  const a = createFoliageMesh(scene, "stroke-a", data, assets);
  const b = createFoliageMesh(scene, "stroke-b", data, assets);
  await Promise.all([foliagePreparation(a), foliagePreparation(b)]);
  const am = a.getChildMeshes().find((mesh): mesh is Mesh => mesh instanceof Mesh && mesh.hasThinInstances)!;
  const bm = b.getChildMeshes().find((mesh): mesh is Mesh => mesh instanceof Mesh && mesh.hasThinInstances)!;
  expect(am.thinInstanceCount).toBe(2);
  expect(am.material).toBe(material);
  expect(am.geometry).toBe(bm.geometry);
  expect(glbContainerLoadCount(scene)).toBe(1);
  expect(am.thinInstanceGetWorldMatrices()[1]!.getTranslation().x).toBe(4);
  a.dispose();
  expect(bm.isDisposed()).toBe(false);
  expect(scene.materials).toContain(material);
});

it("does not adopt a model after its foliage component is deleted", async () => {
  const { engine, scene } = createTestEngine();
  disposers.push(() => { scene.dispose(); engine.dispose(); });
  const root = createFoliageMesh(scene, "deleted", { batches: [{ modelGuid: "m", transforms: [identitySerializedTransform()] }] }, { modelBytes: new Map([["m", encodeTriangleGlb()]]) });
  root.dispose();
  await foliagePreparation(root);
  expect(scene.meshes.some((mesh) => mesh.name.startsWith("deleted:"))).toBe(false);
});

it("waits for initial foliage and refreshes late model sources and import scale with actor visibility", async () => {
  const { scene, engine } = createTestEngine();
  const sync = new EditorSceneSync(scene);
  disposers.push(() => { sync.dispose(); scene.dispose(); engine.dispose(); });
  const data = { ...createDefaultScene(), actors: [createActor("stroke", "Stroke", { visible: false, locked: true, components: [{ id: "foliage", classId: "FoliageComponent", properties: { batches: [{ modelGuid: "tree", transforms: [identitySerializedTransform()] }] } }] })] };
  sync.apply(data);
  await sync.whenEditorModelsReady();
  const empty = sync.meshForComponent("stroke", "foliage")!;
  expect(empty.getChildMeshes()).toHaveLength(0);
  const modelSources = new Map([["tree", installAssetBytes(encodeTriangleGlb(), "model/gltf-binary")]]);
  sync.setMeshAssets({ modelSources });
  await sync.whenEditorModelsReady();
  const root = sync.meshForComponent("stroke", "foliage")!;
  const instance = root.getChildMeshes().find((mesh): mesh is Mesh => mesh instanceof Mesh && mesh.hasThinInstances)!;
  expect(instance.thinInstanceCount).toBe(1);
  expect(instance.isVisible).toBe(false);
  expect(instance.isPickable).toBe(false);
  sync.setMeshAssets({ modelSources, modelPayloads: new Map([["tree", normalizeModelPayload({ importScale: 3 })]]) });
  await sync.whenEditorModelsReady();
  const resized = sync.meshForComponent("stroke", "foliage")!.getChildMeshes().find((mesh): mesh is Mesh => mesh instanceof Mesh && mesh.hasThinInstances)!;
  expect(root.isDisposed()).toBe(true);
  const scale = new Vector3(); resized.thinInstanceGetWorldMatrices()[0]!.decompose(scale);
  expect(scale.x).toBeCloseTo(3);
  sync.apply({ ...data, actors: [{ ...data.actors[0]!, visible: true, locked: false }] });
  await sync.whenEditorModelsReady();
  expect(resized.isVisible && resized.isPickable).toBe(true);
});
