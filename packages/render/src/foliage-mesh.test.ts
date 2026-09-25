import { afterEach, expect, it } from "vitest";
import { Mesh, StandardMaterial } from "@babylonjs/core";
import { identitySerializedTransform } from "@babylonslate/core";
import { installAssetBytes } from "@babylonslate/assets";
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
