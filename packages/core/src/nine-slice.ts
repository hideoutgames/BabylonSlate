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

/** An authored margin is a 0–1 fraction of the source texture edge; values above 1 clamp to the whole edge. */
export function overlayPanelMarginToPx(margin: number, srcPx: number): number {
  if (!Number.isFinite(margin) || margin <= 0) return 0;
  return Math.min(margin, 1) * (srcPx > 0 ? srcPx : 0);
}

/**
 * Clamp a pair of opposite margins to `[0, max]` each, then shrink both in
 * proportion when together they exceed `max`.
 */
function fitMarginPair(first: number, second: number, max: number): [number, number] {
  const limit = Math.max(0, max);
  const clamp = (value: number) => (!Number.isFinite(value) || value <= 0 ? 0 : Math.min(value, limit));
  let a = clamp(first);
  let b = clamp(second);
  if (a + b > limit) {
    const scale = limit / (a + b);
    a *= scale;
    b *= scale;
  }
  return [a, b];
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
  // Source slices in texture pixels; the texture coordinates come from these.
  const [srcLeft, srcRight] = fitMarginPair(
    overlayPanelMarginToPx(options.marginLeft, srcW),
    overlayPanelMarginToPx(options.marginRight, srcW),
    srcW,
  );
  const [srcBottom, srcTop] = fitMarginPair(
    overlayPanelMarginToPx(options.marginBottom, srcH),
    overlayPanelMarginToPx(options.marginTop, srcH),
    srcH,
  );
  // Corners keep their pixel/ppu size and squeeze, never crop, on a smaller panel.
  const [left, right] = fitMarginPair(srcLeft / ppu, srcRight / ppu, destW);
  const [bottom, top] = fitMarginPair(srcBottom / ppu, srcTop / ppu, destH);
  const centerW = destW - left - right;
  const centerH = destH - bottom - top;
  const uLeft = srcLeft / srcW;
  const uRight = srcRight / srcW;
  const vBottom = srcBottom / srcH;
  const vTop = srcTop / srcH;
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

export type OverlayNineSliceSourceFractions = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

/** Pixel-margin splits on the source image (CSS Y: top of PNG is 0). */
export function overlayNineSliceSourceFractions(options: {
  srcWidthPx: number;
  srcHeightPx: number;
  marginLeft: number;
  marginRight: number;
  marginTop: number;
  marginBottom: number;
}): OverlayNineSliceSourceFractions {
  const srcW = options.srcWidthPx > 0 ? options.srcWidthPx : 1;
  const srcH = options.srcHeightPx > 0 ? options.srcHeightPx : 1;
  const [left, right] = fitMarginPair(
    overlayPanelMarginToPx(options.marginLeft, srcW),
    overlayPanelMarginToPx(options.marginRight, srcW),
    srcW,
  );
  const [top, bottom] = fitMarginPair(
    overlayPanelMarginToPx(options.marginTop, srcH),
    overlayPanelMarginToPx(options.marginBottom, srcH),
    srcH,
  );
  return {
    left: left / srcW,
    right: 1 - right / srcW,
    top: top / srcH,
    bottom: 1 - bottom / srcH,
  };
}
