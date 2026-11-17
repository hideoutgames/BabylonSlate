/**
 * Pixel-matched orthographic game cameras (Pixel-Perfect Mode with Nearest Texture Filtering): the scale is fixed by
 * Pixels Per Unit, so one texture pixel covers a whole number of design pixels (or a design pixel shows a whole number
 * of texels when zoomed out). A camera's authored Orthographic Size, or the Layer Camera's Width × Height and zoom,
 * only choose that whole ratio: the nearest one to what they would frame over the design area. The view then covers
 * the whole output in design pixels (`sceneLayerOutputDesignSize`), so it never stretches: with Black Bars it is the
 * design resolution, and an output wider or taller than the design size shows more world on those sides, as Scene
 * Layers do.
 */

/** The whole scale nearest `scale`: an integer from 1 up, or a whole fraction 1/n below 1 (1 when not positive). */
export function wholePixelScale(scale: number): number {
  if (!(scale > 0) || !Number.isFinite(scale)) return 1;
  if (scale >= 1) return Math.max(1, Math.round(scale));
  return 1 / Math.max(1, Math.round(1 / scale));
}

/** What a pixel-matched camera frames from: the design resolution, the output in design pixels and Pixels Per Unit. */
export interface PixelMatchedContext {
  /** The design resolution in pixels (`sceneLayerDesignResolution`). */
  design: { width: number; height: number };
  /** The output in design pixels (`sceneLayerOutputDesignSize`): the design size, or larger on an extended side. */
  output: { width: number; height: number };
  pixelsPerUnit: number;
}

function positive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Design pixels per texel for a frame `requestedHeight` world units tall over the design area: the whole scale
 * nearest the design height in units over it. 1 shows one texel per design pixel; 2 zooms in; 1/2 zooms out.
 */
export function pixelMatchedScale(requestedHeight: number, designHeightPx: number, pixelsPerUnit: number): number {
  const designUnits = positive(designHeightPx, 1080) / positive(pixelsPerUnit, 100);
  return wholePixelScale(designUnits / positive(requestedHeight, designUnits));
}

/**
 * The world a pixel-matched camera shows, in units: the whole output in design pixels at `pixelMatchedScale`. The
 * design area is `pixelMatchedDesignFrame`, centred in it.
 */
export function pixelMatchedView(
  requestedHeight: number,
  context: PixelMatchedContext,
): { width: number; height: number; scale: number } {
  const ppu = positive(context.pixelsPerUnit, 100);
  const scale = pixelMatchedScale(requestedHeight, context.design.height, ppu);
  return {
    width: positive(context.output.width, context.design.width) / (ppu * scale),
    height: positive(context.output.height, context.design.height) / (ppu * scale),
    scale,
  };
}

/** The design area a pixel-matched camera frames (the editor's outline): the design resolution at its scale. */
export function pixelMatchedDesignFrame(
  requestedHeight: number,
  context: Omit<PixelMatchedContext, "output">,
): { width: number; height: number; scale: number } {
  return pixelMatchedView(requestedHeight, { ...context, output: context.design });
}
