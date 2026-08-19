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

export function usesSpriteOrTilemapSorting(actor: {
  components: ReadonlyArray<{ classId: string }>;
}): boolean {
  return actor.components.some(
    (component) =>
      component.classId === "SpriteComponent" ||
      component.classId === "TilemapComponent",
  );
}

/** 3D MeshComponent visuals sit above the editor grid underlay. */
export function applyWorldVisualGroup(
  mesh: {
    renderingGroupId: number;
    getChildMeshes: () => Array<{ renderingGroupId: number }>;
  },
  actor: { components: ReadonlyArray<{ classId: string }> },
): void {
  if (usesSpriteOrTilemapSorting(actor)) return;
  mesh.renderingGroupId = RENDERING_GROUP.world;
  for (const child of mesh.getChildMeshes()) {
    child.renderingGroupId = RENDERING_GROUP.world;
  }
}

/**
 * Clear depth (not color) when drawing world/foreground/ui so the grid in
 * group 0 is an underlay rather than a transparent peer.
 */
export function configureEditorRenderingGroups(scene: {
  setRenderingAutoClearDepthStencil: (
    renderingGroupId: number,
    autoClear: boolean,
    depth?: boolean,
    stencil?: boolean,
  ) => void;
}): void {
  scene.setRenderingAutoClearDepthStencil(
    RENDERING_GROUP.background,
    false,
  );
  for (const group of [
    RENDERING_GROUP.world,
    RENDERING_GROUP.foreground,
    RENDERING_GROUP.ui,
  ] as const) {
    scene.setRenderingAutoClearDepthStencil(group, true, true, true);
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
