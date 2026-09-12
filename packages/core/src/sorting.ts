/** Widest span of `orderInLayer` a single layer can address, either side of 0. */
export const ORDER_IN_LAYER_LIMIT = 32767;
const LAYER_STRIDE = ORDER_IN_LAYER_LIMIT * 2 + 2;

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

/** Shared order for world components and Tilemap asset layers. */
export function sortingLayerSortKey(layers: readonly string[], name: string, order: number): number {
  const index = layers.indexOf(name);
  return computeSortKey(index >= 0 ? index : Math.max(0, layers.indexOf("Default")), order);
}
