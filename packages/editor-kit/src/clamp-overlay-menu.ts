export type ClampOverlayMenuPositionInput = {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  margin?: number;
};

export type OverlaySubmenuOriginInput = {
  parentX: number;
  parentY: number;
  parentWidth: number;
  submenuWidth: number;
  viewportWidth: number;
  margin?: number;
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
}: ClampOverlayMenuPositionInput): { x: number; y: number } {
  const maxX = Math.max(margin, viewportWidth - margin - width);
  const maxY = Math.max(margin, viewportHeight - margin - height);
  return {
    x: Math.min(Math.max(x, margin), maxX),
    y: Math.min(Math.max(y, margin), maxY),
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
}: OverlaySubmenuOriginInput): { x: number; y: number } {
  const rightX = parentX + parentWidth;
  if (rightX + submenuWidth <= viewportWidth - margin) {
    return { x: rightX, y: parentY };
  }
  return { x: parentX - submenuWidth, y: parentY };
}
