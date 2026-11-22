import { Constants } from "@babylonjs/core/Engines/constants";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultSpriteAnimationSheet, type SpriteAnimationPayload, type SpritePayload } from "@haptic/assets";
import { SNAPSHOT_FLAG_VISIBLE } from "@haptic/bridge";
import { applyAnimStateToScene, sceneAnimHostFromBinding } from "./anim-apply";
import { AnimVisibilityGate } from "./anim-visibility";
import { createEditorCamera } from "./editor-camera";
import { setScene2DLighting } from "./lights-2d";
import { ResourceCache } from "./resource-cache";
import {
  applyAssignMaterial,
  applyAssignMesh,
  applySnapshotToScene,
  createSnapshotSceneBinding,
  disposeSnapshotBinding,
  retirePlaySlot,
  type SnapshotSceneBinding,
} from "./snapshot-apply";
import { isSpriteQuad } from "./sprite-quad";
import {
  SPRITE_BATCH_FINISH_KIND,
  SPRITE_BATCH_SIZE_PIVOT_KIND,
  SPRITE_BATCH_TEXEL_KIND,
  SPRITE_BATCH_UV_RECT_KIND,
  isWorldSpriteBatchMesh,
} from "./sprite-batch-block";
import { unlitBinding } from "./unlit-material-blocks";
import {
  batchedSpriteOf,
  ejectBatchedSprite,
  findWorldSpriteBatcher,
  isBatchedSpriteRoot,
  setSceneWorldSpriteBatching,
  setSceneWorldSpriteImagePages,
  worldSpriteBatchStats,
  worldSpriteBounds,
} from "./world-sprite-batcher";
import { createHeadlessEngine, largeWorldEngineOptions } from "./large-world";

/** Minimal valid 1×1 RGBA PNG bytes for deterministic ResourceCache texture leases. */
const TINY_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54,
  0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0xf0, 0x1f, 0x00, 0x05, 0x00, 0x01, 0xff,
  0x89, 0x99, 0x3d, 0x1d,
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
  0xae, 0x42, 0x60, 0x82,
]);

const TINY_PNG_B = new Uint8Array([
  ...TINY_PNG.slice(0, TINY_PNG.length - 12),
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
  0xae, 0x42, 0x60, 0x82,
]);

function makeSpritePayload(textureGuid: string, width = 64, height = 64, pivot = { x: 0.5, y: 0.5 }): SpritePayload {
  return {
    textureGuid,
    pixelsPerUnit: 100,
    pivot,
    collision: { x: 0, y: 0, width: 1, height: 1 },
    width,
    height,
  };
}

function makeSnapshot(
  frameId: number,
  actors: Array<{ slotId: number; x?: number; y?: number; z?: number; sx?: number; sy?: number; sz?: number; visible?: boolean }>,
) {
  return {
    frameId,
    tickIndex: frameId,
    actorCount: actors.length,
    actors: actors.map((a) => ({
      slotId: a.slotId,
      flags: a.visible === false ? 0 : SNAPSHOT_FLAG_VISIBLE,
      position: new Vector3(a.x ?? 0, a.y ?? 0, a.z ?? 0),
      rotation: Quaternion.Identity(),
      scale: new Vector3(a.sx ?? 1, a.sy ?? 1, a.sz ?? 1),
    })),
  };
}

describe("WorldSpriteBatcher", () => {
  let engine: NullEngine;
  let scene: Scene;
  let binding: SnapshotSceneBinding;
  let resourceCache: ResourceCache;

  beforeEach(() => {
    engine = createHeadlessEngine();
    engine.getCaps().instancedArrays = true;
    scene = new Scene(engine);
    const camera = createEditorCamera(scene, { mode: "2d", orthoHalfHeight: 5 });
    camera.updateOrthoBounds(16 / 9);
    scene.updateTransformMatrix();
    setSceneWorldSpriteBatching(scene, true);
    resourceCache = new ResourceCache();
    binding = createSnapshotSceneBinding();
    binding.resourceCache = resourceCache;
    binding.textureBytes = new Map([
      ["tex-a", TINY_PNG],
      ["tex-b", TINY_PNG_B],
    ]);
    binding.spritePayloads = new Map([
      ["sprite-a", makeSpritePayload("tex-a", 100, 100)],
      ["sprite-b", makeSpritePayload("tex-b", 64, 128, { x: 0.5, y: 1 })],
    ]);
  });

  afterEach(() => {
    disposeSnapshotBinding(binding);
    resourceCache.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("collapses 200 Play world sprites sharing a texture and sorting layer into 1 thin-instanced batch mesh with no eager overlay meshes", () => {
    const actors = [];
    for (let i = 0; i < 200; i++) {
      applyAssignMesh(scene, binding, {
        type: "assignMesh",
        slotId: i,
        meshKind: "sprite",
        meshAssetGuid: "sprite-a",
        sortingLayer: "Default",
        orderInLayer: 0,
      });
      actors.push({ slotId: i, x: i * 0.5, y: 0 });
    }
    applySnapshotToScene(scene, binding, makeSnapshot(1, actors));
    const batcher = findWorldSpriteBatcher(scene)!;
    batcher.flush();

    const active = batcher.activeBatchMeshes();
    expect(active).toHaveLength(1);
    expect(active[0]!.thinInstanceCount).toBe(200);
    expect(isWorldSpriteBatchMesh(active[0])).toBe(true);
    // Geometry-free roots stay in binding.meshes with 0 vertices and no eager actor-N-blend overlays.
    expect(binding.meshes.get(0)?.getTotalVertices()).toBe(0);
    expect(binding.meshes.get(0)?.isVisible).toBe(false);
    expect(binding.spriteOverlays?.size ?? 0).toBe(0);
    expect(worldSpriteBatchStats(scene).sprites).toBe(200);
    expect(worldSpriteBatchStats(scene).batches).toBe(1);
  });

  it("uploads zero GPU buffers on unchanged frames and updates only dirty batches when a sprite moves", () => {
    applyAssignMesh(scene, binding, { type: "assignMesh", slotId: 0, meshKind: "sprite", meshAssetGuid: "sprite-a", orderInLayer: 0 });
    applyAssignMesh(scene, binding, { type: "assignMesh", slotId: 1, meshKind: "sprite", meshAssetGuid: "sprite-a", orderInLayer: 5 });
    applySnapshotToScene(scene, binding, makeSnapshot(1, [{ slotId: 0, x: 0 }, { slotId: 1, x: 2 }]));
    const batcher = findWorldSpriteBatcher(scene)!;
    batcher.flush();
    const afterFirst = worldSpriteBatchStats(scene).bufferUploads;
    expect(afterFirst).toBe(2);

    // Unchanged frame: 0 buffer uploads.
    applySnapshotToScene(scene, binding, makeSnapshot(2, [{ slotId: 0, x: 0 }, { slotId: 1, x: 2 }]));
    batcher.flush();
    expect(worldSpriteBatchStats(scene).bufferUploads).toBe(afterFirst);

    // Move only slot 0: only batch 0 uploads (+1, not +2).
    applySnapshotToScene(scene, binding, makeSnapshot(3, [{ slotId: 0, x: 1.5 }, { slotId: 1, x: 2 }]));
    batcher.flush();
    expect(worldSpriteBatchStats(scene).bufferUploads).toBe(afterFirst + 1);
  });

  it("splits batches cleanly by sorting layer, orderInLayer, lighting mode, mirrored scale, and texture", () => {
    setScene2DLighting(scene, true);
    // Different order, lighting, texture, and negative scaleX (mirrored).
    applyAssignMesh(scene, binding, { type: "assignMesh", slotId: 0, meshKind: "sprite", meshAssetGuid: "sprite-a", sortingLayer: "Default", orderInLayer: 0, shadingMode: "2d" });
    applyAssignMesh(scene, binding, { type: "assignMesh", slotId: 1, meshKind: "sprite", meshAssetGuid: "sprite-a", sortingLayer: "Default", orderInLayer: 1, shadingMode: "2d" });
    applyAssignMesh(scene, binding, { type: "assignMesh", slotId: 2, meshKind: "sprite", meshAssetGuid: "sprite-a", sortingLayer: "Default", orderInLayer: 0, shadingMode: "unlit" });
    applyAssignMesh(scene, binding, { type: "assignMesh", slotId: 3, meshKind: "sprite", meshAssetGuid: "sprite-a", sortingLayer: "Default", orderInLayer: 0, shadingMode: "3d" });
    applyAssignMesh(scene, binding, { type: "assignMesh", slotId: 4, meshKind: "sprite", meshAssetGuid: "sprite-b", sortingLayer: "Default", orderInLayer: 0, shadingMode: "2d" });
    applyAssignMesh(scene, binding, { type: "assignMesh", slotId: 5, meshKind: "sprite", meshAssetGuid: "sprite-a", sortingLayer: "Default", orderInLayer: 0, shadingMode: "2d" });

    applySnapshotToScene(scene, binding, makeSnapshot(1, [
      { slotId: 0, x: 0 },
      { slotId: 1, x: 1 },
      { slotId: 2, x: 2 },
      { slotId: 3, x: 3 },
      { slotId: 4, x: 4 },
      { slotId: 5, x: 5, sx: -1 }, // Mirrored!
    ]));
    const batcher = findWorldSpriteBatcher(scene)!;
    batcher.flush();

    expect(batcher.activeBatchMeshes()).toHaveLength(6);
    // Verify mirrored batch uses reversed indices so backFaceCulling: true doesn't cull negative-scale sprites.
    const mirroredHandle = batchedSpriteOf(binding.meshes.get(5)!)!;
    const normalHandle = batchedSpriteOf(binding.meshes.get(0)!)!;
    expect(mirroredHandle.mirrored).toBe(true);
    expect(Array.from(mirroredHandle.primary.batch!.mesh.getIndices() ?? [])).toEqual([0, 2, 1, 0, 3, 2]);
    expect(Array.from(normalHandle.primary.batch!.mesh.getIndices() ?? [])).toEqual([0, 1, 2, 0, 2, 3]);
    expect(mirroredHandle.primary.batch!.mesh.material?.name).toContain("lit2D");
    expect(batchedSpriteOf(binding.meshes.get(2)!)!.primary.batch!.mesh.material?.name).not.toContain(":lit");
    expect(batchedSpriteOf(binding.meshes.get(3)!)!.primary.batch!.mesh.material?.name).toContain("lit3D");
  });

  it("updates sheet animation frames, Flip Frame, and two-layer crossfades in place without buffer reallocation", () => {
    const sheetAnim: SpriteAnimationPayload = {
      frameDurationMs: 100,
      source: "sheet",
      sheet: { ...createDefaultSpriteAnimationSheet(), textureGuid: "tex-a", cellWidth: 32, cellHeight: 32 },
      frames: [
        { textureGuid: "tex-a", cell: 1, durationMs: 100, pivot: { x: 0.5, y: 1 }, collision: { x: 0, y: 0, width: 1, height: 1 }, width: 32, height: 32, uv: { u0: 0, v0: 0.5, u1: 0.5, v1: 1 } },
        { textureGuid: "tex-a", cell: 2, durationMs: 100, pivot: { x: 0.5, y: 1 }, collision: { x: 0, y: 0, width: 1, height: 1 }, width: 64, height: 32, uv: { u0: 0.5, v0: 0.5, u1: 1, v1: 1 } },
      ],
    };
    binding.spriteAnimations = new Map([["anim-run", sheetAnim]]);
    const animHost = sceneAnimHostFromBinding(binding, {
      spritePayloads: binding.spritePayloads,
      spriteAnimations: binding.spriteAnimations,
    });

    applyAssignMesh(scene, binding, { type: "assignMesh", slotId: 0, meshKind: "sprite", meshAssetGuid: "sprite-a" });
    applySnapshotToScene(scene, binding, makeSnapshot(1, [{ slotId: 0, x: 0 }]));
    const batcher = findWorldSpriteBatcher(scene)!;
    batcher.flush();

    const batchMesh = batcher.activeBatchMeshes()[0]!;
    const setBufferSpy = vi.spyOn(batchMesh, "thinInstanceSetBuffer");
    const partialSpy = vi.spyOn(batchMesh, "thinInstancePartialBufferUpdate");

    // Step to frame 2 with Flip Frame X: updates spriteUvRect and spriteSizePivot via partial update, zero reallocations.
    applyAnimStateToScene(animHost, {
      type: "animState",
      slotId: 0,
      stateId: "run",
      normalisedTime: 0.9,
      blendWeights: { run: 1 },
      layers: [{ stateId: "run", clipAssetGuid: "anim-run", clipName: "Run", clipKind: "sprite", normalisedTime: 0.9, weight: 1, flipX: true }],
    });
    batcher.flush();

    expect(setBufferSpy).not.toHaveBeenCalled();
    expect(partialSpy).toHaveBeenCalled();
    const handle = batchedSpriteOf(binding.meshes.get(0)!)!;
    // Flipped frame 2: u0=1, u1=0.5 (du=-0.5), width=0.64, height=0.32, pivot=(0.5, 1)
    expect(handle.primary.u0).toBeCloseTo(1);
    expect(handle.primary.u1).toBeCloseTo(0.5);
    expect(handle.primary.width).toBeCloseTo(0.64);
    expect(handle.primary.height).toBeCloseTo(0.32);

    // Two-layer crossfade: both primary (0.7) and secondary (0.3) move to a blended cutout batch (`visibility = 0.5`).
    applyAnimStateToScene(animHost, {
      type: "animState",
      slotId: 0,
      stateId: "run",
      normalisedTime: 0.1,
      blendWeights: { run: 0.7, idle: 0.3 },
      layers: [
        { stateId: "run", clipAssetGuid: "anim-run", clipName: "Run", clipKind: "sprite", normalisedTime: 0.1, weight: 0.7 },
        { stateId: "idle", clipAssetGuid: "anim-run", clipName: "Idle", clipKind: "sprite", normalisedTime: 0.9, weight: 0.3 },
      ],
    });
    batcher.flush();

    const crossfadeMeshes = batcher.activeBatchMeshes();
    expect(crossfadeMeshes).toHaveLength(1);
    const blendMesh = crossfadeMeshes[0]!;
    expect(blendMesh.thinInstanceCount).toBe(2);
    expect(blendMesh.visibility).toBe(0.5);
    expect(blendMesh.material!.needAlphaBlendingForMesh(blendMesh)).toBe(true);
    expect(blendMesh.material!.needAlphaTestingForMesh(blendMesh)).toBe(true);
    const finishData = blendMesh._userThinInstanceBuffersStorage?.data[SPRITE_BATCH_FINISH_KIND];
    expect(finishData?.[0]).toBeCloseTo(0.7);
    expect(finishData?.[4]).toBeCloseTo(0.3);

    // End crossfade: secondary disappears and primary returns to opaque alpha-test batch.
    applyAnimStateToScene(animHost, {
      type: "animState",
      slotId: 0,
      stateId: "run",
      normalisedTime: 0.1,
      blendWeights: { run: 1 },
      layers: [{ stateId: "run", clipAssetGuid: "anim-run", clipName: "Run", clipKind: "sprite", normalisedTime: 0.1, weight: 1 }],
    });
    batcher.flush();
    expect(batcher.activeBatchMeshes()).toHaveLength(1);
    expect(batcher.activeBatchMeshes()[0]!.thinInstanceCount).toBe(1);
    expect(batcher.activeBatchMeshes()[0]!.visibility).toBe(1);
    expect(batcher.activeBatchMeshes()[0]!.material!.needAlphaBlendingForMesh(batcher.activeBatchMeshes()[0]!)).toBe(false);
  });

  it("promotes a sprite cleanly to a standalone quad mesh when a custom Material attaches, without double-drawing", () => {
    const customMat = new StandardMaterial("custom-sprite-mat", scene);
    binding.resolveMaterial = (guid) => (guid === "mat-custom" ? customMat : null);

    applyAssignMesh(scene, binding, { type: "assignMesh", slotId: 0, meshKind: "sprite", meshAssetGuid: "sprite-a" });
    applyAssignMesh(scene, binding, { type: "assignMesh", slotId: 1, meshKind: "sprite", meshAssetGuid: "sprite-a" });
    applySnapshotToScene(scene, binding, makeSnapshot(1, [{ slotId: 0, x: 0 }, { slotId: 1, x: 2 }]));
    const batcher = findWorldSpriteBatcher(scene)!;
    batcher.flush();

    expect(batcher.activeBatchMeshes()[0]!.thinInstanceCount).toBe(2);
    const slot0Root = binding.meshes.get(0)!;
    expect(isBatchedSpriteRoot(slot0Root)).toBe(true);

    // Assign custom material to slot 0: slot 0 promotes in place to a standalone sprite quad; slot 1 stays batched.
    applyAssignMaterial(scene, binding, { type: "assignMaterial", slotId: 0, materialAssetGuid: "mat-custom" });
    batcher.flush();

    expect(binding.meshes.get(0)).toBe(slot0Root);
    expect(isBatchedSpriteRoot(slot0Root)).toBe(false);
    expect(isSpriteQuad(slot0Root)).toBe(true);
    expect(slot0Root.isVisible).toBe(true);
    expect(slot0Root.material).toBe(customMat);
    expect(batcher.activeBatchMeshes()).toHaveLength(1);
    expect(batcher.activeBatchMeshes()[0]!.thinInstanceCount).toBe(1);
    expect(isBatchedSpriteRoot(binding.meshes.get(1)!)).toBe(true);
  });

  it("switches 2D-shaded batches between unlit and lit2D when scene2DLighting toggles", () => {
    applyAssignMesh(scene, binding, { type: "assignMesh", slotId: 0, meshKind: "sprite", meshAssetGuid: "sprite-a", shadingMode: "2d" });
    applySnapshotToScene(scene, binding, makeSnapshot(1, [{ slotId: 0 }]));
    const batcher = findWorldSpriteBatcher(scene)!;
    batcher.flush();
    expect(batcher.activeBatchMeshes()[0]!.material?.name).not.toContain("lit2D");

    setScene2DLighting(scene, true);
    expect(batcher.activeBatchMeshes()[0]!.material?.name).toContain("lit2D");

    setScene2DLighting(scene, false);
    expect(batcher.activeBatchMeshes()[0]!.material?.name).not.toContain("lit2D");
  });

  it("leaves Scene Layer overlay sprites unintercepted so OverlayDrawBatcher handles them", () => {
    binding.isOverlaySlot = (slotId) => slotId === 10;
    applyAssignMesh(scene, binding, { type: "assignMesh", slotId: 10, meshKind: "sprite", meshAssetGuid: "sprite-a" });
    const mesh = binding.meshes.get(10)!;
    expect(isBatchedSpriteRoot(mesh)).toBe(false);
    expect(isSpriteQuad(mesh)).toBe(true);
  });

  it("computes exact world bounds for frustum culling and AnimVisibilityGate When Visible culling", () => {
    applyAssignMesh(scene, binding, { type: "assignMesh", slotId: 0, meshKind: "sprite", meshAssetGuid: "sprite-b" });
    applyAssignMesh(scene, binding, { type: "assignMesh", slotId: 1, meshKind: "sprite", meshAssetGuid: "sprite-b" });
    // sprite-b is 0.64 × 1.28 with pivot (0.5, 1) -> local X in [-0.32, 0.32], Y in [0, 1.28].
    applySnapshotToScene(scene, binding, makeSnapshot(1, [
      { slotId: 0, x: 1, y: 2 },
      { slotId: 1, x: 500, y: 0 }, // far outside camera frustum
    ]));
    const batcher = findWorldSpriteBatcher(scene)!;
    batcher.flush();

    const bounds0 = worldSpriteBounds(binding.meshes.get(0)!)!;
    expect(bounds0.minX).toBeCloseTo(0.68);
    expect(bounds0.maxX).toBeCloseTo(1.32);
    expect(bounds0.minY).toBeCloseTo(2.0);
    expect(bounds0.maxY).toBeCloseTo(3.28);

    const batchBounds = batcher.activeBatchMeshes()[0]!.getBoundingInfo().boundingBox;
    expect(batchBounds.minimumWorld.x).toBeCloseTo(0.68);
    expect(batchBounds.maximumWorld.x).toBeCloseTo(500.32);

    const applied: number[] = [];
    const gate = new AnimVisibilityGate(scene, binding, (cmd) => applied.push(cmd.slotId));
    const cmd0 = { type: "animState" as const, slotId: 0, stateId: "a", normalisedTime: 0, blendWeights: { a: 1 }, whenVisible: true };
    const cmd1 = { type: "animState" as const, slotId: 1, stateId: "a", normalisedTime: 0, blendWeights: { a: 1 }, whenVisible: true };
    binding.pendingAnimState = new Map([[0, cmd0], [1, cmd1]]);
    gate.offer(cmd0);
    gate.offer(cmd1);
    gate.flush();
    expect(applied).toEqual([0]);
    expect(gate.isHeld(1)).toBe(true);
  });

  it("subtracts floatingOriginOffset in 64-bit precision under Large World Rendering", () => {
    const lwEngine = new NullEngine({
      renderWidth: 64,
      renderHeight: 64,
      textureSize: 4,
      deterministicLockstep: false,
      lockstepMaxSteps: 1,
      ...largeWorldEngineOptions(true),
    });
    lwEngine.getCaps().instancedArrays = true;
    const lwScene = new Scene(lwEngine, { useFloatingOrigin: true });
    lwScene.floatingOriginOffset.set(1_000_000, 0, 0);
    setSceneWorldSpriteBatching(lwScene, true);
    const lwBinding = createSnapshotSceneBinding();
    lwBinding.resourceCache = resourceCache;
    lwBinding.textureBytes = binding.textureBytes;
    lwBinding.spritePayloads = binding.spritePayloads;

    try {
      applyAssignMesh(lwScene, lwBinding, { type: "assignMesh", slotId: 0, meshKind: "sprite", meshAssetGuid: "sprite-a" });
      applySnapshotToScene(lwScene, lwBinding, makeSnapshot(1, [{ slotId: 0, x: 1_000_002.25, y: 3 }]));
      const lwBatcher = findWorldSpriteBatcher(lwScene)!;
      lwBatcher.flush();

      const batchMesh = lwBatcher.activeBatchMeshes()[0]!;
      expect(batchMesh.position.x).toBe(1_000_000);
      const matrixData = batchMesh._thinInstanceDataStorage.matrixData!;
      // Eye-relative translation stored with full precision: 1_000_002.25 - 1_000_000 = 2.25
      expect(matrixData[12]).toBeCloseTo(2.25, 5);
      expect(matrixData[13]).toBeCloseTo(3, 5);
      // World bounding box stays at actual world coordinates!
      expect(batchMesh.getBoundingInfo().boundingBox.minimumWorld.x).toBeCloseTo(1_000_001.75);
      expect(batchMesh.getBoundingInfo().boundingBox.maximumWorld.x).toBeCloseTo(1_000_002.75);
    } finally {
      disposeSnapshotBinding(lwBinding);
      lwScene.dispose();
      lwEngine.dispose();
    }
  });

  it("recycles batches when slots retire and preserves sprite batch defines isolation on UnlitMaterial", () => {
    applyAssignMesh(scene, binding, { type: "assignMesh", slotId: 0, meshKind: "sprite", meshAssetGuid: "sprite-a" });
    applySnapshotToScene(scene, binding, makeSnapshot(1, [{ slotId: 0 }]));
    const batcher = findWorldSpriteBatcher(scene)!;
    batcher.flush();

    const batchMesh = batcher.activeBatchMeshes()[0]!;
    expect(batchMesh.thinInstanceCount).toBe(1);
    expect(batchMesh._userThinInstanceBuffersStorage?.data[SPRITE_BATCH_SIZE_PIVOT_KIND]).toBeDefined();
    expect(batchMesh._userThinInstanceBuffersStorage?.data[SPRITE_BATCH_UV_RECT_KIND]).toBeDefined();

    // Retire slot 0 -> batch disables and enters pool.
    retirePlaySlot(binding, 0);
    batcher.flush();
    expect(batcher.activeBatchMeshes()).toHaveLength(0);
    expect(batchMesh.isEnabled()).toBe(false);
    expect(batchMesh.thinInstanceCount).toBe(0);
    expect(worldSpriteBatchStats(scene).poolSize).toBe(1);

    // Spawning a new sprite reuses the pooled batch mesh (poolSize stays 1).
    applyAssignMesh(scene, binding, { type: "assignMesh", slotId: 1, meshKind: "sprite", meshAssetGuid: "sprite-a" });
    applySnapshotToScene(scene, binding, makeSnapshot(2, [{ slotId: 1 }]));
    batcher.flush();
    expect(batcher.activeBatchMeshes()).toEqual([batchMesh]);
    expect(worldSpriteBatchStats(scene).poolSize).toBe(1);

    // Explicit eject preserves visibility=true and removes from batcher.
    const ejected = ejectBatchedSprite(binding.meshes.get(1)!);
    expect(ejected).toBe(binding.meshes.get(1));
    batcher.flush();
    expect(batcher.activeBatchMeshes()).toHaveLength(0);

    // Toggling image pages off/on works cleanly without errors.
    setSceneWorldSpriteImagePages(scene, false);
    setSceneWorldSpriteImagePages(scene, true);
  });

  it("coalesces small loose nearest textures onto LayerImageAtlas into a single batch with per-instance spriteTexel grids", () => {
    Object.defineProperty(engine, "webGLVersion", { get: () => 2, configurable: true });
    applyAssignMesh(scene, binding, { type: "assignMesh", slotId: 0, meshKind: "sprite", meshAssetGuid: "sprite-a", orderInLayer: 0 });
    applyAssignMesh(scene, binding, { type: "assignMesh", slotId: 1, meshKind: "sprite", meshAssetGuid: "sprite-b", orderInLayer: 0 });
    applySnapshotToScene(scene, binding, makeSnapshot(1, [
      { slotId: 0, x: 0 },
      { slotId: 1, x: 2 },
    ]));

    // Mark both leased textures ready with distinct small sizes (16×16 and 32×32) eligible for LayerImageAtlas.
    const texA = batchedSpriteOf(binding.meshes.get(0)!)!.primary.texture!;
    const texB = batchedSpriteOf(binding.meshes.get(1)!)!.primary.texture!;
    const intA = texA.getInternalTexture()!;
    const intB = texB.getInternalTexture()!;
    for (const [internal, edge] of [[intA, 16], [intB, 32]] as const) {
      internal.width = internal.baseWidth = edge;
      internal.height = internal.baseHeight = edge;
      internal.type = Constants.TEXTURETYPE_UNSIGNED_BYTE;
      internal.format = Constants.TEXTUREFORMAT_RGBA;
      internal.useMipMaps = false;
      internal.generateMipMaps = false;
      internal._useSRGBBuffer = false;
      internal.isReady = true;
    }

    const batcher = findWorldSpriteBatcher(scene)!;
    // First flush registers both textures with LayerImageAtlas while keeping their own textures until copied.
    batcher.flush();
    expect(batcher.activeBatchMeshes()).toHaveLength(2);
    expect(worldSpriteBatchStats(scene).atlasImages).toBe(2);
    expect(worldSpriteBatchStats(scene).atlasDrawn).toBe(0);

    // Next before-render runs LayerImageAtlas.flush() (insertFirst) then WorldSpriteBatcher.flush(), coalescing both into 1 batch!
    scene.onBeforeRenderObservable.notifyObservers(scene);
    const active = batcher.activeBatchMeshes();
    expect(active).toHaveLength(1);
    expect(active[0]!.thinInstanceCount).toBe(2);
    expect(unlitBinding(active[0]!).texture?.name).toBe("layer-image-atlas:alpha");
    expect(worldSpriteBatchStats(scene).atlasDrawn).toBe(2);

    // Verify per-instance spriteTexel carries distinct cell origins on the shared atlas page (0,0) and (16,0),
    // with negative size matching default WRAP_ADDRESSMODE on loaded textures.
    const texelBuf = active[0]!._userThinInstanceBuffersStorage!.data[SPRITE_BATCH_TEXEL_KIND] as Float32Array;
    expect([texelBuf[0], texelBuf[1], texelBuf[2], texelBuf[3]]).toEqual([-16, -16, 0, 0]);
    expect([texelBuf[4], texelBuf[5], texelBuf[6], texelBuf[7]]).toEqual([-32, -32, 16, 0]);

    // Disabling image pages splits them cleanly back into 2 batches sampling their own textures.
    setSceneWorldSpriteImagePages(scene, false);
    batcher.flush();
    expect(batcher.activeBatchMeshes()).toHaveLength(2);
  });
});
