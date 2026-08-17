import { MeshBuilder, TransformNode } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { createTestEngine } from "./create-null-engine";
import { adoptLoadedHierarchy } from "./glb-anim";
import {
  applySnapshotToScene,
  createSnapshotSceneBinding,
} from "./snapshot-apply";

describe("adoptLoadedHierarchy", () => {
  const handles: Array<{ engine: { dispose: () => void }; scene: { dispose: () => void } }> =
    [];

  afterEach(() => {
    while (handles.length > 0) {
      const handle = handles.pop();
      handle?.scene.dispose();
      handle?.engine.dispose();
    }
  });

  it("parents a parentless TransformNode so descendant meshes follow actor TRS", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    const slot = MeshBuilder.CreateBox("actor-2", { size: 1 }, scene);
    const gltfRoot = new TransformNode("__root__", scene);
    const skinned = MeshBuilder.CreateBox("skinned", { size: 1 }, scene);
    skinned.parent = gltfRoot;
    adoptLoadedHierarchy(slot, {
      rootNodes: [gltfRoot],
      transformNodes: [gltfRoot],
      meshes: [skinned],
    });
    expect(gltfRoot.parent).toBe(slot);
    expect(skinned.isDescendantOf(slot)).toBe(true);
    const binding = createSnapshotSceneBinding();
    binding.meshes.set(2, slot);
    applySnapshotToScene(scene, binding, {
      frameId: 1,
      tickIndex: 1,
      alpha: 1,
      actorCount: 1,
      actors: [
        {
          slotId: 2,
          position: { x: 10, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          scale: { x: 1, y: 1, z: 1 },
          flags: 1,
        },
      ],
    });
    skinned.computeWorldMatrix(true);
    expect(skinned.getAbsolutePosition().x).toBeCloseTo(10);
  });
});
