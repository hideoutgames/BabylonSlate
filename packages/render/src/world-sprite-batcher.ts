import "@babylonjs/core/Meshes/thinInstanceMesh";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import type { CubeTexture } from "@babylonjs/core/Materials/Textures/cubeTexture";
import type { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { Observer } from "@babylonjs/core/Misc/observable";
import type { Scene } from "@babylonjs/core/scene";
import type { TileUv } from "@haptic/assets";
import type { SurfaceShadingMode } from "@haptic/core";
import { assetByteFingerprint } from "./asset-byte-fingerprint";
import { isDisposedGpuTexture } from "./gpu-resource-live";
import { LayerImageAtlas, type LayerImageCell } from "./layer-image-atlas";
import { onScene2DLightingChanged, scene2DLighting } from "./lights-2d";
import { applyAlbedoTexture, applySpriteVisibility, registerBatchedSpriteTextureHooks, type MeshAssetContext } from "./mesh-assets";
import { markBoundsHoldInstances } from "./play-view-culling";
import { PIXEL_ART_TEXTURE_SAMPLING, type ResourceLease } from "./resource-cache";
import { markSceneReadinessDirty } from "./scene-readiness-signal";
import { sceneShadowController } from "./shadow-controller";
import {
  SPRITE_BATCH_FINISH_KIND,
  SPRITE_BATCH_SIZE_PIVOT_KIND,
  SPRITE_BATCH_TEXEL_KIND,
  SPRITE_BATCH_UV_RECT_KIND,
  isWorldSpriteBatchMesh,
  markWorldSpriteBatchMesh,
} from "./sprite-batch-block";
import {
  accumulateSpriteQuad,
  batchedSpriteOf,
  compareDrawIdentity,
  compareMeshDrawIdentity,
  createSpriteBounds,
  isBatchedSpriteRoot,
  registerBatchedSpriteHandle,
  resetSpriteBounds,
  sceneSortingRevision,
  unregisterBatchedSpriteHandle,
  worldSpriteBounds,
  type BatchedSpriteHandle as BaseBatchedSpriteHandle,
  type SpriteLayerState as BaseSpriteLayerState,
} from "./sprite-batch-handle";
import { populateSpriteQuadGeometry } from "./sprite-quad";
import { setUnlitMaterial, type UnlitBinding, type UnlitMaterialKey } from "./unlit-material";
import { UNLIT_TEXEL_WHOLE, unlitTexelGrid } from "./unlit-material-blocks";

export { batchedSpriteOf, isBatchedSpriteRoot, worldSpriteBounds };
export type { BaseBatchedSpriteHandle as BatchedSpriteHandle };

/**
 * Persistent thin-instanced 2D world sprite batcher (`WorldSpriteBatcher`).
 *
 * Play world `SpriteComponent` visuals keep a lightweight geometry-free root `Mesh` in `binding.meshes` (zero VBOs,
 * `isVisible = false`), so every actor/component transform, parent, light/occluder/particle attachment and command
 * consumer works unchanged while the sprites draw as thin instances of unit quads. The picture is the one the same
 * sprites drawn one by one (`createSpriteQuad`) give:
 *
 * - **Order:** a cutout sprite draws in the alpha-test queue, ordered by `compareAlphaTestDraws`. Sprites of one
 *   rendering group and `alphaIndex` (a bucket) sort by that comparator's identity; a batch holds a run of consecutive
 *   sprites that draw alike (lighting, winding, shadow reception, sampled texture) with no other mesh of the bucket
 *   between them (a tilemap, text, an ejected sprite), in order, and sorts as its first sprite
 *   (`metadata.sortingName`). With the default `LEQUAL` depth test a later draw wins at equal depth, so the order is
 *   the picture.
 * - **Crossfades:** a layer whose weight is between 0 and 1 blends in the transparent queue, which sorts by distance:
 *   each such layer draws alone, with the bounds its quad would have, the primary before the overlay.
 * - **Shadows, picking, outlines:** a sprite that casts shadows never batches (the shadow depth pass draws a batch's
 *   raw unit quad); Simulation Edit and `worlddebug spritebatching off` eject every sprite (`setSceneWorldSpriteBatching`);
 *   Material overrides, Deformers and Outlines eject theirs (`ejectBatchedSprite`).
 * - **Updates:** each sprite layer owns a slot in its batch; a transform, frame or weight change writes that slot and
 *   uploads only the dirty range of the buffers it changed. A spawn, despawn, hide or crossfade start re-partitions its
 *   bucket alone, writing only slots whose sprite changed. Large World anchors each batch near the eye and re-bases it
 *   only once the eye has moved `REBASE_DISTANCE` away.
 * - **Auto-Atlasing:** small nearest-sampled sprite textures coalesce onto the Scene's `LayerImageAtlas` page through
 *   per-instance `spriteTexel` grids.
 */

const UNIT_QUAD_POSITIONS = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0];
const UNIT_QUAD_NORMALS = [0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1];
const UNIT_QUAD_UVS = [0, 0, 1, 0, 1, 1, 0, 1];
const UNIT_QUAD_INDICES = [0, 1, 2, 0, 2, 3];
const UNIT_QUAD_MIRRORED_INDICES = [0, 2, 1, 0, 3, 2];

const INITIAL_CAPACITY = 16;

/**
 * How far (world units, on any axis) the eye may move from a Large World batch's anchor before the batch re-bases:
 * instance rows hold placements relative to the anchor, so a camera moving less re-uploads nothing.
 */
export const REBASE_DISTANCE = 256;

/** World sprite UnlitMaterial keys matching `mesh-assets.ts` (`SPRITE_MATERIAL`). */
const WORLD_SPRITE_BASE_KEY: UnlitMaterialKey = { textured: true, backFaceCulling: true, fog: true, role: "world" };
const WORLD_SPRITE_LIT_2D_KEY: UnlitMaterialKey = { ...WORLD_SPRITE_BASE_KEY, lighting: "2d" };
const WORLD_SPRITE_LIT_3D_KEY: UnlitMaterialKey = { ...WORLD_SPRITE_BASE_KEY, lighting: "3d" };

const LIGHTING_NONE = 0;
const LIGHTING_2D = 1;
const LIGHTING_3D = 2;
type Lighting = typeof LIGHTING_NONE | typeof LIGHTING_2D | typeof LIGHTING_3D;

/** Instance buffers, in upload order: kind and floats per instance. */
const KIND_MATRIX = 0;
const KIND_SIZE_PIVOT = 1;
const KIND_UV_RECT = 2;
const KIND_FINISH = 3;
const KIND_TEXEL = 4;
const KIND_COUNT = 5;
const KIND_NAMES = ["matrix", SPRITE_BATCH_SIZE_PIVOT_KIND, SPRITE_BATCH_UV_RECT_KIND, SPRITE_BATCH_FINISH_KIND, SPRITE_BATCH_TEXEL_KIND] as const;
const KIND_STRIDES = [16, 4, 4, 4, 4] as const;
const MASK_MATRIX = 1 << KIND_MATRIX;
/** A frame change: size and pivot, UV rect and texel grid. */
const MASK_FRAME = (1 << KIND_SIZE_PIVOT) | (1 << KIND_UV_RECT) | (1 << KIND_TEXEL);
const MASK_FINISH = 1 << KIND_FINISH;
const MASK_ALL = (1 << KIND_COUNT) - 1;

export interface WorldSpriteBatchStats {
  /** Sprite layers drawn through batches (primary layers and active crossfade overlays). */
  sprites: number;
  /** Batch meshes drawing. */
  batches: number;
  /** Batch meshes allocated, drawing or pooled. */
  poolSize: number;
  /** Images registered on the Scene's `LayerImageAtlas` page and those drawn there. */
  atlasImages: number;
  atlasDrawn: number;
  /** Buffer uploads since the batcher was made: one per instance buffer per contiguous range (or whole buffer). */
  bufferUploads: number;
  /** Instances those uploads carried, summed over buffers. */
  uploadedInstances: number;
}

export interface BatchedSpriteInit {
  width: number;
  height: number;
  pivotX: number;
  pivotY: number;
  textureGuid?: string | null;
  assets?: MeshAssetContext;
  shadingMode?: SurfaceShadingMode;
}

interface SpriteBatch {
  readonly mesh: Mesh;
  readonly mirrored: boolean;
  /** The bucket whose run it draws; null for a crossfading layer's own draw. */
  bucket: CutoutBucket | null;
  blend: boolean;
  lighting: Lighting;
  receiveShadows: boolean;
  texture: BaseTexture | null;
  capacity: number;
  count: number;
  readonly data: Float32Array[];
  readonly members: Layer[];
  /** Dirty instance range per buffer, `[lo, hi]` inclusive; `lo > hi` when clean. */
  readonly dirtyLo: Int32Array;
  readonly dirtyHi: Int32Array;
  queued: boolean;
  buffersBound: boolean;
  /** World bounds of every instance; recomputed when `boundsStale`, else grown by each written instance. */
  readonly bounds: Float64Array;
  boundsStale: boolean;
  boundsChanged: boolean;
  /** Where the batch mesh stands (Large World anchor); instance rows are relative to it. */
  anchorX: number;
  anchorY: number;
  anchorZ: number;
  boundTexture: BaseTexture | null;
  boundLighting: Lighting | -1;
  boundBlend: boolean | null;
  /** Re-partition pass that last claimed it. */
  claim: number;
}

/** Cutout sprite layers of one rendering group and `alphaIndex`, and the other meshes drawing among them. */
interface CutoutBucket {
  readonly renderingGroupId: number;
  readonly alphaIndex: number;
  readonly members: Layer[];
  /** Other meshes of the bucket, which batches must not straddle. */
  readonly splitters: AbstractMesh[];
  batches: SpriteBatch[];
  dirty: boolean;
}

type Handle = BaseBatchedSpriteHandle<SpriteBatch> & {
  index: number;
  queued: boolean;
  placementDirty: boolean;
  /** The crossfade overlay's stand-in name in the cutout order (`actor-N-blend`, as the unbatched overlay). */
  readonly overlayName: string;
};

interface Layer extends BaseSpriteLayerState<SpriteBatch> {
  owner: Handle;
  bucket: CutoutBucket | null;
  bucketIndex: number;
  /** Placement: how it draws (cutout runs compare these). */
  lighting: Lighting;
  mirrored: boolean;
  receiveShadows: boolean;
  /** Buffers to write at its slot at the next flush. */
  pendingMask: number;
  /** Its texture was not loaded when placed: placed again once it is (texel grid, atlas cell). */
  awaitingTexture: boolean;
}

const batchingEnabledScenes = new WeakSet<Scene>();
const batchers = new WeakMap<Scene, WorldSpriteBatcher>();

const scratchGrid = [0, 0];
const scratchLocalMin = new Vector3();
const scratchLocalMax = new Vector3();
const scratchMatrix = new Matrix();
/** One instance's row per stride, for single-instance uploads that allocate nothing. */
const scratchRows: Record<number, Float32Array> = { 16: new Float32Array(16), 4: new Float32Array(4) };
const NO_SPLITTERS: AbstractMesh[] = [];

function keepsUvs(texture: BaseTexture): boolean {
  const matrix = texture.getTextureMatrix();
  return matrix.isIdentityAs3x2() || matrix.isIdentity();
}

function materialKeyFor(lighting: Lighting): UnlitMaterialKey {
  if (lighting === LIGHTING_2D) return WORLD_SPRITE_LIT_2D_KEY;
  if (lighting === LIGHTING_3D) return WORLD_SPRITE_LIT_3D_KEY;
  return WORLD_SPRITE_BASE_KEY;
}

function createUnitQuadMesh(scene: Scene, name: string, mirrored: boolean): Mesh {
  const mesh = new Mesh(name, scene);
  const data = new VertexData();
  data.positions = UNIT_QUAD_POSITIONS;
  data.normals = UNIT_QUAD_NORMALS;
  data.uvs = UNIT_QUAD_UVS;
  data.indices = mirrored ? UNIT_QUAD_MIRRORED_INDICES : UNIT_QUAD_INDICES;
  data.applyToMesh(mesh, false);
  mesh.isPickable = false;
  mesh.setEnabled(false);
  mesh.isVisible = false;
  mesh.alwaysSelectAsActiveMesh = false;
  mesh.freezeWorldMatrix();
  mesh.metadata = { sortingGroupId: "", sortingLayerKey: 0, sortingName: "", sortingUniqueId: 0 };
  markWorldSpriteBatchMesh(mesh);
  markBoundsHoldInstances(mesh);
  return mesh;
}

function releaseLayerLeases(layer: Layer): void {
  layer.pending?.release();
  layer.pending = undefined;
  layer.lease?.release();
  layer.lease = undefined;
  layer.preparation = undefined;
  layer.texture = null;
  layer.textureGuid = null;
  layer.source = undefined;
  layer.identity = undefined;
  layer.failed = undefined;
}

function layerName(layer: Layer): string {
  return layer.isOverlay ? layer.owner.overlayName : layer.owner.root.name;
}

/** The cutout order of two sprite layers of one bucket (`compareAlphaTestDraws` past `alphaIndex`). */
function compareLayers(a: Layer, b: Layer): number {
  return compareDrawIdentity(
    a.owner.sortingGroupId, 0, 0, layerName(a), a.owner.root.uniqueId,
    b.owner.sortingGroupId, 0, 0, layerName(b), b.owner.root.uniqueId,
  );
}

/** A layer against another mesh of its bucket, as `compareAlphaTestDraws` would order their meshes. */
function compareLayerToMesh(layer: Layer, mesh: AbstractMesh): number {
  const m = mesh.metadata as { sortingGroupId?: string; sortingLayerKey?: number; tilemapLayer?: { ordinal?: number } } | null;
  return compareDrawIdentity(
    layer.owner.sortingGroupId, 0, 0, layerName(layer), layer.owner.root.uniqueId,
    m?.sortingGroupId ?? mesh.name, m?.sortingLayerKey ?? 0, m?.tilemapLayer?.ordinal ?? 0, mesh.name, mesh.uniqueId,
  );
}

function sameDraw(a: Layer, b: Layer): boolean {
  return a.lighting === b.lighting && a.mirrored === b.mirrored && a.receiveShadows === b.receiveShadows &&
    a.sampledTexture === b.sampledTexture;
}

/**
 * Per-scene persistent thin-instanced sprite batcher.
 */
export class WorldSpriteBatcher {
  readonly scene: Scene;
  private readonly handles: Handle[] = [];
  private readonly queuedHandles: Handle[] = [];
  private readonly buckets = new Map<number, Map<number, CutoutBucket>>();
  private readonly dirtyBuckets: CutoutBucket[] = [];
  private readonly queuedBatches: SpriteBatch[] = [];
  private readonly freeNormal: SpriteBatch[] = [];
  private readonly freeMirrored: SpriteBatch[] = [];
  /** Scratch for a bucket's new batch list. */
  private nextBatches: SpriteBatch[] = [];
  private claimPass = 0;
  private atlas: LayerImageAtlas | null = null;
  private lastAtlasRevision = -1;
  private last2DLighting: boolean;
  private anchorX = 0;
  private anchorY = 0;
  private anchorZ = 0;
  private placeAll = false;
  /** What the last scan for other meshes among the buckets saw. */
  private scannedMeshCount = -1;
  private scannedSortingRevision = -1;
  private meshRemoved = false;
  private nextMeshId = 0;
  private activeBatchCount = 0;
  private spriteCount = 0;
  private bufferUploads = 0;
  private uploadedInstances = 0;
  private disposed = false;
  private readonly beforeRenderObserver: Observer<Scene> | null;
  private readonly removedObserver: Observer<AbstractMesh> | null;
  private readonly unsub2DLighting: () => void;
  private readonly disposeObserver: Observer<Scene> | null;

  constructor(scene: Scene) {
    ensureBatchedSpriteTextureHooks();
    this.scene = scene;
    this.last2DLighting = scene2DLighting(scene);
    // Registered normally (after `insertFirst` observers like `LayerImageAtlas.flush()`, and after `animVisibility.flush()`).
    this.beforeRenderObserver = scene.onBeforeRenderObservable.add(() => this.flush());
    this.removedObserver = scene.onMeshRemovedObservable.add(() => { this.meshRemoved = true; });
    this.unsub2DLighting = onScene2DLightingChanged(scene, () => {
      if (this.disposed) return;
      this.placeAll = true;
      this.flush();
      markSceneReadinessDirty(scene, "meshAssets");
    });
    this.disposeObserver = scene.onDisposeObservable.addOnce(() => this.dispose());
  }

  get stats(): WorldSpriteBatchStats {
    const atlasCounts = this.atlas?.counts ?? { images: 0, drawn: 0 };
    return {
      sprites: this.spriteCount,
      batches: this.activeBatchCount,
      poolSize: this.activeBatchCount + this.freeNormal.length + this.freeMirrored.length,
      atlasImages: atlasCounts.images,
      atlasDrawn: atlasCounts.drawn,
      bufferUploads: this.bufferUploads,
      uploadedInstances: this.uploadedInstances,
    };
  }

  /** Attach a batched sprite entry to a geometry-free root `Mesh`. */
  attach(root: Mesh, init: BatchedSpriteInit): BaseBatchedSpriteHandle {
    batchedSpriteOf(root)?.dispose();

    const handle = {
      root,
      scene: this.scene,
      shadingMode: init.shadingMode ?? "2d",
      renderingGroupId: root.renderingGroupId,
      alphaIndex: root.alphaIndex,
      sortingGroupId: root.name,
      receiveShadows: true,
      visible: true,
      assets: init.assets,
      lastWorldUpdateFlag: -1,
      lastEnabled: root.isEnabled(),
      mirrored: false,
      worldMatrix: Matrix.Identity(),
      dirty: true,
      disposed: false,
      index: this.handles.length,
      queued: false,
      placementDirty: true,
      overlayName: `${root.name}-blend`,
    } as Handle;
    const layer = (isOverlay: boolean): Layer => ({
      isOverlay,
      active: !isOverlay,
      width: Math.max(0, init.width),
      height: Math.max(0, init.height),
      pivotX: init.pivotX,
      pivotY: init.pivotY,
      u0: 0,
      v0: 0,
      u1: 1,
      v1: 1,
      visibility: isOverlay ? 0 : 1,
      textureGuid: null,
      texture: null,
      batch: null,
      slot: -1,
      texelX: 0,
      texelY: 0,
      sampledTexture: null,
      cell: null,
      owner: handle,
      bucket: null,
      bucketIndex: -1,
      lighting: LIGHTING_NONE,
      mirrored: false,
      receiveShadows: false,
      pendingMask: 0,
      awaitingTexture: false,
    });
    const primary = layer(false);
    const secondary = layer(true);
    Object.assign(handle, {
      primary,
      secondary,
      updateFrame: (layerName: "primary" | "secondary", frame: Parameters<BaseBatchedSpriteHandle["updateFrame"]>[1]) => {
        if (handle.disposed) return;
        const target = layerName === "primary" ? primary : secondary;
        if (frame.assets) handle.assets = frame.assets;
        const nextW = Math.max(0, frame.width);
        const nextH = Math.max(0, frame.height);
        const u0 = frame.uv ? frame.uv.u0 : 0;
        const v0 = frame.uv ? frame.uv.v0 : 0;
        const u1 = frame.uv ? frame.uv.u1 : 1;
        const v1 = frame.uv ? frame.uv.v1 : 1;
        if (target.isOverlay && !target.active) {
          target.active = true;
          this.queuePlacement(handle);
        }
        if (
          target.width !== nextW || target.height !== nextH ||
          target.pivotX !== frame.pivotX || target.pivotY !== frame.pivotY ||
          target.u0 !== u0 || target.v0 !== v0 || target.u1 !== u1 || target.v1 !== v1
        ) {
          // An empty frame draws nowhere: the layer leaves or joins its batch.
          if ((target.width > 0 && target.height > 0) !== (nextW > 0 && nextH > 0)) this.queuePlacement(handle);
          target.width = nextW;
          target.height = nextH;
          target.pivotX = frame.pivotX;
          target.pivotY = frame.pivotY;
          target.u0 = u0;
          target.v0 = v0;
          target.u1 = u1;
          target.v1 = v1;
          this.queueWrite(target, MASK_FRAME);
        }
        if (frame.textureGuid !== undefined) {
          this.bindLayerTexture(handle, target, frame.textureGuid, frame.assets ?? handle.assets);
        }
      },
      setLayerVisibility: (layerName: "primary" | "secondary", visibility: number) => {
        if (handle.disposed) return;
        const target = layerName === "primary" ? primary : secondary;
        const active = target.isOverlay ? visibility > 0 : true;
        if (target.visibility === visibility && target.active === active) return;
        const wasBlended = target.visibility > 0 && target.visibility < 1;
        const wasDrawn = target.active && target.visibility > 0;
        target.visibility = visibility;
        target.active = active;
        const nowBlended = visibility > 0 && visibility < 1;
        const nowDrawn = active && visibility > 0;
        if (wasBlended !== nowBlended || wasDrawn !== nowDrawn) this.queuePlacement(handle);
        else this.queueWrite(target, MASK_FINISH);
      },
      setSorting: (options: Parameters<BaseBatchedSpriteHandle["setSorting"]>[0]) => {
        if (handle.disposed) return;
        let changed = false;
        if (options.renderingGroupId !== undefined && handle.renderingGroupId !== options.renderingGroupId) {
          handle.renderingGroupId = options.renderingGroupId;
          changed = true;
        }
        if (options.alphaIndex !== undefined && handle.alphaIndex !== options.alphaIndex) {
          handle.alphaIndex = options.alphaIndex;
          changed = true;
        }
        if (options.sortingGroupId !== undefined && handle.sortingGroupId !== options.sortingGroupId) {
          handle.sortingGroupId = options.sortingGroupId;
          changed = true;
        }
        if (options.receiveShadows !== undefined && handle.receiveShadows !== options.receiveShadows) {
          handle.receiveShadows = options.receiveShadows;
          changed = true;
        }
        if (options.shadingMode !== undefined && handle.shadingMode !== options.shadingMode) {
          handle.shadingMode = options.shadingMode;
          changed = true;
        }
        if (changed) this.queuePlacement(handle);
      },
      setVisible: (visible: boolean) => {
        if (handle.disposed || handle.visible === visible) return;
        handle.visible = visible;
        this.queuePlacement(handle);
      },
      markTransformDirty: () => {
        if (handle.disposed) return;
        handle.dirty = true;
      },
      dispose: () => {
        if (handle.disposed) return;
        handle.disposed = true;
        this.unplace(primary);
        this.unplace(secondary);
        releaseLayerLeases(primary);
        releaseLayerLeases(secondary);
        unregisterBatchedSpriteHandle(root, handle);
        const last = this.handles.pop()!;
        if (last !== handle) {
          this.handles[handle.index] = last;
          last.index = handle.index;
        }
        handle.index = -1;
      },
    });

    // The empty root Mesh carries transforms/children/attachments but never draws directly while batched.
    root.isVisible = false;
    root.isPickable = false;
    registerBatchedSpriteHandle(root, handle);
    this.handles.push(handle);
    this.queuePlacement(handle);

    if (init.textureGuid) this.bindLayerTexture(handle, primary, init.textureGuid, init.assets);
    root.onDisposeObservable.addOnce(() => handle.dispose());
    return handle;
  }

  /**
   * Promote a batched sprite root back to a standalone `createSpriteQuad` mesh in place (for custom Materials,
   * Deformers, Outlines, shadow casting or picking), preserving its current primary frame, texture, visibility and
   * sorting. Its shadow participation stays what the root was given.
   */
  eject(root: Mesh): Mesh | undefined {
    const handle = batchedSpriteOf(root) as Handle | undefined;
    if (!handle || handle.disposed) return undefined;
    const { primary, shadingMode, visible, assets, renderingGroupId, alphaIndex, sortingGroupId } = handle;
    const uv: TileUv | null = (primary.u0 === 0 && primary.v0 === 0 && primary.u1 === 1 && primary.v1 === 1)
      ? null
      : { u0: primary.u0, v0: primary.v0, u1: primary.u1, v1: primary.v1 };
    const textureGuid = primary.textureGuid;
    const visibility = primary.visibility;
    const width = primary.width;
    const height = primary.height;
    const pivot = { x: primary.pivotX, y: primary.pivotY };

    // Detach from the batcher before populating standalone quad geometry so no double-draw can occur.
    handle.dispose();

    populateSpriteQuadGeometry(root, width, height, pivot, uv);
    applyAlbedoTexture(root, this.scene, textureGuid, assets, { shadingMode });
    applySpriteVisibility(root, visibility);
    root.renderingGroupId = renderingGroupId;
    root.alphaIndex = alphaIndex;
    const metadata = typeof root.metadata === "object" && root.metadata ? root.metadata : {};
    root.metadata = { ...metadata, sortingGroupId, sortingLayerKey: 0 };
    root.isVisible = visible;
    root.isPickable = true;
    // The root now draws among the buckets' sprites.
    this.scannedMeshCount = -1;
    return root;
  }

  /** Eject every batched sprite (`eject`). */
  ejectAll(): void {
    for (let index = this.handles.length - 1; index >= 0; index -= 1) {
      const handle = this.handles[index];
      if (handle) this.eject(handle.root);
    }
  }

  /** Refresh leased textures whose encoded bytes changed (`refreshAlbedoTextures`). */
  refreshTextures(root: AbstractMesh, assets: MeshAssetContext, changed: ReadonlySet<string>): Promise<void>[] {
    const handle = batchedSpriteOf(root) as Handle | undefined;
    if (!handle || handle.disposed) return [];
    handle.assets = assets;
    const pending: Promise<void>[] = [];
    for (const layer of [handle.primary as Layer, handle.secondary as Layer]) {
      if (!layer.textureGuid || !changed.has(layer.textureGuid)) continue;
      const before = layer.preparation;
      this.bindLayerTexture(handle, layer, layer.textureGuid, assets);
      if (layer.preparation && layer.preparation !== before) pending.push(layer.preparation);
    }
    return pending;
  }

  /**
   * Synchronize sprite transforms, animation frames, atlas cells and the Large World anchor into the persistent
   * thin-instance buffers. An unchanged frame uploads nothing and allocates nothing.
   */
  flush(): void {
    if (this.disposed || this.scene.isDisposed) return;
    const scene = this.scene;

    if (scene.floatingOriginMode) {
      const eye = scene.floatingOriginOffset;
      if (Math.abs(eye.x - this.anchorX) > REBASE_DISTANCE || Math.abs(eye.y - this.anchorY) > REBASE_DISTANCE ||
        Math.abs(eye.z - this.anchorZ) > REBASE_DISTANCE) {
        this.anchorX = eye.x;
        this.anchorY = eye.y;
        this.anchorZ = eye.z;
        // Every drawing batch re-bases at its upload.
        for (const handle of this.handles) {
          if (handle.primary.batch) this.queueBatch(handle.primary.batch);
          if (handle.secondary.batch) this.queueBatch(handle.secondary.batch);
        }
      }
    }

    const lit2D = scene2DLighting(scene);
    if (lit2D !== this.last2DLighting) {
      this.last2DLighting = lit2D;
      this.placeAll = true;
    }
    // An image drawn onto the page, taken off or laid out again since the last flush moves the cells layers sample.
    if ((this.atlas?.revision ?? -1) !== this.lastAtlasRevision) this.placeAll = true;

    const handles = this.handles;
    // Backwards: a disposal moves the last handle into the visited slot.
    for (let index = handles.length - 1; index >= 0; index -= 1) {
      const handle = handles[index]!;
      const root = handle.root;
      if (root.isDisposed()) {
        handle.dispose();
        continue;
      }
      const enabled = root.isEnabled();
      if (enabled !== handle.lastEnabled) {
        handle.lastEnabled = enabled;
        this.queuePlacement(handle);
      }
      if (this.placeAll) this.queuePlacement(handle);
      if (!enabled || !handle.visible) continue;
      if (!root.isWorldMatrixFrozen && !root.isSynchronized()) root.computeWorldMatrix();
      const world = root.getWorldMatrix();
      if (handle.dirty || world.updateFlag !== handle.lastWorldUpdateFlag) {
        handle.lastWorldUpdateFlag = world.updateFlag;
        handle.dirty = false;
        handle.worldMatrix.copyFrom(world);
        const mirrored = world.determinant() < 0;
        if (mirrored !== handle.mirrored) {
          handle.mirrored = mirrored;
          this.queuePlacement(handle);
        }
        this.queueWrite(handle.primary as Layer, MASK_MATRIX);
        this.queueWrite(handle.secondary as Layer, MASK_MATRIX);
      }
      const primary = handle.primary as Layer, secondary = handle.secondary as Layer;
      if ((primary.awaitingTexture && primary.texture?.getInternalTexture()?.isReady) ||
        (secondary.awaitingTexture && secondary.texture?.getInternalTexture()?.isReady)) {
        this.queuePlacement(handle);
      }
    }
    this.placeAll = false;

    const queued = this.queuedHandles;
    for (let index = 0; index < queued.length; index += 1) {
      const handle = queued[index]!;
      if (handle.disposed || !handle.placementDirty) continue;
      handle.placementDirty = false;
      this.place(handle, handle.primary as Layer, lit2D);
      this.place(handle, handle.secondary as Layer, lit2D);
      this.orderAlone(handle);
    }
    // Placement asks the page for cells, which may make it: what it gives out is current as of now.
    this.lastAtlasRevision = this.atlas?.revision ?? -1;

    // Other meshes among the buckets (a new bucket's included): a mesh added or removed, or sorting applied anywhere,
    // may have moved them.
    if (scene.meshes.length !== this.scannedMeshCount || this.meshRemoved || sceneSortingRevision(scene) !== this.scannedSortingRevision) {
      this.scanSplitters();
    }

    const dirtyBuckets = this.dirtyBuckets;
    for (let index = 0; index < dirtyBuckets.length; index += 1) this.partition(dirtyBuckets[index]!);
    dirtyBuckets.length = 0;

    for (let index = 0; index < queued.length; index += 1) {
      const handle = queued[index]!;
      handle.queued = false;
      if (handle.disposed) continue;
      this.writePending(handle.primary as Layer);
      this.writePending(handle.secondary as Layer);
    }
    queued.length = 0;

    const batches = this.queuedBatches;
    for (let index = 0; index < batches.length; index += 1) this.upload(batches[index]!);
    batches.length = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.beforeRenderObserver) this.scene.onBeforeRenderObservable.remove(this.beforeRenderObserver);
    if (this.removedObserver) this.scene.onMeshRemovedObservable.remove(this.removedObserver);
    if (this.disposeObserver) this.scene.onDisposeObservable.remove(this.disposeObserver);
    this.unsub2DLighting();
    for (let index = this.handles.length - 1; index >= 0; index -= 1) this.handles[index]?.dispose();
    for (const byAlpha of this.buckets.values()) {
      for (const bucket of byAlpha.values()) for (const batch of bucket.batches) batch.mesh.dispose(false, false);
    }
    for (const batch of this.freeNormal) batch.mesh.dispose(false, false);
    for (const batch of this.freeMirrored) batch.mesh.dispose(false, false);
    this.buckets.clear();
    this.freeNormal.length = 0;
    this.freeMirrored.length = 0;
    this.atlas?.dispose();
    this.atlas = null;
    if (batchers.get(this.scene) === this) batchers.delete(this.scene);
  }

  private queuePlacement(handle: Handle): void {
    handle.placementDirty = true;
    if (!handle.queued) {
      handle.queued = true;
      this.queuedHandles.push(handle);
    }
  }

  /** Writes `mask`'s buffers of `layer`'s slot at the next flush. */
  private queueWrite(layer: Layer, mask: number): void {
    if (!layer.batch) return;
    layer.pendingMask |= mask;
    const handle = layer.owner;
    if (!handle.queued) {
      handle.queued = true;
      this.queuedHandles.push(handle);
    }
  }

  private isLayerDrawable(handle: Handle, layer: Layer): boolean {
    if (handle.disposed || !handle.visible || !handle.lastEnabled) return false;
    if (!layer.active || layer.visibility <= 0) return false;
    return layer.width > 0 && layer.height > 0;
  }

  private resolveLighting(shadingMode: SurfaceShadingMode, lit2D: boolean): Lighting {
    if (shadingMode === "3d") return LIGHTING_3D;
    if (shadingMode === "2d" && lit2D) return LIGHTING_2D;
    return LIGHTING_NONE;
  }

  private resolveTexture(layer: Layer): void {
    const texture = layer.texture;
    unlitTexelGrid(texture, scratchGrid);
    layer.texelX = scratchGrid[0]!;
    layer.texelY = scratchGrid[1]!;
    layer.awaitingTexture = !!texture && !texture.getInternalTexture()?.isReady;
    let cell: LayerImageCell | null = null;
    if (texture && layer.texelX !== 0 && keepsUvs(texture) && !this.disposed) {
      this.atlas ??= new LayerImageAtlas(this.scene);
      cell = this.atlas.cell(texture);
    }
    layer.cell = cell;
    layer.sampledTexture = cell?.page ?? texture;
  }

  /** Places a layer where it draws now: its bucket, its own crossfade draw, or nowhere. */
  private place(handle: Handle, layer: Layer, lit2D: boolean): void {
    if (!this.isLayerDrawable(handle, layer)) {
      this.unplace(layer);
      return;
    }
    const { cell, texelX, texelY } = layer;
    this.resolveTexture(layer);
    // A layer that keeps its slot writes its texel row again when its grid or cell changed.
    if (layer.cell !== cell || layer.texelX !== texelX || layer.texelY !== texelY) this.queueWrite(layer, 1 << KIND_TEXEL);
    layer.lighting = this.resolveLighting(handle.shadingMode, lit2D);
    layer.mirrored = handle.mirrored;
    layer.receiveShadows = layer.lighting === LIGHTING_3D && handle.receiveShadows;
    if (layer.visibility < 1) {
      this.placeAlone(layer);
      return;
    }
    if (layer.batch && !layer.bucket) this.releaseAlone(layer);
    const bucket = this.bucketOf(handle.renderingGroupId, handle.alphaIndex);
    if (layer.bucket !== bucket) {
      this.leaveBucket(layer);
      layer.bucket = bucket;
      layer.bucketIndex = bucket.members.length;
      bucket.members.push(layer);
    }
    this.markBucketDirty(bucket);
  }

  /** A crossfading layer draws alone in the transparent queue, which sorts each draw by its own distance. */
  private placeAlone(layer: Layer): void {
    this.leaveBucket(layer);
    let batch = layer.batch;
    if (batch && batch.mirrored !== layer.mirrored) {
      this.releaseAlone(layer);
      batch = null;
    }
    if (!batch) {
      batch = this.acquireBatch(layer.mirrored);
      batch.bucket = null;
      batch.count = 1;
      layer.batch = batch;
      layer.slot = 0;
      this.activeBatchCount += 1;
      this.spriteCount += 1;
    }
    this.fillAlone(batch, layer);
  }

  private fillAlone(batch: SpriteBatch, layer: Layer): void {
    const handle = layer.owner;
    batch.members[0] = layer;
    batch.blend = true;
    batch.lighting = layer.lighting;
    batch.receiveShadows = layer.receiveShadows;
    batch.texture = layer.sampledTexture;
    batch.boundsStale = true;
    this.configureBatchMesh(batch, handle.renderingGroupId, handle.alphaIndex);
    this.writeInstance(batch, 0, layer, MASK_ALL);
    layer.pendingMask = 0;
  }

  /**
   * At equal distance the transparent queue keeps Scene order, where the unbatched overlay, made after its root, comes
   * after it: the primary's own draw must be the older mesh of the two.
   */
  private orderAlone(handle: Handle): void {
    const primary = handle.primary as Layer, secondary = handle.secondary as Layer;
    const first = primary.batch, second = secondary.batch;
    if (!first || !second || first.bucket || second.bucket || first.mesh.uniqueId < second.mesh.uniqueId) return;
    primary.batch = second;
    secondary.batch = first;
    this.fillAlone(second, primary);
    this.fillAlone(first, secondary);
  }

  private releaseAlone(layer: Layer): void {
    const batch = layer.batch;
    if (!batch || batch.bucket) return;
    layer.batch = null;
    layer.slot = -1;
    this.activeBatchCount -= 1;
    this.spriteCount -= 1;
    this.recycleBatch(batch);
  }

  /** The layer draws nowhere. */
  private unplace(layer: Layer): void {
    if (layer.bucket) this.leaveBucket(layer);
    else this.releaseAlone(layer);
    layer.pendingMask = 0;
  }

  private leaveBucket(layer: Layer): void {
    const bucket = layer.bucket;
    if (!bucket) return;
    const last = bucket.members.pop()!;
    if (last !== layer) {
      bucket.members[layer.bucketIndex] = last;
      last.bucketIndex = layer.bucketIndex;
    }
    layer.bucket = null;
    layer.bucketIndex = -1;
    layer.batch = null;
    layer.slot = -1;
    this.markBucketDirty(bucket);
  }

  private bucketOf(renderingGroupId: number, alphaIndex: number): CutoutBucket {
    let byAlpha = this.buckets.get(renderingGroupId);
    if (!byAlpha) this.buckets.set(renderingGroupId, (byAlpha = new Map()));
    let bucket = byAlpha.get(alphaIndex);
    if (!bucket) {
      bucket = { renderingGroupId, alphaIndex, members: [], splitters: [], batches: [], dirty: false };
      byAlpha.set(alphaIndex, bucket);
      // Its other meshes are found by the next scan.
      this.scannedMeshCount = -1;
    }
    return bucket;
  }

  private markBucketDirty(bucket: CutoutBucket): void {
    if (bucket.dirty) return;
    bucket.dirty = true;
    this.dirtyBuckets.push(bucket);
  }

  /** Finds each bucket's other meshes: anything with geometry in its rendering group and `alphaIndex`. */
  private scanSplitters(): void {
    const scene = this.scene;
    this.scannedMeshCount = scene.meshes.length;
    this.scannedSortingRevision = sceneSortingRevision(scene);
    this.meshRemoved = false;
    if (this.buckets.size === 0) return;
    for (const byAlpha of this.buckets.values()) for (const bucket of byAlpha.values()) {
      bucket.splitters.length = 0;
      this.markBucketDirty(bucket);
    }
    const meshes = scene.meshes;
    for (let index = 0; index < meshes.length; index += 1) {
      const mesh = meshes[index]!;
      const bucket = this.buckets.get(mesh.renderingGroupId)?.get(mesh.alphaIndex);
      if (!bucket || isWorldSpriteBatchMesh(mesh) || isBatchedSpriteRoot(mesh) || mesh.getTotalVertices() === 0) continue;
      bucket.splitters.push(mesh);
    }
  }

  /**
   * Re-partitions a bucket into runs of consecutive alike sprites that no other mesh of the bucket falls between,
   * reusing its batches, and writes only the slots whose sprite changed.
   */
  private partition(bucket: CutoutBucket): void {
    bucket.dirty = false;
    const members = bucket.members;
    if (members.length === 0) {
      for (const batch of bucket.batches) this.retireBucketBatch(batch);
      bucket.batches.length = 0;
      bucket.splitters.length = 0;
      this.buckets.get(bucket.renderingGroupId)?.delete(bucket.alphaIndex);
      return;
    }
    members.sort(compareLayers);
    for (let index = 0; index < members.length; index += 1) members[index]!.bucketIndex = index;
    const splitters = bucket.splitters.length ? bucket.splitters.sort(compareMeshDrawIdentity) : NO_SPLITTERS;
    const pass = ++this.claimPass;
    const next = this.nextBatches;
    next.length = 0;
    let splitter = 0;
    let start = 0;
    while (start < members.length) {
      const first = members[start]!;
      // Other meshes before this run's first sprite draw before it.
      while (splitter < splitters.length && compareLayerToMesh(first, splitters[splitter]!) > 0) splitter += 1;
      const bound = splitter < splitters.length ? splitters[splitter]! : null;
      let end = start + 1;
      while (end < members.length && sameDraw(first, members[end]!) && (!bound || compareLayerToMesh(members[end]!, bound) < 0)) end += 1;
      const batch = this.claimBatch(bucket, start, end, pass);
      next.push(batch);
      this.fillRun(bucket, batch, start, end);
      start = end;
    }
    for (const batch of bucket.batches) if (batch.claim !== pass) this.retireBucketBatch(batch);
    this.nextBatches = bucket.batches;
    bucket.batches = next;
  }

  /** A batch for members `[start, end)`: one of theirs if free and of their winding, else a pooled one. */
  private claimBatch(bucket: CutoutBucket, start: number, end: number, pass: number): SpriteBatch {
    const members = bucket.members;
    const mirrored = members[start]!.mirrored;
    for (let index = start; index < end; index += 1) {
      const batch = members[index]!.batch;
      if (batch && batch.bucket === bucket && batch.claim !== pass && batch.mirrored === mirrored) {
        batch.claim = pass;
        return batch;
      }
    }
    const batch = this.acquireBatch(mirrored);
    batch.bucket = bucket;
    batch.claim = pass;
    batch.boundsStale = true;
    this.activeBatchCount += 1;
    return batch;
  }

  private fillRun(bucket: CutoutBucket, batch: SpriteBatch, start: number, end: number): void {
    const members = bucket.members;
    const first = members[start]!;
    const count = end - start;
    batch.blend = false;
    batch.lighting = first.lighting;
    batch.receiveShadows = first.receiveShadows;
    batch.texture = first.sampledTexture;
    this.configureBatchMesh(batch, bucket.renderingGroupId, bucket.alphaIndex);
    // The batch sorts as its first sprite would.
    const metadata = batch.mesh.metadata as { sortingGroupId: string; sortingName: string; sortingUniqueId: number };
    metadata.sortingGroupId = first.owner.sortingGroupId;
    metadata.sortingName = layerName(first);
    metadata.sortingUniqueId = first.owner.root.uniqueId;
    if (count > batch.capacity) this.grow(batch, count);
    if (batch.count !== count) {
      this.spriteCount += count - batch.count;
      batch.count = count;
      batch.boundsStale = true;
      this.queueBatch(batch);
    }
    for (let slot = 0; slot < count; slot += 1) {
      const layer = members[start + slot]!;
      if (batch.members[slot] === layer && layer.batch === batch && layer.slot === slot) continue;
      batch.members[slot] = layer;
      layer.batch = batch;
      layer.slot = slot;
      layer.pendingMask = 0;
      batch.boundsStale = true;
      this.writeInstance(batch, slot, layer, MASK_ALL);
    }
    batch.members.length = count;
  }

  private retireBucketBatch(batch: SpriteBatch): void {
    for (let slot = 0; slot < batch.count; slot += 1) {
      const layer = batch.members[slot];
      if (layer && layer.batch === batch) {
        layer.batch = null;
        layer.slot = -1;
      }
    }
    this.spriteCount -= batch.count;
    this.activeBatchCount -= 1;
    this.recycleBatch(batch);
  }

  private grow(batch: SpriteBatch, needed: number): void {
    let capacity = Math.max(INITIAL_CAPACITY, batch.capacity);
    while (capacity < needed) capacity *= 2;
    for (let kind = 0; kind < KIND_COUNT; kind += 1) {
      const data = new Float32Array(capacity * KIND_STRIDES[kind]!);
      data.set(batch.data[kind]!);
      batch.data[kind] = data;
    }
    batch.capacity = capacity;
    batch.buffersBound = false;
    this.queueBatch(batch);
  }

  private acquireBatch(mirrored: boolean): SpriteBatch {
    const pool = mirrored ? this.freeMirrored : this.freeNormal;
    const pooled = pool.pop();
    if (pooled) {
      pooled.claim = 0;
      return pooled;
    }
    const mesh = createUnitQuadMesh(this.scene, `worldSpriteBatch:${this.nextMeshId++}`, mirrored);
    return {
      mesh,
      mirrored,
      bucket: null,
      blend: false,
      lighting: LIGHTING_NONE,
      receiveShadows: false,
      texture: null,
      capacity: INITIAL_CAPACITY,
      count: 0,
      data: KIND_STRIDES.map((stride) => new Float32Array(INITIAL_CAPACITY * stride)),
      members: [],
      dirtyLo: new Int32Array(KIND_COUNT).fill(0x7fffffff),
      dirtyHi: new Int32Array(KIND_COUNT).fill(-1),
      queued: false,
      buffersBound: false,
      bounds: createSpriteBounds(),
      boundsStale: true,
      boundsChanged: false,
      anchorX: 0,
      anchorY: 0,
      anchorZ: 0,
      boundTexture: null,
      boundLighting: -1,
      boundBlend: null,
      claim: 0,
    };
  }

  private configureBatchMesh(batch: SpriteBatch, renderingGroupId: number, alphaIndex: number): void {
    const mesh = batch.mesh;
    if (mesh.renderingGroupId !== renderingGroupId) mesh.renderingGroupId = renderingGroupId;
    if (mesh.alphaIndex !== alphaIndex) mesh.alphaIndex = alphaIndex;
    // A crossfading layer blends (its weight is per instance, in `spriteFinish`); a cutout run does not.
    const visibility = batch.blend ? 0.5 : 1;
    if (mesh.visibility !== visibility) mesh.visibility = visibility;
    if (batch.boundTexture !== batch.texture || batch.boundLighting !== batch.lighting || batch.boundBlend !== batch.blend) {
      const binding: UnlitBinding = {
        texture: batch.texture,
        color: [1, 1, 1],
        alpha: 1,
        cutoff: 0.4,
        blend: false,
        textureAlpha: true,
        twoSided: false,
      };
      setUnlitMaterial(mesh, materialKeyFor(batch.lighting), binding);
      batch.boundTexture = batch.texture;
      batch.boundLighting = batch.lighting;
      batch.boundBlend = batch.blend;
    }
    // A batch never casts: the shadow depth pass would draw its raw unit quad (casting sprites never batch).
    sceneShadowController(this.scene).setParticipation(mesh, { castShadows: false, receiveShadows: batch.receiveShadows });
    this.queueBatch(batch);
  }

  private recycleBatch(batch: SpriteBatch): void {
    batch.members.length = 0;
    batch.count = 0;
    batch.bucket = null;
    batch.dirtyLo.fill(0x7fffffff);
    batch.dirtyHi.fill(-1);
    batch.boundsStale = true;
    batch.mesh.thinInstanceCount = 0;
    batch.mesh.setEnabled(false);
    batch.mesh.isVisible = false;
    (batch.mirrored ? this.freeMirrored : this.freeNormal).push(batch);
  }

  private queueBatch(batch: SpriteBatch): void {
    if (batch.queued) return;
    batch.queued = true;
    this.queuedBatches.push(batch);
  }

  private writePending(layer: Layer): void {
    const mask = layer.pendingMask;
    if (!mask) return;
    layer.pendingMask = 0;
    const batch = layer.batch;
    if (batch && layer.slot >= 0) this.writeInstance(batch, layer.slot, layer, mask);
  }

  /** Writes `mask`'s buffers of one instance and grows the batch's dirty ranges and bounds. */
  private writeInstance(batch: SpriteBatch, slot: number, layer: Layer, mask: number): void {
    const handle = layer.owner;
    const m = handle.worldMatrix.asArray();
    const data = batch.data;
    if (mask & MASK_MATRIX) {
      const matrices = data[KIND_MATRIX]!;
      const offset = slot * 16;
      for (let k = 0; k < 16; k += 1) matrices[offset + k] = m[k]!;
      // Relative to the batch's anchor, subtracted in 64 bits before rounding into the 32-bit row.
      matrices[offset + 12] = m[12]! - this.anchorX;
      matrices[offset + 13] = m[13]! - this.anchorY;
      matrices[offset + 14] = m[14]! - this.anchorZ;
    }
    const offset = slot * 4;
    if (mask & (1 << KIND_SIZE_PIVOT)) {
      const sizePivots = data[KIND_SIZE_PIVOT]!;
      sizePivots[offset] = layer.width;
      sizePivots[offset + 1] = layer.height;
      sizePivots[offset + 2] = layer.pivotX;
      sizePivots[offset + 3] = layer.pivotY;
    }
    if (mask & (1 << KIND_UV_RECT)) {
      const uvRects = data[KIND_UV_RECT]!;
      uvRects[offset] = layer.u0;
      uvRects[offset + 1] = layer.v0;
      uvRects[offset + 2] = layer.u1 - layer.u0;
      uvRects[offset + 3] = layer.v1 - layer.v0;
    }
    if (mask & MASK_FINISH) {
      const finishes = data[KIND_FINISH]!;
      finishes[offset] = layer.visibility;
      finishes[offset + 1] = 0;
      finishes[offset + 2] = 0;
      finishes[offset + 3] = 0;
    }
    if (mask & (1 << KIND_TEXEL)) {
      const texels = data[KIND_TEXEL]!;
      const cell = layer.cell;
      if (cell) {
        texels[offset] = layer.texelX * cell.width;
        texels[offset + 1] = layer.texelY * cell.height;
        texels[offset + 2] = cell.x;
        texels[offset + 3] = cell.y;
      } else {
        texels[offset] = layer.texelX;
        texels[offset + 1] = layer.texelY;
        texels[offset + 2] = UNLIT_TEXEL_WHOLE;
        texels[offset + 3] = UNLIT_TEXEL_WHOLE;
      }
    }
    for (let kind = 0; kind < KIND_COUNT; kind += 1) {
      if (!(mask & (1 << kind))) continue;
      if (slot < batch.dirtyLo[kind]!) batch.dirtyLo[kind] = slot;
      if (slot > batch.dirtyHi[kind]!) batch.dirtyHi[kind] = slot;
    }
    if (mask & (MASK_MATRIX | (1 << KIND_SIZE_PIVOT))) {
      // Bounds hold every instance (frustum and occlusion culling trust them): grow by this one, exact on re-partition.
      if (!batch.boundsStale) accumulateSpriteQuad(layer.width, layer.height, layer.pivotX, layer.pivotY, m, batch.bounds);
      batch.boundsChanged = true;
    }
    this.queueBatch(batch);
  }

  private upload(batch: SpriteBatch): void {
    batch.queued = false;
    const mesh = batch.mesh;
    if (batch.count === 0) return;
    if (batch.anchorX !== this.anchorX || batch.anchorY !== this.anchorY || batch.anchorZ !== this.anchorZ) {
      // Re-based: every row's translation and the mesh's position follow the anchor.
      batch.anchorX = this.anchorX;
      batch.anchorY = this.anchorY;
      batch.anchorZ = this.anchorZ;
      mesh.unfreezeWorldMatrix();
      mesh.position.set(this.anchorX, this.anchorY, this.anchorZ);
      mesh.freezeWorldMatrix();
      for (let slot = 0; slot < batch.count; slot += 1) this.writeInstance(batch, slot, batch.members[slot]!, MASK_MATRIX);
      batch.boundsChanged = true;
    }
    if (!batch.buffersBound) {
      // Suppress automatic thinInstanceRefreshBoundingInfo inside thinInstanceSetBuffer; exact bounds are written below.
      mesh.doNotSyncBoundingInfo = true;
      for (let kind = 0; kind < KIND_COUNT; kind += 1) {
        mesh.thinInstanceSetBuffer(KIND_NAMES[kind]!, batch.data[kind]!, KIND_STRIDES[kind]!, false);
        this.bufferUploads += 1;
        this.uploadedInstances += batch.capacity;
      }
      mesh.doNotSyncBoundingInfo = false;
      batch.buffersBound = true;
      batch.dirtyLo.fill(0x7fffffff);
      batch.dirtyHi.fill(-1);
    } else {
      for (let kind = 0; kind < KIND_COUNT; kind += 1) {
        const lo = batch.dirtyLo[kind]!;
        const hi = Math.min(batch.dirtyHi[kind]!, batch.count - 1);
        batch.dirtyLo[kind] = 0x7fffffff;
        batch.dirtyHi[kind] = -1;
        if (lo > hi) continue;
        const stride = KIND_STRIDES[kind]!;
        const count = hi - lo + 1;
        if (count === 1) {
          // One row through a scratch copy: Babylon's ranged form allocates a view per upload.
          const row = scratchRows[stride]!;
          const source = batch.data[kind]!;
          for (let k = 0; k < stride; k += 1) row[k] = source[lo * stride + k]!;
          mesh.thinInstancePartialBufferUpdate(KIND_NAMES[kind]!, row, lo * stride);
        } else {
          mesh.thinInstancePartialBufferUpdate(KIND_NAMES[kind]!, count, lo);
        }
        this.bufferUploads += 1;
        this.uploadedInstances += count;
      }
    }
    if (mesh.thinInstanceCount !== batch.count) mesh.thinInstanceCount = batch.count;
    if (batch.boundsStale) {
      batch.boundsStale = false;
      batch.boundsChanged = true;
      const bounds = batch.bounds;
      resetSpriteBounds(bounds);
      for (let slot = 0; slot < batch.count; slot += 1) {
        const layer = batch.members[slot]!;
        accumulateSpriteQuad(layer.width, layer.height, layer.pivotX, layer.pivotY, layer.owner.worldMatrix.asArray(), bounds);
      }
    }
    if (batch.boundsChanged) {
      batch.boundsChanged = false;
      this.applyBounds(batch);
    }
    if (!mesh.isEnabled()) mesh.setEnabled(true);
    if (!mesh.isVisible) mesh.isVisible = true;
  }

  private applyBounds(batch: SpriteBatch): void {
    const mesh = batch.mesh;
    if (!batch.bucket) {
      // Alone, the bounds its quad would have drawn one by one: the transparent queue sorts by their centre.
      const layer = batch.members[0]!;
      const left = Math.fround(-layer.pivotX * layer.width);
      const top = Math.fround(layer.pivotY * layer.height);
      scratchLocalMin.set(left, Math.fround(layer.pivotY * layer.height - layer.height), 0);
      scratchLocalMax.set(Math.fround(-layer.pivotX * layer.width + layer.width), top, 0);
      scratchMatrix.copyFrom(layer.owner.worldMatrix);
      mesh.getBoundingInfo().reConstruct(scratchLocalMin, scratchLocalMax, scratchMatrix);
      return;
    }
    const bounds = batch.bounds;
    if (!Number.isFinite(bounds[0]!)) return;
    // In mesh-local space (world minus the anchor) under the mesh's world matrix (the anchor).
    scratchLocalMin.set(bounds[0]! - batch.anchorX, bounds[1]! - batch.anchorY, bounds[2]! - batch.anchorZ);
    scratchLocalMax.set(bounds[3]! - batch.anchorX, bounds[4]! - batch.anchorY, bounds[5]! - batch.anchorZ);
    mesh.getBoundingInfo().reConstruct(scratchLocalMin, scratchLocalMax, mesh.getWorldMatrix());
  }

  private bindLayerTexture(
    handle: Handle,
    layer: Layer,
    textureGuid: string | null,
    assets?: MeshAssetContext,
  ): void {
    if (!textureGuid) {
      const had = layer.texture !== null || layer.textureGuid !== null;
      releaseLayerLeases(layer);
      if (had) this.queuePlacement(handle);
      return;
    }
    const source = assets?.textureBytes?.get(textureGuid);
    if (!source || !assets?.resourceCache) {
      // Remember the authored guid even if bytes aren't installed yet (so `eject` preserves it).
      layer.textureGuid = textureGuid;
      return;
    }
    const identity = source instanceof Blob && layer.source === source ? layer.identity : assetByteFingerprint(source);
    if (
      layer.identity === identity &&
      layer.textureGuid === textureGuid &&
      ((layer.lease && !isDisposedGpuTexture(layer.lease.resource)) || layer.pending)
    ) {
      layer.source = source;
      return;
    }
    if (layer.failed === `${textureGuid}:${identity}`) return;

    let next: ResourceLease<Texture | CubeTexture>;
    try {
      next = assets.resourceCache.acquireTexture(
        textureGuid,
        this.scene.getEngine(),
        source,
        { ...PIXEL_ART_TEXTURE_SAMPLING, hasAlpha: true },
      );
    } catch (error) {
      layer.failed = `${textureGuid}:${identity}`;
      layer.preparation = Promise.reject(error);
      void layer.preparation.catch(() => {});
      console.error("Sprite texture replacement failed", error);
      return;
    }

    layer.pending?.release();
    layer.source = source;
    layer.textureGuid = textureGuid;
    layer.identity = identity;
    layer.pending = next;
    layer.preparation = next.ready;

    const publish = () => {
      if (handle.disposed || layer.pending !== next) {
        next.release();
        return;
      }
      const previous = layer.lease;
      layer.lease = next;
      layer.pending = undefined;
      layer.texture = next.resource;
      layer.cell = null;
      previous?.release();
      this.queuePlacement(handle);
    };

    const failed = (error: unknown) => {
      if (handle.disposed || (layer.pending !== next && layer.lease !== next)) return;
      if (layer.pending === next) layer.pending = undefined;
      if (layer.lease === next) {
        layer.lease = undefined;
        layer.texture = null;
        layer.cell = null;
        this.queuePlacement(handle);
      }
      layer.failed = `${textureGuid}:${identity}`;
      next.release();
      console.error("Sprite texture replacement failed", error);
    };

    if (!layer.lease) {
      publish();
      void next.ready?.catch(failed);
    } else if (next.ready) {
      void next.ready.then(publish, failed);
    } else if (next.resource.isReady()) {
      publish();
    }
  }
}

/**
 * Enable or disable Play world sprite batching on `scene`. Disabling ejects every batched sprite to a standalone quad
 * first (the caller gives slot roots their crossfade overlays: `ejectPlaySprite`), so nothing stops drawing.
 */
export function setSceneWorldSpriteBatching(scene: Scene, enabled: boolean): void {
  if (enabled) {
    batchingEnabledScenes.add(scene);
    worldSpriteBatcher(scene);
  } else {
    batchingEnabledScenes.delete(scene);
    const batcher = batchers.get(scene);
    batcher?.ejectAll();
    batcher?.dispose();
  }
}

/** Whether `scene` batches Play world `SpriteComponent` visuals (requires hardware instanced arrays). */
export function sceneWorldSpriteBatching(scene: Scene): boolean {
  return batchingEnabledScenes.has(scene) && Boolean(scene.getEngine().getCaps().instancedArrays);
}

/** Return `scene`'s `WorldSpriteBatcher`, creating it on first use. */
export function worldSpriteBatcher(scene: Scene): WorldSpriteBatcher {
  let batcher = batchers.get(scene);
  if (!batcher) {
    batcher = new WorldSpriteBatcher(scene);
    batchers.set(scene, batcher);
  }
  return batcher;
}

/** Return `scene`'s `WorldSpriteBatcher` if one exists, without creating one. */
export function findWorldSpriteBatcher(scene: Scene): WorldSpriteBatcher | undefined {
  return batchers.get(scene);
}

/** Batching stats for `scene`'s `WorldSpriteBatcher` (`RenderDiagnostics.worldSprites`); null while it has none. */
export function worldSpriteBatchStats(scene: Scene): WorldSpriteBatchStats | null {
  return batchers.get(scene)?.stats ?? null;
}

export function attachBatchedSprite(root: Mesh, init: BatchedSpriteInit): BaseBatchedSpriteHandle {
  return worldSpriteBatcher(root.getScene()).attach(root, init);
}

export function ejectBatchedSprite(root: AbstractMesh): Mesh | undefined {
  const handle = batchedSpriteOf(root);
  if (!handle || handle.disposed || !(root instanceof Mesh)) return undefined;
  return findWorldSpriteBatcher(root.getScene())?.eject(root);
}

/** Pending texture preparation promise for a batched sprite root (used by `ownedVisualTexturePreparation`). */
export function batchedSpriteTexturePreparation(root: AbstractMesh): Promise<void> | undefined {
  const handle = batchedSpriteOf(root);
  if (!handle || handle.disposed) return undefined;
  const pending: Promise<void>[] = [];
  if (handle.primary.preparation) pending.push(handle.primary.preparation);
  if (handle.secondary.preparation) pending.push(handle.secondary.preparation);
  return pending.length ? Promise.all(pending).then(() => undefined) : undefined;
}

/** Refresh leased textures for a batched sprite root when texture bytes change (`refreshAlbedoTextures`). */
export function refreshBatchedSpriteTextures(
  root: AbstractMesh,
  assets: MeshAssetContext,
  changed: ReadonlySet<string>,
): Promise<void>[] {
  const handle = batchedSpriteOf(root);
  if (!handle || handle.disposed) return [];
  return findWorldSpriteBatcher(root.getScene())?.refreshTextures(root, assets, changed) ?? [];
}

let hooksRegistered = false;
function ensureBatchedSpriteTextureHooks(): void {
  if (hooksRegistered) return;
  hooksRegistered = true;
  registerBatchedSpriteTextureHooks({
    preparation: batchedSpriteTexturePreparation,
    refresh: refreshBatchedSpriteTextures,
  });
}
