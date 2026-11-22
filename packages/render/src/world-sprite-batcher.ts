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
import { applyAlbedoTexture, registerBatchedSpriteTextureHooks, type MeshAssetContext } from "./mesh-assets";
import { markBoundsHoldInstances } from "./play-view-culling";
import { PIXEL_ART_TEXTURE_SAMPLING, type ResourceLease } from "./resource-cache";
import { markSceneReadinessDirty } from "./scene-readiness-signal";
import { sceneShadowController } from "./shadow-controller";
import {
  SPRITE_BATCH_FINISH_KIND,
  SPRITE_BATCH_SIZE_PIVOT_KIND,
  SPRITE_BATCH_TEXEL_KIND,
  SPRITE_BATCH_UV_RECT_KIND,
  markWorldSpriteBatchMesh,
} from "./sprite-batch-block";
import {
  accumulateSpriteCorner,
  batchedSpriteOf,
  isBatchedSpriteRoot,
  registerBatchedSpriteHandle,
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
 * consumer works unchanged while all sprite rendering collapses into sorting-layer and texture-grouped thin-instanced
 * unit quads.
 *
 * - **Sprite Animations:** `sheet` UV cells, `Flip Frame`, multi-texture `frames` (with async `ResourceCache` leases),
 *   and two-layer crossfades (lazy secondary instance only while active) update instance buffers in place with zero VBO
 *   rebuilds and no eager `actor-N-blend` duplicate meshes.
 * - **Auto-Atlasing:** Small nearest-sampled sprite textures (`<= 256×256`) automatically coalesce onto the Scene's
 *   `LayerImageAtlas` page through per-instance `spriteTexel` grids, collapsing loose-texture 2D scenes into a single
 *   draw call per sorting group.
 * - **Exact Rendering:** Preserves `renderingGroupId`, `alphaIndex`, `shadingMode` (`unlit` / `2d` / `3d`), post-cutoff
 *   crossfade blending, `castShadows` / `receiveShadows`, mirrored world transforms (`scale.x < 0` via reversed-winding
 *   batches), Large World floating origin (64-bit eye subtraction), and frustum culling bounds (`markBoundsHoldInstances`).
 * - **Promotion:** Attaching a custom `Material`, `DeformerComponent`, or non-empty `OutlineComponent` calls
 *   `ejectBatchedSprite(root)` to populate standard sprite quad geometry on `root` in place.
 */

const UNIT_QUAD_POSITIONS = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0];
const UNIT_QUAD_NORMALS = [0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1];
const UNIT_QUAD_UVS = [0, 0, 1, 0, 1, 1, 0, 1];
const UNIT_QUAD_INDICES = [0, 1, 2, 0, 2, 3];
const UNIT_QUAD_MIRRORED_INDICES = [0, 2, 1, 0, 3, 2];

const INITIAL_CAPACITY = 16;

/** World sprite UnlitMaterial keys matching `mesh-assets.ts` (`SPRITE_MATERIAL`). */
const WORLD_SPRITE_BASE_KEY: UnlitMaterialKey = { textured: true, backFaceCulling: true, fog: true, role: "world" };
const WORLD_SPRITE_LIT_2D_KEY: UnlitMaterialKey = { ...WORLD_SPRITE_BASE_KEY, lighting: "2d" };
const WORLD_SPRITE_LIT_3D_KEY: UnlitMaterialKey = { ...WORLD_SPRITE_BASE_KEY, lighting: "3d" };

type ResolvedLighting = "none" | "2d" | "3d";
/** 0: alpha-test cutout (`cutoff=0.4, blend=false, vis=1`); 1: crossfading cutout (`cutoff=0.4, blend=false, vis=0.5`); 2: alwaysBlend (`cutoff=0, blend=true, vis=1`). */
type BlendModeCode = 0 | 1 | 2;

export interface WorldSpriteBatchStats {
  /** Active visible sprite instances submitted (primary + active crossfade overlays). */
  sprites: number;
  /** Active non-empty batch meshes. */
  batches: number;
  /** Distinct pooled batch meshes currently allocated (active + recycled). */
  poolSize: number;
  /** Images registered on the Scene's `LayerImageAtlas` page and those drawn there. */
  atlasImages: number;
  atlasDrawn: number;
  /** Cumulative GPU buffer uploads (`thinInstanceSetBuffer` / `thinInstancePartialBufferUpdate` flushes). */
  bufferUploads: number;
}

export interface BatchedSpriteInit {
  width: number;
  height: number;
  pivotX: number;
  pivotY: number;
  u0?: number;
  v0?: number;
  u1?: number;
  v1?: number;
  textureGuid?: string | null;
  assets?: MeshAssetContext;
  shadingMode?: SurfaceShadingMode;
  alwaysBlend?: boolean;
  visibility?: number;
  renderingGroupId?: number;
  alphaIndex?: number;
  sortingGroupId?: string;
  castShadows?: boolean;
  receiveShadows?: boolean;
  visible?: boolean;
}

type SpriteLayerState = BaseSpriteLayerState<SpriteBatch>;
type BatchedSpriteHandle = BaseBatchedSpriteHandle<SpriteBatch>;

interface BatchSpec {
  key: string;
  renderingGroupId: number;
  alphaIndex: number;
  lighting: ResolvedLighting;
  blendMode: BlendModeCode;
  mirrored: boolean;
  receiveShadows: boolean;
  castShadows: boolean;
  sampledTexture: BaseTexture | null;
}

interface SpriteBatch {
  spec: BatchSpec;
  mesh: Mesh;
  mirrored: boolean;
  capacity: number;
  count: number;
  matrices: Float32Array;
  sizePivots: Float32Array;
  uvRects: Float32Array;
  finishes: Float32Array;
  texels: Float32Array;
  members: Array<{ handle: BatchedSpriteHandle; layer: SpriteLayerState; sortDistance: number }>;
  dirty: boolean;
  buffersBound: boolean;
  /** Cached unlit binding values applied to `mesh`. */
  boundTexture: BaseTexture | null;
  boundLighting: ResolvedLighting | null;
  boundBlendMode: BlendModeCode | -1;
}

const batchingEnabledScenes = new WeakSet<Scene>();
const batchers = new WeakMap<Scene, WorldSpriteBatcher>();
const textureBatchIds = new WeakMap<BaseTexture, number>();
let nextTextureBatchId = 1;

/** Guaranteed-unique per-object texture ID (engine-owned `ResourceCache` textures have `uniqueId === 0` in Babylon). */
function textureBatchId(texture: BaseTexture | null): number {
  if (!texture) return 0;
  let id = textureBatchIds.get(texture);
  if (id === undefined) {
    id = nextTextureBatchId++;
    textureBatchIds.set(texture, id);
  }
  return id;
}

const scratchGrid = [0, 0];
const scratchMin = new Vector3();
const scratchMax = new Vector3();
const scratchBoundsLocalMin = new Vector3();
const scratchBoundsLocalMax = new Vector3();

function keepsUvs(texture: BaseTexture): boolean {
  const matrix = texture.getTextureMatrix();
  return matrix.isIdentityAs3x2() || matrix.isIdentity();
}

function nextCapacity(needed: number, current: number): number {
  let cap = Math.max(INITIAL_CAPACITY, current);
  while (cap < needed) cap *= 2;
  return cap;
}

function materialKeyFor(lighting: ResolvedLighting): UnlitMaterialKey {
  if (lighting === "2d") return WORLD_SPRITE_LIT_2D_KEY;
  if (lighting === "3d") return WORLD_SPRITE_LIT_3D_KEY;
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
  mesh.doNotSyncBoundingInfo = false;
  mesh.alwaysSelectAsActiveMesh = false;
  mesh.freezeWorldMatrix();
  markWorldSpriteBatchMesh(mesh);
  markBoundsHoldInstances(mesh);
  return mesh;
}

function createLayerState(isOverlay: boolean, init: BatchedSpriteInit): SpriteLayerState {
  return {
    isOverlay,
    active: !isOverlay,
    width: Math.max(0, init.width),
    height: Math.max(0, init.height),
    pivotX: init.pivotX,
    pivotY: init.pivotY,
    u0: init.u0 ?? 0,
    v0: init.v0 ?? 0,
    u1: init.u1 ?? 1,
    v1: init.v1 ?? 1,
    visibility: isOverlay ? 0 : (init.visibility ?? 1),
    textureGuid: null,
    texture: null,
    batchKey: null,
    batch: null,
    texelX: 0,
    texelY: 0,
    sampledTexture: null,
    cell: null,
  };
}

function releaseLayerLeases(layer: SpriteLayerState): void {
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

/**
 * Per-scene persistent thin-instanced sprite batcher.
 */
export class WorldSpriteBatcher {
  readonly scene: Scene;
  private readonly handles = new Set<BatchedSpriteHandle>();
  private readonly activeBatches = new Map<string, SpriteBatch>();
  private readonly freeNormal: SpriteBatch[] = [];
  private readonly freeMirrored: SpriteBatch[] = [];
  private atlas: LayerImageAtlas | null = null;
  private imagePagesEnabled = true;
  private lastAtlasRevision = -1;
  private last2DLighting: boolean;
  private lastEyeX = 0;
  private lastEyeY = 0;
  private lastEyeZ = 0;
  private structureDirty = false;
  private nextMeshId = 0;
  private bufferUploads = 0;
  private lastSpriteCount = 0;
  private disposed = false;
  private readonly beforeRenderObserver: Observer<Scene> | null;
  private readonly unsub2DLighting: () => void;
  private readonly disposeObserver: Observer<Scene> | null;

  constructor(scene: Scene) {
    ensureBatchedSpriteTextureHooks();
    this.scene = scene;
    this.last2DLighting = scene2DLighting(scene);
    // Registered normally (after `insertFirst` observers like `LayerImageAtlas.flush()`, and after `animVisibility.flush()`).
    this.beforeRenderObserver = scene.onBeforeRenderObservable.add(() => this.flush());
    this.unsub2DLighting = onScene2DLightingChanged(scene, () => {
      if (this.disposed) return;
      this.structureDirty = true;
      this.flush();
      markSceneReadinessDirty(scene, "meshAssets");
    });
    this.disposeObserver = scene.onDisposeObservable.addOnce(() => this.dispose());
  }

  /** Enable or disable automatic `LayerImageAtlas` page coalescing for small (`<=256×256`) nearest textures. */
  setImagePages(enabled: boolean): void {
    if (this.imagePagesEnabled === enabled || this.disposed) return;
    this.imagePagesEnabled = enabled;
    if (!enabled && this.atlas) {
      this.atlas.dispose();
      this.atlas = null;
      this.lastAtlasRevision = -1;
    }
    this.structureDirty = true;
  }

  get stats(): WorldSpriteBatchStats {
    const atlasCounts = this.atlas?.counts ?? { images: 0, drawn: 0 };
    return {
      sprites: this.lastSpriteCount,
      batches: this.activeBatches.size,
      poolSize: this.activeBatches.size + this.freeNormal.length + this.freeMirrored.length,
      atlasImages: atlasCounts.images,
      atlasDrawn: atlasCounts.drawn,
      bufferUploads: this.bufferUploads,
    };
  }

  /** Active batch meshes currently enabled for drawing (primarily for inspection and tests). */
  activeBatchMeshes(): Mesh[] {
    const meshes: Mesh[] = [];
    for (const batch of this.activeBatches.values()) {
      if (batch.count > 0) meshes.push(batch.mesh);
    }
    return meshes;
  }

  /** Attach a batched sprite entry to a geometry-free root `Mesh`. */
  attach(root: Mesh, init: BatchedSpriteInit): BatchedSpriteHandle {
    const existing = batchedSpriteOf(root);
    if (existing) existing.dispose();

    const primary = createLayerState(false, init);
    const secondary = createLayerState(true, init);

    const handle: BatchedSpriteHandle = {
      root,
      scene: this.scene,
      primary,
      secondary,
      shadingMode: init.shadingMode ?? "2d",
      alwaysBlend: init.alwaysBlend === true,
      renderingGroupId: init.renderingGroupId ?? root.renderingGroupId,
      alphaIndex: init.alphaIndex ?? root.alphaIndex,
      sortingGroupId: init.sortingGroupId ?? root.name,
      castShadows: init.castShadows === true,
      receiveShadows: init.receiveShadows !== false,
      visible: init.visible !== false,
      assets: init.assets,
      lastWorldUpdateFlag: -1,
      lastEnabled: root.isEnabled(),
      mirrored: false,
      worldMatrix: Matrix.Identity(),
      dirty: true,
      disposed: false,
      updateFrame: (layerName, frame) => {
        if (handle.disposed) return;
        const layer = layerName === "primary" ? handle.primary : handle.secondary;
        if (frame.assets) handle.assets = frame.assets;
        const nextW = Math.max(0, frame.width);
        const nextH = Math.max(0, frame.height);
        const u0 = frame.uv ? frame.uv.u0 : 0;
        const v0 = frame.uv ? frame.uv.v0 : 0;
        const u1 = frame.uv ? frame.uv.u1 : 1;
        const v1 = frame.uv ? frame.uv.v1 : 1;
        let changed = false;
        if (layerName === "secondary" && !layer.active) {
          layer.active = true;
          this.structureDirty = true;
          changed = true;
        }
        if (
          layer.width !== nextW || layer.height !== nextH ||
          layer.pivotX !== frame.pivotX || layer.pivotY !== frame.pivotY ||
          layer.u0 !== u0 || layer.v0 !== v0 || layer.u1 !== u1 || layer.v1 !== v1
        ) {
          layer.width = nextW;
          layer.height = nextH;
          layer.pivotX = frame.pivotX;
          layer.pivotY = frame.pivotY;
          layer.u0 = u0;
          layer.v0 = v0;
          layer.u1 = u1;
          layer.v1 = v1;
          changed = true;
        }
        if (frame.textureGuid !== undefined) {
          this.bindLayerTexture(handle, layer, frame.textureGuid, frame.assets ?? handle.assets);
        }
        if (changed) this.markLayerDirty(handle, layer);
      },
      setLayerVisibility: (layerName, visibility) => {
        if (handle.disposed) return;
        const layer = layerName === "primary" ? handle.primary : handle.secondary;
        if (layer.visibility === visibility && (layerName === "primary" || layer.active === (visibility > 0))) return;
        const wasBlended = this.layerBlendMode(handle, layer);
        const wasDrawable = this.isLayerDrawable(handle, layer);
        layer.visibility = visibility;
        if (layerName === "secondary") layer.active = visibility > 0;
        const nowBlended = this.layerBlendMode(handle, layer);
        const nowDrawable = this.isLayerDrawable(handle, layer);
        if (wasBlended !== nowBlended || wasDrawable !== nowDrawable) {
          this.structureDirty = true;
        } else {
          this.markLayerDirty(handle, layer);
        }
      },
      setSorting: (options) => {
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
        if (options.castShadows !== undefined && handle.castShadows !== options.castShadows) {
          handle.castShadows = options.castShadows;
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
        if (changed) {
          handle.dirty = true;
          this.structureDirty = true;
        }
      },
      setVisible: (visible) => {
        if (handle.disposed || handle.visible === visible) return;
        handle.visible = visible;
        handle.dirty = true;
        this.structureDirty = true;
      },
      markTransformDirty: () => {
        if (handle.disposed) return;
        handle.dirty = true;
      },
      dispose: () => {
        if (handle.disposed) return;
        handle.disposed = true;
        releaseLayerLeases(handle.primary);
        releaseLayerLeases(handle.secondary);
        unregisterBatchedSpriteHandle(root, handle);
        if (this.handles.delete(handle)) this.structureDirty = true;
      },
    };

    // The empty root Mesh carries transforms/children/attachments but never draws directly while batched.
    root.isVisible = false;
    registerBatchedSpriteHandle(root, handle);
    this.handles.add(handle);
    this.structureDirty = true;

    if (init.textureGuid) {
      this.bindLayerTexture(handle, primary, init.textureGuid, init.assets);
    }
    root.onDisposeObservable.addOnce(() => handle.dispose());
    return handle;
  }

  /**
   * Promote a batched sprite root back to a standalone `createSpriteQuad` mesh in place (for custom Materials,
   * Deformers, or Outlines), preserving its current animation frame, texture, visibility and sorting.
   */
  eject(root: Mesh): Mesh | undefined {
    const handle = batchedSpriteOf(root) as BatchedSpriteHandle | undefined;
    if (!handle || handle.disposed) return undefined;
    const { primary, shadingMode, alwaysBlend, visible, assets, renderingGroupId, alphaIndex, sortingGroupId, castShadows, receiveShadows } = handle;
    const width = primary.width;
    const height = primary.height;
    const pivot = { x: primary.pivotX, y: primary.pivotY };
    const uv: TileUv | null = (primary.u0 === 0 && primary.v0 === 0 && primary.u1 === 1 && primary.v1 === 1)
      ? null
      : { u0: primary.u0, v0: primary.v0, u1: primary.u1, v1: primary.v1 };
    const textureGuid = primary.textureGuid;
    const visibility = primary.visibility;

    // Detach from batcher before populating standalone quad geometry so no double-draw can occur.
    handle.dispose();

    populateSpriteQuadGeometry(root, width, height, pivot, uv);
    applyAlbedoTexture(root, this.scene, textureGuid, assets, { alwaysBlend, shadingMode });
    root.visibility = visibility;
    root.renderingGroupId = renderingGroupId;
    root.alphaIndex = alphaIndex;
    root.metadata = {
      ...(typeof root.metadata === "object" && root.metadata ? root.metadata : {}),
      sortingGroupId,
      sortingLayerKey: 0,
    };
    sceneShadowController(this.scene).setParticipation(root, { castShadows, receiveShadows });
    root.isVisible = visible;
    return root;
  }

  /** Refresh leased textures whose encoded bytes changed (`refreshAlbedoTextures`). */
  refreshTextures(root: AbstractMesh, assets: MeshAssetContext, changed: ReadonlySet<string>): Promise<void>[] {
    const handle = batchedSpriteOf(root) as BatchedSpriteHandle | undefined;
    if (!handle || handle.disposed) return [];
    handle.assets = assets;
    const pending: Promise<void>[] = [];
    for (const layer of [handle.primary, handle.secondary]) {
      if (!layer.textureGuid || !changed.has(layer.textureGuid)) continue;
      const before = layer.preparation;
      this.bindLayerTexture(handle, layer, layer.textureGuid, assets);
      if (layer.preparation && layer.preparation !== before) pending.push(layer.preparation);
    }
    return pending;
  }

  /**
   * Synchronize dirty sprite transforms, animation frames, atlas cells, and floating-origin offsets into
   * persistent dynamic thin-instance buffers. Performs zero GPU uploads on unchanged frames.
   */
  flush(): void {
    if (this.disposed || this.scene.isDisposed) return;

    const scene = this.scene;
    const floatingOrigin = scene.floatingOriginMode;
    const eye = scene.floatingOriginOffset;
    const eyeChanged = floatingOrigin && (eye.x !== this.lastEyeX || eye.y !== this.lastEyeY || eye.z !== this.lastEyeZ);
    const eyeX = floatingOrigin ? eye.x : 0;
    const eyeY = floatingOrigin ? eye.y : 0;
    const eyeZ = floatingOrigin ? eye.z : 0;

    const lit2D = scene2DLighting(scene);
    const lightingChanged = lit2D !== this.last2DLighting;
    const atlasRevision = this.atlas?.revision ?? -1;
    const atlasChanged = atlasRevision !== this.lastAtlasRevision;

    let regroup = this.structureDirty || lightingChanged || atlasChanged;

    // Sync world matrices and detect transform / enabled / mirrored / atlas-cell changes.
    for (const handle of this.handles) {
      const root = handle.root;
      if (root.isDisposed()) {
        handle.dispose();
        regroup = true;
        continue;
      }
      const enabled = root.isEnabled();
      if (enabled !== handle.lastEnabled) {
        handle.lastEnabled = enabled;
        regroup = true;
      }
      if (!enabled || !handle.visible) continue;

      if (!root.isWorldMatrixFrozen && !root.isSynchronized()) {
        root.computeWorldMatrix();
      }
      const world = root.getWorldMatrix();
      if (handle.dirty || world.updateFlag !== handle.lastWorldUpdateFlag) {
        handle.lastWorldUpdateFlag = world.updateFlag;
        handle.worldMatrix.copyFrom(world);
        const mirrored = world.determinant() < 0;
        if (mirrored !== handle.mirrored) {
          handle.mirrored = mirrored;
          regroup = true;
        }
        handle.dirty = false;
        if (handle.primary.batch) handle.primary.batch.dirty = true;
        if (handle.secondary.active && handle.secondary.batch) handle.secondary.batch.dirty = true;
      }
      // If a layer's texture wasn't on the atlas yet, ask the atlas (which queues it for the next before-render copy).
      if (this.imagePagesEnabled && !regroup) {
        if (this.layerAtlasCellChanged(handle.primary) || (handle.secondary.active && this.layerAtlasCellChanged(handle.secondary))) {
          regroup = true;
        }
      }
    }

    if (eyeChanged) {
      for (const batch of this.activeBatches.values()) batch.dirty = true;
    }

    if (regroup) {
      this.rebuildBatches(lit2D);
    }

    this.lastEyeX = eyeX;
    this.lastEyeY = eyeY;
    this.lastEyeZ = eyeZ;
    this.last2DLighting = lit2D;
    this.lastAtlasRevision = this.atlas?.revision ?? -1;
    this.structureDirty = false;

    const camera = scene.activeCamera;
    const camPos = camera ? (camera.globalPosition ?? camera.position) : null;

    let totalSprites = 0;
    for (const batch of this.activeBatches.values()) {
      totalSprites += batch.members.length;
      if (batch.members.length === 0) continue;
      // Blended batches in 2.5D/3D with varying Z depths sort back-to-front by camera distance.
      const needsDepthSort = batch.spec.blendMode !== 0 && batch.members.length > 1 && camPos !== null && this.hasVaryingDepth(batch);
      if (needsDepthSort) batch.dirty = true;
      if (!batch.dirty) continue;
      if (needsDepthSort && camPos) {
        for (const member of batch.members) {
          const m = member.handle.worldMatrix.asArray();
          const dx = m[12]! - camPos.x;
          const dy = m[13]! - camPos.y;
          const dz = m[14]! - camPos.z;
          member.sortDistance = dx * dx + dy * dy + dz * dz;
        }
        batch.members.sort((a, b) => b.sortDistance - a.sortDistance);
      }
      this.uploadBatch(batch, eyeX, eyeY, eyeZ, floatingOrigin);
    }
    this.lastSpriteCount = totalSprites;
  }

  /** Clear all handles and disable/recycle all batch meshes (e.g. on Play `changescene`). */
  clear(): void {
    for (const handle of [...this.handles]) handle.dispose();
    for (const batch of this.activeBatches.values()) this.recycleBatch(batch);
    this.activeBatches.clear();
    this.lastSpriteCount = 0;
    this.structureDirty = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.beforeRenderObserver) this.scene.onBeforeRenderObservable.remove(this.beforeRenderObserver);
    if (this.disposeObserver) this.scene.onDisposeObservable.remove(this.disposeObserver);
    this.unsub2DLighting();
    for (const handle of [...this.handles]) handle.dispose();
    for (const batch of this.activeBatches.values()) batch.mesh.dispose(false, false);
    for (const batch of this.freeNormal) batch.mesh.dispose(false, false);
    for (const batch of this.freeMirrored) batch.mesh.dispose(false, false);
    this.activeBatches.clear();
    this.freeNormal.length = 0;
    this.freeMirrored.length = 0;
    this.atlas?.dispose();
    this.atlas = null;
    batchers.delete(this.scene);
    batchingEnabledScenes.delete(this.scene);
  }

  private markLayerDirty(handle: BatchedSpriteHandle, layer: SpriteLayerState): void {
    handle.dirty = true;
    if (layer.batch) layer.batch.dirty = true;
    else this.structureDirty = true;
  }

  private isLayerDrawable(handle: BatchedSpriteHandle, layer: SpriteLayerState): boolean {
    if (handle.disposed || !handle.visible || !handle.lastEnabled) return false;
    if (!layer.active || layer.visibility <= 0) return false;
    return layer.width > 0 && layer.height > 0;
  }

  private layerBlendMode(handle: BatchedSpriteHandle, layer: SpriteLayerState): BlendModeCode {
    if (handle.alwaysBlend) return 2;
    return layer.visibility > 0 && layer.visibility < 1 ? 1 : 0;
  }

  private resolveLighting(shadingMode: SurfaceShadingMode, lit2D: boolean): ResolvedLighting {
    if (shadingMode === "3d") return "3d";
    if (shadingMode === "2d" && lit2D) return "2d";
    return "none";
  }

  private ensureAtlas(): LayerImageAtlas | null {
    if (!this.imagePagesEnabled || this.disposed) return null;
    if (!this.atlas) this.atlas = new LayerImageAtlas(this.scene);
    return this.atlas;
  }

  private resolveLayerAtlasCell(layer: SpriteLayerState): LayerImageCell | null {
    const texture = layer.texture;
    if (!texture || !this.imagePagesEnabled) return null;
    if (!keepsUvs(texture)) return null;
    unlitTexelGrid(texture, scratchGrid);
    layer.texelX = scratchGrid[0]!;
    layer.texelY = scratchGrid[1]!;
    if (scratchGrid[0] === 0) return null;
    return this.ensureAtlas()?.cell(texture) ?? null;
  }

  private layerAtlasCellChanged(layer: SpriteLayerState): boolean {
    if (!layer.texture || layer.cell) return false;
    const cell = this.resolveLayerAtlasCell(layer);
    return cell !== layer.cell;
  }

  private bindLayerTexture(
    handle: BatchedSpriteHandle,
    layer: SpriteLayerState,
    textureGuid: string | null,
    assets?: MeshAssetContext,
  ): void {
    if (!textureGuid) {
      const had = layer.texture !== null || layer.textureGuid !== null;
      releaseLayerLeases(layer);
      if (had) this.structureDirty = true;
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
      this.structureDirty = true;
    };

    const failed = (error: unknown) => {
      if (handle.disposed || (layer.pending !== next && layer.lease !== next)) return;
      if (layer.pending === next) layer.pending = undefined;
      if (layer.lease === next) {
        layer.lease = undefined;
        layer.texture = null;
        layer.cell = null;
        this.structureDirty = true;
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

  private rebuildBatches(lit2D: boolean): void {
    // Clear previous membership lists while retaining batch objects and their GPU buffers for matching keys.
    for (const batch of this.activeBatches.values()) {
      batch.members.length = 0;
    }

    const addLayer = (handle: BatchedSpriteHandle, layer: SpriteLayerState) => {
      if (!this.isLayerDrawable(handle, layer)) {
        layer.batch = null;
        layer.batchKey = null;
        return;
      }
      const cell = this.resolveLayerAtlasCell(layer);
      if (!cell) {
        unlitTexelGrid(layer.texture, scratchGrid);
        layer.texelX = scratchGrid[0]!;
        layer.texelY = scratchGrid[1]!;
      }
      layer.cell = cell;
      const sampledTexture: BaseTexture | null = cell?.page ?? layer.texture;
      layer.sampledTexture = sampledTexture;

      const lighting = this.resolveLighting(handle.shadingMode, lit2D);
      const blendMode = this.layerBlendMode(handle, layer);
      const receiveShadows = lighting === "3d" && handle.receiveShadows;
      const castShadows = handle.castShadows;
      const mirrored = handle.mirrored;
      const textureId = textureBatchId(sampledTexture);
      const key = `${handle.renderingGroupId}|${handle.alphaIndex}|${lighting}|${blendMode}|${mirrored ? 1 : 0}|${receiveShadows ? 1 : 0}|${castShadows ? 1 : 0}|${textureId}`;

      let batch = this.activeBatches.get(key);
      if (!batch) {
        const spec: BatchSpec = {
          key,
          renderingGroupId: handle.renderingGroupId,
          alphaIndex: handle.alphaIndex,
          lighting,
          blendMode,
          mirrored,
          receiveShadows,
          castShadows,
          sampledTexture,
        };
        batch = this.acquireBatch(spec);
        this.activeBatches.set(key, batch);
      } else {
        batch.spec.sampledTexture = sampledTexture;
      }
      batch.members.push({ handle, layer, sortDistance: 0 });
      batch.dirty = true;
      layer.batchKey = key;
      layer.batch = batch;
    };

    for (const handle of this.handles) {
      if (handle.disposed || !handle.visible || !handle.lastEnabled) {
        handle.primary.batch = null;
        handle.primary.batchKey = null;
        handle.secondary.batch = null;
        handle.secondary.batchKey = null;
        continue;
      }
      addLayer(handle, handle.primary);
      if (handle.secondary.active) addLayer(handle, handle.secondary);
      else {
        handle.secondary.batch = null;
        handle.secondary.batchKey = null;
      }
    }

    // Recycle batches that became empty.
    for (const [key, batch] of this.activeBatches) {
      if (batch.members.length === 0) {
        this.activeBatches.delete(key);
        this.recycleBatch(batch);
      }
    }
  }

  private acquireBatch(spec: BatchSpec): SpriteBatch {
    const pool = spec.mirrored ? this.freeMirrored : this.freeNormal;
    let batch = pool.pop();
    if (!batch) {
      const cap = INITIAL_CAPACITY;
      const mesh = createUnitQuadMesh(this.scene, `worldSpriteBatch:${this.nextMeshId++}`, spec.mirrored);
      batch = {
        spec,
        mesh,
        mirrored: spec.mirrored,
        capacity: cap,
        count: 0,
        matrices: new Float32Array(cap * 16),
        sizePivots: new Float32Array(cap * 4),
        uvRects: new Float32Array(cap * 4),
        finishes: new Float32Array(cap * 4),
        texels: new Float32Array(cap * 4),
        members: [],
        dirty: true,
        buffersBound: false,
        boundTexture: null,
        boundLighting: null,
        boundBlendMode: -1,
      };
    } else {
      batch.spec = spec;
      batch.dirty = true;
    }
    this.configureBatchMesh(batch);
    return batch;
  }

  private configureBatchMesh(batch: SpriteBatch): void {
    const { mesh, spec } = batch;
    mesh.renderingGroupId = spec.renderingGroupId;
    mesh.alphaIndex = spec.alphaIndex;
    mesh.metadata = {
      ...(typeof mesh.metadata === "object" && mesh.metadata ? mesh.metadata : {}),
      sortingGroupId: `spriteBatch:${spec.key}`,
      sortingLayerKey: 0,
      worldSpriteBatch: true,
    };
    const cutoff = spec.blendMode === 2 ? 0 : 0.4;
    const blend = spec.blendMode === 2;
    const visibility = spec.blendMode === 1 ? 0.5 : 1;
    if (mesh.visibility !== visibility) mesh.visibility = visibility;

    if (
      batch.boundTexture !== spec.sampledTexture ||
      batch.boundLighting !== spec.lighting ||
      batch.boundBlendMode !== spec.blendMode
    ) {
      const binding: UnlitBinding = {
        texture: spec.sampledTexture,
        color: [1, 1, 1],
        alpha: 1,
        cutoff,
        blend,
        textureAlpha: true,
        twoSided: false,
      };
      setUnlitMaterial(mesh, materialKeyFor(spec.lighting), binding);
      batch.boundTexture = spec.sampledTexture;
      batch.boundLighting = spec.lighting;
      batch.boundBlendMode = spec.blendMode;
    }
    sceneShadowController(this.scene).setParticipation(mesh, {
      castShadows: spec.castShadows,
      receiveShadows: spec.receiveShadows,
    });
  }

  private recycleBatch(batch: SpriteBatch): void {
    batch.members.length = 0;
    batch.count = 0;
    batch.dirty = false;
    batch.mesh.thinInstanceCount = 0;
    batch.mesh.setEnabled(false);
    batch.mesh.isVisible = false;
    const pool = batch.mirrored ? this.freeMirrored : this.freeNormal;
    pool.push(batch);
  }

  private hasVaryingDepth(batch: SpriteBatch): boolean {
    const firstZ = batch.members[0]!.handle.worldMatrix.asArray()[14]!;
    for (let i = 1; i < batch.members.length; i++) {
      if (batch.members[i]!.handle.worldMatrix.asArray()[14]! !== firstZ) return true;
    }
    return false;
  }

  private uploadBatch(
    batch: SpriteBatch,
    eyeX: number,
    eyeY: number,
    eyeZ: number,
    floatingOrigin: boolean,
  ): void {
    const count = batch.members.length;
    const mesh = batch.mesh;
    let reallocate = !batch.buffersBound;
    if (count > batch.capacity) {
      const cap = nextCapacity(count, batch.capacity);
      batch.capacity = cap;
      batch.matrices = new Float32Array(cap * 16);
      batch.sizePivots = new Float32Array(cap * 4);
      batch.uvRects = new Float32Array(cap * 4);
      batch.finishes = new Float32Array(cap * 4);
      batch.texels = new Float32Array(cap * 4);
      reallocate = true;
    }

    const { matrices, sizePivots, uvRects, finishes, texels, members } = batch;
    scratchMin.set(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
    scratchMax.set(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);

    for (let i = 0; i < count; i++) {
      const { handle, layer } = members[i]!;
      const m = handle.worldMatrix.asArray();
      const matOff = i * 16;
      for (let k = 0; k < 16; k++) matrices[matOff + k] = m[k]!;
      if (floatingOrigin) {
        // Subtract floatingOriginOffset in 64-bit before rounding into the 32-bit instance buffer.
        matrices[matOff + 12] = m[12]! - eyeX;
        matrices[matOff + 13] = m[13]! - eyeY;
        matrices[matOff + 14] = m[14]! - eyeZ;
      }

      const vecOff = i * 4;
      sizePivots[vecOff] = layer.width;
      sizePivots[vecOff + 1] = layer.height;
      sizePivots[vecOff + 2] = layer.pivotX;
      sizePivots[vecOff + 3] = layer.pivotY;

      uvRects[vecOff] = layer.u0;
      uvRects[vecOff + 1] = layer.v0;
      uvRects[vecOff + 2] = layer.u1 - layer.u0;
      uvRects[vecOff + 3] = layer.v1 - layer.v0;

      finishes[vecOff] = layer.visibility;
      finishes[vecOff + 1] = 0;
      finishes[vecOff + 2] = 0;
      finishes[vecOff + 3] = 0;

      const cell = layer.cell;
      if (cell) {
        texels[vecOff] = layer.texelX * cell.width;
        texels[vecOff + 1] = layer.texelY * cell.height;
        texels[vecOff + 2] = cell.x;
        texels[vecOff + 3] = cell.y;
      } else {
        texels[vecOff] = layer.texelX;
        texels[vecOff + 1] = layer.texelY;
        texels[vecOff + 2] = UNLIT_TEXEL_WHOLE;
        texels[vecOff + 3] = UNLIT_TEXEL_WHOLE;
      }

      // Accumulate exact world AABB from the four transformed sprite quad corners.
      const left = -layer.pivotX * layer.width;
      const right = left + layer.width;
      const top = layer.pivotY * layer.height;
      const bottom = top - layer.height;
      accumulateSpriteCorner(left, bottom, m, scratchMin, scratchMax);
      accumulateSpriteCorner(right, bottom, m, scratchMin, scratchMax);
      accumulateSpriteCorner(right, top, m, scratchMin, scratchMax);
      accumulateSpriteCorner(left, top, m, scratchMin, scratchMax);
    }

    // Position the batch mesh at `eye` under floating origin so Babylon's `OffsetWorldToRef(u_World)` is Identity,
    // keeping `u_World * instanceMatrix` exact to 64-bit precision.
    if (floatingOrigin) {
      if (mesh.position.x !== eyeX || mesh.position.y !== eyeY || mesh.position.z !== eyeZ) {
        mesh.unfreezeWorldMatrix();
        mesh.position.set(eyeX, eyeY, eyeZ);
        mesh.freezeWorldMatrix();
      }
    } else if (mesh.position.x !== 0 || mesh.position.y !== 0 || mesh.position.z !== 0) {
      mesh.unfreezeWorldMatrix();
      mesh.position.set(0, 0, 0);
      mesh.freezeWorldMatrix();
    }

    if (reallocate) {
      // Suppress automatic thinInstanceRefreshBoundingInfo inside thinInstanceSetBuffer; we write exact bounds below.
      mesh.doNotSyncBoundingInfo = true;
      mesh.thinInstanceSetBuffer("matrix", matrices, 16, false);
      mesh.thinInstanceSetBuffer(SPRITE_BATCH_SIZE_PIVOT_KIND, sizePivots, 4, false);
      mesh.thinInstanceSetBuffer(SPRITE_BATCH_UV_RECT_KIND, uvRects, 4, false);
      mesh.thinInstanceSetBuffer(SPRITE_BATCH_FINISH_KIND, finishes, 4, false);
      mesh.thinInstanceSetBuffer(SPRITE_BATCH_TEXEL_KIND, texels, 4, false);
      mesh.doNotSyncBoundingInfo = false;
      batch.buffersBound = true;
    } else {
      mesh.thinInstancePartialBufferUpdate("matrix", count, 0);
      mesh.thinInstancePartialBufferUpdate(SPRITE_BATCH_SIZE_PIVOT_KIND, count, 0);
      mesh.thinInstancePartialBufferUpdate(SPRITE_BATCH_UV_RECT_KIND, count, 0);
      mesh.thinInstancePartialBufferUpdate(SPRITE_BATCH_FINISH_KIND, count, 0);
      mesh.thinInstancePartialBufferUpdate(SPRITE_BATCH_TEXEL_KIND, count, 0);
    }

    mesh.thinInstanceCount = count;
    batch.count = count;
    batch.dirty = false;
    this.bufferUploads += 1;

    // Update bounding box in mesh-local space (world minus batchMesh.position) so frustum culling is exact.
    if (Number.isFinite(scratchMin.x)) {
      scratchBoundsLocalMin.set(scratchMin.x - eyeX, scratchMin.y - eyeY, scratchMin.z - eyeZ);
      scratchBoundsLocalMax.set(scratchMax.x - eyeX, scratchMax.y - eyeY, scratchMax.z - eyeZ);
      mesh.getBoundingInfo().reConstruct(scratchBoundsLocalMin, scratchBoundsLocalMax, mesh.getWorldMatrix());
    }

    mesh.alwaysSelectAsActiveMesh = false;
    if (!mesh.isEnabled()) mesh.setEnabled(true);
    if (!mesh.isVisible) mesh.isVisible = true;
  }
}

/** Enable or disable Play world sprite batching on `scene`. */
export function setSceneWorldSpriteBatching(scene: Scene, enabled: boolean): void {
  if (enabled) {
    batchingEnabledScenes.add(scene);
    worldSpriteBatcher(scene);
  } else {
    batchingEnabledScenes.delete(scene);
    batchers.get(scene)?.dispose();
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

/** Toggle `LayerImageAtlas` page coalescing for `scene`'s `WorldSpriteBatcher`. */
export function setSceneWorldSpriteImagePages(scene: Scene, enabled: boolean): void {
  batchers.get(scene)?.setImagePages(enabled);
}

/** Batching stats for `scene`'s `WorldSpriteBatcher` (zeros if not enabled). */
export function worldSpriteBatchStats(scene: Scene): WorldSpriteBatchStats {
  return batchers.get(scene)?.stats ?? { sprites: 0, batches: 0, poolSize: 0, atlasImages: 0, atlasDrawn: 0, bufferUploads: 0 };
}

export function attachBatchedSprite(root: Mesh, init: BatchedSpriteInit): BatchedSpriteHandle {
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
