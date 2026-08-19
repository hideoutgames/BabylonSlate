/** Hold `scene.render` this long after the last integer CSS size change. */
export const CANVAS_RESIZE_HOLD_MS = 80;

export type CanvasSize = {
  clientWidth: number;
  clientHeight: number;
};

export type CanvasResizeGuardOptions = {
  holdMs?: number;
  onHoldChange?: (holding: boolean) => void;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (id: unknown) => void;
};

export type CanvasResizeGuard = ((canvas: CanvasSize) => void) & {
  dispose: () => void;
};

/**
 * Call `resize` when the canvas integer CSS size actually changes, then hold
 * rendering until the size has been stable for `CANVAS_RESIZE_HOLD_MS`.
 */
export function createCanvasResizeGuard(
  resize: () => void,
  options: CanvasResizeGuardOptions = {},
): CanvasResizeGuard {
  let lastWidth = Number.NaN;
  let lastHeight = Number.NaN;
  let holding = false;
  let timer: unknown = null;
  const holdMs = options.holdMs ?? CANVAS_RESIZE_HOLD_MS;
  const schedule =
    options.schedule ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const cancel =
    options.cancel ??
    ((id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>));

  const endHold = () => {
    timer = null;
    if (!holding) return;
    holding = false;
    options.onHoldChange?.(false);
    resize();
  };

  const beginOrExtendHold = () => {
    if (!holding) {
      holding = true;
      options.onHoldChange?.(true);
    }
    if (timer != null) cancel(timer);
    timer = schedule(endHold, holdMs);
  };

  const apply = ((canvas: CanvasSize) => {
    const width = Math.floor(canvas.clientWidth);
    const height = Math.floor(canvas.clientHeight);
    if (width <= 0 || height <= 0) return;
    if (width === lastWidth && height === lastHeight) return;
    lastWidth = width;
    lastHeight = height;
    resize();
    beginOrExtendHold();
  }) as CanvasResizeGuard;

  apply.dispose = () => {
    if (timer == null) return;
    cancel(timer);
    timer = null;
  };

  return apply;
}
