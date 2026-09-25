import { installAssetBytes } from "@babylonslate/assets";
import { FreeCamera, Vector3, MeshBuilder, TransformNode } from "@babylonjs/core";
import { encodeGlbJsonBin, splitGlbJsonBin } from "@babylonslate/assets";
import {
  applyAnimStateToScene,
  sceneAnimHostFromBinding,
  type NamedSeekableGroup,
} from "./anim-apply";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestEngine } from "./create-null-engine";
import {
  accountedGeometryBytesForScene,
  adoptLoadedHierarchy,
  animationRetargetHasMatches,
  beginSlotModelAnimLoad,
  createModelActorRoot,
  invalidateSlotAnimLoad,
  reportGlbLoadFailure,
} from "./glb-anim";
import {
  encodeParentedAnimatedTriangleGlb,
  encodeTranslatedTetrahedronGlb,
  encodeTriangleGlb,
} from "./model-mesh";
import { accountedGeometryBytes } from "./perf-ceilings";
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
  it("restores the authored values after lazily starting an overlapping clip", async () => {
    const handle = createTestEngine();
    new FreeCamera("camera", new Vector3(0, 0, -5), handle.scene);
    const binding = createSnapshotSceneBinding();
    const root = createModelActorRoot(handle.scene, "actor");
    const split = splitGlbJsonBin(encodeParentedAnimatedTriangleGlb("First"))!;
    const animations = split.json.animations as Record<string, unknown>[];
    animations.push({ ...animations[0], name: "Second" });
    try {
      await beginSlotModelAnimLoad(handle.scene, binding, 1, "model", installAssetBytes(encodeGlbJsonBin(split.json, split.bin)), root);
      const [first, second] = binding.slotAnimationGroups!.get(1)! as NamedSeekableGroup[];
      first!.goToFrame(30);
      first!.setWeightForAllAnimatables?.(1);
      handle.scene.render();
      const part = visualMeshes(root)[0]!;
      expect(part.position.y).toBeCloseTo(0.5);
      second!.goToFrame(45);
      second!.reset?.();
      expect(part.position.y).toBeCloseTo(0);
    } finally { handle.scene.dispose(); handle.engine.dispose(); }
  });

  it("coalesces concurrent actor loads and leaves static instances free of animation work", async () => {
    const handle = createTestEngine();
    const binding = createSnapshotSceneBinding();
    const root = createModelActorRoot(handle.scene, "actor");
    const bytes = encodeParentedAnimatedTriangleGlb("Idle");
    try {
      await Promise.all([
        beginSlotModelAnimLoad(handle.scene, binding, 1, "model", installAssetBytes(bytes), root),
        beginSlotModelAnimLoad(handle.scene, binding, 2, "model", installAssetBytes(bytes), root),
      ]);
      expect(visualMeshes(root)).toHaveLength(1);
      expect(handle.scene.animatables).toHaveLength(0);
      const clip = binding.slotAnimationGroups!.get(1)![0]!;
      clip.goToFrame((clip.from + clip.to) / 2);
      expect(handle.scene.animatables.length).toBeGreaterThan(0);
      root.dispose();
      expect(handle.scene.animatables).toHaveLength(0);
      expect(handle.scene.animationGroups).toHaveLength(0);
    } finally { handle.scene.dispose(); handle.engine.dispose(); }
  });

  const handles: Array<{ engine: { dispose: () => void }; scene: { dispose: () => void } }> =
    [];

  afterEach(() => {
    while (handles.length > 0) {
      const handle = handles.pop();
      handle?.scene.dispose();
      handle?.engine.dispose();
    }
  });

  type Layer = [clipName: string, normalisedTime: number, weight: number];
  // Both clips move part y from 0 to 1; only Second also moves root y.
  async function loadCrossfadeModel() {
    const handle = createTestEngine();
    handles.push(handle);
    new FreeCamera("camera", new Vector3(0, 0, -5), handle.scene);
    const binding = createSnapshotSceneBinding();
    const root = createModelActorRoot(handle.scene, "actor");
    const split = splitGlbJsonBin(encodeParentedAnimatedTriangleGlb("First"))!;
    const animations = split.json.animations as Array<{ name: string; channels: unknown[] }>;
    animations.push({
      ...animations[0]!,
      name: "Second",
      channels: [...animations[0]!.channels, { sampler: 0, target: { node: 0, path: "translation" } }],
    });
    await beginSlotModelAnimLoad(handle.scene, binding, 1, "model", installAssetBytes(encodeGlbJsonBin(split.json, split.bin)), root);
    const host = sceneAnimHostFromBinding(binding, { animationGroups: handle.scene.animationGroups });
    const part = visualMeshes(root)[0]!;
    return {
      scene: handle.scene,
      apply: (layers: Layer[]) => {
        const [clipName, normalisedTime] = layers[layers.length - 1]!;
        applyAnimStateToScene(host, {
          type: "animState",
          slotId: 1,
          stateId: `s${layers.length - 1}`,
          normalisedTime,
          blendWeights: Object.fromEntries(layers.map(([, , weight], index) => [`s${index}`, weight])),
          clipName,
          clipKind: "animation",
          clipAssetGuid: "model",
          layers: layers.map(([clipName, normalisedTime, weight], index) => ({
            stateId: `s${index}`, clipAssetGuid: "model", clipName, clipKind: "animation", normalisedTime, weight,
          })),
        });
      },
      pose: () => [part.position.y, (part.parent as TransformNode).position.y],
    };
  }

  it.each<[string, Layer[][], number, number]>([
    ["mixes crossfade layers by weight", [[["First", 1, 0.5], ["Second", 0.5, 0.5]]], 0.75, 0.25],
    ["keeps the outgoing pose when the incoming layer has no weight", [[["First", 1, 1], ["Second", 0.5, 0]]], 1, 0],
    ["seeks a clip shared by two layers once at the current state's time", [[["First", 0.25, 0.5], ["First", 0.75, 0.5]]], 0.75, 0],
    ["renders only the latest crossfade of a slot", [
      [["First", 1, 0.2], ["Second", 0.5, 0.8]],
      [["First", 1, 0.5], ["Second", 0.5, 0.5]],
    ], 0.75, 0.25],
    ["drops a crossfade replaced by a single clip before the render", [
      [["First", 1, 0.5], ["Second", 0.5, 0.5]],
      [["First", 1, 1]],
    ], 1, 0],
  ])("%s", async (_name, commands, partY, rootY) => {
    const model = await loadCrossfadeModel();
    for (const layers of commands) model.apply(layers);
    model.scene.render();
    const [part, root] = model.pose();
    expect(part).toBeCloseTo(partY);
    expect(root).toBeCloseTo(rootY);
  });

  it("drops a crossfade replaced after a render skipped its animation pass", async () => {
    const model = await loadCrossfadeModel();
    const loading = {};
    // Babylon skips a Scene's first animation pass while data is pending.
    model.scene.addPendingData(loading);
    model.apply([["First", 1, 0.5], ["Second", 0.5, 0.5]]);
    model.scene.render();
    model.scene.removePendingData(loading);
    model.apply([["First", 1, 1]]);
    model.scene.render();
    const [part, root] = model.pose();
    expect(part).toBeCloseTo(1);
    expect(root).toBeCloseTo(0);
  });

  it("accounts a mesh shared by two glTF nodes once", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const split = splitGlbJsonBin(encodeTranslatedTetrahedronGlb([0, 0, 0]))!;
    (split.json.nodes as unknown[]).push({ mesh: 0, translation: [1, 0, 0] });
    (split.json.scenes as Array<{ nodes: number[] }>)[0]!.nodes = [0, 1];
    const root = createModelActorRoot(handle.scene, "actor-2");
    await beginSlotModelAnimLoad(handle.scene, createSnapshotSceneBinding(), 2, "model-1",
      installAssetBytes(encodeGlbJsonBin(split.json, split.bin)), root);
    expect(visualMeshes(root)).toHaveLength(2);
    expect(accountedGeometryBytesForScene(handle.scene)).toBe(accountedGeometryBytes(4, 12));
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
    await beginSlotModelAnimLoad(scene, binding, 2, "model-1", installAssetBytes(view), root);
    expect(visualMeshes(root).length).toBeGreaterThan(0);
  });

  it.each(["superseded", "disposed"])("ignores a late loader failure for a %s actor", async (reason) => {
    const handle = createTestEngine();
    handles.push(handle);
    const binding = createSnapshotSceneBinding();
    const root = createModelActorRoot(handle.scene, "actor-2");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const load = beginSlotModelAnimLoad(handle.scene, binding, 2, "broken",
        installAssetBytes(encodeGlbJsonBin({ asset: { version: "99.0" } }, new Uint8Array())), root);
      if (reason === "superseded") invalidateSlotAnimLoad(binding, 2);
      else root.dispose();
      await expect(load).resolves.toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
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
    await beginSlotModelAnimLoad(scene, binding, 2, "model-1", installAssetBytes(encodeTriangleGlb()), root);
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

  it("logs a loader failure and leaves the empty named root", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const binding = createSnapshotSceneBinding();
    const root = createModelActorRoot(scene, "actor-2");
    reportGlbLoadFailure("model-bad", new Error("KHR_draco_mesh_compression"));
    await beginSlotModelAnimLoad(
      scene,
      binding,
      2,
      "model-missing-bytes",
      installAssetBytes(encodeTriangleGlb()),
      root,
    );
    expect(visualMeshes(root).length).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.join(" "))).toMatch(/model-bad/i);
    warn.mockRestore();
  });
});
