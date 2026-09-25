import { expect, it } from "vitest";
import { Mesh, VertexBuffer } from "@babylonjs/core";
import { identitySerializedTransform, parseLandscapeProperties } from "@babylonslate/core";
import { createTestEngine } from "./create-null-engine";
import { createSnapshotSceneBinding, applyAssignMesh, retirePlaySlot } from "./snapshot-apply";
import { installModelSources } from "./mesh-assets";
import { encodeTriangleGlb } from "./model-mesh";

it("realizes terrain heights and instanced foliage from Play parts before publishing the actor", async () => {
  const { scene, engine } = createTestEngine();
  const binding = createSnapshotSceneBinding();
  binding.modelSources = installModelSources({ modelBytes: new Map([["tree", encodeTriangleGlb()]]) });
  binding.liveSlots.add(0);
  try {
    const transform = identitySerializedTransform();
    applyAssignMesh(scene, binding, { type: "assignMesh", slotId: 0, meshKind: "landscape", meshAssetGuid: null, parts: [
      { componentId: "ground", meshKind: "landscape", meshAssetGuid: null, ...transform, landscape: parseLandscapeProperties({ subdivisions: 4, heights: Array(25).fill(2) }) },
      { componentId: "plants", meshKind: "foliage", meshAssetGuid: null, ...transform, foliage: { groupId: "trees", batches: [{ modelGuid: "tree", materialGuid: null, transforms: [transform, { ...transform, position: [3, 0, 0] }] }] } },
    ] });
    await binding.slotAnimLoads?.get(0);
    const root = binding.meshes.get(0)!;
    const ground = root.getChildMeshes().find((mesh) => mesh.metadata?.landscapeRoot)!;
    expect(ground.getVerticesData(VertexBuffer.PositionKind)!.filter((_, index) => index % 3 === 1)).toEqual(Array(25).fill(2));
    const plants = root.getChildMeshes().find((mesh): mesh is Mesh => mesh instanceof Mesh && mesh.hasThinInstances)!;
    expect(plants.thinInstanceCount).toBe(2);
    expect(plants.isVisible).toBe(true);
    expect(plants.thinInstanceGetWorldMatrices()[1]!.getTranslation().x).toBe(3);
    retirePlaySlot(binding, 0);
    expect(root.isDisposed()).toBe(true);
  } finally { scene.dispose(); engine.dispose(); }
});
