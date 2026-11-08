import { compileText2DFontStacks } from "@haptic/assets";

/** Bitmap 2D Text CSS stacks from packed family names, each ending in the project's Global Fallback. */
export function packedFontCssStacks(
  fontFamilies: ReadonlyMap<string, string>,
  globalFallback: string,
  defaultFontGuid?: string,
  fallbackGuids?: ReadonlyMap<string, readonly string[]>,
): { fontCssStack: string; fontCssStackByGuid: Map<string, string> } {
  const compiled = compileText2DFontStacks({
    fonts: [...fontFamilies.entries()].map(([guid, family]) => ({ guid, family, fallbackGuids: fallbackGuids?.get(guid) })),
    defaultFontGuid,
    globalFallback,
  });
  return {
    fontCssStack: compiled.defaultStack,
    fontCssStackByGuid: compiled.byGuid,
  };
}
