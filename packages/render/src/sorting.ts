import type { AbstractMesh, Scene, SubMesh } from "@babylonjs/core";

/**
 * Babylon supports four rendering groups, reserved here for coarse separation
 * so a UI sprite can never sort behind world geometry no matter what its
 * `orderInLayer` says. Fine ordering inside a group is the `alphaIndex` sort
 * key below.
 */
export const RENDERING_GROUP = {
  background: 0,
  world: 1,
  foreground: 2,
  ui: 3,
} as const;

export type RenderingGroupName = keyof typeof RENDERING_GROUP;

/** Widest span of `orderInLayer` a single layer can address, either side of 0. */
export const ORDER_IN_LAYER_LIMIT = 32767;
const LAYER_STRIDE = ORDER_IN_LAYER_LIMIT * 2 + 2;

export interface SortingLayerResolution {
  /** Index of the layer in the project's ordered list; -1 when unknown. */
  layerIndex: number;
  renderingGroupId: number;
  sortKey: number;
}

export function clampOrderInLayer(orderInLayer: number): number {
  const rounded = Math.round(orderInLayer);
  if (Number.isNaN(rounded)) return 0;
  return Math.min(ORDER_IN_LAYER_LIMIT, Math.max(-ORDER_IN_LAYER_LIMIT, rounded));
}

/**
 * Compile `(layer, orderInLayer)` into the single monotonically increasing
 * number Babylon sorts transparent draws by. Two sprites in different layers
 * can never interleave, whatever their order values.
 */
export function computeSortKey(layerIndex: number, orderInLayer: number): number {
  const layer = Math.max(0, Math.round(layerIndex));
  return layer * LAYER_STRIDE + clampOrderInLayer(orderInLayer) + ORDER_IN_LAYER_LIMIT;
}

/**
 * Layers named after a reserved rendering group land in it; everything else is
 * world geometry, which is where an unrecognised layer is least surprising.
 */
export function renderingGroupForLayer(layerName: string): number {
  const key = layerName.trim().toLowerCase();
  if (key === "background") return RENDERING_GROUP.background;
  if (key === "foreground") return RENDERING_GROUP.foreground;
  if (key === "ui" || key === "overlay") return RENDERING_GROUP.ui;
  return RENDERING_GROUP.world;
}

/** Resolve a layer name against the project's ordered sorting-layer list. */
export function resolveSortingLayer(
  sortingLayers: readonly string[],
  layerName: string,
  orderInLayer: number,
): SortingLayerResolution {
  const layerIndex = sortingLayers.indexOf(layerName);
  // An unknown layer sorts as if it were the default layer rather than
  // vanishing behind everything, but keeps its index reported as -1 so the
  // editor can flag it.
  const effectiveIndex = layerIndex >= 0 ? layerIndex : Math.max(0, sortingLayers.indexOf("Default"));
  return {
    layerIndex,
    renderingGroupId: renderingGroupForLayer(layerName),
    sortKey: computeSortKey(effectiveIndex, orderInLayer),
  };
}

/** Apply a resolved sorting layer to a mesh through `alphaIndex`. */
export function applySortingToMesh(
  mesh: { alphaIndex: number; renderingGroupId: number },
  resolution: SortingLayerResolution,
): void {
  mesh.alphaIndex = resolution.sortKey;
  mesh.renderingGroupId = resolution.renderingGroupId;
}

/** Each visual component is a group; Tilemap asset layers sort only inside it. */
export function applyComponentSorting(
  root: AbstractMesh,
  layers: readonly string[],
  layer = "Default",
  order = 0,
  groupId = root.name,
): void {
  const primary = resolveSortingLayer(layers, layer, order);
  for (const mesh of [root, ...root.getChildMeshes(true).filter((child) =>
    child.metadata?.tilemapLayer || child.name === `${root.name}-blend`,
  )]) {
    applySortingToMesh(mesh, primary);
    const internal = mesh.metadata?.tilemapLayer as
      { name: string; order: number; ordinal: number } | undefined;
    mesh.metadata = {
      ...(mesh.metadata ?? {}),
      sortingGroupId: groupId,
      sortingLayerKey: internal ? resolveSortingLayer(layers, internal.name, internal.order).sortKey : 0,
    };
  }
}

function compareIdentity(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Alpha-test draws do not populate Babylon's transparent SubMesh alpha index. */
export function compareAlphaTestDraws(a: SubMesh, b: SubMesh): number {
  const left = a.getMesh();
  const right = b.getMesh();
  return left.alphaIndex - right.alphaIndex
    || compareIdentity(left.metadata?.sortingGroupId ?? left.name, right.metadata?.sortingGroupId ?? right.name)
    || (left.metadata?.sortingLayerKey ?? 0) - (right.metadata?.sortingLayerKey ?? 0)
    || (left.metadata?.tilemapLayer?.ordinal ?? 0) - (right.metadata?.tilemapLayer?.ordinal ?? 0)
    || compareIdentity(left.name, right.name)
    || left.uniqueId - right.uniqueId;
}

/** Preserve opaque/blended passes and depth policy while ordering cutout visuals. */
export function configureCutoutSorting(scene: Pick<Scene, "setRenderingOrder">): void {
  for (const group of Object.values(RENDERING_GROUP)) {
    scene.setRenderingOrder(group, null, compareAlphaTestDraws, null);
  }
}

export function usesSpriteOrTilemapSorting(actor: {
  components: ReadonlyArray<{ classId: string }>;
}): boolean {
  return actor.components.some(
    (component) =>
      component.classId === "SpriteComponent" ||
      component.classId === "TilemapComponent",
  );
}

/** 3D MeshComponent visuals share `RENDERING_GROUP.world` with the editor grid. */
export function applyWorldVisualGroup(
  mesh: {
    renderingGroupId: number;
    metadata?: unknown;
    getChildMeshes: () => Array<{ renderingGroupId: number; metadata?: unknown }>;
  },
  actor: { components: ReadonlyArray<{ classId: string }> },
): void {
  if (usesSpriteOrTilemapSorting(actor)) return;
  if (!isEditorHelperBillboard(mesh)) {
    mesh.renderingGroupId = RENDERING_GROUP.world;
  }
  for (const child of mesh.getChildMeshes()) {
    if (isEditorHelperBillboard(child)) continue;
    child.renderingGroupId = RENDERING_GROUP.world;
  }
}

function isEditorHelperBillboard(mesh: { metadata?: unknown }): boolean {
  return (
    typeof (mesh.metadata as { editorBillboard?: unknown } | null)
      ?.editorBillboard === "string"
  );
}

/**
 * Keep rendering groups on one depth buffer so the world-group grid is
 * occluded by meshes instead of compositing as a cleared underlay.
 */
export function configureEditorRenderingGroups(scene: {
  setRenderingAutoClearDepthStencil: (
    renderingGroupId: number,
    autoClear: boolean,
    depth?: boolean,
    stencil?: boolean,
  ) => void;
}): void {
  for (const group of [
    RENDERING_GROUP.background,
    RENDERING_GROUP.world,
    RENDERING_GROUP.foreground,
    RENDERING_GROUP.ui,
  ] as const) {
    scene.setRenderingAutoClearDepthStencil(group, false);
  }
}

/** Babylon particle systems expose `renderingGroupId`, not mesh `alphaIndex`. */
export function applySortingToParticleSystem(
  system: { renderingGroupId: number },
  resolution: SortingLayerResolution,
): void {
  system.renderingGroupId = resolution.renderingGroupId;
}

/**
 * Sprites have no `alphaIndex`, so depth within a layer is a tiny Z offset:
 * one sub-pixel step per sort-key unit keeps ordering stable without moving
 * the sprite on screen.
 */
export function applySortingToSprite(
  sprite: { position: { z: number } },
  resolution: SortingLayerResolution,
  pixelsPerUnit: number,
): void {
  const scale = pixelsPerUnit > 0 ? pixelsPerUnit : 100;
  sprite.position.z = -resolution.sortKey / (scale * 1000);
}
