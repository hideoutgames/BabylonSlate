/** Container dimensions use SceneLayer world units, including manual safe insets. */
export const OVERLAY_CONTAINER_CLASSES = ["2DVirtualizedListComponent", "2DVirtualizedGridComponent", "2DMaskPanelComponent", "2DMaskComponent", "2DSafeAreaComponent"] as const;
/** Resource ceiling per virtual container, including overscan. */
export const OVERLAY_VIRTUAL_ITEM_LIMIT = 2048;
export type OverlaySafeAreaInsets = { left: number; right: number; top: number; bottom: number };
export type VirtualizedItem = { containerId: string; index: number };
export function isVirtualizedOverlayClass(classId: string): boolean {
  return classId === "2DVirtualizedListComponent" || classId === "2DVirtualizedGridComponent";
}
export function isOverlayScrollClass(classId: string): boolean {
  return classId === "2DScrollBoxComponent" || isVirtualizedOverlayClass(classId);
}
const positive = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : fallback;
export function parseOverlayContainerProperties(value: Record<string, unknown> = {}) {
  return {
    itemClassId: typeof value.itemClassId === "string" ? value.itemClassId : "",
    itemCount: Math.min(10_000_000, Math.floor(positive(value.itemCount, 0))),
    itemWidth: Math.min(1_000_000, Math.max(0.001, positive(value.itemWidth, 1))),
    itemHeight: Math.min(1_000_000, Math.max(0.001, positive(value.itemHeight, 1))),
    columns: Math.min(OVERLAY_VIRTUAL_ITEM_LIMIT, Math.floor(positive(value.columns, 0))), overscan: Math.min(64, Math.floor(positive(value.overscan, 1))),
    useSafeArea: value.useSafeArea !== false,
    safeLeft: value.safeLeft !== false, safeRight: value.safeRight !== false, safeTop: value.safeTop !== false, safeBottom: value.safeBottom !== false,
    insetLeft: positive(value.insetLeft, 0), insetRight: positive(value.insetRight, 0), insetTop: positive(value.insetTop, 0), insetBottom: positive(value.insetBottom, 0),
  };
}
export type VirtualizedOverlayWindow = {
  first: number; end: number; count: number; columns: number;
  contentWidth: number; contentHeight: number; scrollX: number; scrollY: number;
};
/** Half-open range; touching a viewport edge does not allocate another item. */
export function virtualizedOverlayWindow(classId: string, properties: Record<string, unknown>, width: number, height: number, fallbackCount = 0): VirtualizedOverlayWindow {
  const p = parseOverlayContainerProperties(properties), gap = Math.min(1_000_000, positive(properties.gap, 0));
  const horizontal = classId !== "2DVirtualizedGridComponent" && properties.scrollAxis === "horizontal";
  const count = p.itemClassId ? p.itemCount : fallbackCount;
  const columns = classId === "2DVirtualizedGridComponent" ? Math.min(OVERLAY_VIRTUAL_ITEM_LIMIT, Math.max(1, p.columns || Math.floor((width + gap) / (p.itemWidth + gap)))) : horizontal ? Math.max(1, count) : 1;
  const rows = Math.ceil(count / columns);
  const contentWidth = count ? Math.min(columns, count) * (p.itemWidth + gap) - gap : 0;
  const contentHeight = rows ? rows * (p.itemHeight + gap) - gap : 0;
  const scrollX = horizontal ? Math.min(positive(properties.scrollX, 0), Math.max(0, contentWidth - width)) : 0;
  const scrollY = horizontal ? 0 : Math.min(positive(properties.scrollY, 0), Math.max(0, contentHeight - height));
  const step = horizontal ? p.itemWidth + gap : p.itemHeight + gap;
  const offset = horizontal ? scrollX : scrollY, extent = horizontal ? width : height;
  const startRow = Math.max(0, Math.floor(offset / step) - p.overscan);
  const endRow = Math.max(startRow, Math.ceil((offset + extent) / step) + p.overscan);
  const stride = horizontal ? 1 : columns;
  const visibleFirst = Math.floor(offset / step) * stride;
  const visibleCount = Math.ceil((offset + extent) / step) * stride - visibleFirst;
  const spare = Math.max(0, OVERLAY_VIRTUAL_ITEM_LIMIT - visibleCount);
  const first = Math.min(count, Math.max(startRow * stride, visibleFirst - Math.floor(spare / 2)));
  return { first, end: width <= 0 || height <= 0 ? first : Math.min(count, endRow * stride, first + OVERLAY_VIRTUAL_ITEM_LIMIT), count, columns, contentWidth, contentHeight, scrollX, scrollY };
}
