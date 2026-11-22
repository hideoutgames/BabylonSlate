import { Constants } from "@babylonjs/core/Engines/constants";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultSpriteAnimationSheet, createDefaultTilemapPayload, normalizeTilesetPayload, setTile,
  type SpriteAnimationPayload, type SpritePayload,
} from "@haptic/assets";
import { SNAPSHOT_FLAG_VISIBLE } from "@haptic/bridge";
import { applyAnimStateToScene, ejectAllPlaySprites, sceneAnimHostFromBinding } from "./anim-apply";
import { AnimVisibilityGate } from "./anim-visibility";
import { createEditorCamera } from "./editor-camera";
import { setScene2DLighting } from "./lights-2d";
import { pickAtCanvas } from "./picking";
import { ResourceCache } from "./resource-cache";
import { authoredShadowParticipation } from "./shadow-mesh-policy";
import {
  applyAssignMaterial,
  applyAssignMesh,
  applySnapshotToScene,
  createSnapshotSceneBinding,
  disposeSnapshotBinding,
  retirePlaySlot,
  type SnapshotSceneBinding,
} from "./snapshot-apply";
import { compareAlphaTestDraws } from "./sorting";
import { applyPlayVisualSorting } from "./snapshot-visual-factory";
import { isSpriteQuad } from "./sprite-quad";
import {
  SPRITE_BATCH_FINISH_KIND,
  SPRITE_BATCH_SIZE_PIVOT_KIND,
  SPRITE_BATCH_TEXEL_KIND,
  SPRITE_BATCH_UV_RECT_KIND,
  isWorldSpriteBatchMesh,
} from "./sprite-batch-block";
import { createSpriteBounds } from "./sprite-batch-handle";
import { unlitBinding } from "./unlit-material-blocks";
import {
  REBASE_DISTANCE,
  batchedSpriteOf,
  ejectBatchedSprite,
  findWorldSpriteBatcher,
  isBatchedSpriteRoot,
  setSceneWorldSpriteBatching,
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

type Placement = { slotId: number; x?: number; y?: number; z?: number; sx?: number; sy?: number; sz?: number; visible?: boolean };

function makeSnapshot(frameId: number, actors: Placement[]) {
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

type AssignSprite = Omit<Extract<Parameters<typeof applyAssignMesh>[2], { type: "assignMesh" }>, "type" | "meshKind" | "slotId" | "meshAssetGuid">;

/** A Play world sprite as the runtime assigns it: its casting is always stated (false unless the test says). */
function assignSprite(scene: Scene, binding: SnapshotSceneBinding, slotId: number, guid: string, extra: AssignSprite = {}): void {
  applyAssignMesh(scene, binding, { type: "assignMesh", slotId, meshKind: "sprite", meshAssetGuid: guid, castShadows: false, ...extra });
}

/** Batch meshes drawing now. */
function drawingBatches(scene: Scene): Mesh[] {
  return scene.meshes.filter((mesh): mesh is Mesh => isWorldSpriteBatchMesh(mesh) && mesh.isEnabled() && (mesh as Mesh).thinInstanceCount > 0);
}

/** Every buffer upload of `mesh` from now on: its kind and the instances it carried. */
function recordUploads(mesh: Mesh): Array<{ kind: string; instances: number; at: number }> {
  const uploads: Array<{ kind: string; instances: number; at: number }> = [];
  const strides: Record<string, number> = { matrix: 16 };
  const setBuffer = mesh.thinInstanceSetBuffer.bind(mesh);
  vi.spyOn(mesh, "thinInstanceSetBuffer").mockImplementation((kind, buffer, stride, staticBuffer) => {
    strides[kind] = stride || 16;
    uploads.push({ kind, instances: (buffer?.length ?? 0) / (stride || 16), at: 0 });
    return setBuffer(kind, buffer, stride, staticBuffer);
  });
  const partial = mesh.thinInstancePartialBufferUpdate.bind(mesh);
  vi.spyOn(mesh, "thinInstancePartialBufferUpdate").mockImplementation((kind, dataOrLength, offset) => {
    const stride = strides[kind] ?? (kind === "matrix" ? 16 : 4);
    if (typeof dataOrLength === "number") uploads.push({ kind, instances: dataOrLength, at: offset });
    else uploads.push({ kind, instances: dataOrLength.length / stride, at: offset / stride });
    return partial(kind, dataOrLength, offset);
  });
  return uploads;
}

/** The x of each instance a batch draws, in its draw order. */
function instanceXs(mesh: Mesh): number[] {
  const data = mesh._thinInstanceDataStorage.matrixData!;
  return Array.from({ length: mesh.thinInstanceCount }, (_, index) => Math.round(data[index * 16 + 12]! * 100) / 100);
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
      assignSprite(scene, binding, i, "sprite-a", { sortingLayer: "Default", orderInLayer: 0 });
      actors.push({ slotId: i, x: i * 0.5, y: 0 });
    }
    applySnapshotToScene(scene, binding, makeSnapshot(1, actors));
    findWorldSpriteBatcher(scene)!.flush();

    const active = drawingBatches(scene);
    expect(active).toHaveLength(1);
    expect(active[0]!.thinInstanceCount).toBe(200);
    // Geometry-free roots stay in binding.meshes with 0 vertices and no eager actor-N-blend overlays.
    expect(binding.meshes.get(0)?.getTotalVertices()).toBe(0);
    expect(binding.meshes.get(0)?.isVisible).toBe(false);
    expect(binding.spriteOverlays?.size ?? 0).toBe(0);
    expect(worldSpriteBatchStats(scene)).toMatchObject({ sprites: 200, batches: 1 });
  });

  it("uploads nothing on unchanged frames, and one moving sprite uploads its own matrix row alone", () => {
    for (let i = 0; i < 26; i++) assignSprite(scene, binding, i, "sprite-a", { orderInLayer: 0, actorGuid: `actor-${String(i).padStart(2, "0")}` });
    const place = (frame: number, moved: number) => makeSnapshot(frame, Array.from({ length: 26 }, (_, i) => ({ slotId: i, x: i + (i === 13 ? moved : 0) })));
    applySnapshotToScene(scene, binding, place(1, 0));
    const batcher = findWorldSpriteBatcher(scene)!;
    batcher.flush();
    const batch = drawingBatches(scene)[0]!;
    expect(batch.thinInstanceCount).toBe(26);
    const uploads = recordUploads(batch);

    applySnapshotToScene(scene, binding, place(2, 0));
    batcher.flush();
    expect(uploads).toEqual([]);

    applySnapshotToScene(scene, binding, place(3, 0.5));
    batcher.flush();
    expect(uploads).toEqual([{ kind: "matrix", instances: 1, at: 13 }]);
    expect(instanceXs(batch)[13]).toBe(13.5);
    // Its bounds hold where it went, so neither the frustum nor occlusion can cull it by stale bounds.
    applySnapshotToScene(scene, binding, place(4, 40));
    batcher.flush();
    expect(batch.getBoundingInfo().boundingBox.maximumWorld.x).toBeCloseTo(53.5);
  });

  it("spawning into one batch uploads no other batch", () => {
    assignSprite(scene, binding, 0, "sprite-a", { orderInLayer: 0, actorGuid: "a" });
    assignSprite(scene, binding, 1, "sprite-b", { orderInLayer: 5, actorGuid: "b" });
    applySnapshotToScene(scene, binding, makeSnapshot(1, [{ slotId: 0, x: 0 }, { slotId: 1, x: 2 }]));
    const batcher = findWorldSpriteBatcher(scene)!;
    batcher.flush();
    const other = batchedSpriteOf(binding.meshes.get(1)!)!.primary.batch!.mesh;
    const uploads = recordUploads(other);

    assignSprite(scene, binding, 2, "sprite-a", { orderInLayer: 0, actorGuid: "c" });
    applySnapshotToScene(scene, binding, makeSnapshot(2, [{ slotId: 0, x: 0 }, { slotId: 1, x: 2 }, { slotId: 2, x: 4 }]));
    batcher.flush();
    expect(batchedSpriteOf(binding.meshes.get(2)!)!.primary.batch!.mesh.thinInstanceCount).toBe(2);
    expect(uploads).toEqual([]);
  });

  it("splits batches cleanly by sorting layer, orderInLayer, lighting mode, mirrored scale, and texture", () => {
    setScene2DLighting(scene, true);
    assignSprite(scene, binding, 0, "sprite-a", { sortingLayer: "Default", orderInLayer: 0, shadingMode: "2d" });
    assignSprite(scene, binding, 1, "sprite-a", { sortingLayer: "Default", orderInLayer: 1, shadingMode: "2d" });
    assignSprite(scene, binding, 2, "sprite-a", { sortingLayer: "Default", orderInLayer: 0, shadingMode: "unlit" });
    assignSprite(scene, binding, 3, "sprite-a", { sortingLayer: "Default", orderInLayer: 0, shadingMode: "3d" });
    assignSprite(scene, binding, 4, "sprite-b", { sortingLayer: "Default", orderInLayer: 0, shadingMode: "2d" });
    assignSprite(scene, binding, 5, "sprite-a", { sortingLayer: "Default", orderInLayer: 0, shadingMode: "2d" });

    applySnapshotToScene(scene, binding, makeSnapshot(1, [
      { slotId: 0, x: 0 },
      { slotId: 1, x: 1 },
      { slotId: 2, x: 2 },
      { slotId: 3, x: 3 },
      { slotId: 4, x: 4 },
      { slotId: 5, x: 5, sx: -1 }, // Mirrored!
    ]));
    findWorldSpriteBatcher(scene)!.flush();

    expect(drawingBatches(scene)).toHaveLength(6);
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

  it("draws overlapping sprites of one order as their quads would: by actor, around other meshes of that order", () => {
    // A tilemap of the same layer and order, whose actor sorts between the sprites'.
    const map = { ...setTile(createDefaultTilemapPayload(), "layer-1", 0, 0, 1), tilesets: [{ guid: "atlas", firstGid: 1, tileCount: 1 }] };
    binding.tilemaps = new Map([["map", map]]);
    binding.tilesets = new Map([["atlas", normalizeTilesetPayload({})]]);
    // Spawned out of order: the order is the actors', never the spawns'.
    assignSprite(scene, binding, 0, "sprite-a", { orderInLayer: 0, actorGuid: "e" });
    assignSprite(scene, binding, 1, "sprite-a", { orderInLayer: 0, actorGuid: "a" });
    assignSprite(scene, binding, 2, "sprite-a", { orderInLayer: 0, actorGuid: "c" });
    applyAssignMesh(scene, binding, { type: "assignMesh", slotId: 3, meshKind: "tilemap", meshAssetGuid: "map", orderInLayer: 0, actorGuid: "d" });
    const xs: Record<number, number> = { 0: 0.4, 1: 0.1, 2: 0.2, 3: 0.3 };
    applySnapshotToScene(scene, binding, makeSnapshot(1, [0, 1, 2, 3].map((slotId) => ({ slotId, x: xs[slotId] }))));
    findWorldSpriteBatcher(scene)!.flush();

    // The cutout queue's draws in its order, each batch expanded into its instances.
    const tiles = binding.meshes.get(3)!.getChildMeshes().filter((mesh) => mesh.getTotalVertices() > 0);
    expect(tiles.length).toBeGreaterThan(0);
    const draws: AbstractMesh[] = [...drawingBatches(scene), ...tiles];
    draws.sort((a, b) => compareAlphaTestDraws(a.subMeshes[0]!, b.subMeshes[0]!));
    const order = draws.flatMap((mesh) => isWorldSpriteBatchMesh(mesh) ? instanceXs(mesh as Mesh) : [0.3]);
    expect(order).toEqual([0.1, 0.2, ...tiles.map(() => 0.3), 0.4]);
  });

  it("never batches a sprite that casts shadows, and never casts from a batch", () => {
    assignSprite(scene, binding, 0, "sprite-b", { shadingMode: "3d", castShadows: true });
    assignSprite(scene, binding, 1, "sprite-b", { shadingMode: "3d" });
    applySnapshotToScene(scene, binding, makeSnapshot(1, [{ slotId: 0, x: 1 }, { slotId: 1, x: 3 }]));
    findWorldSpriteBatcher(scene)!.flush();

    // Its own quad, sized and pivoted, is what the shadow depth pass draws.
    const caster = binding.meshes.get(0)! as Mesh;
    expect(isBatchedSpriteRoot(caster)).toBe(false);
    expect(isSpriteQuad(caster)).toBe(true);
    caster.computeWorldMatrix(true);
    const box = caster.getBoundingInfo().boundingBox;
    expect([box.minimumWorld.x, box.maximumWorld.x, box.minimumWorld.y, box.maximumWorld.y].map((v) => Math.round(v * 100) / 100))
      .toEqual([0.68, 1.32, 0, 1.28]);
    expect(authoredShadowParticipation(caster).castShadows).toBe(true);
    const batch = batchedSpriteOf(binding.meshes.get(1)!)!.primary.batch!.mesh;
    expect(authoredShadowParticipation(batch).castShadows).toBe(false);

    // A visual whose sorting is replayed casting leaves its batch.
    binding.meshSorting.set(1, { ...binding.meshSorting.get(1), castShadows: true });
    applyPlayVisualSorting(binding.meshes.get(1)!, 1, binding);
    expect(isBatchedSpriteRoot(binding.meshes.get(1)!)).toBe(false);
    expect(isSpriteQuad(binding.meshes.get(1)!)).toBe(true);
  });

  it("updates sheet animation frames and Flip Frame in place, and draws each crossfading layer alone", () => {
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

    assignSprite(scene, binding, 0, "sprite-a");
    applySnapshotToScene(scene, binding, makeSnapshot(1, [{ slotId: 0, x: 0 }]));
    const batcher = findWorldSpriteBatcher(scene)!;
    batcher.flush();

    const batchMesh = drawingBatches(scene)[0]!;
    const uploads = recordUploads(batchMesh);

    // Step to frame 2 with Flip Frame X: its size, UV rect and texel rows, nothing reallocated.
    applyAnimStateToScene(animHost, {
      type: "animState",
      slotId: 0,
      stateId: "run",
      normalisedTime: 0.9,
      blendWeights: { run: 1 },
      layers: [{ stateId: "run", clipAssetGuid: "anim-run", clipName: "Run", clipKind: "sprite", normalisedTime: 0.9, weight: 1, flipX: true }],
    });
    batcher.flush();

    expect(uploads.map(({ kind }) => kind).sort()).toEqual([SPRITE_BATCH_SIZE_PIVOT_KIND, SPRITE_BATCH_TEXEL_KIND, SPRITE_BATCH_UV_RECT_KIND].sort());
    expect(uploads.every(({ instances }) => instances === 1)).toBe(true);
    const handle = batchedSpriteOf(binding.meshes.get(0)!)!;
    // Flipped frame 2: u0=1, u1=0.5 (du=-0.5), width=0.64, height=0.32, pivot=(0.5, 1)
    expect(handle.primary.u0).toBeCloseTo(1);
    expect(handle.primary.u1).toBeCloseTo(0.5);
    expect(handle.primary.width).toBeCloseTo(0.64);
    expect(handle.primary.height).toBeCloseTo(0.32);

    // Two-layer crossfade: each layer blends in a draw of its own, the primary's the older mesh.
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

    const fading = drawingBatches(scene);
    expect(fading).toHaveLength(2);
    const primary = handle.primary.batch!.mesh, overlay = handle.secondary.batch!.mesh;
    expect(primary.uniqueId).toBeLessThan(overlay.uniqueId);
    for (const [mesh, weight] of [[primary, 0.7], [overlay, 0.3]] as const) {
      expect(mesh.thinInstanceCount).toBe(1);
      expect(mesh.material!.needAlphaBlendingForMesh(mesh)).toBe(true);
      expect(mesh._userThinInstanceBuffersStorage?.data[SPRITE_BATCH_FINISH_KIND]?.[0]).toBeCloseTo(weight);
    }
    // Each draw's bounds are its own quad's, as the transparent queue sorts each layer by its own distance.
    expect(primary.getBoundingInfo().boundingBox.maximumWorld.y).toBeCloseTo(0.32);

    // End crossfade: the overlay goes and the primary returns to a cutout batch.
    applyAnimStateToScene(animHost, {
      type: "animState",
      slotId: 0,
      stateId: "run",
      normalisedTime: 0.1,
      blendWeights: { run: 1 },
      layers: [{ stateId: "run", clipAssetGuid: "anim-run", clipName: "Run", clipKind: "sprite", normalisedTime: 0.1, weight: 1 }],
    });
    batcher.flush();
    const ended = drawingBatches(scene);
    expect(ended).toHaveLength(1);
    expect(ended[0]!.thinInstanceCount).toBe(1);
    expect(ended[0]!.visibility).toBe(1);
    expect(ended[0]!.material!.needAlphaBlendingForMesh(ended[0]!)).toBe(false);
  });

  it("promotes a sprite to a pickable standalone quad with its crossfade overlay when a custom Material attaches", () => {
    const customMat = new StandardMaterial("custom-sprite-mat", scene);
    binding.resolveMaterial = (guid) => (guid === "mat-custom" ? customMat : null);

    assignSprite(scene, binding, 0, "sprite-a");
    assignSprite(scene, binding, 1, "sprite-a");
    applySnapshotToScene(scene, binding, makeSnapshot(1, [{ slotId: 0, x: 0 }, { slotId: 1, x: 2 }]));
    const batcher = findWorldSpriteBatcher(scene)!;
    batcher.flush();

    expect(drawingBatches(scene)[0]!.thinInstanceCount).toBe(2);
    const slot0Root = binding.meshes.get(0)!;
    expect(isBatchedSpriteRoot(slot0Root)).toBe(true);

    applyAssignMaterial(scene, binding, { type: "assignMaterial", slotId: 0, materialAssetGuid: "mat-custom" });
    batcher.flush();

    expect(binding.meshes.get(0)).toBe(slot0Root);
    expect(isBatchedSpriteRoot(slot0Root)).toBe(false);
    expect(isSpriteQuad(slot0Root)).toBe(true);
    expect(slot0Root.isVisible).toBe(true);
    expect(slot0Root.isPickable).toBe(true);
    expect(slot0Root.material).toBe(customMat);
    // As an unbatched sprite, it has its crossfade overlay from now on, drawing with the Material too.
    const overlay = binding.spriteOverlays?.get(0);
    expect(overlay?.parent).toBe(slot0Root);
    expect(overlay?.material).toBe(customMat);
    expect(drawingBatches(scene)).toHaveLength(1);
    expect(drawingBatches(scene)[0]!.thinInstanceCount).toBe(1);
    expect(isBatchedSpriteRoot(binding.meshes.get(1)!)).toBe(true);
  });

  it("gives a hidden actor's ejected sprite a hidden crossfade overlay", () => {
    const customMat = new StandardMaterial("custom-sprite-mat", scene);
    binding.resolveMaterial = () => customMat;
    assignSprite(scene, binding, 0, "sprite-a");
    applySnapshotToScene(scene, binding, makeSnapshot(1, [{ slotId: 0, visible: false }]));
    findWorldSpriteBatcher(scene)!.flush();

    applyAssignMaterial(scene, binding, { type: "assignMaterial", slotId: 0, materialAssetGuid: "mat-custom" });
    const animHost = sceneAnimHostFromBinding(binding, { spritePayloads: binding.spritePayloads });
    const overlay = animHost.getSpriteSlot!(0)!.ensureOverlayMesh!();
    expect(binding.meshes.get(0)!.isVisible).toBe(false);
    expect(overlay.isVisible).toBe(false);
  });

  it("ejects every sprite to a pickable quad when batching stops, and the pick finds its actor", () => {
    assignSprite(scene, binding, 0, "sprite-a");
    applySnapshotToScene(scene, binding, makeSnapshot(1, [{ slotId: 0, x: 0 }]));
    findWorldSpriteBatcher(scene)!.flush();
    const centre = () => {
      const width = engine.getRenderWidth(), height = engine.getRenderHeight();
      return pickAtCanvas(scene, width / 2, height / 2);
    };
    expect(centre()).toBeNull();

    ejectAllPlaySprites(binding);
    setSceneWorldSpriteBatching(scene, false);
    expect(isSpriteQuad(binding.meshes.get(0)!)).toBe(true);
    expect(binding.spriteOverlays?.get(0)?.parent).toBe(binding.meshes.get(0));
    expect(centre()?.slotId).toBe(0);
    expect(drawingBatches(scene)).toEqual([]);
    // Sprites built while it is off draw as quads of their own.
    assignSprite(scene, binding, 1, "sprite-a");
    expect(isBatchedSpriteRoot(binding.meshes.get(1)!)).toBe(false);
  });

  it("switches 2D-shaded batches between unlit and lit2D when scene2DLighting toggles", () => {
    assignSprite(scene, binding, 0, "sprite-a", { shadingMode: "2d" });
    applySnapshotToScene(scene, binding, makeSnapshot(1, [{ slotId: 0 }]));
    findWorldSpriteBatcher(scene)!.flush();
    expect(drawingBatches(scene)[0]!.material?.name).not.toContain("lit2D");

    setScene2DLighting(scene, true);
    expect(drawingBatches(scene)[0]!.material?.name).toContain("lit2D");

    setScene2DLighting(scene, false);
    expect(drawingBatches(scene)[0]!.material?.name).not.toContain("lit2D");
  });

  it("leaves Scene Layer overlay sprites unintercepted so OverlayDrawBatcher handles them", () => {
    binding.isOverlaySlot = (slotId) => slotId === 10;
    assignSprite(scene, binding, 10, "sprite-a");
    const mesh = binding.meshes.get(10)!;
    expect(isBatchedSpriteRoot(mesh)).toBe(false);
    expect(isSpriteQuad(mesh)).toBe(true);
  });

  it("computes exact world bounds for frustum culling and AnimVisibilityGate When Visible culling", () => {
    assignSprite(scene, binding, 0, "sprite-b");
    assignSprite(scene, binding, 1, "sprite-b");
    // sprite-b is 0.64 × 1.28 with pivot (0.5, 1) -> local X in [-0.32, 0.32], Y in [0, 1.28].
    applySnapshotToScene(scene, binding, makeSnapshot(1, [
      { slotId: 0, x: 1, y: 2 },
      { slotId: 1, x: 500, y: 0 }, // far outside camera frustum
    ]));
    findWorldSpriteBatcher(scene)!.flush();

    const bounds0 = createSpriteBounds();
    expect(worldSpriteBounds(binding.meshes.get(0)!, bounds0)).toBe(true);
    expect(Array.from(bounds0, (value) => Math.round(value * 100) / 100)).toEqual([0.68, 2, 0, 1.32, 3.28, 0]);

    const batchBounds = drawingBatches(scene)[0]!.getBoundingInfo().boundingBox;
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

  it("keeps Large World rows exact against an anchor that a camera moving less than the re-base distance leaves alone", () => {
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
      assignSprite(lwScene, lwBinding, 0, "sprite-a");
      applySnapshotToScene(lwScene, lwBinding, makeSnapshot(1, [{ slotId: 0, x: 1_000_002.25, y: 3 }]));
      const lwBatcher = findWorldSpriteBatcher(lwScene)!;
      lwBatcher.flush();

      const batchMesh = drawingBatches(lwScene)[0]!;
      expect(batchMesh.position.x).toBe(1_000_000);
      const matrixData = batchMesh._thinInstanceDataStorage.matrixData!;
      // Anchor-relative translation stored with full precision: 1_000_002.25 - 1_000_000 = 2.25
      expect(matrixData[12]).toBeCloseTo(2.25, 5);
      expect(matrixData[13]).toBeCloseTo(3, 5);
      // World bounding box stays at actual world coordinates!
      expect(batchMesh.getBoundingInfo().boundingBox.minimumWorld.x).toBeCloseTo(1_000_001.75);
      expect(batchMesh.getBoundingInfo().boundingBox.maximumWorld.x).toBeCloseTo(1_000_002.75);

      // The camera moves: within the re-base distance nothing uploads.
      const uploads = recordUploads(batchMesh);
      lwScene.floatingOriginOffset.set(1_000_000 + REBASE_DISTANCE / 2, 7, 0);
      lwBatcher.flush();
      expect(uploads).toEqual([]);
      // Past it, the batch re-bases once: its rows follow the new anchor.
      lwScene.floatingOriginOffset.set(1_000_000 + REBASE_DISTANCE * 2, 0, 0);
      lwBatcher.flush();
      expect(uploads).toEqual([{ kind: "matrix", instances: 1, at: 0 }]);
      expect(batchMesh.position.x).toBe(1_000_000 + REBASE_DISTANCE * 2);
      expect(matrixData[12]).toBeCloseTo(2.25 - REBASE_DISTANCE * 2, 5);
      expect(batchMesh.getBoundingInfo().boundingBox.minimumWorld.x).toBeCloseTo(1_000_001.75);
    } finally {
      disposeSnapshotBinding(lwBinding);
      lwScene.dispose();
      lwEngine.dispose();
    }
  });

  it("recycles batches when slots retire and preserves sprite batch defines isolation on UnlitMaterial", () => {
    assignSprite(scene, binding, 0, "sprite-a");
    applySnapshotToScene(scene, binding, makeSnapshot(1, [{ slotId: 0 }]));
    const batcher = findWorldSpriteBatcher(scene)!;
    batcher.flush();

    const batchMesh = drawingBatches(scene)[0]!;
    expect(batchMesh.thinInstanceCount).toBe(1);
    expect(batchMesh._userThinInstanceBuffersStorage?.data[SPRITE_BATCH_SIZE_PIVOT_KIND]).toBeDefined();
    expect(batchMesh._userThinInstanceBuffersStorage?.data[SPRITE_BATCH_UV_RECT_KIND]).toBeDefined();

    // Retire slot 0 -> batch disables and enters pool.
    retirePlaySlot(binding, 0);
    batcher.flush();
    expect(drawingBatches(scene)).toHaveLength(0);
    expect(batchMesh.isEnabled()).toBe(false);
    expect(batchMesh.thinInstanceCount).toBe(0);
    expect(worldSpriteBatchStats(scene)!.poolSize).toBe(1);

    // Spawning a new sprite reuses the pooled batch mesh (poolSize stays 1).
    assignSprite(scene, binding, 1, "sprite-a");
    applySnapshotToScene(scene, binding, makeSnapshot(2, [{ slotId: 1 }]));
    batcher.flush();
    expect(drawingBatches(scene)).toEqual([batchMesh]);
    expect(worldSpriteBatchStats(scene)!.poolSize).toBe(1);

    // Explicit eject preserves visibility=true and removes from batcher.
    const ejected = ejectBatchedSprite(binding.meshes.get(1)!);
    expect(ejected).toBe(binding.meshes.get(1));
    batcher.flush();
    expect(drawingBatches(scene)).toHaveLength(0);
  });

  it("coalesces small loose nearest textures onto LayerImageAtlas into a single batch with per-instance spriteTexel grids", () => {
    Object.defineProperty(engine, "webGLVersion", { get: () => 2, configurable: true });
    assignSprite(scene, binding, 0, "sprite-a", { orderInLayer: 0, actorGuid: "a" });
    assignSprite(scene, binding, 1, "sprite-b", { orderInLayer: 0, actorGuid: "b" });
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
    expect(drawingBatches(scene)).toHaveLength(2);
    expect(worldSpriteBatchStats(scene)).toMatchObject({ atlasImages: 2, atlasDrawn: 0 });

    // Next before-render runs LayerImageAtlas.flush() (insertFirst) then WorldSpriteBatcher.flush(), coalescing both into 1 batch!
    scene.onBeforeRenderObservable.notifyObservers(scene);
    const active = drawingBatches(scene);
    expect(active).toHaveLength(1);
    expect(active[0]!.thinInstanceCount).toBe(2);
    expect(unlitBinding(active[0]!).texture?.name).toBe("layer-image-atlas:alpha");
    expect(worldSpriteBatchStats(scene)!.atlasDrawn).toBe(2);

    // Verify per-instance spriteTexel carries distinct cell origins on the shared atlas page (0,0) and (16,0),
    // with negative size matching default WRAP_ADDRESSMODE on loaded textures.
    const texelBuf = active[0]!._userThinInstanceBuffersStorage!.data[SPRITE_BATCH_TEXEL_KIND] as Float32Array;
    expect([texelBuf[0], texelBuf[1], texelBuf[2], texelBuf[3]]).toEqual([-16, -16, 0, 0]);
    expect([texelBuf[4], texelBuf[5], texelBuf[6], texelBuf[7]]).toEqual([-32, -32, 16, 0]);
  });
});
