export type OverlayNineSliceCell = {
  x: number;
  y: number;
  width: number;
  height: number;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
};

export type OverlayNineSliceOptions = {
  destWidth: number;
  destHeight: number;
  srcWidthPx: number;
  srcHeightPx: number;
  marginLeft: number;
  marginRight: number;
  marginTop: number;
  marginBottom: number;
  pixelsPerUnit: number;
};

function clampMargin(value: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(value, Math.max(0, max));
}

export function overlayPanelDestFromScale(
  scaleX: number,
  scaleY: number,
): { destWidth: number; destHeight: number } {
  return {
    destWidth: Number.isFinite(scaleX) && Math.abs(scaleX) > 0 ? Math.abs(scaleX) : 1,
    destHeight: Number.isFinite(scaleY) && Math.abs(scaleY) > 0 ? Math.abs(scaleY) : 1,
  };
}

/** 9 cells in row-major order from bottom-left, matching CreatePlane UV space. */
export function overlayNineSliceCells(
  options: OverlayNineSliceOptions,
): OverlayNineSliceCell[] {
  const destW = options.destWidth > 0 ? options.destWidth : 1;
  const destH = options.destHeight > 0 ? options.destHeight : 1;
  const ppu = options.pixelsPerUnit > 0 ? options.pixelsPerUnit : 100;
  const srcW = options.srcWidthPx > 0 ? options.srcWidthPx : destW * ppu;
  const srcH = options.srcHeightPx > 0 ? options.srcHeightPx : destH * ppu;
  let left = clampMargin(options.marginLeft / ppu, destW);
  let right = clampMargin(options.marginRight / ppu, destW);
  let bottom = clampMargin(options.marginBottom / ppu, destH);
  let top = clampMargin(options.marginTop / ppu, destH);
  if (left + right > destW) {
    const scale = destW / (left + right);
    left *= scale;
    right *= scale;
  }
  const centerW = destW - left - right;
  if (bottom + top > destH) {
    const scale = destH / (bottom + top);
    bottom *= scale;
    top *= scale;
  }
  const centerH = destH - bottom - top;
  const uLeft = srcW > 0 ? left * ppu / srcW : 0;
  const uRight = srcW > 0 ? right * ppu / srcW : 0;
  const vBottom = srcH > 0 ? bottom * ppu / srcH : 0;
  const vTop = srcH > 0 ? top * ppu / srcH : 0;
  const xs = [-destW / 2, -destW / 2 + left, destW / 2 - right];
  const ys = [-destH / 2, -destH / 2 + bottom, destH / 2 - top];
  const widths = [left, centerW, right];
  const heights = [bottom, centerH, top];
  const us = [0, uLeft, 1 - uRight, 1];
  const vs = [0, vBottom, 1 - vTop, 1];
  const cells: OverlayNineSliceCell[] = [];
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      cells.push({
        x: xs[col]!,
        y: ys[row]!,
        width: widths[col]!,
        height: heights[row]!,
        u0: us[col]!,
        v0: vs[row]!,
        u1: us[col + 1]!,
        v1: vs[row + 1]!,
      });
    }
  }
  return cells;
}
