import { compileText2DFontStacks } from "@babylonslate/assets";

export function packedFontEntries(options: {
  fontBytes: ReadonlyMap<string, Uint8Array>;
  fontFamilies?: ReadonlyMap<string, string>;
}): Array<{ guid: string; family: string; bytes: Uint8Array }> {
  return [...options.fontBytes.entries()].map(([guid, bytes]) => ({
    guid,
    family: options.fontFamilies?.get(guid)?.trim() || guid,
    bytes,
  }));
}

export function packedFontCssStacks(
  fontFamilies: ReadonlyMap<string, string>,
  globalFallback = "sans-serif",
): { fontCssStack: string; fontCssStackByGuid: Map<string, string> } {
  const compiled = compileText2DFontStacks({
    fonts: [...fontFamilies.entries()].map(([guid, family]) => ({ guid, family })),
    globalFallback,
  });
  return {
    fontCssStack: compiled.defaultStack,
    fontCssStackByGuid: compiled.byGuid,
  };
}

/**
 * Packed FontFace from asset bytes (engineplan §15.1). Do not use blob URLs —
 * `FontFace` accepts a BufferSource so the packed payload stays in memory.
 */
export type PackedFontHost = {
  FontFace: typeof FontFace;
  fonts: Pick<FontFaceSet, "add">;
};

function defaultHost(): PackedFontHost | null {
  if (typeof FontFace === "undefined") return null;
  if (typeof document === "undefined" || !document.fonts) return null;
  return { FontFace, fonts: document.fonts };
}

export async function registerPackedFonts(
  fontBytes: Map<string, Uint8Array>,
  host?: PackedFontHost | null,
  families?: ReadonlyMap<string, string>,
): Promise<void> {
  const resolved = host === undefined ? defaultHost() : host;
  if (!resolved) return;
  for (const [guid, bytes] of fontBytes) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const family = families?.get(guid)?.trim() || guid;
    const face = new resolved.FontFace(family, copy);
    resolved.fonts.add(await face.load());
  }
}
