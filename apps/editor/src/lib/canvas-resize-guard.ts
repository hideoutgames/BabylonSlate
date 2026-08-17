/** Call `resize` only when the canvas integer CSS size actually changed. */
export function createCanvasResizeGuard(
  resize: () => void,
): (canvas: { clientWidth: number; clientHeight: number }) => void {
  let lastWidth = Number.NaN;
  let lastHeight = Number.NaN;
  return (canvas) => {
    const width = Math.floor(canvas.clientWidth);
    const height = Math.floor(canvas.clientHeight);
    if (width <= 0 || height <= 0) return;
    if (width === lastWidth && height === lastHeight) return;
    lastWidth = width;
    lastHeight = height;
    resize();
  };
}
