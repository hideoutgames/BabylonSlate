import { compileText2DFontStacks } from "@haptic/assets";

/**
 * Bitmap 2D Text CSS stacks from packed family names, each ending in the project's Global Fallback, and the
 * pixel Fonts' Pixel Sizes.
 */
export function packedFontCssStacks(
  fontFamilies: ReadonlyMap<string, string>,
  globalFallback: string,
  defaultFontGuid?: string,
  fallbackGuids?: ReadonlyMap<string, readonly string[]>,
  pixelSizes?: ReadonlyMap<string, number>,
): { fontCssStack: string; fontCssStackByGuid: Map<string, string>; fontPixelSize: number; fontPixelSizeByGuid: Map<string, number> } {
  const compiled = compileText2DFontStacks({
    fonts: [...fontFamilies.entries()].map(([guid, family]) => ({
      guid, family, fallbackGuids: fallbackGuids?.get(guid), pixelSize: pixelSizes?.get(guid),
    })),
    defaultFontGuid,
    globalFallback,
  });
  return {
    fontCssStack: compiled.defaultStack,
    fontCssStackByGuid: compiled.byGuid,
    fontPixelSize: compiled.defaultPixelSize,
    fontPixelSizeByGuid: compiled.pixelSizeByGuid,
  };
}
