import { MeshBuilder, TransformNode } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { createTestEngine } from "./create-null-engine";
import {
  adoptLoadedHierarchy,
  animationRetargetHasMatches,
  beginSlotModelAnimLoad,
  createModelActorRoot,
} from "./glb-anim";
import { encodeParentedAnimatedTriangleGlb, encodeTriangleGlb } from "./model-mesh";
import {
  applySnapshotToScene,
  createSnapshotSceneBinding,
} from "./snapshot-apply";
import { visualMeshes } from "./visual-meshes";

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

describe("animationRetargetHasMatches", () => {
  const handles: Array<{ engine: { dispose: () => void }; scene: { dispose: () => void } }> =
    [];

  afterEach(() => {
    while (handles.length > 0) {
      const handle = handles.pop();
      handle?.scene.dispose();
      handle?.engine.dispose();
    }
  });

  it("keeps channels when two hierarchy clips share node names", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const bytes = encodeParentedAnimatedTriangleGlb("Idle");
    expect(
      await animationRetargetHasMatches(handle.engine, bytes, bytes, "Idle"),
    ).toBe(true);
  });

  it("returns false when the clip name is missing", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const bytes = encodeParentedAnimatedTriangleGlb("Idle");
    expect(
      await animationRetargetHasMatches(handle.engine, bytes, bytes, "Walk"),
    ).toBe(false);
  });

  it("returns false when the target GLB has no matching nodes", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    expect(
      await animationRetargetHasMatches(
        handle.engine,
        encodeParentedAnimatedTriangleGlb("Idle"),
        encodeTriangleGlb(),
        "Idle",
      ),
    ).toBe(false);
  });
});

describe("beginSlotModelAnimLoad", () => {
  const handles: Array<{ engine: { dispose: () => void }; scene: { dispose: () => void } }> =
    [];

  afterEach(() => {
    while (handles.length > 0) {
      const handle = handles.pop();
      handle?.scene.dispose();
      handle?.engine.dispose();
    }
  });

  it("loads a static GLB nested in a larger ArrayBuffer", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    const glb = encodeTriangleGlb();
    const padded = new Uint8Array(glb.byteLength + 32);
    padded.fill(0xab);
    padded.set(glb, 16);
    const view = padded.subarray(16, 16 + glb.byteLength);
    expect(view.byteOffset).toBe(16);
    const binding = createSnapshotSceneBinding();
    const root = createModelActorRoot(scene, "actor-2");
    await beginSlotModelAnimLoad(scene, binding, 2, "model-1", view, root);
    expect(visualMeshes(root).length).toBeGreaterThan(0);
  });

  it("scales instantiated glTF under a child so actor scaling stays scene TRS", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    const binding = createSnapshotSceneBinding();
    binding.modelPayloads = new Map([
      [
        "model-1",
        {
          materialSlots: [],
          clipNames: [],
          skeletonGuid: null,
          importScale: 10,
          simpleColliders: [],
        },
      ],
    ]);
    const root = createModelActorRoot(scene, "actor-2");
    root.scaling.set(2, 2, 2);
    await beginSlotModelAnimLoad(scene, binding, 2, "model-1", encodeTriangleGlb(), root);
    expect(root.scaling.x).toBe(2);
    expect(root.scaling.y).toBe(2);
    expect(root.scaling.z).toBe(2);
    const wrapper = root.getChildTransformNodes(true).find(
      (node) => node.name === "__importScale",
    );
    expect(wrapper?.scaling.x).toBe(10);
    const visual = visualMeshes(root)[0];
    expect(visual).toBeDefined();
    visual!.computeWorldMatrix(true);
    const world = visual!.getWorldMatrix();
    const scale = world.getRow(0);
    expect(scale).toBeTruthy();
    expect(Math.hypot(scale!.x, scale!.y, scale!.z)).toBeCloseTo(20, 5);
  });
});
