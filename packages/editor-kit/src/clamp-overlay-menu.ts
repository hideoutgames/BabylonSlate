export type ClampOverlayMenuPositionInput = {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  margin?: number;
  insets?: OverlaySafeAreaInsets;
};

export type OverlaySubmenuOriginInput = {
  parentX: number;
  parentY: number;
  parentWidth: number;
  submenuWidth: number;
  viewportWidth: number;
  margin?: number;
  insets?: OverlaySafeAreaInsets;
};

export type OverlaySafeAreaInsets = {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
};

/** Shift a pointer-anchored overlay so every edge stays inside the viewport. */
export function clampOverlayMenuPosition({
  x,
  y,
  width,
  height,
  viewportWidth,
  viewportHeight,
  margin = 8,
  insets = {},
}: ClampOverlayMenuPositionInput): { x: number; y: number } {
  const leftMargin = margin + (insets.left ?? 0);
  const rightMargin = margin + (insets.right ?? 0);
  const topMargin = margin + (insets.top ?? 0);
  const bottomMargin = margin + (insets.bottom ?? 0);
  const maxX = Math.max(leftMargin, viewportWidth - rightMargin - width);
  const maxY = Math.max(topMargin, viewportHeight - bottomMargin - height);
  return {
    x: Math.min(Math.max(x, leftMargin), maxX),
    y: Math.min(Math.max(y, topMargin), maxY),
  };
}

/** Prefer the right of the parent; flip left when the submenu would overflow. */
export function overlaySubmenuOrigin({
  parentX,
  parentY,
  parentWidth,
  submenuWidth,
  viewportWidth,
  margin = 8,
  insets = {},
}: OverlaySubmenuOriginInput): { x: number; y: number } {
  const leftMargin = margin + (insets.left ?? 0);
  const rightMargin = margin + (insets.right ?? 0);
  const rightX = parentX + parentWidth;
  if (rightX + submenuWidth <= viewportWidth - rightMargin) {
    return { x: rightX, y: parentY };
  }
  return {
    x:
      leftMargin === margin
        ? parentX - submenuWidth
        : Math.max(leftMargin, parentX - submenuWidth),
    y: parentY,
  };
}
