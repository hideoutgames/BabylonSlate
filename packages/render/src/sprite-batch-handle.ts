import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import type { CubeTexture } from "@babylonjs/core/Materials/Textures/cubeTexture";
import type { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { type Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";
import type { TileUv } from "@haptic/assets";
import type { SurfaceShadingMode } from "@haptic/core";
import type { LayerImageCell } from "./layer-image-atlas";
import type { MeshAssetContext } from "./mesh-assets";
import type { ResourceLease } from "./resource-cache";

/**
 * Zero-dependency leaf holding the per-root `BatchedSpriteHandle` registry and bounds helper so lower-level
 * render modules (`sorting.ts`, `snapshot-visibility.ts`, `anim-visibility.ts`, `play-handle-inspection.ts`,
 * `scene-stream-admission.ts`) can read or update batched sprite handles without creating an ESM import cycle
 * through `world-sprite-batcher.ts` → `unlit-material.ts` → `material-compiler.ts`.
 */

export interface SpriteBatchRef {
  readonly mesh: Mesh;
  dirty: boolean;
}

export interface SpriteLayerState<TBatch extends SpriteBatchRef = SpriteBatchRef> {
  readonly isOverlay: boolean;
  active: boolean;
  width: number;
  height: number;
  pivotX: number;
  pivotY: number;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  visibility: number;
  textureGuid: string | null;
  texture: Texture | CubeTexture | null;
  lease?: ResourceLease<Texture | CubeTexture>;
  pending?: ResourceLease<Texture | CubeTexture>;
  source?: Uint8Array | Blob;
  identity?: string;
  failed?: string;
  preparation?: Promise<void>;
  /** Batch key and batch currently holding this layer, for fast-path dirty updates. */
  batchKey: string | null;
  batch: TBatch | null;
  /** Cached texel grid for `texture` (without atlas cell). */
  texelX: number;
  texelY: number;
  /** Resolved sampled texture (atlas page or own texture) and cell at last key resolution. */
  sampledTexture: BaseTexture | null;
  cell: LayerImageCell | null;
}

export interface BatchedSpriteHandle<TBatch extends SpriteBatchRef = SpriteBatchRef> {
  readonly root: Mesh;
  readonly scene: Scene;
  readonly primary: SpriteLayerState<TBatch>;
  readonly secondary: SpriteLayerState<TBatch>;
  shadingMode: SurfaceShadingMode;
  alwaysBlend: boolean;
  renderingGroupId: number;
  alphaIndex: number;
  sortingGroupId: string;
  castShadows: boolean;
  receiveShadows: boolean;
  /** Logical visibility from `setPlayVisualVisibility` (the empty `root` mesh stays `isVisible = false`). */
  visible: boolean;
  assets: MeshAssetContext | undefined;
  /** Last observed `root.getWorldMatrix().updateFlag` and mirrored state. */
  lastWorldUpdateFlag: number;
  lastEnabled: boolean;
  mirrored: boolean;
  /** World matrix cached at last sync for fast instance packing. */
  worldMatrix: Matrix;
  /** True when any frame, sorting, visibility or texture property changed since last flush. */
  dirty: boolean;
  disposed: boolean;
  /** Set frame properties (texture, UVs, size, pivot) for the primary or crossfade overlay layer. */
  updateFrame(
    layer: "primary" | "secondary",
    frame: {
      textureGuid?: string | null;
      assets?: MeshAssetContext;
      uv?: TileUv | null;
      width: number;
      height: number;
      pivotX: number;
      pivotY: number;
    },
  ): void;
  /** Set per-layer visibility weight (e.g. Sprite Animation crossfade weights); 0 hides the overlay layer. */
  setLayerVisibility(layer: "primary" | "secondary", visibility: number): void;
  /** Update actor/component sorting and shadow participation. */
  setSorting(options: {
    renderingGroupId?: number;
    alphaIndex?: number;
    sortingGroupId?: string;
    castShadows?: boolean;
    receiveShadows?: boolean;
    shadingMode?: SurfaceShadingMode;
  }): void;
  /** Update logical visibility (called by `setPlayVisualVisibility`). */
  setVisible(visible: boolean): void;
  /** Mark transform dirty (e.g. after `setComponentTransforms` or `writeActorTransform`). */
  markTransformDirty(): void;
  /** Release texture leases and unregister from the batcher. */
  dispose(): void;
}

const rootHandles = new WeakMap<AbstractMesh, BatchedSpriteHandle>();
const scratchMin = new Vector3();
const scratchMax = new Vector3();

export function registerBatchedSpriteHandle(root: AbstractMesh, handle: BatchedSpriteHandle): void {
  rootHandles.set(root, handle);
}

export function unregisterBatchedSpriteHandle(root: AbstractMesh, handle: BatchedSpriteHandle): void {
  if (rootHandles.get(root) === handle) rootHandles.delete(root);
}

export function isBatchedSpriteRoot(mesh: AbstractMesh | null | undefined): boolean {
  const handle = mesh ? rootHandles.get(mesh) : undefined;
  return !!handle && !handle.disposed;
}

export function batchedSpriteOf(mesh: AbstractMesh | null | undefined): BatchedSpriteHandle | undefined {
  const handle = mesh ? rootHandles.get(mesh) : undefined;
  return handle && !handle.disposed ? handle : undefined;
}

export function accumulateSpriteCorner(
  lx: number,
  ly: number,
  m: ArrayLike<number>,
  min: Vector3,
  max: Vector3,
): void {
  const wx = lx * m[0]! + ly * m[4]! + m[12]!;
  const wy = lx * m[1]! + ly * m[5]! + m[13]!;
  const wz = lx * m[2]! + ly * m[6]! + m[14]!;
  if (wx < min.x) min.x = wx;
  if (wy < min.y) min.y = wy;
  if (wz < min.z) min.z = wz;
  if (wx > max.x) max.x = wx;
  if (wy > max.y) max.y = wy;
  if (wz > max.z) max.z = wz;
}

/** World-space AABB for a batched sprite root (used by `AnimVisibilityGate` for `When Visible` culling). */
export function worldSpriteBounds(
  root: AbstractMesh,
): { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } | null {
  const handle = rootHandles.get(root);
  if (!handle || handle.disposed) return null;
  const layer = handle.primary;
  if (layer.width <= 0 || layer.height <= 0) return null;
  const world = root.computeWorldMatrix();
  const m = world.asArray();
  scratchMin.set(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
  scratchMax.set(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);
  const left = -layer.pivotX * layer.width;
  const right = left + layer.width;
  const top = layer.pivotY * layer.height;
  const bottom = top - layer.height;
  accumulateSpriteCorner(left, bottom, m, scratchMin, scratchMax);
  accumulateSpriteCorner(right, bottom, m, scratchMin, scratchMax);
  accumulateSpriteCorner(right, top, m, scratchMin, scratchMax);
  accumulateSpriteCorner(left, top, m, scratchMin, scratchMax);
  return {
    minX: scratchMin.x, minY: scratchMin.y, minZ: scratchMin.z,
    maxX: scratchMax.x, maxY: scratchMax.y, maxZ: scratchMax.z,
  };
}
