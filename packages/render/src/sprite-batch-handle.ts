import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import type { CubeTexture } from "@babylonjs/core/Materials/Textures/cubeTexture";
import type { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { Matrix } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";
import type { TileUv } from "@haptic/assets";
import type { SurfaceShadingMode } from "@haptic/core";
import type { LayerImageCell } from "./layer-image-atlas";
import type { MeshAssetContext } from "./mesh-assets";
import type { ResourceLease } from "./resource-cache";

/**
 * Zero-dependency leaf holding the per-root `BatchedSpriteHandle` registry, the bounds helper and the cutout draw
 * identity so lower-level render modules (`sorting.ts`, `snapshot-visibility.ts`, `anim-visibility.ts`,
 * `play-handle-inspection.ts`, `scene-stream-admission.ts`) can read or update batched sprite handles without creating
 * an ESM import cycle through `world-sprite-batcher.ts` → `unlit-material.ts` → `material-compiler.ts`.
 */

export interface SpriteBatchRef {
  readonly mesh: Mesh;
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
  /** The batch drawing this layer and its instance there; null and -1 while it draws nowhere. */
  batch: TBatch | null;
  slot: number;
  /** Texel grid for `texture` (without atlas cell). */
  texelX: number;
  texelY: number;
  /** Resolved sampled texture (atlas page or own texture) and cell at the last placement. */
  sampledTexture: BaseTexture | null;
  cell: LayerImageCell | null;
}

export interface BatchedSpriteHandle<TBatch extends SpriteBatchRef = SpriteBatchRef> {
  readonly root: Mesh;
  readonly scene: Scene;
  readonly primary: SpriteLayerState<TBatch>;
  readonly secondary: SpriteLayerState<TBatch>;
  shadingMode: SurfaceShadingMode;
  renderingGroupId: number;
  alphaIndex: number;
  sortingGroupId: string;
  receiveShadows: boolean;
  /** Logical visibility from `setPlayVisualVisibility` (the empty `root` mesh stays `isVisible = false`). */
  visible: boolean;
  assets: MeshAssetContext | undefined;
  /** Last observed `root.getWorldMatrix().updateFlag`, enabled and mirrored state. */
  lastWorldUpdateFlag: number;
  lastEnabled: boolean;
  mirrored: boolean;
  /** World matrix cached at last sync for instance packing. */
  worldMatrix: Matrix;
  /** True when the transform must be read again at the next flush. */
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
  /** Update actor/component sorting, shadow reception and shading. */
  setSorting(options: {
    renderingGroupId?: number;
    alphaIndex?: number;
    sortingGroupId?: string;
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

/** A world-space box: `[minX, minY, minZ, maxX, maxY, maxZ]`. */
export type SpriteBounds = Float64Array;

export function createSpriteBounds(): SpriteBounds {
  return new Float64Array(6);
}

export function resetSpriteBounds(bounds: SpriteBounds): void {
  bounds[0] = bounds[1] = bounds[2] = Number.POSITIVE_INFINITY;
  bounds[3] = bounds[4] = bounds[5] = Number.NEGATIVE_INFINITY;
}

export function accumulateSpriteCorner(lx: number, ly: number, m: ArrayLike<number>, bounds: SpriteBounds): void {
  const wx = lx * m[0]! + ly * m[4]! + m[12]!;
  const wy = lx * m[1]! + ly * m[5]! + m[13]!;
  const wz = lx * m[2]! + ly * m[6]! + m[14]!;
  if (wx < bounds[0]!) bounds[0] = wx;
  if (wy < bounds[1]!) bounds[1] = wy;
  if (wz < bounds[2]!) bounds[2] = wz;
  if (wx > bounds[3]!) bounds[3] = wx;
  if (wy > bounds[4]!) bounds[4] = wy;
  if (wz > bounds[5]!) bounds[5] = wz;
}

/** Grows `bounds` by the four corners of a `width` × `height` quad pivoted at `(pivotX, pivotY)` under `m`. */
export function accumulateSpriteQuad(
  width: number,
  height: number,
  pivotX: number,
  pivotY: number,
  m: ArrayLike<number>,
  bounds: SpriteBounds,
): void {
  const left = -pivotX * width;
  const right = left + width;
  const top = pivotY * height;
  const bottom = top - height;
  accumulateSpriteCorner(left, bottom, m, bounds);
  accumulateSpriteCorner(right, bottom, m, bounds);
  accumulateSpriteCorner(right, top, m, bounds);
  accumulateSpriteCorner(left, top, m, bounds);
}

/**
 * Writes the world-space AABB of a batched sprite root's primary frame into `out` (for `AnimVisibilityGate` `When
 * Visible` culling); false, leaving `out` alone, when `root` is no batched sprite or draws an empty frame.
 */
export function worldSpriteBounds(root: AbstractMesh, out: SpriteBounds): boolean {
  const handle = rootHandles.get(root);
  if (!handle || handle.disposed) return false;
  const layer = handle.primary;
  if (layer.width <= 0 || layer.height <= 0) return false;
  resetSpriteBounds(out);
  accumulateSpriteQuad(layer.width, layer.height, layer.pivotX, layer.pivotY, root.computeWorldMatrix().asArray(), out);
  return true;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The cutout draw order inside one rendering group and `alphaIndex` (`compareAlphaTestDraws`): sorting group, then
 * the tilemap layer's sort key and ordinal, then name, then unique id.
 */
export function compareDrawIdentity(
  aGroup: string, aLayerKey: number, aOrdinal: number, aName: string, aId: number,
  bGroup: string, bLayerKey: number, bOrdinal: number, bName: string, bId: number,
): number {
  return compareText(aGroup, bGroup) || aLayerKey - bLayerKey || aOrdinal - bOrdinal || compareText(aName, bName) || aId - bId;
}

interface DrawIdentityMetadata {
  sortingGroupId?: string;
  sortingLayerKey?: number;
  tilemapLayer?: { ordinal?: number };
  /** A world sprite batch's stand-in name and id: those of the first sprite it draws. */
  sortingName?: string;
  sortingUniqueId?: number;
}

/** `compareDrawIdentity` of two meshes' metadata (a world sprite batch sorts as the first sprite it draws). */
export function compareMeshDrawIdentity(left: AbstractMesh, right: AbstractMesh): number {
  const a = left.metadata as DrawIdentityMetadata | null | undefined;
  const b = right.metadata as DrawIdentityMetadata | null | undefined;
  return compareDrawIdentity(
    a?.sortingGroupId ?? left.name, a?.sortingLayerKey ?? 0, a?.tilemapLayer?.ordinal ?? 0, a?.sortingName ?? left.name, a?.sortingUniqueId ?? left.uniqueId,
    b?.sortingGroupId ?? right.name, b?.sortingLayerKey ?? 0, b?.tilemapLayer?.ordinal ?? 0, b?.sortingName ?? right.name, b?.sortingUniqueId ?? right.uniqueId,
  );
}

const sortingRevisions = new WeakMap<Scene, number>();

/** Changes whenever sorting is applied to a mesh of `scene` (`applyComponentSorting`): its cutout draw order may have. */
export function sceneSortingRevision(scene: Scene): number {
  return sortingRevisions.get(scene) ?? 0;
}

export function markSceneSortingChanged(scene: Scene): void {
  sortingRevisions.set(scene, sceneSortingRevision(scene) + 1);
}
