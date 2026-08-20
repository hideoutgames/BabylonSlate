export type CssSizedCanvas = {
  clientWidth: number;
  clientHeight: number;
  width: number;
  height: number;
};

/** Integer CSS layout size. Empty layout floors to 1×1 so a bitmap is never 0. */
export function cssCanvasPixelSize(canvas: {
  clientWidth: number;
  clientHeight: number;
}): { width: number; height: number } {
  return {
    width: Math.max(1, Math.floor(canvas.clientWidth || 0)),
    height: Math.max(1, Math.floor(canvas.clientHeight || 0)),
  };
}

/**
 * Match the drawing buffer to integer CSS pixels so a skipped frame is blank
 * at the host aspect instead of a stretched last bitmap.
 */
export function snapCanvasDrawingBuffer(
  canvas: CssSizedCanvas,
): { width: number; height: number } {
  const size = cssCanvasPixelSize(canvas);
  if (canvas.width !== size.width) canvas.width = size.width;
  if (canvas.height !== size.height) canvas.height = size.height;
  return size;
}
