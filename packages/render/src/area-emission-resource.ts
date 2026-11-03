import type { AreaEmissionPixels } from "@haptic/assets";

// RGBA8 1024-square, complete native mip chain including 1x1.
export const AREA_EMISSION_TEXTURE_BYTES = 5_592_404;
export function areaEmissionResourceKey(pixels: AreaEmissionPixels): string {
  return `${pixels.metadata.processor}:${pixels.metadata.pixelsHash}`;
}
